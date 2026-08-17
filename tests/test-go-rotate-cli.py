#!/usr/bin/env python3
"""go-rotate CLI 零依赖单元测试（仅 Python 标准库）。

运行：python3 tests/test-go-rotate-cli.py
策略：
  - 绝大多数用例用 subprocess 跑真实 CLI，env 覆盖 HOME 为临时目录 → 最贴近真实，覆盖参数解析/退出码。
  - 需要网络（probe_key）或读写全局日志的用例（add/init/stats）用 importlib 进程内加载 + monkeypatch。
  - 绝不触碰真实 ~/.config/opencode/go-keys.json / auth.json / 8899 / /tmp/opencode-go-rotate.log。
"""
import contextlib
import http.server
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI_PATH = os.path.join(ROOT, "go-rotate")


# ---------- 公共工具 ----------

def run_cli(args, home, stdin_text=None, timeout=90, extra_env=None):
    """在临时 HOME 下跑真实 CLI。"""
    env = dict(os.environ)
    env["HOME"] = home
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, CLI_PATH] + args,
        env=env, input=stdin_text,
        capture_output=True, text=True, timeout=timeout,
    )


def cfg_path(home):
    return os.path.join(home, ".config", "opencode", "go-keys.json")


def auth_path(home):
    return os.path.join(home, ".local", "share", "opencode", "auth.json")


def lock_path(home):
    return cfg_path(home) + ".lock"


def write_cfg(home, keys, current="", cooldown_minutes=300, extra=None):
    """直接写配置（跳过 CLI，作为子命令的输入基线）。"""
    d = os.path.dirname(cfg_path(home))
    os.makedirs(d, exist_ok=True)
    cfg = {"provider_id": "opencode-go", "cooldown_minutes": cooldown_minutes,
           "current": current, "keys": keys}
    if extra:
        cfg.update(extra)
    with open(cfg_path(home), "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg_path(home)


def read_cfg(home):
    with open(cfg_path(home)) as f:
        return json.load(f)


def key(name, val, cooldown_until=None, cooldown_minutes=None, last_status=None, cooldown_until_gateway=None, cooldown_until_go=None, last_status_go=None):
    k = {"name": name, "key": val, "cooldown_until": cooldown_until}
    if cooldown_minutes is not None:
        k["cooldown_minutes"] = cooldown_minutes
    if last_status is not None:
        k["last_status"] = last_status
    if cooldown_until_gateway is not None:
        k["cooldown_until_gateway"] = cooldown_until_gateway
    if cooldown_until_go is not None:
        k["cooldown_until_go"] = cooldown_until_go
    if last_status_go is not None:
        k["last_status_go"] = last_status_go
    return k


def fut_iso(minutes_from_now):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes_from_now)).isoformat()


def assert_cooldown_until_near(testcase, iso, expect_min, tol_min=2):
    """断言 cooldown_until ≈ now + expect_min（容差 tol_min 分钟）。"""
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    diff_min = (t - now).total_seconds() / 60
    testcase.assertTrue(
        expect_min - tol_min <= diff_min <= expect_min + tol_min,
        f"cooldown_until 偏差过大: expect≈now+{expect_min}min, 实际 diff={diff_min:.1f}min ({iso})",
    )


class _InProc:
    """进程内加载 go-rotate 模块（用于需要 monkeypatch 的用例）。"""
    g = None

    @classmethod
    def load(cls):
        if cls.g is None:
            import importlib.machinery
            loader = importlib.machinery.SourceFileLoader("grotate_cli", CLI_PATH)
            spec = importlib.util.spec_from_loader("grotate_cli", loader)
            m = importlib.util.module_from_spec(spec)
            # exec 时把 HOME 指到临时目录，避免模块级 CONFIG_FILE 计算指向真实路径
            with tempfile.TemporaryDirectory() as td:
                old_home = os.environ.get("HOME")
                os.environ["HOME"] = td
                try:
                    loader.exec_module(m)
                finally:
                    if old_home is None:
                        os.environ.pop("HOME", None)
                    else:
                        os.environ["HOME"] = old_home
            cls.g = m
        return cls.g


def inproc_setup(home, log_path=None):
    """把模块级全局重指到临时 HOME（进程内用例必须调用）。"""
    g = _InProc.load()
    g.DATA_DIR = os.path.join(home, ".config", "opencode")
    g.CONFIG_FILE = os.path.join(g.DATA_DIR, "go-keys.json")
    g.LOCK_FILE = g.CONFIG_FILE + ".lock"
    g.AUTH_FILE = os.path.join(home, ".local", "share", "opencode", "auth.json")
    if log_path is not None:
        g.LOG_FILE = log_path
    return g


class _CliCase(unittest.TestCase):
    """每个用例独立临时 HOME。"""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="gorotate-test-")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)


# ---------- 1. 命令分发 / 参数解析 / 退出码 ----------

