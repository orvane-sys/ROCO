#!/usr/bin/env python3
"""roco record: writes rt/lowstate and rt/lowcmd to CSV files that `roco replay` plays (see docs/recording-format.md).

    roco record lo my_run                     the simulator on this PC, until Ctrl+C
    roco record enp2s0 my_run --duration 60   the robot, for 60 s

It only reads, like the bridge: the bridge's publisher guard is installed before DDS starts, and it uses the bridge's own readers
and parsers (roco_dds_bridge.DdsSource). It writes only <OUT>/<prefix>_lowstate.csv and <prefix>_lowcmd.csv, never into the
controller's deploy folder, and never over an existing recording. Samples are kept in memory and written in batches every
FLUSH_S, so the work per sample is one list append.
"""
import argparse
import datetime
import os
import signal
import sys
import threading
import time
from typing import List, Optional

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roco_dds_bridge as rb  # noqa: E402

N = rb.N_BODY
IMU_COLS = ["quat_w", "quat_x", "quat_y", "quat_z", "gyro_x", "gyro_y", "gyro_z", "acc_x", "acc_y", "acc_z", "rpy_r", "rpy_p", "rpy_y"]
LS_GROUPS = (("q", "q", "%.9g"), ("dq", "dq", "%.9g"), ("tau_est", "tau", "%.9g"), ("temp0_", "temp0", "%d"),
             ("temp1_", "temp1", "%d"), ("vol_", "vol", "%.9g"), ("motorstate_", "motorstate", "%d"))
LC_GROUPS = ("q", "dq", "kp", "kd", "tau")
LS_COLS = ["t", "unix_t", "tick", "mode_pr", "mode_machine"] + IMU_COLS + [f"{c}{i}" for c, _, _ in LS_GROUPS for i in range(N)]
LC_COLS = ["t", "unix_t"] + [f"{c}{i}" for c in LC_GROUPS for i in range(N)]
# float32 values need 9 significant digits to read back exactly; the times keep microseconds
LS_FMT = ",".join(["%.6f", "%.6f", "%d", "%d", "%d"] + ["%.9g"] * len(IMU_COLS) + [f for _, _, f in LS_GROUPS for _ in range(N)]) + "\n"
LC_FMT = ",".join(["%.6f", "%.6f"] + ["%.9g"] * (len(LC_GROUPS) * N)) + "\n"

FLUSH_S = 0.2          # a batch of samples is written this often
STATUS_S = 5.0         # a status line this often


class CsvSink:
    """Takes the samples DdsSource hands to a monitor (ingest), and writes them in batches (write_pending, from the main thread)."""

    def __init__(self, out: str, prefix: str):
        self.paths = {k: os.path.join(out, f"{prefix}_{k}.csv") for k in ("lowstate", "lowcmd")}
        self.files = {}
        for k, cols in (("lowstate", LS_COLS), ("lowcmd", LC_COLS)):
            f = open(self.paths[k], "x")      # "x": never over an existing recording
            f.write(",".join(cols) + "\n")
            self.files[k] = f
        self.lock = threading.Lock()
        self.states: List = []
        self.cmds: List = []
        self.t0: Optional[float] = None
        self.last_t = {"lowstate": -np.inf, "lowcmd": -np.inf}
        self.rows = {"lowstate": 0, "lowcmd": 0}

    def ingest(self, states, cmds):
        with self.lock:
            self.states += states
            self.cmds += cmds

    def write_pending(self) -> None:
        with self.lock:
            states, self.states = self.states, []
            cmds, self.cmds = self.cmds, []
        if self.t0 is None:
            firsts = [b[0].t for b in (states, cmds) if b]
            if not firsts:
                return
            self.t0 = min(firsts)
        if states:
            self._write("lowstate", self._ls_rows(states), LS_FMT)
        if cmds:
            self._write("lowcmd", self._lc_rows(cmds), LC_FMT)

    def _times(self, key: str, samples) -> np.ndarray:
        # the reader spreads a batch back by its source timestamps; keep each file's times from going backwards across batches
        t = np.maximum.accumulate(np.maximum(np.array([s.t for s in samples]), self.last_t[key]))
        self.last_t[key] = t[-1]
        return t

    def _ls_rows(self, samples) -> np.ndarray:
        m = np.empty((len(samples), len(LS_COLS)))
        m[:, 1] = self._times("lowstate", samples)
        m[:, 0] = m[:, 1] - self.t0
        m[:, 2:5] = [(s.tick, s.mode_pr, s.mode_machine) for s in samples]
        m[:, 5:18] = [(*s.quat, *s.gyro, *s.acc, *s.rpy) for s in samples]
        for k, (_, attr, _) in enumerate(LS_GROUPS):
            m[:, 18 + k * N: 18 + (k + 1) * N] = np.stack([getattr(s, attr)[:N] for s in samples])
        return m

    def _lc_rows(self, samples) -> np.ndarray:
        m = np.empty((len(samples), len(LC_COLS)))
        m[:, 1] = self._times("lowcmd", samples)
        m[:, 0] = m[:, 1] - self.t0
        for k, attr in enumerate(LC_GROUPS):
            m[:, 2 + k * N: 2 + (k + 1) * N] = np.stack([getattr(s, attr)[:N] for s in samples])
        return m

    def _write(self, key: str, m: np.ndarray, fmt: str) -> None:
        f = self.files[key]
        f.write("".join(fmt % tuple(r) for r in m))     # one write per batch, ending on a line boundary
        f.flush()
        self.rows[key] += len(m)

    def close(self) -> None:
        self.write_pending()
        for f in self.files.values():
            f.close()


