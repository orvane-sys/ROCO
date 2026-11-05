#!/usr/bin/env python3
"""
Makes the page's sample recording: what the real bridge sends for a window of a g1_record recording, saved for the browser to play.

  python3 scripts/capture_demo.py <prefix> --log <g1_ctrl log> --config <config yaml> --from 155 --seconds 60 \
      --title "Unitree G1 squat test" --out public/demo/g1-sample.rocodemo.gz

GitHub Pages cannot run the bridge, so src/services/recordedBridge.ts plays this file in its place. The window is copied to a temporary
folder; the recording, the log and the config are only read.

The file is a gzip of records [u32 ms][u8 kind][u32 len][payload], little-endian. ms is data time since the window's first sample.
kind is GREETING (what a page gets when it connects at the first moment), PLAY (the frames of a 1x play-through) or SNAPSHOT (what the
bridge sends after a seek to a whole second), plus BINARY for a binary frame. Replay status frames are not stored: the page makes them.
"""
import argparse
import datetime
import gzip
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import time
from typing import List, Tuple

from regress import Ws, control, is_type, start_bridge
from roco_dds_bridge import parse_log_line

GREETING, PLAY, SNAPSHOT, BINARY = 0, 1, 2, 0x80
RECORD = struct.Struct("<IBI")
STORE_NAME = "g1-sample"        # the folder the bridge reads, so the name in its frames says nothing about this PC
ABS_PATH = re.compile(r"(?:/home/|/Users/|/root/|/tmp/|[A-Za-z]:\\)[^\s'\",)]*")
LIMIT_BYTES = 3 * 1024 * 1024


