#!/usr/bin/env python3
"""fetch_proxies.py — 批量拉取免费 SOCKS5 代理 → 连通性验证 → 输出可直接填入 gateway egress 池的候选。

零第三方依赖（仅标准库）。用于 zen 网关 IP 轮换前快速淘可用的免费出口。

用法:
  python3 fetch_proxies.py                         # 全部源拉取 + 汇总（不验证）
  python3 fetch_proxies.py --check                 # 拉取 + 验证连通（到 opencode.ai:443）
  python3 fetch_proxies.py --check --to 1.2.3.4:443 # 指定验证目标
  python3 fetch_proxies.py --limit 50              # 每源最多 50 条
  python3 fetch_proxies.py --timeout 8             # 单代理验证超时秒
  python3 fetch_proxies.py --json                  # JSON 输出（供脚本消费）

输出格式: socks5://host:port (每行一个，直接粘贴进 gateway-config.json 的 egress 数组)
"""
import concurrent.futures
import json
import re
import socket
import struct
import sys
import time
import urllib.request

SOURCES = {
    "proxifly": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    "thespeedx": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "monosans": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    "clarketm": "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
}
DEFAULT_TARGET_HOST = "opencode.ai"
DEFAULT_TARGET_PORT = 443

IP_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def fetch_raw(url, timeout=15):
    """拉取单个源文本；失败返回空串（不中断整体）。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            for enc in ("utf-8", "latin-1"):
                try:
                    return data.decode(enc)
                except UnicodeDecodeError:
                    continue
            return ""
    except Exception:
        return ""


def parse_lines(text):
    """从源文本提取 (host, port)。容忍 host:port / socks5://host:port / 表格行多种格式。"""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.search(r"(?:socks5://)?([0-9.]+):(\d{1,5})", line)
        if m:
            host, port = m.group(1), int(m.group(2))
            if not IP_RE.match(host):
                continue
            if not (1 <= port <= 65535):
                continue
            out.append((host, port))
    return out


def _socks5_connect(host, port, target_host, target_port, timeout):
    """连代理做完整 SOCKS5 握手 + CONNECT 隧道到 target。成功返回耗时(ms)，失败抛异常。"""
    t0 = time.time()
    if not IP_RE.match(target_host):
        # 域名目标做一次 DNS（简化：用系统解析）
        import socket as s
        try:
            target_host = s.gethostbyname(target_host)
        except Exception:
            raise RuntimeError(f"dns fail {target_host}")
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        # 握手：版本 + 无认证
        sock.sendall(b"\x05\x01\x00")
        rep = sock.recv(2)
        if len(rep) < 2 or rep[0] != 0x05 or rep[1] != 0x00:
            raise RuntimeError(f"handshake fail rep={rep.hex()}")
        # CONNECT（IPv4 ATYP=1）
        ip = socket.inet_aton(target_host) if IP_RE.match(target_host) else None
        if ip is None:
            raise RuntimeError("target must be IPv4")
        req = b"\x05\x01\x00\x01" + ip + struct.pack(">H", target_port)
        sock.sendall(req)
        rep = sock.recv(10)
        if len(rep) < 10 or rep[0] != 0x05 or rep[1] != 0x00:
            raise RuntimeError(f"connect fail code={rep[1] if len(rep) > 1 else '?'}")
    return int((time.time() - t0) * 1000)


def check_one(item, target_host, target_port, timeout):
    host, port = item
    try:
        ms = _socks5_connect(host, port, target_host, target_port, timeout)
        return (host, port, True, ms)
    except Exception as e:
        return (host, port, False, str(e)[:60])


def main():
    args = sys.argv[1:]
    do_check = "--check" in args
    as_json = "--json" in args
    limit = None
    timeout = 6
    target_host, target_port = DEFAULT_TARGET_HOST, DEFAULT_TARGET_PORT
    for i, a in enumerate(args):
        if a == "--limit" and i + 1 < len(args):
            try:
                limit = max(1, int(args[i + 1]))
            except ValueError:
                pass
        if a == "--timeout" and i + 1 < len(args):
            try:
                timeout = max(1, int(args[i + 1]))
            except ValueError:
                pass
        if a == "--to" and i + 1 < len(args):
            hp = args[i + 1]
            if ":" in hp:
                h, p = hp.rsplit(":", 1)
                target_host, target_port = h, int(p)

    collected = {}  # (host,port) -> source
    for name, url in SOURCES.items():
        text = fetch_raw(url)
        items = parse_lines(text)
        if limit:
            items = items[:limit]
        for it in items:
            collected.setdefault(it, name)
        print(f"[i] {name}: 拉到 {len(items)} 条", file=sys.stderr)

    all_items = list(collected.keys())
    print(f"[i] 去重后共 {len(all_items)} 条候选", file=sys.stderr)

    results = []  # (host,port,alive,detail)
    if not do_check:
        for h, p in all_items:
            results.append((h, p, None, ""))
    else:
        print(f"[i] 连通性验证（{target_host}:{target_port}，每代理 {timeout}s）…", file=sys.stderr)
        ok = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=100) as ex:
            futs = {ex.submit(check_one, it, target_host, target_port, timeout): it for it in all_items}
            for fut in concurrent.futures.as_completed(futs):
                h, p, alive, detail = fut.result()
                results.append((h, p, alive, detail))
                if alive:
                    ok += 1
        print(f"[i] 存活 {ok}/{len(results)}", file=sys.stderr)

    # 排序：验证过的把活的放前面（按耗时），未验证按原顺序
    if do_check:
        results.sort(key=lambda r: (0 if r[2] else 1, r[3] if isinstance(r[3], int) else 99999))
    else:
        results.sort(key=lambda r: r[0])

    if as_json:
        out = [
            {"url": f"socks5://{h}:{p}", "alive": a, "ms": m if isinstance(m, int) else None, "err": m if isinstance(m, str) else None}
            for h, p, a, m in results
        ]
        print(json.dumps(out, ensure_ascii=False))
    else:
        for h, p, a, m in results:
            if do_check:
                tag = "OK" if a else "FAIL"
                detail = f"{m}ms" if isinstance(m, int) else str(m)
                print(f"socks5://{h}:{p}\t{tag}\t{detail}")
            else:
                print(f"socks5://{h}:{p}")

    sys.exit(0)


if __name__ == "__main__":
    main()