def inside(path: str, folder: str) -> bool:
    p, d = os.path.realpath(path), os.path.realpath(folder)
    return p == d or p.startswith(d.rstrip(os.sep) + os.sep)


def parse(argv):
    ap = argparse.ArgumentParser(prog="roco record", description="Record rt/lowstate and rt/lowcmd to CSV files that roco replay plays. "
                                 "Only subscribes; writes only into OUT.")
    ap.add_argument("iface", nargs="?", metavar="IFACE", help="DDS interface: lo for the simulator on this PC, or the wired interface to the robot")
    ap.add_argument("out", nargs="?", metavar="OUT", help="folder for the recording (created if missing)")
    ap.add_argument("--domain", type=int, default=0, help="DDS domain id (default 0)")
    ap.add_argument("--prefix", default=None, help="file name prefix (default rec_<date>_<time>)")
    ap.add_argument("--duration", type=float, default=None, metavar="S", help="stop after S seconds (default: run until Ctrl+C)")
    ap.add_argument("--self-test", action="store_true")
    return ap, ap.parse_args(argv)


def check_out(out: str, prefix: str) -> Optional[str]:
    """Why this recording cannot be written there, or None."""
    deploy = rb.default_deploy_dir()
    if inside(out, deploy):
        return f"{out} is inside the controller's deploy folder ({deploy}); ROCO never writes there. Pick another folder."
    for k in ("lowstate", "lowcmd"):
        p = os.path.join(out, f"{prefix}_{k}.csv")
        if os.path.exists(p):
            return f"{p} already exists; pick another --prefix or folder"
    return None


def record(args) -> int:
    sys.stdout.reconfigure(line_buffering=True)
    prefix = args.prefix or datetime.datetime.now().strftime("rec_%Y%m%d_%H%M%S")
    if os.sep in prefix or not prefix:
        print("[roco record] --prefix is a file name, not a path")
        return 2
    why = check_out(args.out, prefix)
    if why:
        print(f"[roco record] {why}")
        return 2
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: stop.set())       # a flag, never an exception in the middle of a write
    try:
        os.makedirs(args.out, exist_ok=True)
        sink = CsvSink(args.out, prefix)
    except OSError as e:
        print(f"[roco record] cannot write to {args.out}: {e}")
        return 2
    try:
        src = rb.DdsSource(sink, args.iface, args.domain, [])     # installs the publisher guard first
    except ImportError as e:
        sink.close()
        print(f"[roco record] live DDS needs unitree_sdk2py and cyclonedds==0.10.2 (see Install in the README): {e}")
        return 2
    src.start()
    print(f"[roco record] writing {sink.paths['lowstate']} and {os.path.basename(sink.paths['lowcmd'])} "
          f"from {args.iface}, domain {args.domain}. Ctrl+C stops.")
    t_start = last_status = time.monotonic()
    last_rows = dict(sink.rows)
    warned = False
    try:
        while not stop.wait(FLUSH_S):
            sink.write_pending()
            now = time.monotonic()
            if args.duration is not None and now - t_start >= args.duration:
                break
            if not warned and sink.rows["lowstate"] == 0 and now - t_start >= STATUS_S:
                warned = True
                print(f"[roco record] no rt/lowstate on {args.iface} (domain {args.domain}) yet. Is the simulator or robot running, "
                      "and is this the interface that reaches it? See Troubleshooting in the README.")
            if now - last_status >= STATUS_S:
                dt = now - last_status
                hz = {k: (sink.rows[k] - last_rows[k]) / dt for k in sink.rows}
                print(f"[roco record] {now - t_start:.0f} s: lowstate {sink.rows['lowstate']} rows ({hz['lowstate']:.0f} Hz), "
                      f"lowcmd {sink.rows['lowcmd']} rows ({hz['lowcmd']:.0f} Hz)")
                last_status, last_rows = now, dict(sink.rows)
    finally:
        src.stop_event.set()
        src.join(timeout=1.0)
        sink.close()
    print(f"[roco record] stopped: {sink.rows['lowstate']} lowstate and {sink.rows['lowcmd']} lowcmd rows in "
          f"{os.path.join(args.out, prefix)}_*.csv. Play it with: roco replay {os.path.join(args.out, prefix)}")
    return 0 if sink.rows["lowstate"] else 1


