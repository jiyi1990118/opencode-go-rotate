#!/usr/bin/env python3
"""go-rotate CLI gateway 子命令零依赖单元测试（仅 Python 标准库）。

运行：python3 tests/test-go-rotate-gateway.py
策略：
  - subprocess 级：跑真实 CLI + 假 launchctl 脚本注入 PATH（分发/快速失败路径/启停调用序列）。
    涉及健康检查的用例注入 ZEN_GATEWAY_PORT=59999（必然拒连）→ healthz 确定性失败，不依赖真实网关。
  - 进程内级：importlib 加载 + monkeypatch _launchctl/_gateway_healthz，覆盖 start/stop/restart/status/logs 全逻辑。
  - 绝不触碰真实 ~/.config/opencode/go-keys.json / auth.json / launchctl / 18888 服务启停。
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI_PATH = os.path.join(ROOT, "go-rotate")
LABEL = "com.go-rotate.zen-gateway"

# 假 launchctl：print 返回值由 print_rc 控制（0=已加载），其余操作由 op_rc 控制（0=成功）；
# 每次调用追加一行到 op_log。rc 直接烘焙进脚本（无 env 依赖，确定性）。
FAKE_LC_SCRIPT = """#!/usr/bin/env bash
# 假 launchctl（测试用，不碰真实 launchd）
case "${{1:-}}" in
  print) echo "$*" >> "{op_log}"; exit {print_rc} ;;
  bootstrap|bootout|load|unload|kickstart) echo "$*" >> "{op_log}"; exit {op_rc} ;;
  *) echo "unexpected launchctl: $*" >> "{op_log}"; exit 9 ;;
