#!/usr/bin/env python3
"""Records the simulator run the hosted page's sample is cut from: the simulated G1 with the real controller.

    python3 scripts/make_sim_demo.py <empty output folder>

Starts unitree_mujoco (sim/g1/scene_type6.xml), g1_record and g1_ctrl (config/config.yaml, the simulator config with keyboard
walking) on the loopback interface, then: f (FixStand), v (Velocity), n while hanging (refused), lowers and releases the band,
stands, n (squat, which hands back to Velocity by itself), stands, squats again, stands, and stops with Ctrl-C. Writes
sim_demo_lowstate.csv, sim_demo_lowcmd.csv, log.txt (g1_ctrl's output) and events.txt (wall-clock time of each step) into the
folder. Then cut the sample with scripts/capture_demo.py, from a few seconds after the band is released (the events say when).

Needs a desktop session: the simulator window gets the band keys through python-xlib, and a key is sent only while that window
has the focus, so nothing is typed into another window. g1_ctrl runs without --log; nothing in the deploy folder is changed.
"""
import os
import pty
import re
import signal
import subprocess
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

OUT = os.path.abspath(sys.argv[1])
DL = os.path.expanduser(os.environ.get("ROCO_DEPLOY_DIR") or "~/unitree_rl_mjlab/deploy_lock")
BUILD = DL + "/robots/g1/build"
SIM = os.path.expanduser(os.environ.get("ROCO_MUJOCO_DIR") or "~/unitree_mujoco/simulate/build")
CONFIG = "config.yaml"
events = open(os.path.join(OUT, "events.txt"), "w")


def log(*a):
    line = " ".join(str(x) for x in a)
    print(time.strftime("%H:%M:%S"), line, flush=True)
    events.write(f"{time.time():.3f} {line}\n")
    events.flush()


def wait_log(pattern: str, timeout: float, count: int = 1) -> bool:
    """Waits for `count` lines of g1_ctrl's output to match."""
    end = time.monotonic() + timeout
    rx = re.compile(pattern)
    while time.monotonic() < end:
        with open(os.path.join(OUT, "log.txt"), errors="ignore") as f:
            if sum(1 for line in f if rx.search(line)) >= count:
                return True
        time.sleep(0.25)
    return False


procs = []
sim = subprocess.Popen(["./unitree_mujoco", "-s", DL + "/sim/g1/scene_type6.xml"], cwd=SIM,
                       stdout=open(OUT + "/sim.log", "w"), stderr=subprocess.STDOUT)
procs.append(sim)
time.sleep(6)
d = display.Display()


def find(root):
    for w in root.query_tree().children:
        try:
            n = w.get_wm_name() or ""
        except Exception:
            n = ""
        if "mujoco" in str(n).lower():
            return w
        r = find(w)
        if r:
            return r
    return None


win = find(d.screen().root)
if win is None:
    sim.terminate()
    raise SystemExit("no simulator window found")


def focused_on_sim() -> bool:
    f = d.get_input_focus().focus
    while f not in (None, 0, X.NONE, X.PointerRoot):
        if f.id == win.id:
            return True
        try:
            f = f.query_tree().parent
        except Exception:
            return False
    return False


def simkey(ch: str) -> bool:
    """One key to the simulator window, only if the focus is on it once asked for."""
    win.set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()
    time.sleep(0.05)
    if not focused_on_sim():
        log("simulator window lost the focus; key", ch, "not sent")
        return False
    kc = d.keysym_to_keycode(XK.string_to_keysym(ch))
    xtest.fake_input(d, X.KeyPress, kc)
    d.sync()
    time.sleep(0.08)
    xtest.fake_input(d, X.KeyRelease, kc)
    d.sync()
    time.sleep(0.4)
    return True


rec = subprocess.Popen([BUILD + "/g1_record", "lo", OUT + "/sim_demo"], cwd=BUILD,
                       stdout=open(OUT + "/rec.log", "w"), stderr=subprocess.STDOUT)
procs.append(rec)
time.sleep(2)
master, slave = pty.openpty()
ctrl = subprocess.Popen(["./g1_ctrl", "-n", "lo", "-c", CONFIG], cwd=BUILD, stdin=slave,
                        stdout=open(OUT + "/log.txt", "w"), stderr=subprocess.STDOUT)
procs.insert(0, ctrl)


def ckey(k: str, note: str = ""):
    os.write(master, k.encode())
    log("g1_ctrl key", repr(k), note)
    time.sleep(0.3)


ok = False
try:
    time.sleep(8)
    ckey("f", "FixStand")
    time.sleep(4.5)
    ckey("v", "Velocity, hanging")
    time.sleep(2)
    ckey("n", "squat request while hanging: must be refused")
    log("refused" if wait_log(r"request cancelled", 10) else "NOT refused")
    time.sleep(1)
    sent = sum(simkey("8") for _ in range(6))
    released = simkey("9")
    if sent < 6 or not released:
        raise SystemExit("the band keys did not all reach the simulator")
    log("band released")
    time.sleep(12)
    log("standing")
    ckey("n", "squat")
    if not wait_log(r"Change state from squat to Velocity", 40):
        raise SystemExit("the squat did not hand back to Velocity")
    log("squat done, standing")
    # No turn in place: q and e turn at a fixed 0.8 rad/s, and starting or stopping that kicked an ankle pitch to 15 Nm, the real
    # checklist's T5 limit, in three runs out of three. A second squat instead.
    time.sleep(8)
    ckey("n", "squat again")
    if not wait_log(r"Change state from squat to Velocity", 40, count=2):
        raise SystemExit("the second squat did not hand back to Velocity")
    log("second squat done, standing")
    time.sleep(25)
    log("end of the useful part")
    ok = True
    ckey("\x03", "Ctrl-C")
    time.sleep(4)
finally:
    for p, sig in ((ctrl, signal.SIGINT), (rec, signal.SIGINT)):
        if p.poll() is None:
            p.send_signal(sig)
    time.sleep(3)
    for p in procs:
        if p.poll() is None:
            p.terminate()
    time.sleep(1)
    for p in procs:
        if p.poll() is None:
            p.kill()
    log("done" if ok else "stopped early")
sys.exit(0 if ok else 1)
