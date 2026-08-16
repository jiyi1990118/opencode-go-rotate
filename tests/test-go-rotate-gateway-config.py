#!/usr/bin/env python3
"""go-rotate CLI gateway plan/token（gateway-config.json）零依赖单元测试（仅 Python 标准库）。

运行：python3 tests/test-go-rotate-gateway-config.py
覆盖：gateway plan [go|zen] 读写、gateway token gen|clear|set 读写、掩码无明文、
      非法值拒绝、写操作持 _with_lock / 只读不锁、GOROTATE_GATEWAY_CONFIG 隔离、
      损坏配置容错、扩展字段保留、原子写无 .tmp 残留、0600 权限。
隔离红线：
  - subprocess：HOME 指向临时目录 + GOROTATE_GATEWAY_CONFIG 指向临时 gateway-config.json。
  - 进程内：模块加载后把 GATEWAY_CONFIG/CONFIG_FILE/LOCK_FILE 重指临时路径。
  - 绝不触碰真实 ~/.config/opencode/go-keys.json / auth.json / ~/.local/share/zen-gateway/gateway-config.json。
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI_PATH = os.path.join(ROOT, "go-rotate")


# ---------- 公共工具 ----------

def run_cli(args, home, gw_cfg=None, extra_env=None, timeout=60):
    """临时 HOME 下跑真实 CLI；gw_cfg 注入 GOROTATE_GATEWAY_CONFIG（默认指向临时 HOME 内默认路径）。"""
    env = dict(os.environ)
    env["HOME"] = home
    if gw_cfg:
        env["GOROTATE_GATEWAY_CONFIG"] = gw_cfg
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, CLI_PATH] + args,
        env=env, capture_output=True, text=True, timeout=timeout,
    )


def gw_path(home, custom=None):
    """gateway-config.json 路径：custom 给非默认路径（验证 env 覆盖）。"""
    if custom:
        return os.path.join(home, custom)
    return os.path.join(home, ".local", "share", "zen-gateway", "gateway-config.json")


def write_gw(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def read_gw(path):
    with open(path) as f:
        return json.load(f)


def _load_module():
    """进程内加载 go-rotate（HOME 指向临时目录避免模块级常量固化真实路径）。"""
    loader = importlib.machinery.SourceFileLoader("grotate_gw_cfg_cli", CLI_PATH)
    spec = importlib.util.spec_from_loader("grotate_gw_cfg_cli", loader)
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
    return m


def inproc(home):
    """模块全局重指临时 HOME + 临时 GATEWAY_CONFIG，返回模块（防用例间污染）。"""
    g = _load_module()
    g.DATA_DIR = os.path.join(home, ".config", "opencode")
    g.CONFIG_FILE = os.path.join(g.DATA_DIR, "go-keys.json")
    g.LOCK_FILE = g.CONFIG_FILE + ".lock"
    g.AUTH_FILE = os.path.join(home, ".local", "share", "opencode", "auth.json")
    g.GATEWAY_CONFIG = gw_path(home)
    return g


def run_main(g, args):
    """monkeypatch sys.argv 跑 g.main()（隔离环境，写路径只落临时配置；吞 stdout 保持测试输出干净）。"""
    old = sys.argv
    sys.argv = ["go-rotate"] + args
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            g.main()
    finally:
        sys.argv = old


class GwCfgCase(unittest.TestCase):
    """每个用例独立临时 HOME。"""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="gorotate-gwcfg-")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def capture(self, fn):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fn()
        return buf.getvalue()


# ---------- 1. plan（subprocess，GOROTATE_GATEWAY_CONFIG 隔离） ----------

class TestPlanSubprocess(GwCfgCase):

    def test_plan无参配置缺失显示默认go且不写文件(self):
        """配置缺失 → 显示默认 go + 提示；只读不创建文件"""
        p = gw_path(self.home)
        r = run_cli(["gateway", "plan"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        self.assertIn("当前套餐: go", r.stdout)
        self.assertIn("配置文件不存在", r.stdout)
        self.assertFalse(os.path.exists(p), "只读操作不应创建 gateway-config.json")

    def test_plan无参已写zen显示zen(self):
        p = gw_path(self.home)
        write_gw(p, {"plan": "zen", "token": None})
        r = run_cli(["gateway", "plan"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        self.assertIn("当前套餐: zen", r.stdout)

    def test_plan切换go写配置提示重启(self):
        """plan go → 原子写 plan=go + 重启提示"""
        p = gw_path(self.home)
        r = run_cli(["gateway", "plan", "go"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        self.assertIn("套餐已改为 go", r.stdout)
        self.assertIn("go-rotate gateway restart", r.stdout)
        cfg = read_gw(p)
        self.assertEqual(cfg["plan"], "go")

    def test_plan切换zen写配置(self):
        p = gw_path(self.home)
        r = run_cli(["gateway", "plan", "zen"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        self.assertIn("套餐已改为 zen", r.stdout)
        self.assertEqual(read_gw(p)["plan"], "zen")

    def test_plan非法套餐拒绝不写文件(self):
        p = gw_path(self.home)
        r = run_cli(["gateway", "plan", "foo"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 1)
        self.assertIn("非法套餐", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(p), "非法套餐不应写文件")

    def test_plan写后0600权限且无tmp残留(self):
        p = gw_path(self.home)
        run_cli(["gateway", "plan", "go"], self.home, gw_cfg=p)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600, "凭据文件应为 0600")
        self.assertFalse(os.path.exists(p + ".tmp"), "原子写不应残留 .tmp")

    def test_env覆盖非默认路径(self):
        """GOROTATE_GATEWAY_CONFIG 指向非默认路径 → 写到那里，默认路径不产生"""
        custom = gw_path(self.home, "custom-gw-config.json")
        default = gw_path(self.home)
        r = run_cli(["gateway", "plan", "zen"], self.home, gw_cfg=custom)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(os.path.exists(custom), "应写到 env 指定路径")
        self.assertEqual(read_gw(custom)["plan"], "zen")
        self.assertFalse(os.path.exists(default), "默认路径不应被写")


# ---------- 2. token（subprocess） ----------

class TestTokenSubprocess(GwCfgCase):

    def test_token无参未设置提示(self):
        p = gw_path(self.home)
        r = run_cli(["gateway", "token"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        self.assertIn("未设置", r.stdout)
        self.assertIn("鉴权关闭", r.stdout)

    def test_tokengen写64hex掩码无明文(self):
        """gen → 配置 token 为 64-hex + token_set_at；stdout 只含掩码，绝无明文"""
        p = gw_path(self.home)
        r = run_cli(["gateway", "token", "gen"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        cfg = read_gw(p)
        self.assertRegex(cfg["token"], r"^[0-9a-f]{64}$", "token 应为 64-hex")
        self.assertTrue(cfg["token_set_at"], "应记录 token_set_at")
        # 掩码断言：前4****后4（64 长）
        self.assertIn(f"{cfg['token'][:4]}****{cfg['token'][-4:]}", r.stdout)
        # 无明文红线：stdout 不应包含完整 token 或其主体段
        self.assertNotIn(cfg["token"], r.stdout, "stdout 不得泄漏完整 token")
        self.assertIn("完整 token 已写入", r.stdout)
        self.assertIn("go-rotate gateway restart", r.stdout)

    def test_tokenset写指定值(self):
        p = gw_path(self.home)
        val = "my-secret-token-1234567890abcdef"
        r = run_cli(["gateway", "token", "set", val], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        cfg = read_gw(p)
        self.assertEqual(cfg["token"], val)
        self.assertTrue(cfg["token_set_at"])
        self.assertIn(f"{val[:4]}****{val[-4:]}", r.stdout)
        self.assertNotIn(val, r.stdout, "set 只打印掩码")

    def test_tokenset空值拒绝(self):
        p = gw_path(self.home)
        r = run_cli(["gateway", "token", "set"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 1)
        self.assertIn("token set <value>", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(p), "空值不应写文件")

    def test_tokenclear清除回退无鉴权(self):
        p = gw_path(self.home)
        write_gw(p, {"plan": "zen", "token": "old-token-value", "token_set_at": "t"})
        r = run_cli(["gateway", "token", "clear"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        cfg = read_gw(p)
        self.assertIsNone(cfg["token"], "clear 应删除 token（回退无鉴权）")
        self.assertIsNone(cfg["token_set_at"])
        self.assertEqual(cfg["plan"], "zen", "clear 不应动 plan")
        self.assertIn("已清除网关 token", r.stdout)

    def test_tokengen覆盖旧值(self):
        p = gw_path(self.home)
        write_gw(p, {"plan": "go", "token": "old-token", "token_set_at": "t0"})
        r = run_cli(["gateway", "token", "gen"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 0)
        cfg = read_gw(p)
        self.assertNotEqual(cfg["token"], "old-token", "gen 应覆盖旧 token")
        self.assertNotEqual(cfg["token_set_at"], "t0")

    def test_token未知操作拒绝(self):
        p = gw_path(self.home)
        r = run_cli(["gateway", "token", "frobnicate"], self.home, gw_cfg=p)
        self.assertEqual(r.returncode, 1)
        self.assertIn("未知 token 操作", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(p), "未知操作不应写文件")

    def test_plan写不丢token_token写不丢plan(self):
        """往返一致性：plan 写只动 plan，token 写只动 token"""
        p = gw_path(self.home)
        run_cli(["gateway", "token", "set", "keep-me"], self.home, gw_cfg=p)
        run_cli(["gateway", "plan", "zen"], self.home, gw_cfg=p)
        cfg = read_gw(p)
        self.assertEqual(cfg["plan"], "zen")
        self.assertEqual(cfg["token"], "keep-me", "plan 写不应动 token")
        run_cli(["gateway", "token", "clear"], self.home, gw_cfg=p)
        cfg = read_gw(p)
        self.assertEqual(cfg["plan"], "zen", "token 写不应动 plan")
        self.assertIsNone(cfg["token"])


# ---------- 3. 进程内：持锁 / 容错 / 扩展字段 ----------

class TestPlanTokenInProc(GwCfgCase):

    def setUp(self):
        super().setUp()
        self.g = inproc(self.home)

    def test_main分发写操作持锁只读不锁(self):
        """plan go|zen / token gen|clear|set 走 _with_lock；plan/token 无参不锁"""
        locked = []
        orig = self.g._with_lock

        def recorder(fn):
            locked.append(fn)
            return orig(fn)
        self.g._with_lock = recorder

        # 写操作 → 持锁
        run_main(self.g, ["gateway", "plan", "go"])
        self.assertEqual(len(locked), 1, "plan go 应持锁")
        run_main(self.g, ["gateway", "token", "gen"])
        self.assertEqual(len(locked), 2, "token gen 应持锁")
        run_main(self.g, ["gateway", "token", "clear"])
        self.assertEqual(len(locked), 3, "token clear 应持锁")
        run_main(self.g, ["gateway", "token", "set", "v"])
        self.assertEqual(len(locked), 4, "token set 应持锁")
        # 只读 → 不锁
        run_main(self.g, ["gateway", "plan"])
        run_main(self.g, ["gateway", "token"])
        self.assertEqual(len(locked), 4, "只读操作不应持锁")

    def test_写操作后锁文件清理无残留(self):
        run_main(self.g, ["gateway", "plan", "zen"])
        self.assertFalse(os.path.exists(self.g.LOCK_FILE), "写后锁文件应清理")

    def test_损坏配置容错回退默认(self):
        p = self.g.GATEWAY_CONFIG
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write("{broken json!!")
        cfg = self.g._gateway_config()
        self.assertEqual(cfg["plan"], "go")
        self.assertIsNone(cfg["token"])
        out = self.capture(lambda: self.g._gateway_plan(None))
        self.assertIn("当前套餐: go", out)
        out2 = self.capture(lambda: self.g._gateway_token(None))
        self.assertIn("未设置", out2)
        # 非 dict 顶层也容错
        write_gw(p, ["not", "a", "dict"])
        self.assertEqual(self.g._gateway_config()["plan"], "go")

    def test_扩展字段保留(self):
        """写 plan/token 不丢未来新增字段（向后兼容）"""
        p = self.g.GATEWAY_CONFIG
        write_gw(p, {"plan": "go", "token": None, "future_feature": {"x": 1}})
        self.capture(lambda: self.g._gateway_plan("zen"))
        cfg = read_gw(p)
        self.assertEqual(cfg["future_feature"], {"x": 1}, "扩展字段应保留")
        self.assertEqual(cfg["plan"], "zen")

    def test_非法token字段归一化(self):
        """token 为非法类型/空串 → 归一化为 None（无鉴权）"""
        p = self.g.GATEWAY_CONFIG
        for bad in (123, "", None, ["a"]):
            write_gw(p, {"plan": "go", "token": bad})
            cfg = self.g._gateway_config()
            self.assertIsNone(cfg["token"], f"token={bad!r} 应归一化 None")

    def test_mask_token边界(self):
        g = self.g
        self.assertEqual(g._mask_token(""), "(未设置)")
        self.assertEqual(g._mask_token("abcdefgh"), "********")
        self.assertEqual(g._mask_token("a" * 64), "aaaa****aaaa")
        self.assertEqual(g._mask_token("abcdefghij"), "abcd****ghij")


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