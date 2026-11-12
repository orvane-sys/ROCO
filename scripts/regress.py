#!/usr/bin/env python3
"""
Regression tests for the ROCO bridge against real processes (the audit's reproductions, repeatable).

  python3 scripts/regress.py            # R1 stuck client, R2 cut-off recordings, R4 report after a jump, R6 launcher, R7 sample, R8 demo,
                                        # R10 frame rate  (about 85 s)
  python3 scripts/regress.py --live     # also R3 old log, no --log, R5 bridge restart and R9 roco record (DDS domain 42, needs unitree_sdk2py)

Standard library only. It writes its own 60 s recording to a temporary folder (no files in ~ are used), starts each bridge on a
free port and stops it in a `finally`; a bridge is a child process, ended by its PID (never by name). Prints PASS / FAIL / SKIP for
each case and exits 0 when nothing failed.

The live cases use a synthetic LowState_ publisher on DDS domain 42, so no simulator or robot on domain 0 can see it. It is a test
tool of this script only: ROCO itself never writes to DDS.

The in-process `roco_dds_bridge.py --self-test` stays: it checks the pieces. This checks them through sockets and the page's own code.
"""
import argparse
import base64
import datetime
import importlib
import json
import math
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from typing import List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRIDGE = os.path.join(HERE, "roco_dds_bridge.py")
LAUNCHER = os.path.join(HERE, "roco")
DOMAIN = 42                     # private DDS domain of the live cases
N_BODY = 29
REC_S, REC_HZ = 60.0, 500
T_BASE = datetime.datetime(2026, 11, 3, 9, 0, 0).timestamp()      # local time: the log's lines are local time
SPEEDS_MAX = 8.0


# ==============================================================================
# Recording
# ==============================================================================
LS_COLS = (["t", "unix_t", "tick", "mode_pr", "mode_machine", "quat_w", "quat_x", "quat_y", "quat_z", "gyro_x", "gyro_y", "gyro_z",
            "acc_x", "acc_y", "acc_z", "rpy_r", "rpy_p", "rpy_y"]
           + [f"{p}{i}" for p in ("q", "dq", "tau_est", "temp0_", "temp1_", "vol_", "motorstate_") for i in range(N_BODY)])
LC_COLS = ["t", "unix_t"] + [f"{p}{i}" for p in ("q", "dq", "kp", "kd", "tau") for i in range(N_BODY)]

# what happens when (seconds into the recording): g1_ctrl states, an ankle torque burst, a motor reporting a fault, body tilt
LOG_LINES = [
    (0.5, "info", "Config: /x/config.yaml"),
    (2.0, "info", "FSM: Change state from Passive to FixStand"),
    (6.0, "info", "FSM: Change state from FixStand to Velocity"),
    (9.5, "info", "Velocity policy: 400 steps, first after 0.3 ms, step interval max 22.9 ms"),
    (12.0, "info", "FSM: Change state from Velocity to squat"),
    (16.0, "info", "FSM: Change state from squat to Velocity"),
    (40.0, "info", "FSM: Change state from Velocity to FixStand"),
]


def log_text(lines=LOG_LINES, base=T_BASE) -> str:
    out = []
    for dt, lvl, text in lines:
        t = datetime.datetime.fromtimestamp(base + dt)
        out.append(f"[{t.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] [{lvl}] {text}\n")
    return "".join(out)


def write_recording(folder: str, prefix: str = "rec") -> None:
    """60 s at 500 Hz in g1_record's layout, a g1_ctrl log beside it, with alerts: motorstate fault 8..11 s, tilt 20..26 s."""
    os.makedirs(folder, exist_ok=True)
    n = int(REC_S * REC_HZ)
    for name, cols in (("lowstate", LS_COLS), ("lowcmd", LC_COLS)):
        idx = {c: i for i, c in enumerate(cols)}
        base = ["0"] * len(cols)
        with open(os.path.join(folder, f"{prefix}_{name}.csv"), "w") as f:
            f.write(",".join(cols) + "\n")
            buf = []
            for i in range(n):
                ph = i / REC_HZ
                row = list(base)
                row[idx["t"]] = repr(ph)
                row[idx["unix_t"]] = repr(T_BASE + ph)
                if name == "lowstate":
                    row[idx["tick"]] = str(i)
                burst = 20.0 * math.sin(ph) ** 2 if 3 < ph < 16 else 2.0
                if name == "lowstate":
                    row[idx["tau_est4"]] = repr(burst)
                    if 8 < ph < 11:
                        row[idx["motorstate_0"]] = "1"
                    if 20 < ph < 26:
                        row[idx["rpy_r"]] = repr(0.8 if 22 < ph < 23 else 0.5)        # 46 deg / 29 deg: critical, then warn
                else:
                    row[idx["tau4"]] = repr(burst)
                    row[idx["tau10"]] = repr(burst * 0.9)
                buf.append(",".join(row))
                if len(buf) == 1000:
                    f.write("\n".join(buf) + "\n")
                    buf = []
            if buf:
                f.write("\n".join(buf) + "\n")
    with open(os.path.join(folder, "log.txt"), "w") as f:
        f.write(log_text())


