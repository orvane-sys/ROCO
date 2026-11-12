#!/usr/bin/env python3
"""ROCO launcher: starts the read-only DDS bridge and serves the built page on this PC, then prints the address.

    scripts/roco sim                 simulator on this PC (unitree_mujoco and g1_ctrl on the loopback interface)
    scripts/roco robot enp2s0        the real robot, on the wired interface that reaches it
    scripts/roco replay <path>       a g1_record folder or zip (optionally <zip>:<prefix>)
    scripts/roco demo                the sample recording that ships with the page: no robot, no simulator, no bridge

It needs only Python (the bridge's own packages are needed as before) and the built page: dist/ in a clone (`npm run build` once,
on any PC with Node, then copy dist/ here), or the page inside the release's wheel. The page is served on loopback only. The launcher sends nothing to the robot: the bridge it
starts only subscribes. Ctrl+C stops both.
"""
import argparse
import functools
import http.server
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import quote, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRIDGE = os.path.join(HERE, "roco_dds_bridge.py")
LOOPBACK = "127.0.0.1"


def find_dist(here: str = HERE, root: str = ROOT) -> str:
    """The built page: dist/ of a clone (the one you just built wins), else the page packed in the release wheel (roco_page/).
    When neither has an index.html, the clone's dist/ is returned, so the message names a place to put it."""
    for d in (os.path.join(root, "dist"), os.path.join(here, "roco_page")):
        if os.path.isfile(os.path.join(d, "index.html")):
            return d
    return os.path.join(root, "dist")


DIST = find_dist()


def demo_url(web_port: int) -> str:
    """The address of the sample recording, played by the page itself (no bridge)."""
    return f"http://localhost:{web_port}/?demo=1"


def page_url(web_port: int, bridge_port: int, token=None) -> str:
    """The address to open: the page, told which bridge to read (it opens in monitor mode, so it never offers drive controls).
    The token is the bridge's, when it has one: without it the page cannot connect."""
    ws = f"ws://localhost:{bridge_port}" + (f"/?token={token}" if token else "")
    return f"http://localhost:{web_port}/?monitor=1&ws={quote(ws, safe='')}"


def bridge_command(args) -> list:
    # --page-port makes the bridge print the address of this page, not the dev server's
    # --exit-with-stdin: the bridge stops when this launcher is gone, even after a kill -9 (its stdin is our pipe)
    cmd = [sys.executable, BRIDGE, "--port", str(args.port), "--page-port", str(args.web_port), "--exit-with-stdin"]
    if args.mode == "replay":
        cmd += ["--replay", args.target]
    elif args.mode == "robot":
        cmd += ["--iface", args.target, "--source", "robot"]
    else:
        cmd += ["--iface", args.iface]
    if args.deploy_dir:
        cmd += ["--deploy-dir", args.deploy_dir]
    if getattr(args, "ctrl_log", None):
        cmd += ["--ctrl-log", args.ctrl_log]
    return cmd


def port_free(port: int, host: str = LOOPBACK) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _die_with_parent() -> None:
    """In the bridge, before it starts (Linux): the kernel sends it SIGTERM when this launcher dies, however it dies."""
    try:
        import ctypes
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)   # 1 = PR_SET_PDEATHSIG
    except Exception:
        pass