# ==============================================================================
# Self-test: what CsvSink writes, the replay reads back unchanged
# ==============================================================================
def self_test() -> bool:
    import tempfile
    ok = True

    def check(cond, what):
        nonlocal ok
        ok &= bool(cond)
        print(("PASS " if cond else "FAIL ") + what)

    rng = np.random.default_rng(1)
    M = rb.MOTOR_COUNT

    def ls(i, t):
        s = rb.LowStateSample()
        s.t, s.version, s.tick, s.mode_pr, s.mode_machine = t, (1, 0), 1000 + i, 0, 6
        s.quat, s.gyro, s.acc, s.rpy = (tuple(float(x) for x in rng.standard_normal(k).astype(np.float32)) for k in (4, 3, 3, 3))
        s.imu_temp = 30
        s.mode = np.ones(M, np.uint8)
        s.q, s.dq, s.ddq, s.tau, s.vol = (rng.standard_normal(M).astype(np.float32) * 10 for _ in range(5))
        s.temp0, s.temp1 = (rng.integers(20, 90, M).astype(np.int16) for _ in range(2))
        s.sensor0 = s.sensor1 = np.zeros(M, np.uint32)
        s.motorstate = rng.integers(0, 2 ** 32, M, dtype=np.uint64).astype(np.uint32)
        return s

    def lc(t):
        c = rb.LowCmdSample()
        c.t, c.mode = t, np.ones(M, np.uint8)
        c.q, c.dq, c.tau, c.kp, c.kd = ((rng.standard_normal(N) * 50).astype(np.float32).astype(np.float64) for _ in range(5))
        return c

    print("=" * 72 + "\nroco_record self-test\n" + "=" * 72)
    check(len(LS_COLS) == LS_FMT.count("%") and len(LC_COLS) == LC_FMT.count("%"), "one format per column")
    check(len(set(LS_COLS)) == len(LS_COLS) and len(set(LC_COLS)) == len(LC_COLS), "no column twice")
    with tempfile.TemporaryDirectory() as d:
        t0 = 1_790_000_000.123456
        states = [ls(i, t0 + i * 0.002) for i in range(300)]
        cmds = [lc(t0 + 0.001 + i * 0.002) for i in range(300)]
        sink = CsvSink(d, "run")
        sink.ingest(states[:120], cmds[:100])
        sink.write_pending()
        late = ls(999, t0 + 0.1)        # a sample timed before the last written one: written, but not back in time
        sink.ingest(states[120:] + [late], cmds[100:])
        sink.close()
        store, prefix = rb.resolve_replay(d)
        check(prefix == "run", "the replay finds the recording in its folder")
        got_ls, got_lc = rb.CsvStream(store, "run_lowstate.csv", "ls"), rb.CsvStream(store, "run_lowcmd.csv", "lc")
        rows = []
        while (s := got_ls.pop()) is not None:
            rows.append(s)
        cmd_rows = []
        while (c := got_lc.pop()) is not None:
            cmd_rows.append(c)
        check(len(rows) == 301 and len(cmd_rows) == 300, f"every sample is a row ({len(rows)} lowstate, {len(cmd_rows)} lowcmd)")
        same = all(
            abs(a.t - b.t) < 1e-6 and a.tick == b.tick and a.mode_machine == b.mode_machine
            and np.allclose(a.quat + a.gyro + a.acc + a.rpy, b.quat + b.gyro + b.acc + b.rpy, rtol=0, atol=1e-5)
            and all(np.array_equal(getattr(a, f)[:N], getattr(b, f)[:N]) for f in ("q", "dq", "tau", "vol", "temp0", "temp1", "motorstate"))
            for a, b in zip(states, rows))
        check(same, "lowstate reads back the same: times, tick, IMU, and the 29 joints' q, dq, tau_est, temperatures, voltage, motor state")
        # LowCmd_ carries float32; the replay reads the text as float64, which is the same float32 once cast back
        check(all(abs(a.t - b.t) < 1e-6 and all(np.array_equal(getattr(a, f).astype(np.float32), getattr(b, f).astype(np.float32))
                                                for f in LC_GROUPS)
                  for a, b in zip(cmds, cmd_rows)), "lowcmd reads back the same float32 values: q, dq, kp, kd, tau")
        check(rows[-1].t == rows[-2].t and rows[-1].tick == 1999, "a sample timed before the last written one does not go back in time")
        first = open(os.path.join(d, "run_lowstate.csv")).readlines()[1].split(",")
        check(first[0] == "0.000000" and first[1] == f"{t0:.6f}", "t starts at 0 and unix_t keeps microseconds")

        # a recorder killed mid-write: the replay skips the cut-off row
        with open(os.path.join(d, "run_lowstate.csv"), "rb") as f:
            data = f.read()
        os.makedirs(os.path.join(d, "cut"))
        with open(os.path.join(d, "cut", "x_lowstate.csv"), "wb") as f:
            f.write(data[: len(data) - 40])
        s2 = rb.CsvStream(rb.Store(os.path.join(d, "cut")), "x_lowstate.csv", "ls")
        n = 0
        while s2.pop() is not None:
            n += 1
        check(n == 300, f"a file cut off mid-row still opens and plays its complete rows ({n})")

        check(check_out(d, "run") and "already exists" in check_out(d, "run"), "an existing recording is never written over")
        old = os.environ.get("ROCO_DEPLOY_DIR")
        os.environ["ROCO_DEPLOY_DIR"] = d
        try:
            check("deploy folder" in (check_out(os.path.join(d, "robots", "rec"), "new") or ""), "a folder inside the deploy folder is refused")
        finally:
            if old is None:
                del os.environ["ROCO_DEPLOY_DIR"]
            else:
                os.environ["ROCO_DEPLOY_DIR"] = old
        check(check_out(os.path.join(d, "elsewhere"), "new") is None, "a new prefix in another folder is fine")
        try:
            CsvSink(d, "run")
            check(False, "opening an existing recording for writing fails")
        except FileExistsError:
            check(True, "opening an existing recording for writing fails")

        # cost per batch: what the main thread spends writing 0.2 s of 500 Hz lowstate and lowcmd
        sink = CsvSink(d, "perf")
        big_s, big_c = [ls(i, t0 + i * 0.002) for i in range(100)], [lc(t0 + i * 0.002) for i in range(100)]
        t = time.perf_counter()
        for _ in range(10):
            sink.ingest(big_s, big_c)
            sink.write_pending()
        ms = (time.perf_counter() - t) / 10 * 1e3
        sink.close()
        print(f"     writing one 0.2 s batch (100 lowstate + 100 lowcmd rows) takes {ms:.1f} ms ({ms / 200 * 100:.1f} % of a core)")
        check(ms < 50, "a batch costs under a quarter of its 0.2 s")
    print("ALL TESTS PASSED" if ok else "SOME TESTS FAILED")
    return ok


def main(argv=None) -> int:
    ap, args = parse(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return 0 if self_test() else 1
    if not args.iface or not args.out:
        ap.print_usage()
        print("roco record: IFACE and OUT are needed, e.g. roco record lo my_run")
        return 2
    return record(args)


if __name__ == "__main__":
    sys.exit(main())