class TestDispatchBasics(_CliCase):
    """命令分发与退出码"""

    def test_无参数打印用法退出0(self):
        """无参数 → 打印 docstring，退出码 0"""
        r = run_cli([], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("go-rotate:", r.stdout)

    def test_未知命令退出1(self):
        """未知命令 frobnicate → 退出码 1"""
        r = run_cli(["frobnicate"], self.home)
        self.assertEqual(r.returncode, 1)

    def test_无配置时status干净报错(self):
        """全新 HOME（无配置目录）跑 status → 退出 1，输出干净错误，无 traceback"""
        r = run_cli(["status"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("config not found", r.stdout + r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_无配置时set干净报错且不残留锁(self):
        """全新 HOME 跑 set → 退出 1 无 traceback，且锁文件不残留（finally 清理）"""
        r = run_cli(["set", "act1"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("config not found", r.stdout + r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertFalse(os.path.exists(lock_path(self.home)),
                         "锁文件应被 finally 清理")

    def test_set缺参数退出1(self):
        """set 无参数 → 打印用法，退出码 1"""
        r = run_cli(["set"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("go-rotate:", r.stdout)

    def test_add缺参数退出1(self):
        """add 缺 name/key → 退出码 1（解析层拦截，不发网络探测）"""
        r1 = run_cli(["add"], self.home)
        r2 = run_cli(["add", "onlyname"], self.home)
        self.assertEqual(r1.returncode, 1)
        self.assertEqual(r2.returncode, 1)

    def test_cooldown缺参数退出1(self):
        """cooldown 无 name → 退出码 1"""
        r = run_cli(["cooldown"], self.home)
        self.assertEqual(r.returncode, 1)

    def test_next非法分钟值干净报错(self):
        """next abc → 退出 1，输出干净用法提示，无 traceback（修复后）"""
        write_cfg(self.home, [key("act1", "sk-a")], current="act1")
        r = run_cli(["next", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("分钟", r.stdout + r.stderr)


# ---------- 2. status / list ----------

class TestStatusList(_CliCase):
    """status/list 输出"""

    def setUp(self):
        super().setUp()
        self.keys = [key("act1", "sk-act1-key-0001", last_status="ok"),
                     key("act2", "sk-act2-key-0002", last_status="limited")]
        write_cfg(self.home, self.keys, current="act1")

    def test_status展示当前key与所有key(self):
        """status 输出含 provider_id / 当前 key / 各 key 名 / 当前标记 >"""
        r = run_cli(["status"], self.home)
        self.assertEqual(r.returncode, 0)
        out = r.stdout
        self.assertIn("provider_id: opencode-go", out)
        self.assertIn("current key: act1", out)
        self.assertIn("act1", out)
        self.assertIn("act2", out)
        self.assertIn("> act1", out)

    def test_status展示冷却状态(self):
        """cooldown_until 未来 → 输出 cooling 字样"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until=fut_iso(30))],
                  current="act1")
        r = run_cli(["status"], self.home)
        self.assertIn("cooling", r.stdout)

    def test_status展示last_status标签(self):
        """last_status=limited → 输出中文标签 [限流]"""
        r = run_cli(["status"], self.home)
        self.assertIn("限流", r.stdout)

    def test_status后无锁无tmp残留(self):
        """status 后 .config/opencode 下无 .lock / .tmp 残留"""
        run_cli(["status"], self.home)
        for f in os.listdir(os.path.dirname(cfg_path(self.home))):
            self.assertFalse(f.endswith(".lock") or f.endswith(".tmp"),
                             f"不应残留 {f}")

    def test_list是status别名(self):
        """list 与 status 行为一致"""
        r = run_cli(["list"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("current key: act1", r.stdout)


# ---------- 3. set / next ----------

class TestSetNext(_CliCase):
    """set / next 轮换"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home,
                  [key("act1", "sk-act1-key-0001"),
                   key("act2", "sk-act2-key-0002"),
                   key("act3", "sk-act3-key-0003")],
                  current="act1")

    def test_set切换current并同步auth(self):
        """set act2 → current=act2，auth.json 的 opencode-go.key 同步为 act2 的 key"""
        r = run_cli(["set", "act2"], self.home)
        self.assertEqual(r.returncode, 0)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current"], "act2")
        with open(auth_path(self.home)) as f:
            auth = json.load(f)
        self.assertEqual(auth["opencode-go"]["key"], "sk-act2-key-0002")

    def test_set未知key退出1(self):
        """set nope → 退出 1「not found」，配置不变"""
        r = run_cli(["set", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)
        self.assertEqual(read_cfg(self.home)["current"], "act1")

    def test_next跳过冷却key轮换到可用key(self):
        """act2 冷却中 → next 跳过 act2 轮到 act3"""
        write_cfg(self.home,
                  [key("act1", "sk-a"),
                   key("act2", "sk-b", cooldown_until=fut_iso(60)),
                   key("act3", "sk-c")],
                  current="act1")
        r = run_cli(["next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('rotated to key "act3"', r.stdout)
        self.assertEqual(read_cfg(self.home)["current"], "act3")

    def test_next全部冷却保持当前(self):
        """全部冷却 → 打印 no available key，退出 0，current 不变"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until=fut_iso(60)),
                   key("act2", "sk-b", cooldown_until=fut_iso(60))],
                  current="act1")
        r = run_cli(["next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("no available key", r.stdout)
        self.assertEqual(read_cfg(self.home)["current"], "act1")

    def test_next带分钟参数不冷却旧key(self):
        """next 45 → 轮换成功，但旧 key 未被冷却（dst_min 死变量，待裁决）"""
        write_cfg(self.home,
                  [key("act1", "sk-a"),
                   key("act2", "sk-b")],
                  current="act1")
        r = run_cli(["next", "45"], self.home)
        self.assertEqual(r.returncode, 0)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current"], "act2")
        old = next(k for k in cfg["keys"] if k["name"] == "act1")
        self.assertIsNone(old.get("cooldown_until"),
                          "next [minutes] 应冷却旧 key，但当前未生效（死变量）")

    def test_next单key轮换回自身(self):
        """只有一个 key → next 轮换回自身，退出 0"""
        write_cfg(self.home, [key("act1", "sk-a")], current="act1")
        r = run_cli(["next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(read_cfg(self.home)["current"], "act1")


# ---------- 4. cooldown 全链路 ----------

class TestCooldown(_CliCase):
    """cooldown 命令全链路"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home, [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1")

    def test_cooldown显式分钟(self):
        """cooldown act1 60 → cooldown_until ≈ now+60min"""
        r = run_cli(["cooldown", "act1", "60"], self.home)
        self.assertEqual(r.returncode, 0)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until"], 60)

    def test_cooldown无参用全局窗口(self):
        """cooldown act1（无参）→ 用全局 300min"""
        r = run_cli(["cooldown", "act1"], self.home)
        self.assertEqual(r.returncode, 0)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until"], 300)

    def test_cooldown无参优先key独立窗口(self):
        """key 有 cooldown_minutes=30 → 无参冷却用 30min"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_minutes=30)], current="act1")
        run_cli(["cooldown", "act1"], self.home)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until"], 30)

    def test_cooldown_window设置(self):
        """cooldown act1 window 45 → JSON 出现 cooldown_minutes=45"""
        r = run_cli(["cooldown", "act1", "window", "45"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(read_cfg(self.home)["keys"][0]["cooldown_minutes"], 45)

    def test_cooldown_window清除(self):
        """window clear → cooldown_minutes 字段删除（回退全局）"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_minutes=45)], current="act1")
        r = run_cli(["cooldown", "act1", "window", "clear"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("cooldown_minutes", read_cfg(self.home)["keys"][0])

    def test_cooldown_clear清冷却(self):
        """cooldown act1 clear → cooldown_until 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until=fut_iso(60))], current="act1")
        r = run_cli(["cooldown", "act1", "clear"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until"])

    def test_cooldown_0清冷却(self):
        """cooldown act1 0 → cooldown_until 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until=fut_iso(60))], current="act1")
        run_cli(["cooldown", "act1", "0"], self.home)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until"])

    def test_cooldown_window负数拒绝(self):
        """window -5 → 退出 1「不能为负数」"""
        r = run_cli(["cooldown", "act1", "window", "-5"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("负数", r.stdout + r.stderr)

    def test_cooldown_window非整数拒绝(self):
        """window abc → 退出 1 用法提示"""
        r = run_cli(["cooldown", "act1", "window", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("用法", r.stdout + r.stderr)

    def test_cooldown未知key退出1(self):
        """cooldown nope → 退出 1「not found」"""
        r = run_cli(["cooldown", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)

    def test_cooldown非法分钟值干净报错(self):
        """cooldown act1 abc → 退出 1，干净用法提示，无 traceback（修复后）"""
        r = run_cli(["cooldown", "act1", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)


# ---------- 5. 锁 / 原子写 / 并发 ----------

class TestLockAtomic(_CliCase):
    """_with_lock 陈旧锁 / 超时降级 / 原子写"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home, [key("act1", "sk-a"), key("act2", "sk-b")], current="act1")

    def test_陈旧锁被清除命令继续(self):
        """mtime 超 15s 的锁文件 → 自动清除，命令正常执行"""
        lp = lock_path(self.home)
        with open(lp, "w") as f:
            f.write("99999")
        old = time.time() - 20  # 20s 前 → 超过 LOCK_STALE_MS 15s
        os.utime(lp, (old, old))
        r = run_cli(["set", "act2"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(read_cfg(self.home)["current"], "act2")
        self.assertFalse(os.path.exists(lp), "陈旧锁应被清除且不残留")

    def test_新鲜锁超时降级警告继续(self):
        """mtime 小于 15s 的锁文件 → 等待 ~5s 后超时降级警告，命令仍执行（长用例 ~5s）"""
        lp = lock_path(self.home)
        with open(lp, "w") as f:
            f.write("99999")
        t0 = time.time()
        r = run_cli(["cooldown", "act1", "60"], self.home, timeout=30)
        elapsed = time.time() - t0
        self.assertEqual(r.returncode, 0)
        self.assertIn("获取配置锁超时", r.stdout)
        self.assertGreaterEqual(elapsed, 4.5, "应等待约 5s 才降级")
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until"], 60)

    def test_写后JSON合法且无tmp残留(self):
        """多次写命令后 → JSON 可解析，无 .tmp 残留"""
        for i in range(3):
            run_cli(["cooldown", "act1", "window", str(i)], self.home)
        cfg = read_cfg(self.home)
        self.assertEqual(len(cfg["keys"]), 2)
        d = os.path.dirname(cfg_path(self.home))
        self.assertFalse(any(f.endswith(".tmp") for f in os.listdir(d)),
                         "原子写不应残留 .tmp")

    def test_20并发写命令JSON无损(self):
        """20 个写命令并行 → JSON 无损、锁文件删除、无 tmp"""
        procs = []
        for i in range(20):
            env = dict(os.environ)
            env["HOME"] = self.home
            procs.append(subprocess.Popen(
                [sys.executable, CLI_PATH, "cooldown", "act1", "window", str(i)],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        codes = [p.wait(timeout=60) for p in procs]
        self.assertTrue(all(c == 0 for c in codes), f"并发命令有失败: {codes}")
        cfg = read_cfg(self.home)  # 应可解析
        self.assertEqual(cfg["current"], "act1")
        self.assertIn(cfg["keys"][0]["cooldown_minutes"], range(20))
        self.assertFalse(os.path.exists(lock_path(self.home)), "并发后锁文件应已删除")
        d = os.path.dirname(cfg_path(self.home))
        self.assertFalse(any(f.endswith(".tmp") for f in os.listdir(d)),
                         "并发后不应残留 .tmp")


# ---------- 6. web 命令分发 ----------

class TestWeb(_CliCase):
    """web 子命令（不真实起服务，不碰 8899）"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home, [key("act1", "sk-a")], current="act1")

    def test_web_on写配置(self):
        """web on → auto_web=true"""
        r = run_cli(["web", "on"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(read_cfg(self.home)["auto_web"])

    def test_web_off写配置(self):
        """web off → auto_web=false"""
        r = run_cli(["web", "off"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertFalse(read_cfg(self.home)["auto_web"])

    def test_web_status读取状态(self):
        """web status → 输出 开启/关闭"""
        run_cli(["web", "on"], self.home)
        r = run_cli(["web", "status"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("auto_web: 开启", r.stdout)

    def test_web独立启动无插件退出1(self):
        """web（独立启动）在无插件 HOME → 退出 1「插件未安装」，不碰 bun/8899"""
        r = run_cli(["web"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("插件未安装", r.stdout + r.stderr)

    def test_web_restart无插件退出1(self):
        """web restart：注入假 lsof（空输出→不 kill）→ 无插件 → 退出 1「插件未安装」"""
        fake = os.path.join(self.home, "bin")
        os.makedirs(fake, exist_ok=True)
        with open(os.path.join(fake, "lsof"), "w") as f:
            f.write("#!/bin/sh\necho -n ''\n")
        os.chmod(os.path.join(fake, "lsof"), 0o755)
        r = run_cli(["web", "restart"], self.home, extra_env={"PATH": fake + os.pathsep + os.environ["PATH"]})
        self.assertEqual(r.returncode, 1)
        self.assertIn("插件未安装", r.stdout + r.stderr)


# ---------- 7. stats（进程内 + 临时日志） ----------

class TestStats(_CliCase):
    """do_stats 解析临时日志（不碰真实 /tmp/opencode-go-rotate.log）"""

    SAMPLE = (
        "[2026-08-16 10:00:00] 轮换到 key \"act1\"\n"
        "[2026-08-16 10:01:00] key \"act2\" 配额耗尽\n"
        "[2026-08-16 10:02:00] 轮换到 key \"act2\"\n"
        "[2026-08-16 10:03:00] key \"act1\" 配额耗尽\n"
        "[2026-08-16 10:04:00] 轮换到 key \"act1\"\n"
        "[2026-08-16 10:05:00] 无关行 should be ignored\n"
    )

    def _make_log(self, content):
        lp = os.path.join(self.home, "fake-rotate.log")
        with open(lp, "w", encoding="utf-8") as f:
            f.write(content)
        return lp

    def test_stats统计轮换与冷却次数(self):
        """3 次轮换 + 2 次冷却 → 总数与每 key 计数正确"""
        g = inproc_setup(self.home, log_path=self._make_log(self.SAMPLE))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            g.do_stats()
        out = buf.getvalue()
        self.assertIn("总轮换次数: 3", out)
        self.assertIn('act1', out)
        self.assertIn("被切到 2", out)   # act1 被切到 2 次
        self.assertIn("进冷却 1", out)   # act1 进冷却 1 次
        self.assertIn("被切到 1", out)   # act2 被切到 1 次
        self.assertIn("2026-08-16 10:04:00", out)  # 最近切换时间

    def test_stats日志不存在退出1(self):
        """日志不存在 → SystemExit，提示「日志不存在」"""
        g = inproc_setup(self.home, log_path=os.path.join(self.home, "missing.log"))
        buf, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as cm:
                g.do_stats()
        # sys.exit(字符串) 时 code 为字符串；进程内被捕获后消息不落流（子进程级由
        # 「无配置时 status 干净报错」等用例覆盖 stderr + 退出码）
        self.assertIn("日志不存在", str(cm.exception.code))

    def test_stats无轮换记录提示(self):
        """只有冷却行无轮换行 → 打印「暂无轮换记录」"""
        g = inproc_setup(self.home, log_path=self._make_log(
            '[2026-08-16 10:00:00] key "act1" 配额耗尽\n'))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            g.do_stats()
        self.assertIn("暂无轮换记录", buf.getvalue())


# ---------- 8. add（进程内，monkeypatch probe_key 避免网络） ----------

class TestAdd(_CliCase):
    """add 命令（probe_key 打桩为 ok，避免真实网络）"""

    def setUp(self):
        super().setUp()
        self.g = inproc_setup(self.home)
        self.g.probe_key = lambda k: ("ok", "可用")

    def test_add新建key并写入配置(self):
        """add 合法 → 配置含新 key，JSON 合法，current 自动设为第一个 key"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.g.do_add(self.g.load() if os.path.exists(self.g.CONFIG_FILE) else
                          {"provider_id": "opencode-go", "cooldown_minutes": 300,
                           "current": "", "keys": []},
                          "act1", "sk-new-key-0001")
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current"], "act1")
        self.assertEqual(cfg["keys"][0]["key"], "sk-new-key-0001")

    def test_add已有配置追加不覆盖(self):
        """已有 act1 时 add act2 → act2 追加，act1 保留，current 不变"""
        write_cfg(self.home, [key("act1", "sk-a")], current="act1")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.g.do_add(read_cfg(self.home), "act2", "sk-b")
        cfg = read_cfg(self.home)
        self.assertEqual([k["name"] for k in cfg["keys"]], ["act1", "act2"])
        self.assertEqual(cfg["current"], "act1")

    def test_add重名拒绝(self):
        """add 重名 → SystemExit「already exists」（检查在探测之前，不发网络）"""
        write_cfg(self.home, [key("act1", "sk-a")], current="act1")
        with self.assertRaises(SystemExit) as cm:
            self.g.do_add(read_cfg(self.home), "act1", "sk-x")
        self.assertIn("already exists", str(cm.exception))

    def test_add探测在锁内执行(self):
        """源码结构：main() 中 add 经 _with_lock 包裹 → 网络探测期间持锁（设计观察，待裁决）"""
        src = open(CLI_PATH, encoding="utf-8").read()
        self.assertIn('_with_lock(lambda: do_add(load(), args[1], args[2]))', src)


# ---------- 9. init（进程内，monkeypatch probe_key + 模拟 stdin） ----------

class TestInit(_CliCase):
    """init 交互（打桩 probe_key + 替换 stdin，不真实输入）"""

    def setUp(self):
        super().setUp()
        self.g = inproc_setup(self.home)
        self.g.probe_key = lambda k: ("ok", "可用")

    def _run_init(self, text):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            with contextlib.redirect_stderr(io.StringIO()):
                old_stdin, sys.stdin = sys.stdin, io.StringIO(text)
                try:
                    self.g.do_init()
                finally:
                    sys.stdin = old_stdin
        return buf.getvalue()

    def test_init交互创建配置并同步auth(self):
        """init 输入 act1+key+回车 → 配置生成、current=act1、auth 同步"""
        out = self._run_init("act1\nsk-init-key-1\n\n")
        self.assertIn("配置完成", out)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current"], "act1")
        self.assertEqual(cfg["keys"][0]["name"], "act1")
        with open(auth_path(self.home)) as f:
            self.assertEqual(json.load(f)["opencode-go"]["key"], "sk-init-key-1")

    def test_init空输入不写配置(self):
        """init 直接回车 → 提示未添加任何 key，不写配置文件"""
        out = self._run_init("\n")
        self.assertIn("未添加任何 key", out)
        self.assertFalse(os.path.exists(cfg_path(self.home)))

    def test_init重名跳过(self):
        """init 重复输入同名 → 第二次被跳过，只保留 1 个 key"""
        out = self._run_init("act1\nsk-a\nact1\n\n")
        self.assertIn("已存在", out)
        self.assertEqual(len(read_cfg(self.home)["keys"]), 1)


# ---------- 10. uninstall（只测取消路径，不真删） ----------

class TestUninstall(_CliCase):
    """uninstall 只验证分发与取消路径（-y 会真删，危险，不测）"""

    def test_uninstall输入n取消不删除(self):
        """uninstall 输入 n → 已取消，CLI 文件仍在，退出 0"""
        r = run_cli(["uninstall"], self.home, stdin_text="n\n")
        self.assertEqual(r.returncode, 0)
        self.assertIn("已取消", r.stdout)
        self.assertTrue(os.path.exists(CLI_PATH), "取消后 CLI 不应被删除")

    def test_uninstall无输入默认取消(self):
        """uninstall 无 stdin（EOF）→ 默认取消"""
        r = run_cli(["uninstall"], self.home, stdin_text="")
        self.assertEqual(r.returncode, 0)
        self.assertIn("已取消", r.stdout)
        self.assertTrue(os.path.exists(CLI_PATH))


# ---------- 11. auth 同步 ----------

class TestAuthSync(_CliCase):
    """auth.json 同步行为"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home, [key("act1", "sk-act1-key-0001")], current="act1")

    def test_auth文件权限0600(self):
        """set 后 auth.json 存在且权限 0600"""
        run_cli(["set", "act1"], self.home)
        mode = os.stat(auth_path(self.home)).st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_auth保留其他provider(self):
        """auth.json 已有其他 provider → set 后保留，仅更新 opencode-go"""
        ap = auth_path(self.home)
        os.makedirs(os.path.dirname(ap), exist_ok=True)
        with open(ap, "w") as f:
            json.dump({"codeplan": {"type": "api", "key": "sk-other"}}, f)
        run_cli(["set", "act1"], self.home)
        with open(ap) as f:
            auth = json.load(f)
        self.assertEqual(auth["codeplan"]["key"], "sk-other")
        self.assertEqual(auth["opencode-go"]["key"], "sk-act1-key-0001")


# ---------- 12. gateway 双域独立轮换（current_gateway / cooldown_until_gateway） ----------

class TestGatewayDomain(_CliCase):
    """gateway {set|next|cooldown} 网关域独立轮换（不动 TUI 域字段）"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home,
                  [key("act1", "sk-act1-key-0001"),
                   key("act2", "sk-act2-key-0002"),
                   key("act3", "sk-act3-key-0003")],
                  current="act1")

    # ---- gateway set ----

    def test_gateway_set写current_gateway不动TUI且不同步auth(self):
        """gateway set act2 → current_gateway=act2，TUI current 不变，不写 auth.json（网关域轮换不碰 auth）"""
        r = run_cli(["gateway", "set", "act2"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('gateway switched to key "act2"', r.stdout)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current_gateway"], "act2")
        self.assertEqual(cfg["current"], "act1")
        self.assertFalse(os.path.exists(auth_path(self.home)),
                         "网关域 set 不得同步 auth.json")

    def test_gateway_set未知key退出1(self):
        """gateway set nope → 退出 1「not found」，current_gateway 不变"""
        run_cli(["gateway", "set", "act2"], self.home)
        r = run_cli(["gateway", "set", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)
        self.assertEqual(read_cfg(self.home)["current_gateway"], "act2")

    def test_gateway_set缺参数退出1(self):
        """gateway set（无 name）→ 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["gateway", "set"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)

    # ---- gateway next ----

    def test_gateway_next独立轮换不动TUI域(self):
        """网关 current=act2 → next → current_gateway=act3；原网关 current(act2) 进网关域冷却；
        TUI current/cooldown_until 不动（act1 的 TUI 冷却不影响网关域选择）"""
        run_cli(["gateway", "set", "act2"], self.home)
        tui_act1_cd = fut_iso(999)  # TUI 域 act1 冷却，不应被网关域读取
        cfg = read_cfg(self.home)
        cfg["keys"][0]["cooldown_until"] = tui_act1_cd
        with open(cfg_path(self.home), "w") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        r = run_cli(["gateway", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('gateway rotated to key "act3"', r.stdout)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_gateway"], "act3")
        # 原网关 current(act2) 进网关域冷却
        self.assertIsNotNone(out_cfg["keys"][1]["cooldown_until_gateway"])
        # TUI 域字段完全不动
        self.assertEqual(out_cfg["current"], "act1")
        self.assertEqual(out_cfg["keys"][0]["cooldown_until"], tui_act1_cd)
        self.assertIsNone(out_cfg["keys"][0].get("cooldown_until_gateway"),
                          "act1 未被网关域冷却，其网关域冷却字段应为空")

    def test_gateway_next带分钟参数冷却原网关current(self):
        """gateway next 10 → 原网关 current 冷却 10min（minutes 覆盖），选下一个"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_gateway": "act1"})
        r = run_cli(["gateway", "next", "10"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_gateway"], "act2")
        assert_cooldown_until_near(self, out_cfg["keys"][0]["cooldown_until_gateway"], 10)

    def test_gateway_next跳过网关域冷却的key(self):
        """网关域内冷却 act2 → next 跳过 act2 到 act3；TUI 域 act1 的 cooldown_until 不被读取"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until=fut_iso(999)),
                   key("act2", "sk-b", cooldown_until_gateway=fut_iso(60)),
                   key("act3", "sk-c")],
                  current="act1", extra={"current_gateway": "act1"})
        r = run_cli(["gateway", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_gateway"], "act3")
        self.assertEqual(out_cfg["current"], "act1")
        self.assertIsNotNone(out_cfg["keys"][0].get("cooldown_until"), "TUI 冷却保留")
        self.assertIsNotNone(out_cfg["keys"][1].get("cooldown_until_gateway"), "act2 网关域冷却保留")

    def test_gateway_next全部冷却保持网关当前(self):
        """全部网关域冷却 → 「no available key」，current_gateway 不变"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until_gateway=fut_iso(60)),
                   key("act2", "sk-b", cooldown_until_gateway=fut_iso(60))],
                  current="act1", extra={"current_gateway": "act1"})
        r = run_cli(["gateway", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("no available key", r.stdout)
        self.assertEqual(read_cfg(self.home)["current_gateway"], "act1")

    def test_gateway_next迁移兜底从current起(self):
        """无 current_gateway 字段 → 网关 next 以 current 为起点轮换并写 current_gateway（读侧兜底）"""
        write_cfg(self.home, [key("act1", "sk-a"), key("act2", "sk-b")], current="act1")  # 无 current_gateway
        r = run_cli(["gateway", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_gateway"], "act2")
        self.assertEqual(out_cfg["current"], "act1")
        self.assertIsNotNone(out_cfg["keys"][0].get("cooldown_until_gateway"),
                             "原网关 current(=current act1) 应进网关域冷却")

    def test_gateway_next非法分钟值退出1(self):
        """gateway next abc → 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["gateway", "next", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("分钟", r.stdout + r.stderr)

    # ---- gateway cooldown ----

    def test_gateway_cooldown写网关域字段不动TUI(self):
        """gateway cooldown act1 60 → cooldown_until_gateway≈now+60，TUI cooldown_until 不动"""
        r = run_cli(["gateway", "cooldown", "act1", "60"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('gateway key "act1" cooling for 60 min', r.stdout)
        cfg = read_cfg(self.home)
        assert_cooldown_until_near(self, cfg["keys"][0]["cooldown_until_gateway"], 60)
        self.assertIsNone(cfg["keys"][0].get("cooldown_until"), "TUI 域 cooldown_until 不应被写")

    def test_gateway_cooldown无参用全局窗口(self):
        """gateway cooldown act1（无参）→ 用全局 300min"""
        r = run_cli(["gateway", "cooldown", "act1"], self.home)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until_gateway"], 300)

    def test_gateway_cooldown无参优先key独立窗口(self):
        """key 有 cooldown_minutes=30 → 无参网关冷却用 30min"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_minutes=30)], current="act1")
        run_cli(["gateway", "cooldown", "act1"], self.home)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until_gateway"], 30)

    def test_gateway_cooldown_clear清除(self):
        """gateway cooldown act1 clear → cooldown_until_gateway 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until_gateway=fut_iso(60))], current="act1")
        r = run_cli(["gateway", "cooldown", "act1", "clear"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until_gateway"])

    def test_gateway_cooldown_0清除(self):
        """gateway cooldown act1 0 → cooldown_until_gateway 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until_gateway=fut_iso(60))], current="act1")
        run_cli(["gateway", "cooldown", "act1", "0"], self.home)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until_gateway"])

    def test_gateway_cooldown未知key退出1(self):
        """gateway cooldown nope → 退出 1「not found」"""
        r = run_cli(["gateway", "cooldown", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)

    def test_gateway_cooldown非法分钟值退出1(self):
        """gateway cooldown act1 abc → 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["gateway", "cooldown", "act1", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)

    def test_gateway_cooldown缺参数退出1(self):
        """gateway cooldown（无 name）→ 退出 1"""
        r = run_cli(["gateway", "cooldown"], self.home)
        self.assertEqual(r.returncode, 1)

    # ---- status 双域 ----

    def test_status输出TUI与网关当前双域(self):
        """status 含 zen 当前 / 网关当前 双域行（各自独立游标）"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_gateway": "act2"})
        r = run_cli(["status"], self.home)
        self.assertIn("zen 当前: act1", r.stdout)
        self.assertIn("网关当前: act2", r.stdout)

    def test_status网关当前迁移兜底(self):
        """无 current_gateway → 网关当前显示 current（读侧兜底）"""
        r = run_cli(["status"], self.home)  # current=act1, 无 current_gateway
        self.assertIn("zen 当前: act1", r.stdout)
        self.assertIn("网关当前: act1", r.stdout)

    def test_status当前key冷却剩余可选展示(self):
        """网关当前 key 有冷却 → 双域行带冷却后缀"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until_gateway=fut_iso(30))],
                  current="act1", extra={"current_gateway": "act1"})
        r = run_cli(["status"], self.home)
        self.assertIn("网关当前: act1", r.stdout)
        self.assertIn("cooling", r.stdout)

    # ---- 锁 / 残留 ----

    def test_gateway写命令后无锁无tmp残留(self):
        """gateway set/next/cooldown 后锁文件已清、无 tmp 残留"""
        run_cli(["gateway", "set", "act2"], self.home)
        run_cli(["gateway", "next"], self.home)
        run_cli(["gateway", "cooldown", "act1", "10"], self.home)
        d = os.path.dirname(cfg_path(self.home))
        for f in os.listdir(d):
            self.assertFalse(f.endswith(".lock") or f.endswith(".tmp"), f"不应残留 {f}")

    def test_gateway写命令走锁(self):
        """源码结构：main() 中 gateway set/next/cooldown 经 _with_lock 包裹（写 go-keys.json）"""
        src = open(CLI_PATH, encoding="utf-8").read()
        self.assertIn('if sub in ("start", "stop", "restart", "set", "next", "cooldown"):', src)
        self.assertIn("_with_lock(lambda: do_gateway(sub, args[2:]))", src)

    def test_tui写命令不动网关域字段(self):
        """TUI 域 set/next/cooldown 只动 current/cooldown_until，不写 current_gateway/cooldown_until_gateway"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_gateway": "act2"})
        run_cli(["set", "act2"], self.home)          # TUI set
        run_cli(["cooldown", "act1", "60"], self.home)  # TUI cooldown
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current_gateway"], "act2")        # 网关域游标不动
        self.assertIsNone(cfg["keys"][0].get("cooldown_until_gateway"))  # 网关域冷却不动


# ---------- 13. go 套餐域独立轮换（current_go / cooldown_until_go，三域之一） ----------

class TestGoDomain(_CliCase):
    """go {set|next|cooldown} go 套餐域独立轮换（不动 zen 域 current/cooldown_until 与网关域；不写 auth.json）"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home,
                  [key("act1", "sk-act1-key-0001"),
                   key("act2", "sk-act2-key-0002"),
                   key("act3", "sk-act3-key-0003")],
                  current="act1")

    # ---- go set ----

    def test_go_set写current_go不动Zen且不同步auth(self):
        """go set act2 → current_go=act2，zen current 不变，不写 auth.json"""
        r = run_cli(["go", "set", "act2"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('go switched to key "act2"', r.stdout)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current_go"], "act2")
        self.assertEqual(cfg["current"], "act1")
        self.assertFalse(os.path.exists(auth_path(self.home)),
                         "go 域 set 不得同步 auth.json")

    def test_go_set未知key退出1(self):
        """go set nope → 退出 1「not found」，current_go 不变"""
        run_cli(["go", "set", "act2"], self.home)
        r = run_cli(["go", "set", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)
        self.assertEqual(read_cfg(self.home)["current_go"], "act2")

    def test_go_set缺参数退出1(self):
        """go set（无 name）→ 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["go", "set"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)

    # ---- go next ----

    def test_go_next独立轮换不动Zen域(self):
        """go current=act2 → next → current_go=act3；原 go current(act2) 进 go 域冷却；
        zen current/cooldown_until 不动（act1 的 zen 冷却不影响 go 域选择）"""
        run_cli(["go", "set", "act2"], self.home)
        zen_act1_cd = fut_iso(999)  # zen 域 act1 冷却，不应被 go 域读取
        cfg = read_cfg(self.home)
        cfg["keys"][0]["cooldown_until"] = zen_act1_cd
        with open(cfg_path(self.home), "w") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        r = run_cli(["go", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('go rotated to key "act3"', r.stdout)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_go"], "act3")
        self.assertIsNotNone(out_cfg["keys"][1]["cooldown_until_go"])  # 原 go current(act2) 进 go 域冷却
        # zen 域字段完全不动
        self.assertEqual(out_cfg["current"], "act1")
        self.assertEqual(out_cfg["keys"][0]["cooldown_until"], zen_act1_cd)
        self.assertIsNone(out_cfg["keys"][0].get("cooldown_until_go"),
                          "act1 未被 go 域冷却，其 cooldown_until_go 应为空")

    def test_go_next带分钟参数冷却原go当前(self):
        """go next 10 → 原 go current 冷却 10min（minutes 覆盖），选下一个"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_go": "act1"})
        r = run_cli(["go", "next", "10"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_go"], "act2")
        assert_cooldown_until_near(self, out_cfg["keys"][0]["cooldown_until_go"], 10)

    def test_go_next跳过go域冷却的key(self):
        """go 域内冷却 act2 → next 跳过 act2 到 act3；zen 域 act1 的 cooldown_until 不被读取"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until=fut_iso(999)),
                   key("act2", "sk-b", cooldown_until_go=fut_iso(60)),
                   key("act3", "sk-c")],
                  current="act1", extra={"current_go": "act1"})
        r = run_cli(["go", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_go"], "act3")
        self.assertEqual(out_cfg["current"], "act1")
        self.assertIsNotNone(out_cfg["keys"][0].get("cooldown_until"), "zen 冷却保留")
        self.assertIsNotNone(out_cfg["keys"][1].get("cooldown_until_go"), "act2 go 域冷却保留")

    def test_go_next全部冷却保持go当前(self):
        """全部 go 域冷却 →「no available key」，current_go 不变"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until_go=fut_iso(60)),
                   key("act2", "sk-b", cooldown_until_go=fut_iso(60))],
                  current="act1", extra={"current_go": "act1"})
        r = run_cli(["go", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn("no available key", r.stdout)
        self.assertEqual(read_cfg(self.home)["current_go"], "act1")

    def test_go_next迁移兜底从current起(self):
        """无 current_go 字段 → go next 以 current 为起点轮换并写 current_go（读侧兜底）"""
        write_cfg(self.home, [key("act1", "sk-a"), key("act2", "sk-b")], current="act1")  # 无 current_go
        r = run_cli(["go", "next"], self.home)
        self.assertEqual(r.returncode, 0)
        out_cfg = read_cfg(self.home)
        self.assertEqual(out_cfg["current_go"], "act2")
        self.assertEqual(out_cfg["current"], "act1")
        self.assertIsNotNone(out_cfg["keys"][0].get("cooldown_until_go"),
                             "原 go current(=current act1) 应进 go 域冷却")

    def test_go_next非法分钟值退出1(self):
        """go next abc → 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["go", "next", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("分钟", r.stdout + r.stderr)

    # ---- go cooldown ----

    def test_go_cooldown写go域字段不动Zen(self):
        """go cooldown act1 60 → cooldown_until_go≈now+60，zen cooldown_until 不动"""
        r = run_cli(["go", "cooldown", "act1", "60"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIn('go key "act1" cooling for 60 min', r.stdout)
        cfg = read_cfg(self.home)
        assert_cooldown_until_near(self, cfg["keys"][0]["cooldown_until_go"], 60)
        self.assertIsNone(cfg["keys"][0].get("cooldown_until"), "zen 域 cooldown_until 不应被写")

    def test_go_cooldown无参用全局窗口(self):
        """go cooldown act1（无参）→ 用全局 300min"""
        r = run_cli(["go", "cooldown", "act1"], self.home)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until_go"], 300)

    def test_go_cooldown无参优先key独立窗口(self):
        """key 有 cooldown_minutes=30 → 无参 go 冷却用 30min"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_minutes=30)], current="act1")
        run_cli(["go", "cooldown", "act1"], self.home)
        assert_cooldown_until_near(self, read_cfg(self.home)["keys"][0]["cooldown_until_go"], 30)

    def test_go_cooldown_clear清除(self):
        """go cooldown act1 clear → cooldown_until_go 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until_go=fut_iso(60))], current="act1")
        r = run_cli(["go", "cooldown", "act1", "clear"], self.home)
        self.assertEqual(r.returncode, 0)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until_go"])

    def test_go_cooldown_0清除(self):
        """go cooldown act1 0 → cooldown_until_go 置 null"""
        write_cfg(self.home, [key("act1", "sk-a", cooldown_until_go=fut_iso(60))], current="act1")
        run_cli(["go", "cooldown", "act1", "0"], self.home)
        self.assertIsNone(read_cfg(self.home)["keys"][0]["cooldown_until_go"])

    def test_go_cooldown未知key退出1(self):
        """go cooldown nope → 退出 1「not found」"""
        r = run_cli(["go", "cooldown", "nope"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stdout + r.stderr)

    def test_go_cooldown非法分钟值退出1(self):
        """go cooldown act1 abc → 退出 1，干净用法提示，无 traceback"""
        r = run_cli(["go", "cooldown", "act1", "abc"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)

    def test_go_cooldown缺参数退出1(self):
        """go cooldown（无 name）→ 退出 1"""
        r = run_cli(["go", "cooldown"], self.home)
        self.assertEqual(r.returncode, 1)

    # ---- status 三域 ----

    def test_status输出三域当前(self):
        """status 含 zen 当前 / go 当前 / 网关当前 三域行（各自独立游标）"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b"), key("act3", "sk-c")],
                  current="act1", extra={"current_go": "act2", "current_gateway": "act3"})
        r = run_cli(["status"], self.home)
        self.assertIn("zen 当前: act1", r.stdout)
        self.assertIn("go 当前: act2", r.stdout)
        self.assertIn("网关当前: act3", r.stdout)

    def test_status_go迁移兜底(self):
        """无 current_go → go 当前显示 current（读侧兜底）"""
        r = run_cli(["status"], self.home)  # current=act1, 无 current_go
        self.assertIn("zen 当前: act1", r.stdout)
        self.assertIn("go 当前: act1", r.stdout)

    def test_status每域冷却key摘要(self):
        """三域各有冷却 key → 冷却摘要行列出对应 key"""
        write_cfg(self.home,
                  [key("act1", "sk-a", cooldown_until=fut_iso(30),
                       cooldown_until_gateway=fut_iso(30)),
                   key("act2", "sk-b"),
                   key("act3", "sk-c", cooldown_until_go=fut_iso(30))],
                  current="act1", extra={"current_go": "act3", "current_gateway": "act1"})
        r = run_cli(["status"], self.home)
        out = r.stdout
        self.assertIn("zen 冷却中: act1", out)
        self.assertIn("go 冷却中: act3", out)
        self.assertIn("网关 冷却中: act1", out)

    # ---- 锁 / 残留 / 域隔离 ----

    def test_go写命令后无锁无tmp残留(self):
        """go set/next/cooldown 后锁文件已清、无 tmp 残留"""
        run_cli(["go", "set", "act2"], self.home)
        run_cli(["go", "next"], self.home)
        run_cli(["go", "cooldown", "act1", "10"], self.home)
        d = os.path.dirname(cfg_path(self.home))
        for f in os.listdir(d):
            self.assertFalse(f.endswith(".lock") or f.endswith(".tmp"), f"不应残留 {f}")

    def test_go写命令走锁(self):
        """源码结构：main() 中 go set/next/cooldown 经 _with_lock 包裹（写 go-keys.json）"""
        src = open(CLI_PATH, encoding="utf-8").read()
        self.assertIn('if sub in ("set", "next", "cooldown"):', src)
        self.assertIn("_with_lock(lambda: do_go(sub, args[2:]))", src)

    def test_zen写命令不动go域字段(self):
        """zen 域 set/next/cooldown 只动 current/cooldown_until，不写 current_go/cooldown_until_go"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_go": "act2"})
        run_cli(["set", "act2"], self.home)               # zen set
        run_cli(["cooldown", "act1", "60"], self.home)    # zen cooldown
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current_go"], "act2")                   # go 域游标不动
        self.assertIsNone(cfg["keys"][0].get("cooldown_until_go"))    # go 域冷却不动

    def test_go写命令不动网关域字段(self):
        """go 域 set/next/cooldown 不写 current_gateway/cooldown_until_gateway"""
        write_cfg(self.home,
                  [key("act1", "sk-a"), key("act2", "sk-b")],
                  current="act1", extra={"current_gateway": "act2"})
        run_cli(["go", "set", "act1"], self.home)
        run_cli(["go", "cooldown", "act1", "60"], self.home)
        cfg = read_cfg(self.home)
        self.assertEqual(cfg["current_gateway"], "act2")
        self.assertIsNone(cfg["keys"][0].get("cooldown_until_gateway"))


# ---------- 14. check 双端点健康检查（zen + go，双行输出 + 字段写入） ----------

class _BadKeyHandler(http.server.BaseHTTPRequestHandler):
    """mock OpenAI-compatible 探测端点：Authorization 含 sk-bad → 401 invalid；其它 → 200 ok。
    记录收到的 Authorization，供断言单端点/双端点路径。"""
    seen_auths = []

    def do_POST(self):
        auth = self.headers.get("Authorization", "")
        type(self).seen_auths.append(auth)
        if "sk-bad" in auth:
            body = json.dumps({"error": {"message": "invalid api key"}}).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps({"id": "mock", "object": "chat.completion", "model": "hy3",
                           "choices": [{"message": {"role": "assistant", "content": "ok"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@contextlib.contextmanager
def _mock_probe_server():
    """起一个 mock 探测服务器，yield (base_url, reset_seen)。"""
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _BadKeyHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    _BadKeyHandler.seen_auths[:] = []
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}", (lambda: _BadKeyHandler.seen_auths[:])
    finally:
        httpd.shutdown()
        httpd.server_close()


class TestCheckDualEndpoint(_CliCase):
    """check 双端点健康检查（默认 zen+go 双探测；--plan 单端点；字段写入 + 探测时间）"""

    def setUp(self):
        super().setUp()
        write_cfg(self.home, [key("act1", "sk-ok-key-0001"), key("act2", "sk-bad-key-0002")], current="act1")

    def test_check默认双端点输出两行并写字段(self):
        """check（双端点）→ 每 key 输出 zen/go 两行；act1(ok key) 双 ok，act2(bad key) zen ok / go invalid；
        写 last_status/last_status_go + last_checked_zen/last_checked_go"""
        with _mock_probe_server() as (base, _):
            extra = {"GOROTATE_ZEN_BASE": base, "GOROTATE_GO_BASE": base}
            r = run_cli(["check"], self.home, extra_env=extra)
        self.assertEqual(r.returncode, 0)
        out = r.stdout
        self.assertIn("act1", out)
        self.assertIn("[zen] ✅ 可用", out)
        self.assertIn("[go] ✅ 可用", out)
        self.assertIn("[zen] ⚠️  key 无效", out)   # act2 的 zen 探测（sk-bad）→ 401 invalid
        self.assertIn("[go] ⚠️  key 无效", out)    # act2 的 go 探测 → 401 invalid
        cfg = read_cfg(self.home)
        act1 = next(k for k in cfg["keys"] if k["name"] == "act1")
        self.assertEqual(act1["last_status"], "ok")
        self.assertEqual(act1["last_status_go"], "ok")
        self.assertIn("last_checked_zen", act1)
        self.assertIn("last_checked_go", act1)
        act2 = next(k for k in cfg["keys"] if k["name"] == "act2")
        self.assertEqual(act2["last_status"], "invalid")
        self.assertEqual(act2["last_status_go"], "invalid")

    def test_check单端点plan_go只写go域字段(self):
        """check --plan go → 每 key 只输出 go 一行；只写 last_status_go/last_checked_go，zen last_status 不动"""
        before = read_cfg(self.home)
        before["keys"][0]["last_status"] = "ok"   # 预置 zen 状态，验证 check --plan go 不改它
        with open(cfg_path(self.home), "w") as f:
            json.dump(before, f, ensure_ascii=False, indent=2)
        with _mock_probe_server() as (base, _):
            r = run_cli(["check", "--plan", "go"], self.home,
                        extra_env={"GOROTATE_ZEN_BASE": base, "GOROTATE_GO_BASE": base})
        self.assertEqual(r.returncode, 0)
        out = r.stdout
        self.assertNotIn("[zen]", out)
        self.assertIn("[go] ✅ 可用", out)
        cfg = read_cfg(self.home)
        act1 = next(k for k in cfg["keys"] if k["name"] == "act1")
        self.assertEqual(act1["last_status"], "ok")        # zen 状态不动
        self.assertEqual(act1["last_status_go"], "ok")
        self.assertIn("last_checked_go", act1)
        self.assertNotIn("last_checked_zen", act1)

    def test_check指定key名(self):
        """check act2 --plan zen → 只探测 act2 的 zen 端点"""
        with _mock_probe_server() as (base, seen):
            run_cli(["check", "act2", "--plan", "zen"], self.home,
                    extra_env={"GOROTATE_ZEN_BASE": base, "GOROTATE_GO_BASE": base})
            auths = seen()
        self.assertEqual(len(auths), 1, "仅应 1 次 zen 探测")
        self.assertIn("sk-bad-key-0002", auths[0])
        cfg = read_cfg(self.home)
        self.assertEqual(next(k for k in cfg["keys"] if k["name"] == "act2")["last_status"], "invalid")
        self.assertEqual(next(k for k in cfg["keys"] if k["name"] == "act1").get("last_status"), None)

    def test_check非法plan退出1(self):
        """check --plan xxx → 退出 1 用法提示，无 traceback"""
        r = run_cli(["check", "--plan", "xxx"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn("用法", r.stdout + r.stderr)

    def test_check未知选项退出1(self):
        """check --bogus → 退出 1 用法提示"""
        r = run_cli(["check", "--bogus"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("用法", r.stdout + r.stderr)

    def test_check无key可检测退出1(self):
        """配置无 key → 退出 1「没有可检测的 key」"""
        write_cfg(self.home, [], current="")
        r = run_cli(["check"], self.home)
        self.assertEqual(r.returncode, 1)
        self.assertIn("没有可检测的 key", r.stdout + r.stderr)

    def test_check写字段走锁(self):
        """源码结构：main() 中 check 经 _with_lock 包裹（写 go-keys.json 健康字段）"""
        src = open(CLI_PATH, encoding="utf-8").read()
        self.assertIn("_with_lock(lambda: do_check(load(), args[1:]))", src)


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