# ==============================================================================
# Processes
# ==============================================================================
def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Child:
    """A child process in its own process group, output to files. Ended by its PID / group only."""

    def __init__(self, argv: List[str], tmp: str, name: str):
        self.out_path, self.err_path = os.path.join(tmp, name + ".out"), os.path.join(tmp, name + ".err")
        self._out, self._err = open(self.out_path, "wb"), open(self.err_path, "wb")
        self.proc = subprocess.Popen([sys.executable, "-u"] + argv, stdout=self._out, stderr=self._err, stdin=subprocess.DEVNULL,
                                     start_new_session=True)
        self.pid = self.proc.pid

    def stdout(self) -> str:
        with open(self.out_path, errors="replace") as f:
            return f.read()

    def stderr(self) -> str:
        with open(self.err_path, errors="replace") as f:
            return f.read()

    def rss_mb(self) -> float:
        try:
            with open(f"/proc/{self.pid}/status") as f:
                for ln in f:
                    if ln.startswith("VmRSS:"):
                        return int(ln.split()[1]) / 1024
        except OSError:
            pass
        return 0.0

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        if self.proc.poll() is None:
            try:
                os.kill(self.pid, signal.SIGINT)        # the bridge stops its checkpoint worker on Ctrl-C
                self.proc.wait(5)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                pass
        try:
            os.killpg(self.pid, signal.SIGKILL)         # anything of the group that is left (the worker)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        self._out.close()
        self._err.close()


def start_bridge(tmp: str, name: str, *extra: str, port: Optional[int] = None) -> Tuple[Child, int]:
    port = port or free_port()
    deploy = os.path.join(tmp, "deploy")           # an empty deploy folder: ROCO's own limits, no dependence on ~
    os.makedirs(deploy, exist_ok=True)
    child = Child([BRIDGE, "--port", str(port), "--deploy-dir", deploy, *extra], tmp, name)
    t_end = time.time() + 15
    while time.time() < t_end:
        if not child.alive():
            raise RuntimeError(f"bridge {name} exited early:\n{child.stdout()}\n{child.stderr()}")
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return child, port
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"bridge {name} did not listen on {port}:\n{child.stdout()}")


def have_dds() -> bool:
    try:
        importlib.import_module("unitree_sdk2py")
        return True
    except Exception:
        return False


def publisher_main(domain: int, tilt_deg: float, tilt_after_s: float) -> None:
    """Test only: a synthetic LowState_ at about 400-500 Hz (a 2 ms sleep per write) on a private domain, tilted `tilt_deg` after `tilt_after_s`."""
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelPublisher
    from unitree_sdk2py.idl.default import unitree_hg_msg_dds__LowState_ as default_ls
    from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowState_
    ChannelFactoryInitialize(domain, "lo")
    pub = ChannelPublisher("rt/lowstate", LowState_)
    pub.Init()
    msg = default_ls()
    t0, tick = time.time(), 0
    while True:
        roll = math.radians(tilt_deg if time.time() - t0 >= tilt_after_s else 0.0)        # the bridge's tilt alert reads rpy
        msg.imu_state.rpy = [roll, 0.0, 0.0]
        msg.imu_state.quaternion = [math.cos(roll / 2), math.sin(roll / 2), 0.0, 0.0]
        tick += 1
        msg.tick = tick
        pub.Write(msg)
        time.sleep(0.002)


