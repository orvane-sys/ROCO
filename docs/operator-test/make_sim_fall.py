#!/usr/bin/env python3
"""Records the simulator rehearsal fall used by the operator test (TEST_MANUAL §5 step 3).

    python3 docs/operator-test/make_sim_fall.py <empty output folder>

Starts unitree_mujoco, g1_record and g1_ctrl on the loopback interface, lowers and releases the band, stands in Velocity for
20 s, then sends `p` (Passive), so the simulated robot collapses, as the manual says it will without a rope. Writes
sim_fall_lowstate.csv, sim_fall_lowcmd.csv and log.txt (g1_ctrl's output) into the folder, which `scripts/roco replay` opens.
Needs a desktop session (the simulator window gets the band keys through python-xlib), and nothing in deploy_lock is changed.
The recording is a SIM run with the real controller; it is not a fall of the real robot. ~150 MB.
"""
import os, pty, subprocess, sys, time, signal, select
from Xlib import X, XK, display
from Xlib.ext import xtest

OUT = sys.argv[1]
DL = os.path.expanduser(os.environ.get("ROCO_DEPLOY_DIR") or "~/unitree_rl_mjlab/deploy_lock")
BUILD = DL + "/robots/g1/build"
SIM = os.path.expanduser("~/unitree_mujoco/simulate/build")
def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

sim = subprocess.Popen(["./unitree_mujoco", "-s", DL + "/sim/g1/scene_type6.xml"], cwd=SIM, stdout=open(OUT + "/sim.log", "w"), stderr=subprocess.STDOUT)
time.sleep(6)
d = display.Display()
def find(root):
    for w in root.query_tree().children:
        try:
            n = w.get_wm_name() or ""
        except Exception:
            n = ""
        if "mujoco" in str(n).lower(): return w
        r = find(w)
        if r: return r
    return None
win = find(d.screen().root)
log("sim window:", bool(win))
def simkey(ch):
    win.set_input_focus(X.RevertToParent, X.CurrentTime); d.sync()
    kc = d.keysym_to_keycode(XK.string_to_keysym(ch))
    xtest.fake_input(d, X.KeyPress, kc); d.sync(); time.sleep(0.08)
    xtest.fake_input(d, X.KeyRelease, kc); d.sync(); time.sleep(0.4)

rec = subprocess.Popen([BUILD + "/g1_record", "lo", OUT + "/sim_fall"], cwd=BUILD, stdout=open(OUT + "/rec.log", "w"), stderr=subprocess.STDOUT)
time.sleep(2)
master, slave = pty.openpty()
ctrl = subprocess.Popen(["./g1_ctrl", "-n", "lo", "-c", "config_hw.yaml"], cwd=BUILD, stdin=slave, stdout=open(OUT + "/log.txt", "w"), stderr=subprocess.STDOUT)
def ckey(k): os.write(master, k.encode()); log("g1_ctrl key", repr(k)); time.sleep(0.3)
try:
    time.sleep(8)
    ckey("f"); time.sleep(4); ckey("v"); time.sleep(2)
    for _ in range(6): simkey("8")
    simkey("9"); log("band released"); time.sleep(12)
    log("standing; waiting"); time.sleep(20)
    ckey("p"); log("p sent: expect the fall"); time.sleep(10)
    ckey("\x03"); time.sleep(4)
finally:
    for p, sig in ((ctrl, signal.SIGINT), (rec, signal.SIGINT)):
        if p.poll() is None: p.send_signal(sig)
    time.sleep(3)
    for p in (ctrl, rec, sim):
        if p.poll() is None: p.terminate()
    time.sleep(1); log("done")