esac
"""


# ---------- 公共工具 ----------

def run_cli(args, home, fake_dir=None, extra_env=None, timeout=90):
    """临时 HOME 下跑真实 CLI；fake_dir 注入 PATH（假 launchctl）。"""
    env = dict(os.environ)
    env["HOME"] = home
    if fake_dir:
        env["PATH"] = fake_dir + os.pathsep + env.get("PATH", "")
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, CLI_PATH] + args,
        env=env, capture_output=True, text=True, timeout=timeout,
    )


def make_fake_launchctl(op_log, print_rc=0, op_rc=0):
    """创建假 launchctl 脚本目录（注入 PATH 用），返回目录路径。"""
    d = tempfile.mkdtemp(prefix="gorotate-fakebin-")
    p = os.path.join(d, "launchctl")
    with open(p, "w") as f:
        f.write(FAKE_LC_SCRIPT.format(op_log=op_log, print_rc=print_rc, op_rc=op_rc))
    os.chmod(p, 0o755)
    return d


def cfg_path(home):
    return os.path.join(home, ".config", "opencode", "go-keys.json")


def write_cfg(home, keys, current=""):
    d = os.path.dirname(cfg_path(home))
    os.makedirs(d, exist_ok=True)
    cfg = {"provider_id": "opencode-go", "cooldown_minutes": 300,
           "current": current, "keys": keys}
    with open(cfg_path(home), "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def make_gateway_log(home, n):
    """在临时 HOME 写 n 行网关日志（~/Library/Logs/zen-gateway.log）。"""
    p = os.path.join(home, "Library", "Logs", "zen-gateway.log")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        for i in range(1, n + 1):
            f.write(f"line-{i:03d}\n")
    return p


def make_plist(home):
    """在临时 HOME 创建（空）plist，让 start 通过存在性检查。"""
    p = os.path.join(home, "Library", "LaunchAgents", LABEL + ".plist")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").close()
    return p


class _InProc:
    """进程内加载 go-rotate 模块（用于 monkeypatch 用例）。"""
    g = None
    originals = None
    MONKEYPATCHED = ("_launchctl", "_gateway_healthz", "_gateway_wait_health", "GATEWAY_PORT",
                     "_schtasks", "_systemctl_user")

    @classmethod
    def load(cls):
        if cls.g is None:
            loader = importlib.machinery.SourceFileLoader("grotate_gw_cli", CLI_PATH)
            spec = importlib.util.spec_from_loader("grotate_gw_cli", loader)
            m = importlib.util.module_from_spec(spec)
            with tempfile.TemporaryDirectory() as td:
                old = os.environ.get("HOME")
                os.environ["HOME"] = td
                try:
                    loader.exec_module(m)
                finally:
                    if old is None:
                        os.environ.pop("HOME", None)
                    else:
                        os.environ["HOME"] = old
            cls.g = m
            cls.originals = {name: getattr(m, name) for name in cls.MONKEYPATCHED}
        return cls.g


def inproc(home):
    """把模块级全局重指到临时 HOME，并恢复被 monkeypatch 的成员（防用例间污染），返回模块。"""
    g = _InProc.load()
    for name in _InProc.MONKEYPATCHED:
        setattr(g, name, _InProc.originals[name])
    g.DATA_DIR = os.path.join(home, ".config", "opencode")
    g.CONFIG_FILE = os.path.join(g.DATA_DIR, "go-keys.json")
    g.LOCK_FILE = g.CONFIG_FILE + ".lock"
    g.AUTH_FILE = os.path.join(home, ".local", "share", "opencode", "auth.json")
    g.GATEWAY_PLIST = os.path.join(home, "Library", "LaunchAgents", g.GATEWAY_LABEL + ".plist")
    g.GATEWAY_LOG = os.path.join(home, "Library", "Logs", "zen-gateway.log")
    # 平台分发/路径全局复位为 darwin（宿主）语义，防跨平台用例 pollution 污染其它类（unittest 按类名字母序执行）
    g.IS_WINDOWS = os.name == "nt"
    g.GATEWAY_PLATFORM_OVERRIDE = None
    g.GATEWAY_UNIT = None
    g.GATEWAY_WRAPPER = None
    g.GATEWAY_PORT = 18888
    return g


def fake_launchctl(ops, initial_loaded=True):
    """进程内假 launchctl：记录调用到 ops，模拟 bootstrap/bootout 后状态翻转（有状态）。"""
    state = {"loaded": initial_loaded}

    def f(args):
        ops.append(list(args))
        cmd = args[0]
        if cmd == "print":
            return (0, "", "") if state["loaded"] else (1, "", "")
        if cmd in ("bootstrap", "load"):
            state["loaded"] = True
            return 0, "", ""
        if cmd in ("bootout", "unload"):
            state["loaded"] = False
            return 0, "", ""
        if cmd == "kickstart":
            return 0, "", ""
        return 0, "", ""
    return f


class GwCase(unittest.TestCase):
    """每个用例独立临时 HOME + 独立操作日志。"""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="gorotate-gw-")
        self.op_log = os.path.join(self.home, "launchctl-ops.log")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def op_lines(self):
        if not os.path.exists(self.op_log):
            return []
        with open(self.op_log) as f:
            return [l.strip() for l in f if l.strip()]


# ---------- 1. 分发 / 用法 / 快速失败路径（subprocess + 假 launchctl） ----------

class TestGatewayDispatch(GwCase):
    """gateway 子命令分发与快速失败路径（假 launchctl 注入 PATH）"""

    def test_无参打印用法退出0(self):
        r = run_cli(["gateway"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("go-rotate gateway {start|stop|restart|status|logs", r.stdout)

    def test_未知子命令打印用法退出1(self):
        r = run_cli(["gateway", "frobnicate"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("用法", r.stdout)

    def test_start无plist快速失败不碰launchctl(self):
        """临时 HOME 无 LaunchAgents plist → 退出 1「未安装服务」，launchctl 未被调用"""
        fake = make_fake_launchctl(self.op_log)
        try:
            r = run_cli(["gateway", "start"], self.home, fake_dir=fake)
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("未安装服务", r.stdout + r.stderr)
        self.assertEqual(self.op_lines(), [], "launchctl 不应被调用")

    def test_start已加载健康失败警告不bootstrap(self):
        """print=0（已加载）+ 59999 必然拒连 → 健康失败警告；不 bootstrap（幂等跳过）"""
        make_plist(self.home)
        fake = make_fake_launchctl(self.op_log, print_rc=0)
        try:
            r = run_cli(["gateway", "start"], self.home, fake_dir=fake,
                        extra_env={"ZEN_GATEWAY_PORT": "59999"})
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("健康检查未通过", r.stdout)
        self.assertFalse(any("bootstrap" in l for l in self.op_lines()), "幂等：不应 bootstrap")

    def test_stop未加载提示未在运行(self):
        """print=1（未加载）→ 提示未在运行，不 bootout，退出 0"""
        fake = make_fake_launchctl(self.op_log, print_rc=1)
        try:
            r = run_cli(["gateway", "stop"], self.home, fake_dir=fake)
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("未在运行", r.stdout)
        self.assertFalse(any("bootout" in l for l in self.op_lines()), "未加载不应 bootout")

    def test_stop已加载调用bootout(self):
        """print=0（已加载）→ bootout 带 label，输出已停止"""
        fake = make_fake_launchctl(self.op_log, print_rc=0)
        try:
            r = run_cli(["gateway", "stop"], self.home, fake_dir=fake)
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("已停止", r.stdout)
        ops = self.op_lines()
        self.assertTrue(any(l.startswith("print ") for l in ops), ops)
        self.assertTrue(any(l.startswith("bootout ") and LABEL in l for l in ops), ops)

    def test_restart已加载stop再start(self):
        """restart：先 bootout 停止；stateless 假 launchctl 仍报已加载 → start 走已加载分支"""
        make_plist(self.home)
        fake = make_fake_launchctl(self.op_log, print_rc=0)
        try:
            r = run_cli(["gateway", "restart"], self.home, fake_dir=fake,
                        extra_env={"ZEN_GATEWAY_PORT": "59999"})
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("已停止", r.stdout)
        self.assertTrue(any("bootout" in l for l in self.op_lines()), "restart 应先 stop")

    def test_status未加载输出stopped端口key数(self):
        """print=1（未加载）→ stopped + 端口 18888 + key 数（读 go-keys.json）；不碰 healthz"""
        write_cfg(self.home, [{"name": "act1", "key": "sk-a", "cooldown_until": None},
                              {"name": "act2", "key": "sk-b", "cooldown_until": None}],
                  current="act1")
        fake = make_fake_launchctl(self.op_log, print_rc=1)
        try:
            r = run_cli(["gateway", "status"], self.home, fake_dir=fake)
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("状态: stopped", r.stdout)
        self.assertIn("端口: 18888", r.stdout)
        self.assertIn("key 数: 2", r.stdout)

    def test_status已加载健康检查失败(self):
        """print=0（已加载）+ 59999 拒连 → 状态标注健康检查未通过"""
        write_cfg(self.home, [{"name": "act1", "key": "sk-a", "cooldown_until": None}], current="act1")
        fake = make_fake_launchctl(self.op_log, print_rc=0)
        try:
            r = run_cli(["gateway", "status"], self.home, fake_dir=fake,
                        extra_env={"ZEN_GATEWAY_PORT": "59999"})
        finally:
            shutil.rmtree(fake, ignore_errors=True)
        self.assertEqual(r.returncode, 0)
        self.assertIn("健康检查未通过", r.stdout)
        self.assertIn("端口: 59999", r.stdout)


# ---------- 2. logs（subprocess，无需 launchctl/healthz） ----------

class TestGatewayLogsSubprocess(GwCase):
    """logs 子命令 tail 行为（不碰 launchctl / 网络）"""

    def test_logs默认100行(self):
        make_gateway_log(self.home, 150)
        r = run_cli(["gateway", "logs"], self.home)
        self.assertEqual(r.returncode, 0)
        lines = r.stdout.splitlines()
        self.assertEqual(len(lines), 100)
        self.assertEqual(lines[0], "line-051")
        self.assertEqual(lines[-1], "line-150")

    def test_logs指定行数(self):
        make_gateway_log(self.home, 150)
        r = run_cli(["gateway", "logs", "7"], self.home)
        self.assertEqual(r.returncode, 0)
        lines = r.stdout.splitlines()
        self.assertEqual(len(lines), 7)
        self.assertEqual(lines[0], "line-144")

    def test_logs无日志文件提示退出0(self):
        r = run_cli(["gateway", "logs"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("日志文件不存在", r.stdout)


# ---------- 3. 进程内全逻辑（monkeypatch _launchctl/_gateway_healthz） ----------

class TestGatewayInProc(GwCase):
    """monkeypatch 假 launchctl + 假 healthz，覆盖 start/stop/restart/status 全逻辑"""

    def setUp(self):
        super().setUp()
        self.g = inproc(self.home)
        self.ops = []
        self.g._launchctl = fake_launchctl(self.ops)
        self._hz = []

    def patch_healthz(self, results):
        """healthz 依次返回 results，最后一个持续；返回计数可查。"""
        state = {"i": 0}
        def f():
            i = min(state["i"], len(results) - 1)
            state["i"] += 1
            return results[i]
        self.g._gateway_healthz = f
        return state

    def capture(self, fn):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fn()
        return buf.getvalue()

    def test_start未加载启动成功(self):
        """未加载 → bootstrap + 健康等待（首次失败二次成功）→ 启动成功"""
        make_plist(self.home)
        self.g._launchctl = fake_launchctl(self.ops, initial_loaded=False)
        hz = self.patch_healthz([(False, {}), (True, {"keys": 2})])
        out = self.capture(self.g._gateway_start)
        self.assertIn("启动成功", out)
        self.assertEqual(hz["i"], 2, "健康等待应轮询 2 次")
        self.assertTrue(any(o[0] == "bootstrap" for o in self.ops), self.ops)

    def test_start幂等已运行不bootstrap(self):
        """已加载 + 健康通过 → 已在运行，不 bootstrap"""
        make_plist(self.home)
        self.patch_healthz([(True, {"keys": 1})])
        out = self.capture(self.g._gateway_start)
        self.assertIn("已在运行", out)
        self.assertFalse(any(o[0] == "bootstrap" for o in self.ops), self.ops)

    def test_start已加载健康失败警告(self):
        """已加载 + 健康失败 → 警告，不 bootstrap"""
        make_plist(self.home)
        self.patch_healthz([(False, {})])
        out = self.capture(self.g._gateway_start)
        self.assertIn("健康检查未通过", out)
        self.assertFalse(any(o[0] == "bootstrap" for o in self.ops), self.ops)

    def test_start无plist退出且不碰launchctl(self):
        """无 plist → SystemExit「未安装服务」，launchctl 零调用"""
        with self.assertRaises(SystemExit) as cm:
            self.g._gateway_start()
        self.assertIn("未安装服务", str(cm.exception))
        self.assertEqual(self.ops, [])

    def test_start健康等待超时警告(self):
        """未加载 + 等待超时 → 已加载但健康未通过警告（patch wait 为 False，避免真实 15s）"""
        make_plist(self.home)
        self.g._launchctl = fake_launchctl(self.ops, initial_loaded=False)
        self.g._gateway_wait_health = lambda: False
        out = self.capture(self.g._gateway_start)
        self.assertIn("已加载但健康检查未通过", out)
        self.assertTrue(any(o[0] == "bootstrap" for o in self.ops), self.ops)

    def test_stop未运行不bootout(self):
        ops = []
        self.g._launchctl = fake_launchctl(ops, initial_loaded=False)
        out = self.capture(self.g._gateway_stop)
        self.assertIn("未在运行", out)
        self.assertFalse(any(o[0] == "bootout" for o in ops), ops)

    def test_stop已加载调bootout(self):
        out = self.capture(self.g._gateway_stop)
        self.assertIn("已停止", out)
        self.assertTrue(any(o[0] == "bootout" for o in self.ops), self.ops)

    def test_restart已加载stop再start(self):
        """已加载 → bootout 后重新 bootstrap + 健康通过 → 启动成功"""
        make_plist(self.home)
        self.patch_healthz([(True, {})])
        out = self.capture(self.g._gateway_restart)
        self.assertIn("启动成功", out)
        cmds = [o[0] for o in self.ops]
        self.assertIn("bootout", cmds)
        self.assertIn("bootstrap", cmds)
        self.assertEqual(cmds.count("print"), 2, "stop 和 start 各查一次加载状态")

    def test_restart未运行直接启动(self):
        """未加载 → 提示直接启动并 start 成功"""
        make_plist(self.home)
        self.g._launchctl = fake_launchctl(self.ops, initial_loaded=False)
        self.patch_healthz([(True, {})])
        out = self.capture(self.g._gateway_restart)
        self.assertIn("未运行", out)
        self.assertIn("启动成功", out)
        self.assertTrue(any(o[0] == "bootstrap" for o in self.ops), self.ops)

    def test_status运行中(self):
        write_cfg(self.home, [{"name": "a", "key": "sk-a", "cooldown_until": None},
                              {"name": "b", "key": "sk-b", "cooldown_until": None}])
        hz = self.patch_healthz([(True, {"keys": 2, "current": "a"})])
        out = self.capture(self.g._gateway_status)
        self.assertIn("状态: running", out)
        self.assertIn("端口: 18888", out)
        self.assertIn("key 数: 2", out)
        self.assertEqual(hz["i"], 1, "healthz 应被探测一次")

    def test_status已加载健康检查失败(self):
        self.patch_healthz([(False, {})])
        out = self.capture(self.g._gateway_status)
        self.assertIn("running（健康检查未通过）", out)

    def test_status未加载不探测healthz(self):
        self.g._launchctl = fake_launchctl(self.ops, initial_loaded=False)
        hz = self.patch_healthz([(True, {})])
        out = self.capture(self.g._gateway_status)
        self.assertIn("状态: stopped", out)
        self.assertEqual(hz["i"], 0, "未加载时不应探测 healthz")

    def test_status无配置key数未知(self):
        self.g._launchctl = fake_launchctl(self.ops, initial_loaded=False)
        out = self.capture(self.g._gateway_status)
        self.assertIn("key 数: 未知", out)

    def test_logs默认100行(self):
        make_gateway_log(self.home, 150)
        out = self.capture(lambda: self.g._gateway_logs())
        lines = out.splitlines()
        self.assertEqual(len(lines), 100)
        self.assertEqual(lines[0], "line-051")
        self.assertEqual(lines[-1], "line-150")

    def test_logs指定行数(self):
        make_gateway_log(self.home, 150)
        out = self.capture(lambda: self.g._gateway_logs("5"))
        self.assertEqual(len(out.splitlines()), 5)

    def test_logs非法行数回退100(self):
        make_gateway_log(self.home, 150)
        out = self.capture(lambda: self.g._gateway_logs("abc"))
        self.assertEqual(len(out.splitlines()), 100)

    def test_logs无文件提示(self):
        out = self.capture(lambda: self.g._gateway_logs())
        self.assertIn("日志文件不存在", out)

    def test_healthz真实拒连容错(self):
        """真实 urllib 打向必然未监听端口 → (False, {}) 无异常（2s 超时容错）"""
        self.g.GATEWAY_PORT = 59999
        ok, info = self.g._gateway_healthz()
        self.assertFalse(ok)
        self.assertEqual(info, {})


# ---------- 4. do_status 网关行 + do_gateway 分发 ----------

class TestGatewayStatusLine(GwCase):
    """status 末尾网关状态行（容错：没网关不报错）"""

    def setUp(self):
        super().setUp()
        self.g = inproc(self.home)
        self.cfg = {"provider_id": "opencode-go", "cooldown_minutes": 300,
                    "current": "act1",
                    "keys": [{"name": "act1", "key": "sk-a", "cooldown_until": None}]}

    def test_do_status网关行running(self):
        self.g._gateway_healthz = lambda: (True, {"keys": 1, "current": "act1"})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.g.do_status(self.cfg)
        out = buf.getvalue()
        self.assertTrue(out.rstrip().endswith("网关: running (18888)"), out)

    def test_do_status网关行stopped(self):
        self.g._gateway_healthz = lambda: (False, {})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.g.do_status(self.cfg)
        out = buf.getvalue()
        self.assertTrue(out.rstrip().endswith("网关: stopped"), out)

    def test_do_gateway无参打印用法(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.g.do_gateway(None)
        self.assertIn("用法", buf.getvalue())

    def test_do_gateway未知子命令退出1(self):
        with self.assertRaises(SystemExit) as cm:
            self.g.do_gateway("frobnicate")
        self.assertEqual(cm.exception.code, 1)

    def test_main分发启停持锁status只读(self):
        """源码结构：start/stop/restart + 网关域 set/next/cooldown 经 _with_lock；status/logs 直调"""
        src = open(CLI_PATH, encoding="utf-8").read()
        self.assertIn('if sub in ("start", "stop", "restart", "set", "next", "cooldown"):', src)
        self.assertIn("_with_lock(lambda: do_gateway(sub, args[2:]))", src)
        self.assertIn("do_gateway(sub, args[2:])", src)


# ---------- 4. 跨平台服务后端分发（Windows schtasks / Linux systemd --user，monkeypatch 假命令） ----------

class TestGatewayCrossPlatform(GwCase):
    """monkeypatch _schtasks/_systemctl_user + GATEWAY_PLATFORM_OVERRIDE，
    验证 loaded/boot/bootout 在 Windows 与 Linux 的分发路径（macOS 分支由既有用例覆盖）。"""

    def setUp(self):
        super().setUp()
        self.g = inproc(self.home)
        # inproc 复位后置空 override；此处按用例设置
        self.g.GATEWAY_PLATFORM_OVERRIDE = None

    def fake_schtasks(self, ops, query_found=True, op_rc=0):
        """假 schtasks：记录调用；/Query 返回 query_found 决定 is-loaded；其余按 op_rc。"""
        state = {"found": query_found}
        def f(args):
            ops.append(args)
            if "/Query" in args:
                return (0 if state["found"] else 1), "", ""
            if "/Create" in args:
                state["found"] = True
            if "/Delete" in args:
                state["found"] = False
            return op_rc, "", ""
        self.g._schtasks = f
        self.g.GATEWAY_PLATFORM_OVERRIDE = "windows"
        return state

    def fake_systemctl(self, ops, enable_rc=0):
        def f(args):
            ops.append(args)
            if args[0] == "enable":
                return enable_rc, "", ""
            return 0, "", ""
        self.g._systemctl_user = f
        self.g.GATEWAY_PLATFORM_OVERRIDE = "linux"
        return ops

    # ---- Windows ----
    def test_windows_loaded_未注册(self):
        make_gateway_log(self.home, 3)
        ops = []
        self.fake_schtasks(ops, query_found=False)
        self.assertFalse(self.g._gateway_loaded())
        self.assertTrue(any("/Query" in o for o in ops))

    def test_windows_loaded_已注册(self):
        ops = []
        self.fake_schtasks(ops, query_found=True)
        self.assertTrue(self.g._gateway_loaded())

    def test_windows_boot_创建计划任务并运行(self):
        """未注册 → /Create (ONLOGON) + /Run；已注册 → 直接 True 不重复创建"""
        ops = []
        self.fake_schtasks(ops, query_found=False)
        self.g.GATEWAY_WRAPPER = os.path.join(self.home, "zen-gateway.cmd")
        self.assertTrue(self.g._gateway_boot())
        creates = [o for o in ops if "/Create" in o]
        self.assertEqual(len(creates), 1)
        self.assertIn("ONLOGON", creates[0])
        self.assertTrue(any("/Run" in o for o in ops))
        # 已注册直接 True 且不重复 Create
        before = len([o for o in ops if "/Create" in o])
        self.assertTrue(self.g._gateway_boot())
        self.assertEqual(len([o for o in ops if "/Create" in o]), before)

    def test_windows_bootout_end并删除任务(self):
        ops = []
        self.fake_schtasks(ops, query_found=True)
        self.g._gateway_bootout()
        self.assertTrue(any("/End" in o for o in ops))
        self.assertTrue(any("/Delete" in o for o in ops))

    def test_windows_marker_指向zen_gateway_cmd(self):
        self.fake_schtasks([], query_found=True)
        self.g.GATEWAY_WRAPPER = os.path.join(self.home, "zen-gateway.cmd")
        self.assertEqual(self.g._gateway_marker(), self.g.GATEWAY_WRAPPER)

    def test_windows_start_未安装包装脚本报错(self):
        """Windows 无 zen-gateway.cmd → start 报「未安装服务」"""
        self.fake_schtasks([], query_found=False)
        with self.assertRaises(SystemExit) as cm:
            self.g._gateway_start()
        self.assertIn("未安装服务", str(cm.exception))

    # ---- Linux ----
    def test_linux_loaded_unit文件不存在为未注册(self):
        make_gateway_log(self.home, 3)
        ops = []
        self.fake_systemctl(ops)
        self.g.GATEWAY_UNIT = os.path.join(self.home, "zen-gateway.service")
        self.assertFalse(self.g._gateway_loaded())  # 文件不存在 → False

    def test_linux_loaded_unit存在于已注册(self):
        unit = os.path.join(self.home, "zen-gateway.service")
        self.g.GATEWAY_UNIT = unit
        open(unit, "w").close()  # 或写入 unit；空文件仅表示存在
        self.fake_systemctl([])
        self.assertTrue(self.g._gateway_loaded())

    def test_linux_boot_enable现在(self):
        make_gateway_log(self.home, 3)
        ops = []
        self.fake_systemctl(ops)
        unit = os.path.join(self.home, "zen-gateway.service")
        open(unit, "w").close()
        self.assertTrue(self.g._gateway_boot())
        self.assertIn(["enable", "--now", "zen-gateway.service"], [o for o in ops])

    def test_linux_bootout_disable现在(self):
        make_gateway_log(self.home, 3)
        ops = []
        self.fake_systemctl(ops)
        self.g._gateway_bootout()
        self.assertIn(["disable", "--now", "zen-gateway.service"], ops)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    n_assert = src.count("self.assert")
    print("\n" + "=" * 64)
    print(f"用例数: {result.testsRun}  断言语句数: {n_assert}  失败: {len(result.failures)}  错误: {len(result.errors)}  跳过: {len(result.skipped)}")
    print("=" * 64)
    sys.exit(0 if result.wasSuccessful() else 1)