def wait_listening(proc: subprocess.Popen, port: int, note_after_s: float = 15.0) -> bool:
    """True once the bridge accepts connections on its port, False if it exits first. A long recording can take a while to
    open, so after note_after_s this says so and keeps waiting."""
    t0, noted = time.monotonic(), False
    while proc.poll() is None:
        try:
            socket.create_connection((LOOPBACK, port), 0.5).close()
            return True
        except OSError:
            pass
        if not noted and time.monotonic() - t0 > note_after_s:
            print("[roco] the bridge is still starting (a long recording takes a while to open)")
            noted = True
        time.sleep(0.1)
    return False


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serves dist/ and nothing else. No request logging. A rebuilt page shows up at once: index.html is never stored, the hashed
    files under /assets/ never change so they are kept a year, and everything else (robot models, the sample) is asked about again
    each time and answered 304 when it is unchanged, which the Last-Modified header of the base class allows."""

    def log_message(self, *_args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", cache_policy(self.path))
        super().end_headers()


def cache_policy(url_path: str) -> str:
    path = urlsplit(url_path).path
    if path in ("/", "/index.html"):
        return "no-store"
    if path.startswith("/assets/"):
        return "public, max-age=31536000, immutable"
    return "no-cache"


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # a browser that stops a download (a reload, a closed tab) is not an error to show the operator
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def make_server(directory: str, port: int) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(QuietHandler, directory=directory)
    return QuietServer((LOOPBACK, port), handler)


def parse(argv):
    ap = argparse.ArgumentParser(prog="roco", description="Start the read-only ROCO bridge and serve the page.")
    sub = ap.add_subparsers(dest="mode")
    sim = sub.add_parser("sim", help="simulator on this PC")
    sim.add_argument("--iface", default="lo", help="DDS interface (default lo)")
    robot = sub.add_parser("robot", help="the real robot")
    robot.add_argument("target", metavar="IFACE", help="wired interface that reaches the robot, e.g. enp2s0")
    replay = sub.add_parser("replay", help="a g1_record recording")
    replay.add_argument("target", metavar="PATH", help="folder or zip (optionally <zip>:<prefix>)")
    demo = sub.add_parser("demo", help="the sample recording, with no robot and no bridge")
    demo.add_argument("--web-port", type=int, default=8780, help="port the page is served on (default 8780)")
    demo.add_argument("--open", action="store_true", help="open the page in the default browser")
    for p in (sim, robot, replay):
        p.add_argument("--port", type=int, default=8765, help="bridge WebSocket port (default 8765)")
        p.add_argument("--web-port", type=int, default=8780, help="port the page is served on (default 8780)")
        p.add_argument("--open", action="store_true", help="open the page in the default browser")
        p.add_argument("--deploy-dir", default=None, metavar="DIR",
                       help="g1_ctrl's deploy folder (default: $ROCO_DEPLOY_DIR, else ~/unitree_rl_mjlab/deploy_lock if it exists, "
                            "else ~/unitree_rl_mjlab/deploy)")
    for p in (sim, robot):
        p.add_argument("--ctrl-log", default=None, metavar="FILE",
                       help="g1_ctrl's log, for the controller state (default: robots/g1/log/log.txt in the deploy folder)")
    ap.add_argument("--self-test", action="store_true")
    return ap, ap.parse_args(argv)


def run(args) -> int:
    sys.stdout.reconfigure(line_buffering=True)   # the URL shows at once even when output is piped or redirected
    # Ctrl-C, a closed terminal (SIGHUP) and `kill` all stop the bridge too, so it is never left running on its own
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, signal.default_int_handler)
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        print(f"[roco] the page is not built: {DIST}/index.html is missing.\n"
              "       In a clone, run `npm run build` once on a PC with Node. Or install the wheel from the GitHub release, "
              "which has the page inside.")
        return 2
    ports = (("page", args.web_port),) if args.mode == "demo" else (("bridge", args.port), ("page", args.web_port))
    for name, port in ports:
        if not port_free(port):
            print(f"[roco] port {port} ({name}) is already in use. Is another roco or bridge running? Use --port / --web-port to change it.")
            return 2
    server = make_server(DIST, args.web_port)
    if args.mode == "demo":
        return run_demo(args, server)
    cmd = bridge_command(args)
    print("[roco] starting the bridge: " + " ".join(cmd[1:]))
    # Started before the web thread: preexec_fn is not safe once this process has threads.
    bridge = subprocess.Popen(cmd, stdin=subprocess.PIPE, preexec_fn=_die_with_parent if sys.platform.startswith("linux") else None)
    threading.Thread(target=server.serve_forever, name="web", daemon=True).start()
    try:
        if not wait_listening(bridge, args.port):
            print(f"[roco] the bridge stopped before it was ready (exit code {bridge.returncode}); see its message above")
            return bridge.returncode or 1
        url = page_url(args.web_port, args.port, os.environ.get("ROCO_BRIDGE_TOKEN"))
        print(f"[roco] open {url}")
        if args.open:
            import webbrowser
            webbrowser.open(url)
        while bridge.poll() is None:
            time.sleep(0.2)
        print(f"[roco] the bridge stopped (exit code {bridge.returncode})")
        return bridge.returncode or 0
    except KeyboardInterrupt:
        print("\n[roco] stopping")
        bridge.send_signal(signal.SIGINT)
        try:
            bridge.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge.terminate()
        return 0
    finally:
        server.shutdown()
        server.server_close()


def run_demo(args, server) -> int:
    """Serves the page and prints the address of the sample recording; the page plays it by itself, so no bridge is started."""
    threading.Thread(target=server.serve_forever, name="web", daemon=True).start()
    try:
        url = demo_url(args.web_port)
        print(f"[roco] open {url}\n[roco] the sample recording of a simulated G1, labelled SAMPLE. Ctrl+C stops.")
        if args.open:
            import webbrowser
            webbrowser.open(url)
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[roco] stopping")
        return 0
    finally:
        server.shutdown()
        server.server_close()


def self_test() -> bool:
    import tempfile
    import urllib.request
    ok = True

    def check(cond, what):
        nonlocal ok
        print(f"  [{'✓' if cond else '✗'}] {what}")
        ok = ok and bool(cond)

    print("roco launcher self-test")
    _, a = parse(["sim"])
    check(bridge_command(a)[1:] == [BRIDGE, "--port", "8765", "--page-port", "8780", "--exit-with-stdin", "--iface", "lo"], "sim: bridge on the loopback interface")
    _, a = parse(["robot", "enp2s0", "--port", "9000"])
    check(bridge_command(a)[1:] == [BRIDGE, "--port", "9000", "--page-port", "8780", "--exit-with-stdin", "--iface", "enp2s0", "--source", "robot"], "robot: interface and source 'robot'")
    _, a = parse(["replay", "/x/log.zip:stand", "--web-port", "9100"])
    check(bridge_command(a)[1:] == [BRIDGE, "--port", "8765", "--page-port", "9100", "--exit-with-stdin", "--replay", "/x/log.zip:stand"], "replay: the path as given, the bridge told the page's port")
    _, a = parse(["sim", "--deploy-dir", "/opt/dl"])
    check(bridge_command(a)[-2:] == ["--deploy-dir", "/opt/dl"], "the deploy folder is passed on only when given")
    _, a = parse(["robot", "enp2s0", "--ctrl-log", "/x/g1_ctrl.log"])
    check(bridge_command(a)[-2:] == ["--ctrl-log", "/x/g1_ctrl.log"], "the g1_ctrl log is passed on when given")
    _, a = parse(["sim"])
    check("--ctrl-log" not in bridge_command(a), "and not otherwise")
    _, a = parse(["demo", "--web-port", "9200"])
    check(a.mode == "demo" and demo_url(a.web_port) == "http://localhost:9200/?demo=1", "demo: the sample's address, no bridge")
    check(page_url(8780, 8765) =="http://localhost:8780/?monitor=1&ws=ws%3A%2F%2Flocalhost%3A8765", "page address names the bridge and monitor mode")
    check(page_url(8780, 8765, "s3") == "http://localhost:8780/?monitor=1&ws=ws%3A%2F%2Flocalhost%3A8765%2F%3Ftoken%3Ds3", "with a bridge token the address carries it")
    with tempfile.TemporaryDirectory() as t:
        here, root = os.path.join(t, "site"), os.path.join(t, "clone")
        for sub in (os.path.join(here, "roco_page"), os.path.join(root, "dist")):
            os.makedirs(sub)
        check(find_dist(here, root) == os.path.join(root, "dist"), "no page anywhere: the message names the clone's dist/")
        with open(os.path.join(here, "roco_page", "index.html"), "w") as f:
            f.write("x")
        check(find_dist(here, root) == os.path.join(here, "roco_page"), "an installed wheel's page is found")
        with open(os.path.join(root, "dist", "index.html"), "w") as f:
            f.write("x")
        check(find_dist(here, root) == os.path.join(root, "dist"), "a clone's own dist/ wins over the packed page")
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "index.html"), "w") as f:
            f.write("<title>ok</title>")
        with open(os.path.join(os.path.dirname(d), "secret_roco_test.txt"), "w") as f:
            f.write("outside")
        srv = make_server(d, 0)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            body = urllib.request.urlopen(f"http://{LOOPBACK}:{port}/index.html", timeout=3).read()
            check(body == b"<title>ok</title>", "serves the built page")
            check(srv.server_address[0] == LOOPBACK, "listens on loopback only")
            try:
                urllib.request.urlopen(f"http://{LOOPBACK}:{port}/../secret_roco_test.txt", timeout=3)
                outside = True
            except Exception:
                outside = False
            check(not outside, "does not serve files outside dist/")
            check(urllib.request.urlopen(f"http://{LOOPBACK}:{port}/index.html", timeout=3).headers.get("Cache-Control") == "no-store", "a rebuilt page is not cached")
            os.makedirs(os.path.join(d, "assets"))
            os.makedirs(os.path.join(d, "models"))
            for name in ("assets/app-abc123.js", "models/pelvis.glb"):
                with open(os.path.join(d, name), "wb") as f:
                    f.write(b"x")
            asset = urllib.request.urlopen(f"http://{LOOPBACK}:{port}/assets/app-abc123.js", timeout=3)
            check(asset.headers.get("Cache-Control") == "public, max-age=31536000, immutable", "a hashed file is kept for a year")
            model = urllib.request.urlopen(f"http://{LOOPBACK}:{port}/models/pelvis.glb", timeout=3)
            check(model.headers.get("Cache-Control") == "no-cache", "a model is asked about again each time")
            again = urllib.request.Request(f"http://{LOOPBACK}:{port}/models/pelvis.glb", headers={"If-Modified-Since": model.headers.get("Last-Modified", "")})
            try:
                urllib.request.urlopen(again, timeout=3)
                status = 200
            except urllib.error.HTTPError as e:
                status = e.code
            check(status == 304, "an unchanged model is answered 304, not sent again")
            with open(os.path.join(d, "models", "big.glb"), "wb") as f:
                f.write(b"x" * 8_000_000)
            import contextlib
            import io
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                r = urllib.request.urlopen(f"http://{LOOPBACK}:{port}/models/big.glb", timeout=3)
                r.read(64)
                r.fp.raw._sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))   # a reset, as a closed tab
                r.close()
                time.sleep(0.5)
            check("Traceback" not in err.getvalue(), "a download the browser stops prints no traceback")
        finally:
            srv.shutdown()
            srv.server_close()
            try:
                os.remove(os.path.join(os.path.dirname(d), "secret_roco_test.txt"))
            except OSError:
                pass
        check(port_free(port), "a stopped server frees its port")
    # B9: the address is printed only once the bridge listens, and never when it exits first
    with socket.socket() as s:
        s.bind((LOOPBACK, 0))
        port = s.getsockname()[1]
    late = subprocess.Popen([sys.executable, "-c", "import socket, time; time.sleep(0.6); s = socket.socket(); "
                             f"s.bind(('{LOOPBACK}', {port})); s.listen(); time.sleep(5)"])
    t = time.monotonic()
    try:
        ready = wait_listening(late, port)
        check(ready and time.monotonic() - t >= 0.5, f"waits until the bridge listens ({time.monotonic() - t:.1f} s)")
    finally:
        late.kill()
        late.wait()
    early = subprocess.Popen([sys.executable, "-c", "raise SystemExit(3)"])
    check(not wait_listening(early, port) and early.returncode == 3, "a bridge that exits first gives no address")
    print("ALL TESTS PASSED" if ok else "SOME TESTS FAILED")
    return ok


def main() -> int:
    ap, args = parse(sys.argv[1:])
    if args.self_test:
        return 0 if self_test() else 1
    if not args.mode:
        ap.print_help()
        return 2
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