# ==============================================================================
# WebSocket client (raw sockets)
# ==============================================================================
class Ws:
    def __init__(self, port: int, rcvbuf: Optional[int] = None, handshake_read: bool = True):
        self.s = socket.socket()
        if rcvbuf:
            self.s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        self.s.settimeout(5)
        self.s.connect(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(f"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                       f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise ConnectionError("closed during the handshake")
            self.buf += chunk
        head, _, self.buf = self.buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.split(b"\r\n")[0].decode(errors="replace"))

    def _need(self, n: int, deadline: float) -> bytes:
        while len(self.buf) < n:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            self.s.settimeout(left)
            try:
                chunk = self.s.recv(65536)
            except socket.timeout:
                raise TimeoutError
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def frame(self, timeout: float = 5.0) -> Tuple[int, bytes]:
        """(opcode, payload) of the next data frame; TimeoutError when none comes in time."""
        deadline = time.monotonic() + timeout
        while True:
            b1, b2 = self._need(2, deadline)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._need(2, deadline))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._need(8, deadline))[0]
            payload = self._need(n, deadline)
            op = b1 & 0x0F
            if op in (0x1, 0x2):
                return op, payload
            if op == 0x8:
                raise ConnectionError("closed by the bridge")

    def json_frames(self, seconds: float):
        """Yields (monotonic time, op, payload) for every frame for `seconds`."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                op, p = self.frame(max(0.01, end - time.monotonic()))
            except TimeoutError:
                return
            yield time.monotonic(), op, p

    def send(self, obj: dict) -> None:
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def close(self) -> None:
        try:
            self.s.close()
        except OSError:
            pass


def is_type(payload: bytes, name: str) -> bool:
    """True for a text frame {"type": name, ...} (every bridge frame starts with its type; json.dumps spaces vary)."""
    return payload.startswith(b'{"type":"' + name.encode() + b'"') or payload.startswith(b'{"type": "' + name.encode() + b'"')


def next_json(ws: Ws, kind: str, timeout: float = 5.0) -> dict:
    """The next text frame of this type."""
    end = time.monotonic() + timeout
    while True:
        op, p = ws.frame(max(0.01, end - time.monotonic()))
        if op == 0x1 and is_type(p, kind):
            return json.loads(p)


def control(ws: Ws, action: str, value=None) -> None:
    ws.send({"type": "replay_control", "action": action, "value": value})


# ==============================================================================
# Cases
# ==============================================================================
class Results:
    def __init__(self):
        self.failed = 0
        self.rows: List[Tuple[str, str]] = []

    def say(self, case: str, status: str, detail: str = "") -> None:
        if status == "FAIL":
            self.failed += 1
        print(f"{status:4}  {case}" + (f"  ({detail})" if detail else ""), flush=True)
        self.rows.append((case, status))


def r1_stuck_client(tmp: str, rec: str, res: Results) -> None:
    case = "R1 a client that stops reading does not hold up the others"
    child, port = start_bridge(tmp, "r1", "--replay", rec, "--no-checkpoints")
    a = b = None
    try:
        a = Ws(port)
        while True:
            op, p = a.frame()
            if op == 0x1 and is_type(p, "replay"):
                break
        b = Ws(port, rcvbuf=4096)                 # handshakes, then never reads
        time.sleep(1.0)                           # let the bridge's per-client buffers fill and settle
        rss0 = child.rss_mb()
        stamps: List[float] = []
        for ts, op, p in a.json_frames(10.0):
            if op == 0x1 and is_type(p, "aux"):
                stamps.append(ts)
        gaps = [y - x for x, y in zip(stamps, stamps[1:])]
        worst = max(gaps) if gaps else 99.0
        grew = child.rss_mb() - rss0
        b.close()
        b = None
        after = sum(1 for _, op, p in a.json_frames(1.0) if op == 0x1 and is_type(p, "aux"))
        want = int(0.9 * 50 * 10)
        bad = []
        if len(stamps) < want:
            bad.append(f"A got {len(stamps)} aux frames, need {want}")
        if worst >= 0.2:
            bad.append(f"A's largest gap {worst * 1000:.0f} ms")
        if grew >= 20:
            bad.append(f"RSS grew {grew:.1f} MB")
        if after < 20:
            bad.append(f"after B closed A got {after} aux frames in 1 s")
        if not child.alive():
            bad.append("the bridge exited")
        res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) or f"{len(stamps)} aux frames in 10 s, largest gap {worst * 1000:.0f} ms, RSS +{grew:.1f} MB")
    finally:
        for c in (a, b):
            if c:
                c.close()
        child.stop()


def play_to_end(port: int, timeout: float) -> Tuple[bool, str]:
    ws = Ws(port)
    try:
        control(ws, "speed", SPEEDS_MAX)
        end = time.monotonic() + timeout
        last = None
        while time.monotonic() < end:
            try:
                op, p = ws.frame(1.0)
            except TimeoutError:
                continue
            if op == 0x1 and is_type(p, "replay"):
                last = json.loads(p)
                if last.get("ended"):
                    return True, f"ended at {last['t'] - last['t0']:.2f} s"
        return False, f"did not end in {timeout:.0f} s (t={last and last['t'] - last['t0']})"
    finally:
        ws.close()


def r2_cut_recordings(tmp: str, rec_dir: str, res: Results) -> None:
    for what, cut in (("the last row cut in half", "half"), ("a damaged last line", "damaged")):
        case = f"R2 a recording with {what} opens and plays to the end"
        d = os.path.join(tmp, "cut_" + cut)
        os.makedirs(d, exist_ok=True)
        shutil.copyfile(os.path.join(rec_dir, "rec_lowcmd.csv"), os.path.join(d, "rec_lowcmd.csv"))
        shutil.copyfile(os.path.join(rec_dir, "log.txt"), os.path.join(d, "log.txt"))
        src = os.path.join(rec_dir, "rec_lowstate.csv")
        dst = os.path.join(d, "rec_lowstate.csv")
        shutil.copyfile(src, dst)
        with open(dst, "r+b") as f:
            data = f.read()
            start = data.rstrip(b"\n").rfind(b"\n") + 1
            if cut == "half":
                f.truncate(start + (len(data) - start) // 2)
            else:
                f.seek(start)
                f.truncate()
                f.write(b"1.5,garbage,\n")
        child, port = start_bridge(tmp, "r2_" + cut, "--replay", os.path.join(d, "rec"), "--no-checkpoints")
        try:
            ok, detail = play_to_end(port, 30.0)
            out, err = child.stdout(), child.stderr()
            bad = []
            if not ok:
                bad.append(detail)
            if "Traceback" in out or "Traceback" in err:
                bad.append("Traceback in the bridge's output")
            if "line(s) are cut off (the recording stopped mid-write) and are ignored" not in out:
                bad.append("no 'cut off' message on stdout")
            if not child.alive():
                bad.append("the bridge exited")
            res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) or detail)
        finally:
            child.stop()


def r3_old_log(tmp: str, res: Results) -> None:
    case = "R3 an old run's log (no --log): state unknown, no events, no alerts"
    if not have_dds():
        res.say(case, "SKIP", "unitree_sdk2py is not importable")
        return
    old = os.path.join(tmp, "old_log.txt")
    with open(old, "w") as f:
        f.write(log_text(base=time.time() - 3600))
    os.utime(old, (time.time() - 3600, time.time() - 3600))       # nobody writes it, and it is an hour old
    child, port = start_bridge(tmp, "r3", "--iface", "lo", "--domain", str(DOMAIN), "--ctrl-log", old)
    pub = Child([os.path.abspath(__file__), "--publisher", str(DOMAIN), "0", "0"], tmp, "r3_pub")
    ws = None
    try:
        time.sleep(1.5)
        ws = Ws(port)
        hello = next_json(ws, "hello")
        fsm = next_json(ws, "fsm")
        aux = alerts = 0
        for _, op, p in ws.json_frames(3.0):
            if op == 0x1 and is_type(p, "aux"):
                a = json.loads(p)
                aux += 1
                alerts += len(a["alerts"]) + len(a["alertEvents"])
        bad = []
        if not fsm.get("full"):
            bad.append("first fsm frame is not a full one")
        if fsm.get("state") is not None:
            bad.append(f"state {fsm['state']!r}, not unknown")
        if fsm.get("events"):
            bad.append(f"{len(fsm['events'])} events from the old run")
        if alerts:
            bad.append(f"{alerts} alerts in 3 s")
        if aux == 0:
            bad.append("no aux frames: the publisher's data did not arrive")
        if hello.get("source") != "sim":
            bad.append(f"hello source {hello.get('source')}")
        res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) or f"{aux} aux frames, no alerts")
    finally:
        if ws:
            ws.close()
        pub.stop()
        child.stop()


def r4_report_after_jump(tmp: str, rec: str, res: Results) -> None:
    case = "R4 the report after a jump equals the report of the played run"
    node = shutil.which("node")
    if not node:
        res.say(case, "SKIP", "node is not installed")
        return
    play, seek = os.path.join(tmp, "play.jsonl"), os.path.join(tmp, "seek.jsonl")
    child, port = start_bridge(tmp, "r4", "--replay", rec)
    t_stop = 45.0
    try:
        p = Ws(port)
        status = None
        paused_at = None
        done = False
        end = time.monotonic() + 120
        with open(play, "w") as out:
            control(p, "speed", SPEEDS_MAX)
            sent_pause = False
            while time.monotonic() < end and not (paused_at is not None and done):
                try:
                    op, payload = p.frame(2.0)
                except TimeoutError:
                    continue
                if op != 0x1:
                    continue
                out.write(payload.decode() + "\n")
                if is_type(payload, "replay"):
                    status = json.loads(payload)
                    if not sent_pause and status["t"] - status["t0"] >= t_stop - 1:
                        control(p, "pause")
                        sent_pause = True
                    if sent_pause and not status["playing"] and not status["busy"]:
                        paused_at = status["t"]
                    done = status.get("statsPass") == "done"
        p.close()
        if paused_at is None or not done:
            res.say(case, "FAIL", f"the play did not reach a pause with the statistics pass done (paused_at={paused_at}, pass={status and status.get('statsPass')})")
            return
        s = Ws(port)
        with open(seek, "w") as out:
            got_status = False
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:             # the greeting
                try:
                    op, payload = s.frame(0.5)
                except TimeoutError:
                    break
                if op == 0x1:
                    out.write(payload.decode() + "\n")
            out.write(json.dumps({"seek": paused_at}) + "\n")
            control(s, "seek", paused_at)
            deadline = time.monotonic() + 30
            after = 0
            seen_busy = False
            while time.monotonic() < deadline:
                try:
                    op, payload = s.frame(1.0)
                except TimeoutError:
                    continue
                if op != 0x1:
                    continue
                out.write(payload.decode() + "\n")
                if is_type(payload, "replay"):
                    st = json.loads(payload)
                    seen_busy = seen_busy or bool(st["busy"])
                    if not st["busy"] and abs(st["t"] - paused_at) < 0.05 and seen_busy:
                        got_status = True
                elif is_type(payload, "aux") and got_status:
                    after += 1
                    if after >= 3:
                        break
        s.close()
        if after < 3:
            res.say(case, "FAIL", "the jump did not finish")
            return
        r = subprocess.run([node, os.path.join(HERE, "check-regress-report.mjs"), play, seek], capture_output=True, text=True, timeout=120, cwd=ROOT)
        tail = (r.stdout + r.stderr).strip().splitlines()
        res.say(case, "PASS" if r.returncode == 0 else "FAIL", tail[-1] if r.returncode == 0 and tail else "\n      ".join(tail[-14:]))
    finally:
        child.stop()


def r5_bridge_restart(tmp: str, res: Results) -> None:
    case = "R5 after a bridge restart the history is the new session's, and a second client gets the same"
    if not have_dds():
        res.say(case, "SKIP", "unitree_sdk2py is not importable")
        return
    pub = Child([os.path.abspath(__file__), "--publisher", str(DOMAIN), "30", "0.5"], tmp, "r5_pub")
    port = free_port()
    child = None
    try:
        child, _ = start_bridge(tmp, "r5a", "--iface", "lo", "--domain", str(DOMAIN), "--no-ctrl-log", port=port)
        time.sleep(3.0)
        w1 = Ws(port)
        hello1 = next_json(w1, "hello")
        fsm1 = next_json(w1, "fsm")
        time.sleep(0.5)
        w1.close()
        child.stop()
        child, _ = start_bridge(tmp, "r5b", "--iface", "lo", "--domain", str(DOMAIN), "--no-ctrl-log", port=port)
        time.sleep(3.0)
        w2 = Ws(port)
        hello2 = next_json(w2, "hello")
        fsm2 = next_json(w2, "fsm")
        w3 = Ws(port)
        hello3 = next_json(w3, "hello")
        fsm3 = next_json(w3, "fsm")
        w2.close()
        w3.close()
        s1, s2, s3 = (h.get("session") or {} for h in (hello1, hello2, hello3))
        hist2, hist3 = fsm2.get("alertHistory") or [], fsm3.get("alertHistory") or []
        bad = []
        if not s1.get("id") or s1["id"] == s2.get("id"):
            bad.append("the restarted bridge has the same session id")
        if s2.get("id") != s3.get("id"):
            bad.append("the session id changed between two clients of one bridge")
        if not fsm2.get("full"):
            bad.append("no full fsm frame")
        if not any(e["id"] == "tilt" and e["event"] == "open" for e in hist2):
            bad.append("the tilt alert is not in the new session's history")
        started = s2.get("startedAt", 0)
        if any(e["since"] < started - 1.0 for e in hist2):
            bad.append("the history holds an event from before the restart")
        if hist2 != hist3 and not (hist2 and hist3 and hist2[0] == hist3[0]):
            bad.append("a second client got a different history")
        if not (fsm1.get("full")):
            bad.append("the first run sent no full frame")
        res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) or f"new session {s2['id']}, {len(hist2)} history events")
    finally:
        if child:
            child.stop()
        pub.stop()


def children(pid: int) -> List[int]:
    try:
        with open(f"/proc/{pid}/task/{pid}/children") as f:
            return [int(x) for x in f.read().split()]
    except OSError:
        return []


def running(pid: int) -> bool:
    """False once the process has ended (a zombie waiting for its reaper counts as ended)."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