def scrub(value):
    """Every string with its absolute paths cut down to the file or folder name."""
    if isinstance(value, str):
        return ABS_PATH.sub(lambda m: re.split(r"[/\\]", m[0].rstrip("/\\"))[-1], value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def cut_csv(src: str, dst: str, t_from: float, seconds: float) -> Tuple[float, int]:
    """Copies the rows of the window, unchanged. Returns (last row's time, rows)."""
    with open(src, "rb") as f, open(dst, "wb") as out:
        header = f.readline()
        out.write(header)
        it = header.decode().strip().split(",").index("unix_t")
        last, n = None, 0
        for line in f:
            if not line.endswith(b"\n"):
                break
            t = float(line.split(b",", it + 1)[it])
            if t < t_from:
                continue
            if t > t_from + seconds:
                break
            out.write(line)
            last = t
            n += 1
    if n == 0:
        raise SystemExit(f"no rows in the window in {src}")
    return last, n


def cut_log(log: str, dst: str, t0: float, t1: float) -> int:
    """The log lines of the window. g1_ctrl's last Config line and state change before it are repeated just before its first moment:
    the bridge only reads 30 s back, and without them the state would be unknown until the next change."""
    config, state, kept = None, None, []
    with open(log, errors="ignore") as f:
        for line in f:
            p = parse_log_line(line)
            if not p or p[0] > t1 + 1:
                continue
            if p[0] >= t0 - 30:
                kept.append(line.rstrip("\n"))
            elif p[2].startswith("Config:"):
                config = p
            elif "Change state" in p[2]:
                state = p
    stamp = lambda t: datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    head = [f"[{stamp(t0 - 2 + i * 0.5)}] [{p[1]}] {p[2]}" for i, p in enumerate(q for q in (config, state) if q)]
    with open(dst, "w") as out:
        out.write("\n".join(head + kept) + "\n")
    return len(head) + len(kept)


class Capture:
    def __init__(self, port: int):
        self.ws, self.port = Ws(port), port

    def status(self, timeout: float = 10.0) -> dict:
        end = time.monotonic() + timeout
        while True:
            op, p = self.ws.frame(max(0.01, end - time.monotonic()))
            if op == 0x1 and is_type(p, "replay"):
                return json.loads(p)

    def wait(self, ready, timeout: float = 120.0) -> dict:
        end = time.monotonic() + timeout
        while True:
            s = self.status()
            if ready(s):
                return s
            if time.monotonic() > end:
                raise SystemExit(f"the bridge did not get ready: {s}")

    def greeting(self, title: str, recorded: str, note: str) -> List[Tuple[int, bytes]]:
        """What a page connecting now receives, with the sample's name in the hello."""
        ws = Ws(self.port)
        out: List[Tuple[int, bytes]] = []
        try:
            while True:
                op, p = ws.frame(5.0)
                if op == 0x2:
                    out.append((BINARY, p))
                    continue
                f = scrub(json.loads(p))
                if f["type"] == "hello":
                    f["demo"] = {"title": title, "recorded": recorded}
                    f["replay"]["notes"] = [*f["replay"]["notes"], note]
                out.append((0, compact(f)))
                if f["type"] == "replay":
                    return out
        finally:
            ws.close()

    def play(self, t0: float) -> List[Tuple[int, int, bytes]]:
        """A 1x play-through. Each frame is stamped with the data time of the step that sent it: a step sends binary, aux, fsm."""
        control(self.ws, "play")
        out: List[Tuple[int, int, bytes]] = []
        waiting: List[bytes] = []
        ms = 0
        while True:
            op, p = self.ws.frame(5.0)
            if op == 0x2:
                waiting.append(p)
                continue
            f = scrub(json.loads(p))
            if f["type"] == "aux":
                ms = max(0, round((f["t"] - t0) * 1e3))
                out += [(ms, BINARY, b) for b in waiting] + [(ms, 0, compact(f))]
                waiting = []
            elif f["type"] == "fsm":
                out.append((ms, 0, compact(f)))
            elif f["type"] == "replay" and f.get("ended"):
                return out

    def snapshot(self, t0: float, t: float) -> List[Tuple[int, bytes]]:
        """The frames that follow a seek to t: the moment's binary frame and aux, then the full fsm frame."""
        control(self.ws, "seek", t)
        self.wait(lambda s: not s["busy"] and abs(s["t"] - t) < 1.0)
        out: List[Tuple[int, bytes]] = []
        while True:
            op, p = self.ws.frame(5.0)
            if op == 0x2:
                out.append((BINARY, p))
                continue
            f = scrub(json.loads(p))
            if f["type"] == "aux" and not any(k == 0 and b'"aux"' in q[:12] for k, q in out):
                out.append((0, compact(f)))
            elif f["type"] == "fsm" and f.get("full"):
                out.append((0, compact(f)))
                return out


def compact(frame: dict) -> bytes:
    return json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode()


def main() -> int:
    ap = argparse.ArgumentParser(description="Make the page's sample recording from a g1_record recording")
    ap.add_argument("prefix", help="recording: the path before _lowstate.csv")
    ap.add_argument("--log", required=True, help="the run's g1_ctrl log")
    ap.add_argument("--config", default=None, help="the run's g1_ctrl config")
    ap.add_argument("--deploy-dir", default=os.environ.get("ROCO_DEPLOY_DIR"), help="deploy folder for the robot model and the manual")
    ap.add_argument("--from", dest="start", type=float, default=0.0, help="start of the window, seconds into the recording")
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--rate", type=float, default=50.0, help="dashboard frame rate in Hz")
    ap.add_argument("--title", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="roco_capture_")
    child = None
    try:
        store = os.path.join(tmp, STORE_NAME)
        os.makedirs(store)
        name = os.path.basename(args.prefix)
        with open(args.prefix + "_lowstate.csv", "rb") as f:
            header = f.readline().decode().strip().split(",")
            first_t = float(f.readline().split(b",", header.index("unix_t") + 1)[header.index("unix_t")])
        t0 = first_t + args.start
        t1, rows = cut_csv(args.prefix + "_lowstate.csv", os.path.join(store, name + "_lowstate.csv"), t0, args.seconds)
        cut_csv(args.prefix + "_lowcmd.csv", os.path.join(store, name + "_lowcmd.csv"), t0, args.seconds)
        lines = cut_log(args.log, os.path.join(store, "log.txt"), t0, t1)
        if args.config:
            shutil.copy(args.config, store)
        print(f"[capture] window {args.start:.1f} s + {t1 - t0:.1f} s: {rows} lowstate rows, {lines} log lines", flush=True)

        extra = ["--replay", store, "--rate", str(args.rate)] + (["--deploy-dir", args.deploy_dir] if args.deploy_dir else [])
        child, port = start_bridge(tmp, "capture", *extra)
        cap = Capture(port)
        control(cap.ws, "pause")
        cap.wait(lambda s: s["statsPass"] == "done" and s["t1"] is not None)
        control(cap.ws, "seek", t0)
        cap.wait(lambda s: not s["busy"] and abs(s["t"] - t0) < 1.0)

        recorded = datetime.datetime.fromtimestamp(t0).strftime("%Y-%m-%d")
        note = f"a {t1 - t0:.0f} s cut of {name}, from {args.start:.0f} s; its Config line and last state change are repeated at its start"
        records = [(0, GREETING | k, p) for k, p in cap.greeting(args.title, recorded, note)]
        t_play = time.monotonic()
        print("[capture] playing at 1x", flush=True)
        records += [(ms, PLAY | k, p) for ms, k, p in cap.play(t0)]
        print(f"[capture] played in {time.monotonic() - t_play:.1f} s, seeking", flush=True)
        n_seek = 0
        for sec in range(int(t1 - t0) + 1):
            records += [(sec * 1000, SNAPSHOT | k, p) for k, p in cap.snapshot(t0, t0 + sec)]
            n_seek += 1
        cap.ws.close()

        raw = b"".join(RECORD.pack(ms, kind, len(p)) + p for ms, kind, p in records)
        data = gzip.compress(raw, 9, mtime=0)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "wb") as f:
            f.write(data)
        print(f"[capture] {len(records)} records, {n_seek} snapshots, {len(raw) / 1e6:.2f} MB -> {args.out}: {len(data) / 1e6:.2f} MB", flush=True)
        if len(data) > LIMIT_BYTES:
            print(f"[capture] over the {LIMIT_BYTES / 1e6:.1f} MB budget: shorten the window or lower --rate")
            return 1
        return 0
    finally:
        if child is not None:
            child.stop()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
