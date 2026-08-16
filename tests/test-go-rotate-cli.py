#!/usr/bin/env python3
"""go-rotate CLI 零依赖单元测试（仅 Python 标准库）。

运行：python3 tests/test-go-rotate-cli.py
策略：
  - 绝大多数用例用 subprocess 跑真实 CLI，env 覆盖 HOME 为临时目录 → 最贴近真实，覆盖参数解析/退出码。
  - 需要网络（probe_key）或读写全局日志的用例（add/init/stats）用 importlib 进程内加载 + monkeypatch。
  - 绝不触碰真实 ~/.config/opencode/go-keys.json / auth.json / 8899 / /tmp/opencode-go-rotate.log。
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI_PATH = os.path.join(ROOT, "go-rotate")


# ---------- 公共工具 ----------

def run_cli(args, home, stdin_text=None, timeout=90):
    """在临时 HOME 下跑真实 CLI。"""
    env = dict(os.environ)
    env["HOME"] = home
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


def key(name, val, cooldown_until=None, cooldown_minutes=None, last_status=None):
    k = {"name": name, "key": val, "cooldown_until": cooldown_until}
    if cooldown_minutes is not None:
        k["cooldown_minutes"] = cooldown_minutes
    if last_status is not None:
        k["last_status"] = last_status
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