def r6_launcher(tmp: str, rec: str, res: Results) -> None:
    case = "R6 the launcher prints the address once the bridge listens, and a killed launcher takes the bridge with it"
    if not os.path.isfile(os.path.join(ROOT, "dist", "index.html")):
        res.say(case, "SKIP", "the page is not built: npm run build")
        return
    if not sys.platform.startswith("linux"):
        res.say(case, "SKIP", "reads /proc")
        return
    port, web_port = free_port(), free_port()
    deploy = os.path.join(tmp, "deploy")
    os.makedirs(deploy, exist_ok=True)
    child = Child([LAUNCHER, "replay", rec, "--port", str(port), "--web-port", str(web_port), "--deploy-dir", deploy], tmp, "r6")
    left: List[int] = []
    try:
        t_end, listening = time.time() + 20, None
        while time.time() < t_end and child.alive() and "[roco] open " not in child.stdout():
            time.sleep(0.05)
        if "[roco] open " in child.stdout():
            try:
                socket.create_connection(("127.0.0.1", port), 1.0).close()
                listening = True
            except OSError:
                listening = False
        stats_pass = None
        if listening:   # the checkpoint worker runs to the end under the launcher too
            ws = Ws(port)
            control(ws, "speed", SPEEDS_MAX)
            t_end, seen = time.monotonic() + 60, set()
            # "off" is also the state before the worker's first message, so only "off" after "running" (or the bridge's
            # message) is a failure
            while (time.monotonic() < t_end and stats_pass != "done" and not ("running" in seen and stats_pass == "off")
                   and "checkpoint pass failed" not in child.stdout()):
                try:
                    op, payload = ws.frame(2.0)
                except TimeoutError:
                    continue
                if op == 0x1 and is_type(payload, "replay"):
                    stats_pass = json.loads(payload).get("statsPass")
                    seen.add(stats_pass)
            ws.close()
        bridge = children(child.pid)
        tree = bridge + [g for b in bridge for g in children(b)]   # the bridge and its checkpoint worker, if still running
        if not listening or stats_pass != "done" or not tree:
            res.say(case, "FAIL", f"address printed: {listening is not None}, bridge listening then: {bool(listening)}, "
                                  f"checkpoint pass: {stats_pass}, bridge processes: {len(tree)}\n{child.stdout()}{child.stderr()}")
            return
        os.kill(child.pid, signal.SIGKILL)
        child.proc.wait(5)
        t0 = time.time()
        while time.time() - t0 < 3 and any(running(p) for p in tree):
            time.sleep(0.05)
        left = [p for p in tree if running(p)]
        res.say(case, "FAIL" if left else "PASS",
                f"{len(left)} of {len(tree)} still running 3 s after kill -9" if left else
                f"{len(tree)} processes gone {time.time() - t0:.2f} s after kill -9 of the launcher")
    finally:
        for p in left:
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.stop()

    # Ctrl-C, the way an operator stops it: a clean exit with nothing frightening on the screen
    case = "R6 Ctrl-C on the launcher stops the bridge cleanly"
    port, web_port = free_port(), free_port()
    child = Child([LAUNCHER, "replay", rec, "--port", str(port), "--web-port", str(web_port), "--deploy-dir", deploy], tmp, "r6c")
    tree = []
    try:
        t_end = time.time() + 20
        while time.time() < t_end and child.alive() and "[roco] open " not in child.stdout():
            time.sleep(0.05)
        bridge = children(child.pid)
        tree = bridge + [g for b in bridge for g in children(b)]
        if not bridge:
            res.say(case, "FAIL", f"no bridge to stop\n{child.stdout()}{child.stderr()}")
            return
        os.kill(child.pid, signal.SIGINT)
        code = child.proc.wait(8)
        time.sleep(0.2)     # the launcher waits for the bridge, the worker follows the bridge
        left = [p for p in tree if running(p)]
        text = child.stdout() + child.stderr()
        bad = "Fatal Python error" in text or "Traceback" in text
        res.say(case, "FAIL" if code or left or bad else "PASS",
                f"launcher exit code {code}, {len(left)} of {len(tree)} still running, an error printed: {bad}\n{text}" if code or left or bad else
                f"launcher exit code 0, {len(tree)} processes gone, no error printed")
    finally:
        for p in [p for p in tree if running(p)]:
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.stop()


def r7_sample_recording(tmp: str, rec: str, res: Results) -> None:
    case = "R7 a captured sample recording passes the page's own player: no path of this PC in it, a jump equals playing"
    node = shutil.which("node")
    if not node:
        res.say(case, "SKIP", "node is not installed")
        return
    out = os.path.join(tmp, "sample.rocodemo.gz")
    deploy = os.path.join(tmp, "deploy")
    os.makedirs(deploy, exist_ok=True)
    cap = subprocess.run([sys.executable, os.path.join(HERE, "capture_demo.py"), rec, "--log", os.path.join(os.path.dirname(rec), "log.txt"),
                          "--deploy-dir", deploy, "--from", "5", "--seconds", "25", "--title", "regress", "--out", out],
                         capture_output=True, text=True, timeout=180)
    if cap.returncode != 0:
        res.say(case, "FAIL", f"capture_demo.py exited {cap.returncode}: {(cap.stdout + cap.stderr)[-400:]}")
        return
    chk = subprocess.run([node, os.path.join(HERE, "check-demo.mjs"), out, "--times", "8,15,22", "--allow-limits"], capture_output=True, text=True, timeout=120)
    if chk.returncode != 0:
        res.say(case, "FAIL", (chk.stdout + chk.stderr)[-600:])
        return
    res.say(case, "PASS", f"{os.path.getsize(out) / 1e6:.2f} MB, {chk.stdout.strip()}")


def r8_demo(tmp: str, res: Results) -> None:
    case = "R8 roco demo serves the page and the sample with no bridge, and Ctrl-C stops it"
    if not os.path.isfile(os.path.join(ROOT, "dist", "index.html")):
        res.say(case, "SKIP", "the page is not built: npm run build")
        return
    web_port = free_port()
    child = Child([LAUNCHER, "demo", "--web-port", str(web_port)], tmp, "r8")
    try:
        t_end = time.time() + 15
        while time.time() < t_end and child.alive() and "[roco] open " not in child.stdout():
            time.sleep(0.05)
        want = f"http://localhost:{web_port}/?demo=1"
        bad = [] if want in child.stdout() else [f"address {want} not printed"]
        for path in ("/?demo=1", "/demo/g1-sample.rocodemo.gz"):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{web_port}{path}", timeout=5) as r:
                    if r.status != 200 or not r.read(64):
                        bad.append(f"{path}: {r.status}")
            except OSError as e:
                bad.append(f"{path}: {e}")
        kids = children(child.pid) if sys.platform.startswith("linux") else []
        if kids:
            bad.append(f"{len(kids)} child process(es): demo starts no bridge")
        os.kill(child.pid, signal.SIGINT)
        code = child.proc.wait(8)
        text = child.stdout() + child.stderr()
        if code or "Traceback" in text:
            bad.append(f"exit code {code}, traceback printed: {'Traceback' in text}")
        res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) + (f"\n{text}" if bad else "") or
                "page and sample served (200), no child process, Ctrl-C exit code 0")
    finally:
        child.stop()


def r10_frame_rate(tmp: str, rec: str, res: Results) -> None:
    case = "R10 the bridge sends 50 binary frames a second, without drift"
    child, port = start_bridge(tmp, "r10", "--replay", rec, "--no-checkpoints")
    ws = None
    try:
        ws = Ws(port)
        while True:                               # frames flow once the replay has sent its status
            op, p = ws.frame()
            if op == 0x1 and is_type(p, "replay"):
                break
        stamps = [ts for ts, op, _ in ws.json_frames(10.0) if op == 0x2]
        gaps = [y - x for x, y in zip(stamps, stamps[1:])]
        worst = max(gaps) if gaps else 99.0
        n = len(stamps)
        ok = 490 <= n <= 510 and worst < 0.1
        res.say(case, "PASS" if ok else "FAIL", f"{n} binary frames in 10 s (want 490 to 510), largest gap {worst * 1000:.0f} ms")
    finally:
        if ws:
            ws.close()
        child.stop()


def r9_record(tmp: str, res: Results) -> None:
    case = "R9 roco record writes what was published, the replay plays it to the end, and Ctrl-C leaves complete rows"
    if not have_dds():
        res.say(case, "SKIP", "unitree_sdk2py is not importable")
        return
    out = os.path.join(tmp, "r9_rec")
    pub = Child([os.path.abspath(__file__), "--publisher", str(DOMAIN), "30", "2.5"], tmp, "r9_pub")
    rec = stopped = None
    bad = []
    try:
        time.sleep(1.0)
        rec = Child([LAUNCHER, "record", "lo", out, "--domain", str(DOMAIN), "--prefix", "run", "--duration", "4"], tmp, "r9_rec")
        code = rec.proc.wait(20)
        text = rec.stdout() + rec.stderr()
        if code or "Traceback" in text:
            bad.append(f"exit code {code}: {text[-400:]}")
        with open(os.path.join(out, "run_lowstate.csv")) as f:
            header = f.readline().strip().split(",")
            rows = [ln.split(",") for ln in f]
        col = {c: i for i, c in enumerate(header)}
        ticks = [int(r[col["tick"]]) for r in rows]
        rolls = [float(r[col["rpy_r"]]) for r in rows]
        span = float(rows[-1][col["t"]]) - float(rows[0][col["t"]]) if len(rows) > 1 else 0.0
        # every tick from the first to the last is a row: no sample lost (--duration counts from the start, and DDS
        # discovery takes part of it, so the count alone says little)
        lost = ticks[-1] - ticks[0] + 1 - len(ticks) if ticks else 0
        if len(rows) < 1000 or lost > len(rows) // 200:
            bad.append(f"{len(rows)} rows over {span:.2f} s, {lost} ticks missing")
        if any(b <= a for a, b in zip(ticks, ticks[1:])):
            bad.append("tick does not always increase")
        if not (rolls and abs(rolls[0]) < 1e-6 and abs(max(rolls) - math.radians(30)) < 1e-5):
            bad.append(f"the published tilt is not in rpy_r (first {rolls[:1]}, max {max(rolls, default=None)})")
        child, port = start_bridge(tmp, "r9_play", "--replay", os.path.join(out, "run"), "--no-checkpoints")
        try:
            ok, detail = play_to_end(port, 30.0)
            if not ok:
                bad.append("replay: " + detail)
        finally:
            child.stop()
        # stopped with Ctrl-C part way: exit code 0, and every line is a complete row
        stopped = Child([LAUNCHER, "record", "lo", out, "--domain", str(DOMAIN), "--prefix", "cut"], tmp, "r9_cut")
        time.sleep(2.5)
        os.kill(stopped.pid, signal.SIGINT)
        code = stopped.proc.wait(8)
        with open(os.path.join(out, "cut_lowstate.csv"), "rb") as f:
            data = f.read()
        lines = data.split(b"\n")
        ends_nl = data.endswith(b"\n")
        if code or not ends_nl or any(ln.count(b",") != len(header) - 1 for ln in lines[1:-1]) or len(lines) < 200:
            bad.append(f"Ctrl-C: exit code {code}, {len(lines) - 2} rows, ends on a newline: {ends_nl}")
        res.say(case, "FAIL" if bad else "PASS", "; ".join(bad) or
                f"{len(rows)} rows over {span:.1f} s, {lost} ticks missing, ticks increasing, the tilt recorded, replay played to the end, Ctrl-C left {len(lines) - 2} complete rows")
    finally:
        for c in (stopped, rec, pub):
            if c:
                c.stop()


def main() -> int:
    ap = argparse.ArgumentParser(description="ROCO bridge regression tests against real processes")
    ap.add_argument("--live", action="store_true", help="also the cases that need DDS (domain 42): R3, R5 and R9")
    ap.add_argument("--publisher", nargs=3, metavar=("DOMAIN", "TILT_DEG", "AFTER_S"), help=argparse.SUPPRESS)
    ap.add_argument("--keep", action="store_true", help="keep the temporary folder")
    args = ap.parse_args()
    if args.publisher:
        publisher_main(int(args.publisher[0]), float(args.publisher[1]), float(args.publisher[2]))
        return 0

    res = Results()
    tmp = tempfile.mkdtemp(prefix="roco_regress_")
    t0 = time.time()
    print(f"[regress] temporary folder {tmp}", flush=True)
    try:
        rec_dir = os.path.join(tmp, "recording")
        write_recording(rec_dir)
        rec = os.path.join(rec_dir, "rec")
        print(f"[regress] recording written in {time.time() - t0:.1f} s", flush=True)
        cases = [("R1", lambda: r1_stuck_client(tmp, rec, res)), ("R2", lambda: r2_cut_recordings(tmp, rec_dir, res)),
                 ("R4", lambda: r4_report_after_jump(tmp, rec, res)), ("R6", lambda: r6_launcher(tmp, rec, res)),
                 ("R7", lambda: r7_sample_recording(tmp, rec, res)), ("R8", lambda: r8_demo(tmp, res)),
                 ("R10", lambda: r10_frame_rate(tmp, rec, res))]
        if args.live:
            cases += [("R3", lambda: r3_old_log(tmp, res)), ("R5", lambda: r5_bridge_restart(tmp, res)),
                      ("R9", lambda: r9_record(tmp, res))]
        for name, run in cases:
            try:
                run()
            except Exception as e:      # a case that cannot run is a failure, not a crash of the rest
                res.say(name, "FAIL", f"{type(e).__name__}: {e}")
    finally:
        if args.keep:
            print(f"[regress] kept {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    n = len(res.rows)
    print(f"[regress] {n - res.failed - sum(1 for _, s in res.rows if s == 'SKIP')} passed, {res.failed} failed, "
          f"{sum(1 for _, s in res.rows if s == 'SKIP')} skipped, {time.time() - t0:.0f} s")
    return 1 if res.failed else 0


if __name__ == "__main__":
    sys.exit(main())
