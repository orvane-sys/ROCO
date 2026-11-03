#!/usr/bin/env python3
"""
Read-only DDS monitor bridge for the ROCO dashboard (Unitree G1, unitree_hg messages).

Live:   subscribes to rt/lowstate, rt/lowcmd, odometry (rt/sportmodestate in unitree_mujoco,
        rt/odommodestate on the robot) and rt/lf/bmsstate, on any interface (lo = simulator).
Replay: plays g1_record recordings (<prefix>_lowstate.csv / _lowcmd.csv), from a folder or a zip.

It never publishes: no DDS writer can be created in this process (see install_no_publisher_guard),
so it cannot command the robot and does not trip g1_ctrl's "other lowcmd publisher" check, exactly
like g1_record. WebSocket frames from the dashboard are ignored, except replay controls.

To the dashboard (ws://127.0.0.1:8765):
  binary  2092-byte LowState_ frame (ROCO layout, real temperatures/voltages/motorstate; pelvis
          position from odometry in reserve[0..2]) whenever a new rt/lowstate sample arrived.
  text    {"type":"hello"} on connect: limits from the controller config and the robot model.
          {"type":"aux"} every frame: lowcmd, PD demand, window maxima, link rates, alerts.
          {"type":"fsm"} g1_ctrl state from its log (--ctrl-log), on change.
          {"type":"replay"} playback position (replay only).

PD demand = kp*(q_cmd-q) + kd*(dq_cmd-dq) + tau with the latest lowcmd before each lowstate,
computed for every sample (about 1 kHz), the same formula and pairing as deploy_lock's real_log.py.
"""

import argparse
import asyncio
import datetime
import hashlib
import json
import math
import os
import re
import struct
import sys
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import deque
from typing import Dict, List, Optional, Tuple

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mujoco_roco_bridge import (  # noqa: E402
    LOOPBACK_HOSTS,
    LOW_STATE_BYTE_LENGTH,
    MOTOR_COUNT,
    OFFSET_CRC,
    OFFSET_MOTOR_STATE_ARRAY,
    OFFSET_STATE_RESERVE,
    ROBOT_PROFILES,
    AccessPolicy,
    BuiltinWebSocketServer,
    calc_crc32,
)

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False


# ==============================================================================
# Robot facts (G1 29-DoF, waist locked, mode_machine 6)
# ==============================================================================
N_BODY = 29                       # body motors; g1_record logs these 29 (kMotors)
LEG = np.arange(12)
ANKLE_PITCH = (4, 10)
ANKLE_ROLL = (5, 11)
KNEE = (3, 9)
# Each ankle joint is driven by 2 x 5020 motors (HW_TEST_REPORT_2026-10-24 §9.6); one motor peaks at
# 24.8 Nm (real_log.py ANK_PEAK). real_log compares the ankle pitch PD demand against this value.
ANKLE_MOTOR_PEAK_NM = 24.8

DEPLOY_LOCK = os.path.expanduser("~/unitree_rl_mjlab/deploy_lock")
DEFAULT_MODEL = os.path.join(DEPLOY_LOCK, "sim/g1/g1_29dof_type6.xml")
DEFAULT_CFG_SIM = os.path.join(DEPLOY_LOCK, "robots/g1/config/config.yaml")
DEFAULT_CFG_HW = os.path.join(DEPLOY_LOCK, "robots/g1/config/config_hw.yaml")
DEFAULT_CTRL_LOG = os.path.join(DEPLOY_LOCK, "robots/g1/log/log.txt")
MANUAL_PATH = os.path.join(DEPLOY_LOCK, "TEST_MANUAL.md")

PROFILE_JOINT_NAMES = [name for name, _, _ in ROBOT_PROFILES["g1_29dof"]["joints"]]


# ==============================================================================
# No-publisher guard
# ==============================================================================
_GUARD_INSTALLED = False


def _forbidden(*_args, **_kwargs):
    raise RuntimeError("roco_dds_bridge is read-only: creating a DDS writer is forbidden in this process")


def install_no_publisher_guard():
    """Makes every way of creating a DDS writer (unitree_sdk2py and cyclonedds) raise."""
    global _GUARD_INSTALLED
    from cyclonedds import pub as cdds_pub
    from unitree_sdk2py.core import channel as ch

    ch.ChannelPublisher.__init__ = _forbidden
    ch.ChannelFactory.CreateSendChannel = _forbidden
    ch.Channel.SetWriter = _forbidden
    cdds_pub.DataWriter.__init__ = _forbidden
    _GUARD_INSTALLED = True


# ==============================================================================
# Samples and raw CDR parsing
# ==============================================================================
class LowStateSample:
    __slots__ = ("t", "version", "tick", "mode_pr", "mode_machine", "quat", "gyro", "acc", "rpy", "imu_temp",
                 "mode", "q", "dq", "ddq", "tau", "temp0", "temp1", "vol", "sensor0", "sensor1", "motorstate")


class LowCmdSample:
    __slots__ = ("t", "mode", "q", "dq", "tau", "kp", "kd")


# Python deserialisation of one LowState_ takes ~260 us; the raw CDR stream is parsed with numpy instead.
# Offsets are into the serialised sample including its 4-byte encapsulation header. Past the IMU, CDR
# alignment puts every MotorState_ field at the same offset as ROCO's C-layout frame (motor 0's mode byte
# excepted). Verified field by field against LowState_.deserialize() in --self-test.
_CDR_LS_HEAD = struct.Struct("<2IBBxxI4f3f3f3fh")   # version..imu temperature, at offset 4
_CDR_LS_MOTOR = np.dtype({
    "names": ["q", "dq", "ddq", "tau", "t0", "t1", "vol", "s0", "s1", "ms"],
    "formats": ["<f4", "<f4", "<f4", "<f4", "<i2", "<i2", "<f4", "<u4", "<u4", "<u4"],
    "offsets": [0, 4, 8, 12, 16, 18, 20, 24, 28, 32],
    "itemsize": 56,
})
_CDR_LS_MOTOR_Q0 = 76        # motor k: q at 76 + 56k, mode byte at 72 + 56k (k >= 1), 74 (k = 0)
_CDR_LC_MOTOR = np.dtype({
    "names": ["q", "dq", "tau", "kp", "kd"],
    "formats": ["<f4"] * 5,
    "offsets": [0, 4, 8, 12, 16],
    "itemsize": 28,
})
_CDR_LC_MOTOR_Q0 = 8         # motor k: q at 8 + 28k, mode byte at 4 + 28k (k >= 1), 6 (k = 0)
_CDR_LE = (0x01, 0x07)       # CDR_LE / CDR2_LE plain encapsulation (identical layout for these types)
_CDR_LS_LEN = 2092
_CDR_LC_LEN = 1004


def parse_lowstate_cdr(data: bytes, t: float) -> Optional[LowStateSample]:
    if len(data) != _CDR_LS_LEN or data[0] != 0 or data[1] not in _CDR_LE:
        return None
    h = _CDR_LS_HEAD.unpack_from(data, 4)
    m = np.ndarray((MOTOR_COUNT,), _CDR_LS_MOTOR, buffer=data, offset=_CDR_LS_MOTOR_Q0)
    mode = np.ndarray((MOTOR_COUNT,), np.uint8, buffer=data, offset=_CDR_LS_MOTOR_Q0 - 4, strides=(56,)).copy()
    mode[0] = data[_CDR_LS_MOTOR_Q0 - 2]
    s = LowStateSample()
    s.t = t
    s.version = (h[0], h[1])
    s.mode_pr, s.mode_machine, s.tick = h[2], h[3], h[4]
    s.quat, s.gyro, s.acc, s.rpy = h[5:9], h[9:12], h[12:15], h[15:18]
    s.imu_temp = h[18]
    s.mode = mode
    s.q, s.dq, s.ddq, s.tau = m["q"].copy(), m["dq"].copy(), m["ddq"].copy(), m["tau"].copy()
    s.temp0, s.temp1, s.vol = m["t0"].copy(), m["t1"].copy(), m["vol"].copy()
    s.sensor0, s.sensor1, s.motorstate = m["s0"].copy(), m["s1"].copy(), m["ms"].copy()
    return s


def lowstate_from_msg(msg, t: float) -> LowStateSample:
    """Fallback for an encapsulation the fast parser does not handle (deserialised message object)."""
    s = LowStateSample()
    s.t = t
    s.version = tuple(msg.version)
    s.mode_pr, s.mode_machine, s.tick = msg.mode_pr, msg.mode_machine, msg.tick
    imu = msg.imu_state
    s.quat, s.gyro, s.acc, s.rpy = tuple(imu.quaternion), tuple(imu.gyroscope), tuple(imu.accelerometer), tuple(imu.rpy)
    s.imu_temp = imu.temperature
    ms = msg.motor_state
    s.mode = np.array([m.mode for m in ms], np.uint8)
    s.q = np.array([m.q for m in ms], np.float32)
    s.dq = np.array([m.dq for m in ms], np.float32)
    s.ddq = np.array([m.ddq for m in ms], np.float32)
    s.tau = np.array([m.tau_est for m in ms], np.float32)
    s.temp0 = np.array([m.temperature[0] for m in ms], np.int16)
    s.temp1 = np.array([m.temperature[1] for m in ms], np.int16)
    s.vol = np.array([m.vol for m in ms], np.float32)
    s.sensor0 = np.array([m.sensor[0] for m in ms], np.uint32)
    s.sensor1 = np.array([m.sensor[1] for m in ms], np.uint32)
    s.motorstate = np.array([m.motorstate for m in ms], np.uint32)
    return s


_CDR_ODOM_LEN = 516          # unitree_go SportModeState_: position 3f at 84, velocity 3f at 100
_CDR_ODOM = struct.Struct("<3f4x3f")


def parse_odom_cdr(data: bytes) -> Optional[Tuple[tuple, tuple]]:
    if len(data) != _CDR_ODOM_LEN or data[0] != 0 or data[1] not in _CDR_LE:
        return None
    v = _CDR_ODOM.unpack_from(data, 84)
    return v[:3], v[3:]


def parse_lowcmd_cdr(data: bytes, t: float) -> Optional[LowCmdSample]:
    if len(data) != _CDR_LC_LEN or data[0] != 0 or data[1] not in _CDR_LE:
        return None
    m = np.ndarray((MOTOR_COUNT,), _CDR_LC_MOTOR, buffer=data, offset=_CDR_LC_MOTOR_Q0)
    mode = np.ndarray((MOTOR_COUNT,), np.uint8, buffer=data, offset=_CDR_LC_MOTOR_Q0 - 4, strides=(28,)).copy()
    mode[0] = data[_CDR_LC_MOTOR_Q0 - 2]
    c = LowCmdSample()
    c.t = t
    c.mode = mode
    c.q, c.dq, c.tau, c.kp, c.kd = (m[f][:N_BODY].astype(np.float64) for f in ("q", "dq", "tau", "kp", "kd"))
    return c


def lowcmd_from_msg(msg, t: float) -> LowCmdSample:
    mc = msg.motor_cmd[:N_BODY]
    c = LowCmdSample()
    c.t = t
    c.mode = np.array([m.mode for m in msg.motor_cmd], np.uint8)
    c.q = np.array([m.q for m in mc], np.float64)
    c.dq = np.array([m.dq for m in mc], np.float64)
    c.tau = np.array([m.tau for m in mc], np.float64)
    c.kp = np.array([m.kp for m in mc], np.float64)
    c.kd = np.array([m.kd for m in mc], np.float64)
    return c


# ==============================================================================
# ROCO dashboard frame (C layout, src/utils/unitreeBinaryCodec.ts)
# ==============================================================================
_ROCO_HEAD = struct.Struct("<2I2B2xI4f3f3f3fh2x")   # 72 bytes at offset 0
_ROCO_MOTOR = np.dtype({
    "names": ["mode", "q", "dq", "ddq", "tau", "t0", "t1", "vol", "s0", "s1", "ms"],
    "formats": ["u1", "<f4", "<f4", "<f4", "<f4", "<i2", "<i2", "<f4", "<u4", "<u4", "<u4"],
    "offsets": [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 36],
    "itemsize": 56,
})


def _crc_tables():
    """Slicing-by-4 tables for the Unitree CRC (one 32-bit word per step instead of one byte)."""
    t0 = [0] * 256
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
        t0[i] = c
    tables = [t0]
    for _ in range(3):
        p = tables[-1]
        tables.append([((v << 8) & 0xFFFFFFFF) ^ t0[v >> 24] for v in p])
    return tables


_CRC_T0, _CRC_T1, _CRC_T2, _CRC_T3 = _crc_tables()


def fast_crc32(words) -> int:
    """Same result as mujoco_roco_bridge.calc_crc32 (checked in --self-test), about 4x faster."""
    crc = 0xFFFFFFFF
    t0, t1, t2, t3 = _CRC_T0, _CRC_T1, _CRC_T2, _CRC_T3
    for w in words:
        x = crc ^ w
        crc = t3[x >> 24] ^ t2[(x >> 16) & 0xFF] ^ t1[(x >> 8) & 0xFF] ^ t0[x & 0xFF]
    return crc


def pack_roco_frame(s: LowStateSample, pelvis_pos: Optional[Tuple[float, float, float]]) -> bytes:
    """Re-encodes a real LowState_ sample in ROCO's 2092-byte layout. reserve[0..2] = pelvis xyz (0 = unknown)."""
    buf = bytearray(LOW_STATE_BYTE_LENGTH)
    _ROCO_HEAD.pack_into(buf, 0, s.version[0], s.version[1], s.mode_pr, s.mode_machine, s.tick,
                         *s.quat, *s.gyro, *s.acc, *s.rpy, s.imu_temp)
    m = np.ndarray((MOTOR_COUNT,), _ROCO_MOTOR, buffer=buf, offset=OFFSET_MOTOR_STATE_ARRAY)
    m["mode"], m["q"], m["dq"], m["ddq"], m["tau"] = s.mode, s.q, s.dq, s.ddq, s.tau
    m["t0"], m["t1"], m["vol"] = s.temp0, s.temp1, s.vol
    m["s0"], m["s1"], m["ms"] = s.sensor0, s.sensor1, s.motorstate
    x, y, z = pelvis_pos if pelvis_pos else (0.0, 0.0, 0.0)
    struct.pack_into("<3fI", buf, OFFSET_STATE_RESERVE, x, y, z, 0)
    struct.pack_into("<I", buf, OFFSET_CRC, fast_crc32(struct.unpack_from("<522I", buf, 0)))
    return bytes(buf)


# ==============================================================================
# Limits: robot model (torque, range) + g1_ctrl config (safety, locked joints, targets)
# ==============================================================================
def load_limits(model_path: Optional[str], cfg_path: Optional[str], tilt_warn_deg: float,
                tilt_crit_deg: float) -> dict:
    lim = {
        "jointNames": list(PROFILE_JOINT_NAMES),
        "torque": [None] * N_BODY,
        "range": [None] * N_BODY,
        "imuSiteOffset": None,
        "pdTargetRange": None,
        "lockedJoints": [],
        "modeMachine": None,
        "safety": {},
        "transitions": {},
        "states": [],
        "ankleMotorPeak": ANKLE_MOTOR_PEAK_NM,
        "tiltWarnDeg": tilt_warn_deg,
        "tiltCritDeg": tilt_crit_deg,
        "model": None,
        "ctrlConfig": None,
        "warnings": [],
    }

    if model_path and os.path.exists(model_path):
        root = ET.parse(model_path).getroot()
        joints = {j.get("name"): j for j in root.iter("joint")}
        motors = [m for m in root.iter("motor")]
        names = [m.get("joint") for m in motors][:N_BODY]
        if names != PROFILE_JOINT_NAMES:
            lim["warnings"].append(f"actuator order in {os.path.basename(model_path)} differs from the SDK motor order")
        for i, name in enumerate(PROFILE_JOINT_NAMES):
            j = joints.get(name)
            if j is None:
                lim["warnings"].append(f"{name} missing from the model")
                continue
            if j.get("range"):
                lo, hi = (float(v) for v in j.get("range").split())
                lim["range"][i] = [lo, hi]
            frc = j.get("actuatorfrcrange")
            if not frc:
                m = next((mm for mm in motors if mm.get("joint") == name), None)
                frc = m.get("ctrlrange") if m is not None else None
            if frc:
                lim["torque"][i] = max(abs(float(v)) for v in frc.split())
        # Simulator odometry (rt/sportmodestate) is the "imu" site position: keep its offset in the pelvis.
        for body in root.iter("body"):
            if body.find("freejoint") is not None or any(j.get("type") == "free" for j in body.findall("joint")):
                site = next((s for s in body.findall("site") if s.get("name") == "imu"), None)
                if site is not None and not site.get("quat") and site.get("pos"):
                    lim["imuSiteOffset"] = [float(v) for v in site.get("pos").split()]
                break
        lim["model"] = os.path.abspath(model_path)
    else:
        lim["warnings"].append(f"robot model not found ({model_path}): no torque limits or joint ranges")

    if cfg_path and os.path.exists(cfg_path) and HAS_YAML:
        with open(cfg_path) as f:
            cfg = yaml.safe_load(f) or {}
        apply_ctrl_config(lim, cfg)
        lim["ctrlConfig"] = os.path.abspath(cfg_path)
    elif cfg_path:
        lim["warnings"].append(f"controller config not read ({cfg_path}): no safety thresholds")
    return lim


def apply_ctrl_config(lim: dict, cfg: dict):
    fsm = cfg.get("FSM", {}) or {}
    lim["modeMachine"] = fsm.get("mode_machine")
    lim["lockedJoints"] = [int(i) for i in fsm.get("locked_joints", []) or []]
    rng = fsm.get("pd_target_range")
    lim["pdTargetRange"] = [[float(a), float(b)] for a, b in rng][:N_BODY] if rng else None
    s = fsm.get("safety", {}) or {}
    keys = ("temp_warn", "temp_stop", "temp_index", "lowstate_timeout_ms", "policy_stall_ms", "leg_speed_stop", "leg_speed_ms")
    lim["safety"] = {k: s[k] for k in keys if k in s}
    enabled = fsm.get("_", {}) or {}
    lim["states"] = list(enabled)
    lim["transitions"] = {
        name: dict((fsm.get(name) or {}).get("transitions") or {}) for name in enabled if isinstance(fsm.get(name), dict)
    }


# ==============================================================================
# Alerts
# ==============================================================================
_LEVELS = {"info": 0, "warn": 1, "critical": 2}


class AlertBook:
    """Open alerts by key. A condition re-reported within HOLD_S keeps its alert open; then it closes."""

    HOLD_S = 0.5

    def __init__(self):
        self.active: Dict[str, dict] = {}
        self.pending: List[dict] = []

    def step(self, t: float, scope: str, conds: Dict[str, tuple]):
        """conds: key -> (level, kind, joint_index | None, value, text). Closes this scope's absent keys."""
        for key, (level, kind, joint, value, text) in conds.items():
            a = self.active.get(key)
            if a is None:
                a = {"id": key, "scope": scope, "kind": kind, "joint": joint, "level": level, "peakLevel": level,
                     "value": value, "peak": value, "since": t, "last": t, "text": text, "critSamples": 0}
                self.active[key] = a
                self.pending.append({"event": "open", **_public(a)})
            else:
                a["level"], a["value"], a["last"], a["text"] = level, value, t, text
                if _LEVELS[level] > _LEVELS[a["peakLevel"]]:
                    a["peakLevel"] = level
                if value is not None and (a["peak"] is None or abs(value) > abs(a["peak"])):
                    a["peak"] = value
            if level == "critical":
                a["critSamples"] += 1
        for key in [k for k, a in self.active.items() if a["scope"] == scope and k not in conds]:
            a = self.active[key]
            if t - a["last"] >= self.HOLD_S or t < a["last"]:
                del self.active[key]
                self.pending.append({"event": "close", **_public(a), "durationS": round(a["last"] - a["since"], 3)})

    def clear(self):
        self.active.clear()
        self.pending.clear()

    def take_pending(self) -> List[dict]:
        p, self.pending = self.pending, []
        return p


def _public(a: dict) -> dict:
    return {k: v for k, v in a.items() if k not in ("scope", "critSamples")}


# ==============================================================================
# Monitor: full-rate statistics shared by live DDS and replay
# ==============================================================================
_LOG_RE = re.compile(r"\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\] \[(\w+)\] (.*)")
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_CHANGE_RE = re.compile(r"FSM: Change state from (\w+) to (\w+)")
_INFO_PREFIXES = ("Config:", "Robot type", "Policy directory", "Loaded motion", "State_squat: motion CRC",
                  "Safety: leg runaway", "FSM: 'n' requested", "Exit")
# Info-level g1_ctrl lines that TEST_MANUAL section 3 checks by eye. The formats are in deploy_lock
# (TransitionBlend.h stats(), CtrlFSM.h start-up safety lines, the "first 2s in" report).
_POLICY_RE = re.compile(r"(\w+) policy: (\d+) steps, first after ([\d.]+) ms, step interval max ([\d.]+) ms")
_FIRST2S_RE = re.compile(r"FSM: first 2s in (\w+): max cmd step legs=([\d.]+) arms=([\d.]+) deg/tick, "
                         r"max joint speed legs=([\d.]+) arms=([\d.]+) rad/s")
_START_TEMP_RE = re.compile(r"Safety: motor temperatures \[0\]/\[1\] at start:(.*)")
_START_MS_RE = re.compile(r"Safety: motorstate at start:(.*)")


def parse_health(text: str) -> Optional[dict]:
    """A g1_ctrl health line as numbers, or None. Never raises on a line it does not know."""
    m = _POLICY_RE.search(text)
    if m:
        return {"kind": "policyTiming", "policy": m[1], "steps": int(m[2]), "firstMs": float(m[3]),
                "intervalMaxMs": float(m[4])}
    m = _FIRST2S_RE.search(text)
    if m:
        return {"kind": "first2s", "state": m[1], "cmdStepLegs": float(m[2]), "cmdStepArms": float(m[3]),
                "speedLegs": float(m[4]), "speedArms": float(m[5])}
    m = _START_TEMP_RE.search(text)
    if m:
        try:
            pairs = [tuple(int(v) for v in tok.split("/")) for tok in m[1].split()]
        except ValueError:
            return None
        return {"kind": "startTemps", "maxC": max((max(p) for p in pairs), default=None), "motors": len(pairs)}
    m = _START_MS_RE.search(text)
    if m:
        try:
            states = [int(tok, 16) for tok in m[1].split()]
        except ValueError:
            return None
        return {"kind": "startMotorstate", "nonzero": [i for i, v in enumerate(states) if v], "motors": len(states)}
    return None


def parse_log_line(line: str) -> Optional[Tuple[float, str, str]]:
    """g1_ctrl (spdlog) line '[YYYY-mm-dd HH:MM:SS.fff] [level] text' -> (unix time, level, text). Local time."""
    m = _LOG_RE.match(_ANSI_RE.sub("", line).rstrip("\r\n"))
    if not m:
        return None
    t = datetime.datetime.strptime(m[1], "%Y-%m-%d %H:%M:%S.%f").timestamp()
    return t, m[2], m[3]


def _r(a, nd=5) -> list:
    return np.round(np.asarray(a, np.float64), nd).tolist()


class Monitor:
    DT_BIN_S = 1e-7
    DT_BINS = 200_000

    def __init__(self, limits: dict, source: str):
        self.limits = limits
        self.source = source
        self.lock = threading.RLock()
        self.torque = np.array([v if v else np.inf for v in limits["torque"]], np.float64)
        rng = limits["range"]
        self.lo = np.array([r[0] if r else -np.inf for r in rng])
        self.hi = np.array([r[1] if r else np.inf for r in rng])
        self.margin = np.where(np.isfinite(self.hi - self.lo), 0.05 * (self.hi - self.lo), 0.0)
        ptr = limits["pdTargetRange"]
        self.ptr_lo = np.array([r[0] for r in ptr]) if ptr else None
        self.ptr_hi = np.array([r[1] for r in ptr]) if ptr else None
        self.locked = np.zeros(N_BODY, bool)
        for i in limits["lockedJoints"]:
            if 0 <= i < N_BODY:
                self.locked[i] = True
        self.valid = ~self.locked
        sf = limits["safety"]
        self.temp_warn = sf.get("temp_warn")
        self.temp_stop = sf.get("temp_stop")
        self.temp_index = sf.get("temp_index", [0, 1])
        self.leg_speed = sf.get("leg_speed_stop")
        self.leg_speed_s = sf.get("leg_speed_ms", 0) / 1000.0
        self.timeout_s = sf.get("lowstate_timeout_ms", 200) / 1000.0
        self.peak = limits["ankleMotorPeak"]
        self.tilt_warn = math.radians(limits["tiltWarnDeg"])
        self.tilt_crit = math.radians(limits["tiltCritDeg"])
        self.names = limits["jointNames"]
        self.alerts = AlertBook()
        self.reset_streams()
        self.fsm_state: Optional[str] = None
        self.fsm_since: Optional[float] = None
        self.fsm_events: deque = deque(maxlen=200)
        self.fsm_new: List[dict] = []
        self.segments: List[dict] = []
        self.segments_changed = False
        self.fsm_rebuilt = False        # after a replay seek: clients must replace their timeline
        self.segment = self._new_segment(None, None)
        self.odom: Optional[dict] = None
        self.bms: Optional[dict] = None

    # -- state ----------------------------------------------------------------------
    def reset_streams(self):
        self.ls: Optional[LowStateSample] = None
        self.cmd: Optional[LowCmdSample] = None
        self.ls_count = 0
        self.cmd_count = 0
        # whole-run histogram of lowstate intervals (0.1 us bins up to 20 ms) for real_log.py's median dt
        self.ls_interval_hist = np.zeros(self.DT_BINS, np.int64)
        self._dt, self._dt_at = None, 0
        self.rate_mark = None          # (t, ls_count, cmd_count)
        self.ls_hz = 0.0
        self.cmd_hz = 0.0
        self.sent_count = -1
        self.dem = np.zeros(N_BODY)
        self.over_samples = np.zeros(N_BODY, np.int64)   # samples with |PD demand| >= joint limit
        self.leg_fast_since = np.full(len(LEG), np.nan)
        self.any_leg_fast = False
        self._reset_window()
        self.window_sent = False

    def _reset_window(self):
        self.w_dem = np.zeros(N_BODY)
        self.w_tau = np.zeros(N_BODY)
        self.w_dq = np.zeros(N_BODY)
        self.w_err = np.zeros(N_BODY)
        self.w_ankle = [0.0, 0.0]
        self.w_ls_gap = 0.0
        self.w_cmd_gap = 0.0
        self.w_tick_gap = 0

    def _new_segment(self, name: Optional[str], t0: Optional[float]) -> dict:
        return {"name": name or "Passive", "t0": t0, "n": 0, "demMax": 0.0, "overN": 0, "run": 0, "bestRun": 0,
                "ankP": 0.0, "ankR": 0.0, "knee": 0.0, "errMax": 0.0, "qd": 0.0, "tilt": [0.0, 0.0], "gyro": 0.0,
                "assumed": name is None}

    def dt_med(self) -> float:
        """Median lowstate interval over the whole run (real_log.py's dt), refreshed every 500 samples."""
        if self.ls_count - self._dt_at >= 500 or self._dt is None:
            self._dt_at = self.ls_count
            c = np.cumsum(self.ls_interval_hist)
            self._dt = (np.searchsorted(c, c[-1] / 2) + 0.5) * self.DT_BIN_S if c[-1] else None
        return self._dt or 0.001

    # Values go out with more digits than the page shows, so the page rounds once, as real_log.py does (not twice).
    def _segment_public(self, seg: dict) -> dict:
        dt = self.dt_med()
        return {
            "name": seg["name"], "t0": seg["t0"], "durS": round(seg["n"] * dt, 3),
            "ankPitchDemandMax": round(seg["demMax"], 4), "ankPitchDemandPct": round(100 * seg["demMax"] / self.peak, 3),
            "overMs": round(seg["overN"] * dt * 1e3, 1), "overRunMs": round(seg["bestRun"] * dt * 1e3, 1),
            "tauAnkP": round(seg["ankP"], 4), "tauAnkR": round(seg["ankR"], 4), "tauKnee": round(seg["knee"], 4),
            "legErrMaxDeg": round(math.degrees(seg["errMax"]), 4), "legDqMax": round(seg["qd"], 4),
            "tiltDeg": [round(math.degrees(v), 4) for v in seg["tilt"]], "gyroMax": round(seg["gyro"], 4),
            "samples": seg["n"],
        }

    # -- inputs ---------------------------------------------------------------------
    def on_lowstate(self, s: LowStateSample):
        self.ingest([s], [])

    def on_lowcmd(self, c: LowCmdSample):
        self.ingest([], [c])

    def ingest(self, states: List[LowStateSample], cmds: List[LowCmdSample]):
        """One batch (a DDS poll, or replay rows up to the next log line), each list in time order.
        Every state sample is paired with the latest command strictly before it (real_log.py's
        searchsorted(K.t, t) - 1), so batching does not change any per-sample number. Alerts are
        evaluated once per batch on the batch's worst values."""
        with self.lock:
            if self.window_sent:            # the window restarts with the first sample after a sent frame
                self._reset_window()
                self.window_sent = False
            prev_cmd = self.cmd
            if cmds:
                self._ingest_cmds(cmds)
            if states:
                self._ingest_states(states, prev_cmd, cmds)

    def _ingest_cmds(self, cmds: List[LowCmdSample]):
        last = self.cmd.t if self.cmd is not None else None
        for c in cmds:
            if last is not None:
                self.w_cmd_gap = max(self.w_cmd_gap, c.t - last)
            last = c.t
        self.cmd = cmds[-1]
        self.cmd_count += len(cmds)
        conds = {}
        for j in np.flatnonzero(self.locked):
            v = max(max(abs(c.q[j]), abs(c.dq[j]), abs(c.kp[j]), abs(c.kd[j]), abs(c.tau[j])) for c in cmds)
            if v != 0:
                conds[f"locked_cmd:{j}"] = ("critical", "locked_cmd", int(j), float(v),
                                            f"{self.names[j]} is locked but was commanded (max |field| {v:.3g})")
        if self.ptr_lo is not None:
            QC = np.array([c.q for c in cmds]) if len(cmds) > 1 else cmds[0].q[None]
            KP = np.array([c.kp for c in cmds]) if len(cmds) > 1 else cmds[0].kp[None]
            out = (self.valid & (KP > 0) & ((QC < self.ptr_lo - 1e-4) | (QC > self.ptr_hi + 1e-4))).any(0)
            for j in np.flatnonzero(out):
                conds[f"pd_target:{j}"] = ("warn", "pd_target", int(j), float(cmds[-1].q[j]),
                                           f"{self.names[j]} target {cmds[-1].q[j]:.3f} rad outside pd_target_range")
        self.alerts.step(cmds[-1].t, "cmd", conds)

    def _ingest_states(self, states: List[LowStateSample], prev_cmd: Optional[LowCmdSample], cmds: List[LowCmdSample]):
        n = len(states)
        ts = np.array([s.t for s in states])
        prev = self.ls
        if prev is not None:
            tt = np.concatenate([[prev.t], ts])
            ticks = [prev.tick] + [s.tick for s in states]
        else:
            tt, ticks = ts, [s.tick for s in states]
        if len(tt) > 1:
            d = np.diff(tt)
            d = d[d > 0]
            if d.size:
                np.add.at(self.ls_interval_hist, np.minimum((d / self.DT_BIN_S).astype(np.int64), self.DT_BINS - 1), 1)
                self.w_ls_gap = max(self.w_ls_gap, float(d.max()))
            self.w_tick_gap = max(self.w_tick_gap, max((b - a) & 0xFFFFFFFF for a, b in zip(ticks, ticks[1:])))
        self.ls = states[-1]
        self.ls_count += n

        Q = np.array([s.q[:N_BODY] for s in states], np.float64)
        DQ = np.array([s.dq[:N_BODY] for s in states], np.float64)
        TAU = np.array([s.tau[:N_BODY] for s in states], np.float64)
        # command for each state: index into [prev_cmd] + cmds, latest with t < state t
        pool = ([prev_cmd] if prev_cmd is not None else []) + cmds
        if pool:
            ct = np.array([c.t for c in pool])
            ci = np.searchsorted(ct, ts, "left") - 1
            have = ci >= 0
            ci = np.maximum(ci, 0)
            stack = lambda f: np.array([getattr(c, f) for c in pool])[ci]
            KP, KD, QC, DQC, TAUC = stack("kp"), stack("kd"), stack("q"), stack("dq"), stack("tau")
            DEM = KP * (QC - Q) + KD * (DQC - DQ) + TAUC
            ERR = np.where(KP > 0, np.abs(QC - Q), 0.0)
            if not have.all():
                DEM[~have] = 0.0
                ERR[~have] = 0.0
        else:
            DEM = np.zeros((n, N_BODY))
            ERR = np.zeros((n, N_BODY))
        self.batch_dem = DEM
        self.dem = DEM[-1]
        ADEM, ADQ, ATAU = np.abs(DEM), np.abs(DQ), np.abs(TAU)
        dem_max, dq_max, tau_max, err_max = ADEM.max(0), ADQ.max(0), ATAU.max(0), ERR.max(0)
        np.maximum(self.w_dem, dem_max, out=self.w_dem)
        np.maximum(self.w_tau, tau_max, out=self.w_tau)
        np.maximum(self.w_dq, dq_max, out=self.w_dq)
        np.maximum(self.w_err, err_max, out=self.w_err)
        ANK = np.stack([(ADEM[:, 4] + ADEM[:, 5]) / 2, (ADEM[:, 10] + ADEM[:, 11]) / 2], 1)   # approx. per motor
        ank = ANK.max(0).tolist()
        self.w_ankle = [max(self.w_ankle[0], ank[0]), max(self.w_ankle[1], ank[1])]
        Tm = tau_max.tolist()
        leg_dq_max = float(dq_max[:12].max())
        RPY = np.array([s.rpy for s in states]) if n > 1 else np.array([states[0].rpy])
        GY = np.array([s.gyro[:2] for s in states]) if n > 1 else np.array([states[0].gyro[:2]])
        tilt_max = np.abs(RPY[:, :2]).max(0).tolist()

        # real_log.py per-state numbers (ankle pitch demand vs one 5020 motor's peak)
        seg = self.segment
        AP = np.maximum(ADEM[:, 4], ADEM[:, 10])
        seg["n"] += n
        seg["demMax"] = max(seg["demMax"], float(AP.max()))
        for o in (AP > self.peak).tolist():
            if o:
                seg["overN"] += 1
                seg["run"] += 1
                if seg["run"] > seg["bestRun"]:
                    seg["bestRun"] = seg["run"]
            else:
                seg["run"] = 0
        seg["ankP"] = max(seg["ankP"], Tm[4], Tm[10])
        seg["ankR"] = max(seg["ankR"], Tm[5], Tm[11])
        seg["knee"] = max(seg["knee"], Tm[3], Tm[9])
        seg["errMax"] = max(seg["errMax"], float(err_max[:12].max()))
        seg["qd"] = max(seg["qd"], leg_dq_max)
        tl = seg["tilt"]
        tl[0], tl[1] = max(tl[0], tilt_max[0]), max(tl[1], tilt_max[1])
        seg["gyro"] = max(seg["gyro"], float(np.abs(GY).max()))

        # alerts: worst value in the batch, stamped with the batch's last time
        t = states[-1].t
        conds = {}
        FRAC = ADEM / self.torque
        over_n = (FRAC >= 1.0).sum(0)
        if over_n.any():
            self.over_samples += over_n
        frac = FRAC.max(0)
        hot = self.valid & (frac >= 0.8)
        if hot.any():
            for j in np.flatnonzero(hot):
                lvl = "critical" if frac[j] >= 1.0 else "warn"
                conds[f"pd:{j}"] = (lvl, "pd_demand", int(j), round(100 * float(frac[j]), 1),
                                    f"{self.names[j]} PD demand {dem_max[j]:.1f} Nm = {100 * frac[j]:.0f}% of {self.torque[j]:g} Nm")
        for side, val in zip(("L", "R"), ank):
            if val >= 0.8 * self.peak:
                lvl = "critical" if val >= self.peak else "warn"
                conds[f"ankle_motor:{side}"] = (lvl, "ankle_motor", None, round(val, 2),
                                                f"{side} ankle motor load ~{val:.1f} Nm of {self.peak} Nm (approx., even linkage split)")
        qmin, qmax = Q.min(0), Q.max(0)
        edge = self.valid & ((qmin <= self.lo + self.margin) | (qmax >= self.hi - self.margin))
        if edge.any():
            for j in np.flatnonzero(edge):
                beyond = qmin[j] < self.lo[j] or qmax[j] > self.hi[j]
                qj = qmin[j] if qmin[j] <= self.lo[j] + self.margin[j] else qmax[j]
                conds[f"range:{j}"] = ("critical" if beyond else "warn", "joint_range", int(j), round(float(qj), 4),
                                       f"{self.names[j]} at {qj:.3f} rad, range [{self.lo[j]:.3f}, {self.hi[j]:.3f}]")
        if self.leg_speed and (leg_dq_max > self.leg_speed or self.any_leg_fast):
            FAST = ADQ[:, :12] > self.leg_speed
            since = self.leg_fast_since
            for k in range(n):                 # per sample: g1_ctrl's "for leg_speed_ms" is a duration
                f = FAST[k]
                since[~f] = np.nan
                since[f & np.isnan(since)] = ts[k]
            fast = FAST[-1]
            self.any_leg_fast = bool(fast.any())
            for j in np.flatnonzero(FAST.any(0)):
                held = 0.0 if np.isnan(since[j]) else t - since[j]
                lvl = "critical" if fast[j] and held >= self.leg_speed_s else "warn"
                conds[f"leg_speed:{j}"] = (lvl, "leg_speed", int(j), round(float(dq_max[j]), 2),
                                           f"{self.names[j]} |dq| {dq_max[j]:.1f} rad/s > {self.leg_speed:g} for {held * 1e3:.0f} ms")
        if self.temp_warn is not None:
            T0 = np.array([s.temp0[:N_BODY] for s in states]).max(0)
            T1 = np.array([s.temp1[:N_BODY] for s in states]).max(0)
            temps = np.stack([T0, T1])[self.temp_index].max(0)
            hot = temps >= self.temp_warn
            if hot.any():
                for j in np.flatnonzero(hot):
                    lvl = "critical" if self.temp_stop is not None and temps[j] >= self.temp_stop else "warn"
                    conds[f"temp:{j}"] = (lvl, "temperature", int(j), int(temps[j]),
                                          f"{self.names[j]} {temps[j]} °C (warn {self.temp_warn}, stop {self.temp_stop})")
        ms = np.bitwise_or.reduce(np.array([s.motorstate[:N_BODY] for s in states]), 0)
        if ms.any():
            for j in np.flatnonzero(ms):
                conds[f"motorstate:{j}"] = ("warn", "motorstate", int(j), int(ms[j]),
                                            f"{self.names[j]} motorstate 0x{int(ms[j]):X}")
        tilt = max(tilt_max)
        if tilt >= self.tilt_warn:
            lvl = "critical" if tilt >= self.tilt_crit else "warn"
            r, p = RPY[-1, 0], RPY[-1, 1]
            conds["tilt"] = (lvl, "tilt", None, round(math.degrees(tilt), 1),
                             f"body tilt roll {math.degrees(r):.1f}°, pitch {math.degrees(p):.1f}°")
        self.alerts.step(t, "ls", conds)

    def on_log_line(self, t: float, level: str, text: str, history: bool = False):
        with self.lock:
            m = _CHANGE_RE.search(text)
            ev = {"t": t, "level": level, "text": text}
            health = parse_health(text)
            if health:
                ev["health"] = health
            if m:
                ev["from"], ev["to"] = m[1], m[2]
                self._change_state(m[2], t)
            elif text.startswith("Config:"):
                ev["session"] = True             # a new g1_ctrl run starts in Passive
                if self.fsm_state in (None, "Passive"):
                    # same state: keep the segment, as real_log.py splits only on "FSM: Change state"
                    self.fsm_state, self.fsm_since = "Passive", self.fsm_since or t
                    self.segment["assumed"] = False
                else:
                    self._change_state("Passive", t)
            elif level not in ("warning", "error", "critical") and not text.startswith(_INFO_PREFIXES) \
                    and not health:
                return
            if history:
                ev["history"] = True
            self.fsm_events.append(ev)
            self.fsm_new.append(ev)

    def on_log_closed(self, t: float):
        """g1_ctrl closed its log (it stopped): its last state is no longer known, and a run without --log must not show it."""
        with self.lock:
            if self.fsm_state is None:
                return
            ev = {"t": t, "level": "warning", "logClosed": True,
                  "text": "g1_ctrl closed its log (it stopped). State unknown until g1_ctrl runs with --log again"}
            self.fsm_state, self.fsm_since = None, None
            self.fsm_events.append(ev)
            self.fsm_new.append(ev)

    def _change_state(self, state: str, t: float):
        if self.segment["n"] >= 5:
            self.segments.append(self.segment)      # raw: durations use the latest median dt when sent
            self.segments = self.segments[-100:]
            self.segments_changed = True
        self.fsm_state, self.fsm_since = state, t
        self.segment = self._new_segment(state, t)

    def on_odom(self, t: float, topic: str, pos, vel):
        with self.lock:
            self.odom = {"t": t, "topic": topic, "pos": tuple(float(v) for v in pos), "vel": tuple(float(v) for v in vel)}

    def on_bms(self, t: float, msg):
        with self.lock:
            self.bms = {"t": t, "soc": int(msg.soc), "bmsVoltageRaw": [int(v) for v in msg.bmsvoltage],
                        "currentRaw": int(msg.current)}

    # -- output ---------------------------------------------------------------------
    def pelvis_position(self) -> Optional[Tuple[float, float, float]]:
        o, s = self.odom, self.ls
        if o is None or s is None:
            return None
        x, y, z = o["pos"]
        if x == 0 and y == 0 and z == 0:
            return None       # publisher without a position source
        off = self.limits["imuSiteOffset"]
        if o["topic"] == "rt/sportmodestate" and off:
            # unitree_mujoco publishes the "imu" site position: pelvis = site - R(quat) * offset
            w, qx, qy, qz = s.quat
            ox, oy, oz = off
            r00, r01, r02 = 1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - w * qz), 2 * (qx * qz + w * qy)
            r10, r11, r12 = 2 * (qx * qy + w * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - w * qx)
            r20, r21, r22 = 2 * (qx * qz - w * qy), 2 * (qy * qz + w * qx), 1 - 2 * (qx * qx + qy * qy)
            x -= r00 * ox + r01 * oy + r02 * oz
            y -= r10 * ox + r11 * oy + r12 * oz
            z -= r20 * ox + r21 * oy + r22 * oz
        return x, y, z

    def link_checks(self, now: float):
        conds = {}
        if self.ls is None:
            pass
        elif now - self.ls.t > self.timeout_s:
            age = now - self.ls.t
            conds["lowstate_timeout"] = ("critical", "lowstate_timeout", None, round(age * 1e3),
                                         f"no rt/lowstate for {age * 1e3:.0f} ms (g1_ctrl goes Passive after {self.timeout_s * 1e3:.0f} ms)")
        if self.cmd is not None and self.ls is not None and now - self.cmd.t > 0.2 and now - self.ls.t < 0.2:
            age = now - self.cmd.t
            conds["lowcmd_silent"] = ("warn", "lowcmd_silent", None, round(age * 1e3),
                                      f"no rt/lowcmd for {age * 1e3:.0f} ms (g1_ctrl stopped?)")
        if self.w_ls_gap > self.timeout_s / 2:
            conds["lowstate_gap"] = ("warn", "lowstate_gap", None, round(self.w_ls_gap * 1e3),
                                     f"rt/lowstate gap {self.w_ls_gap * 1e3:.0f} ms")
        self.alerts.step(now, "link", conds)
        # streams that stopped cannot close their own alerts
        if self.ls is not None and now - self.ls.t > 0.5:
            self.alerts.step(now, "ls", {})
        if self.cmd is not None and now - self.cmd.t > 0.5:
            self.alerts.step(now, "cmd", {})

    def fsm_frame(self, full: bool) -> Optional[dict]:
        """full: everything, for a newly connected client (leaves the broadcast backlog alone)."""
        if full:
            return {"type": "fsm", "full": True, "state": self.fsm_state, "since": self.fsm_since,
                    "events": list(self.fsm_events), "segment": self._segment_public(self.segment),
                    "segments": [self._segment_public(g) for g in self.segments]}
        if self.fsm_rebuilt:
            self.fsm_rebuilt = False
            self.fsm_new = []
            self.segments_changed = False
            return self.fsm_frame(full=True)
        if not self.fsm_new and not self.segments_changed:
            return None
        frame = {"type": "fsm", "full": False, "state": self.fsm_state, "since": self.fsm_since,
                 "events": self.fsm_new, "segment": self._segment_public(self.segment)}
        if self.segments_changed:
            frame["segments"] = [self._segment_public(g) for g in self.segments]
        self.fsm_new = []
        self.segments_changed = False
        return frame

    def snapshot(self, now: float, build: bool = True) -> Tuple[Optional[bytes], Optional[dict], Optional[dict]]:
        """One dashboard frame. build=False (nobody connected): bookkeeping only, backlogs dropped."""
        with self.lock:
            self.link_checks(now)
            if self.rate_mark is None:
                self.rate_mark = (now, self.ls_count, self.cmd_count)
            elif now - self.rate_mark[0] >= 0.5:
                t0, n0, c0 = self.rate_mark
                self.ls_hz = (self.ls_count - n0) / (now - t0)
                self.cmd_hz = (self.cmd_count - c0) / (now - t0)
                self.rate_mark = (now, self.ls_count, self.cmd_count)
            if not build:
                self._reset_window()
                self.alerts.take_pending()
                self.fsm_new = []
                self.segments_changed = False
                return None, None, None

            frame = None
            if self.ls is not None and self.ls_count != self.sent_count:
                frame = pack_roco_frame(self.ls, self.pelvis_position())
                self.sent_count = self.ls_count

            dt = self.dt_med()
            c, s = self.cmd, self.ls
            aux = {
                "type": "aux",
                "t": now,
                "source": self.source,
                "cmd": None if c is None else {
                    "q": _r(c.q), "dq": _r(c.dq), "kp": _r(c.kp, 3), "kd": _r(c.kd, 3), "tau": _r(c.tau, 4),
                    "ageMs": round((now - c.t) * 1e3, 1),
                },
                "demand": _r(self.dem, 3),
                "demandMax": _r(self.w_dem, 3),
                "tauMax": _r(self.w_tau, 3),
                "dqMax": _r(self.w_dq, 3),
                "errMax": _r(self.w_err, 5),
                "overLimitMs": _r(self.over_samples * dt * 1e3, 1),
                "ankleMotor": {"left": round(float((abs(self.dem[4]) + abs(self.dem[5])) / 2), 3),
                               "right": round(float((abs(self.dem[10]) + abs(self.dem[11])) / 2), 3),
                               "leftMax": round(self.w_ankle[0], 3), "rightMax": round(self.w_ankle[1], 3),
                               "peak": self.peak},
                "odom": None,
                "battery": None,
                "link": {
                    "lowstateHz": round(self.ls_hz, 1), "lowcmdHz": round(self.cmd_hz, 1),
                    "lowstateAgeMs": None if s is None else round((now - s.t) * 1e3, 1),
                    "lowcmdAgeMs": None if c is None else round((now - c.t) * 1e3, 1),
                    "lowstateGapMaxMs": round(self.w_ls_gap * 1e3, 2), "lowcmdGapMaxMs": round(self.w_cmd_gap * 1e3, 2),
                    "tickGapMax": int(self.w_tick_gap), "dtMedMs": round(dt * 1e3, 3),
                    "lowstateCount": self.ls_count, "lowcmdCount": self.cmd_count,
                },
                "segment": self._segment_public(self.segment),
                "alerts": [_public(a) for a in self.alerts.active.values()],
                "alertEvents": self.alerts.take_pending(),
            }
            if s is not None:
                aux["imuTemp"] = int(s.imu_temp)
                vols = s.vol[:N_BODY][s.vol[:N_BODY] > 0]
                motor_v = round(float(np.median(vols)), 2) if vols.size else None
                aux["battery"] = {"motorVoltage": motor_v}
            if self.bms is not None:
                aux["battery"] = {**(aux["battery"] or {}), "soc": self.bms["soc"],
                                  "bmsVoltageRaw": self.bms["bmsVoltageRaw"], "currentRaw": self.bms["currentRaw"],
                                  "bmsAgeMs": round((now - self.bms["t"]) * 1e3)}
            o = self.odom
            if o is not None:
                yaw = s.rpy[2] if s is not None else 0.0
                vx, vy, vz = o["vel"]
                cy, sy = math.cos(yaw), math.sin(yaw)
                pp = self.pelvis_position()
                aux["odom"] = {"topic": o["topic"], "x": pp[0] if pp else o["pos"][0], "y": pp[1] if pp else o["pos"][1],
                               "z": pp[2] if pp else o["pos"][2],
                               "vx": round(cy * vx + sy * vy, 4), "vy": round(-sy * vx + cy * vy, 4), "vz": round(vz, 4),
                               "ageMs": round((now - o["t"]) * 1e3, 1)}
            if frame is not None:       # until new samples arrive (paused replay, stopped stream) resend this window
                self.window_sent = True
            fsm = self.fsm_frame(full=False)
            if self.source != "replay":
                aux["fsmStale"] = c is None or now - c.t > 1.0
            return frame, aux, fsm


# ==============================================================================
# Live DDS source
# ==============================================================================
class DdsSource(threading.Thread):
    """Polls the readers in batches every POLL_S (a ctypes listener callback per 1 kHz sample costs far more)."""

    QUEUE = 64          # samples kept per reader between polls (64 ms at 1 kHz)
    POLL_S = 0.02       # ~20 samples per batch; per-sample numbers do not depend on the batch size
    BMS_EVERY_S = 0.5

    def __init__(self, monitor: Monitor, iface: str, domain: int, odom_topics: List[str]):
        super().__init__(name="dds_poll", daemon=True)
        install_no_publisher_guard()
        from cyclonedds.qos import Policy, Qos
        from cyclonedds.sub import DataReader
        from cyclonedds.topic import Topic
        from cyclonedds._clayer import ddspy_take
        from unitree_sdk2py.core import channel as ch
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import SportModeState_
        from unitree_sdk2py.idl.unitree_hg.msg.dds_ import BmsState_, LowCmd_, LowState_

        self.monitor = monitor
        self._take = ddspy_take
        self.types = {"ls": LowState_, "lc": LowCmd_, "odom": SportModeState_, "bms": BmsState_}
        ch.ChannelFactoryInitialize(domain, iface)
        participant = ch.ChannelFactory._ChannelFactory__participant
        qos = Qos(Policy.History.KeepLast(self.QUEUE))
        self.latest: Dict[str, Optional[tuple]] = {}
        self._bms_t = 0.0
        self.errors = 0
        self.stop_event = threading.Event()
        self.readers = []

        def reader(name, typ, cb):
            self.readers.append((DataReader(participant, Topic(participant, name, typ), qos), cb))

        reader("rt/lowstate", LowState_, None)
        reader("rt/lowcmd", LowCmd_, None)
        for name in odom_topics:
            reader(name, SportModeState_, lambda r, n=name: self._keep_latest(r, n))
        reader("rt/lf/bmsstate", BmsState_, lambda r: self._keep_latest(r, "bms"))

    def run(self):
        (ls_reader, _), (lc_reader, _) = self.readers[:2]
        while not self.stop_event.is_set():
            start = time.perf_counter()
            try:
                states = [parse_lowstate_cdr(d, t) or lowstate_from_msg(self.types["ls"].deserialize(d), t)
                          for d, t in self._samples(ls_reader)]
                cmds = [parse_lowcmd_cdr(d, t) or lowcmd_from_msg(self.types["lc"].deserialize(d), t)
                        for d, t in self._samples(lc_reader)]
                if states or cmds:
                    self.monitor.ingest(states, cmds)
            except Exception as e:  # never let a bad sample stop the poller
                self._error("lowstate/lowcmd", e)
            for r, cb in self.readers[2:]:
                cb(r)
            self.stop_event.wait(max(0.0, self.POLL_S - (time.perf_counter() - start)))

    def _samples(self, reader):
        """Raw CDR samples with receive times; a batch is spread back in time by its source timestamps."""
        ret = self._take(reader._ref, self.QUEUE)
        if isinstance(ret, int):
            return []
        now = time.time()
        valid = [(d, i) for d, i in ret if i.valid_data]
        if len(valid) <= 1:
            return [(d, now) for d, _ in valid]
        last = valid[-1][1].source_timestamp
        return [(d, now - max(0, last - i.source_timestamp) * 1e-9) for d, i in valid]

    def _keep_latest(self, reader, key):
        try:
            samples = self._samples(reader)
            if samples:
                self.latest[key] = samples[-1]
        except Exception as e:
            self._error(key, e)

    def _error(self, what, e):
        self.errors += 1
        if self.errors <= 5:
            print(f"[ROCO DDS] {what} sample error: {e!r}")

    def pump(self):
        """Decodes only the newest odometry sample per dashboard frame, BMS at most every BMS_EVERY_S."""
        for key, item in list(self.latest.items()):
            if item is None:
                continue
            data, t = item
            if key == "bms":
                if t - self._bms_t < self.BMS_EVERY_S:
                    continue
                self._bms_t = t
                self.latest[key] = None
                self.monitor.on_bms(t, self.types["bms"].deserialize(data))
            else:
                self.latest[key] = None
                pv = parse_odom_cdr(data)
                if pv is None:
                    msg = self.types["odom"].deserialize(data)
                    pv = msg.position, msg.velocity
                self.monitor.on_odom(t, key, *pv)


def log_open_for_writing(path: str, pid_hint: Optional[str] = None) -> Tuple[Optional[bool], Optional[str]]:
    """Does another process hold `path` open for writing? g1_ctrl keeps log.txt open while it runs with --log, so
    False means the log is an old run's. Returns (answer, writer pid); the answer is None where /proc cannot tell."""
    if not os.path.isdir("/proc/self/fd"):
        return None, None
    target, me = os.path.realpath(path), str(os.getpid())
    pids = [p for p in os.listdir("/proc") if p.isdigit() and p != me]
    if pid_hint in pids:
        pids.insert(0, pid_hint)        # the writer found last time first: one process to look at, not all
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(f"/proc/{pid}/fd/{fd}") != target:
                    continue
                with open(f"/proc/{pid}/fdinfo/{fd}") as fi:
                    flags = next((int(ln.split()[1], 8) for ln in fi if ln.startswith("flags:")), 0)
                if flags & (os.O_WRONLY | os.O_RDWR):       # a reader such as `tail -f` does not count
                    return True, pid
            except (OSError, ValueError):
                pass
    return False, None


class LogTailer(threading.Thread):
    """Follows g1_ctrl's log.txt (read-only). On start it replays the current session's lines, but only while g1_ctrl
    holds the log open: a log nobody writes is an old run's, and its last state is not the robot's state now."""

    BACKFILL_BYTES = 512 * 1024
    WRITER_CHECK_S = 1.0

    def __init__(self, path: str, monitor: Monitor, poll_s: float = 0.1):
        super().__init__(name="ctrl_log", daemon=True)
        self.path, self.monitor, self.poll_s = path, monitor, poll_s
        self.stop_event = threading.Event()

    def _feed(self, lines, history=False):
        for ln in lines:
            p = parse_log_line(ln)
            if p:
                self.monitor.on_log_line(*p, history=history)

    def run(self):
        f, ino, rest, first = None, None, "", True
        writing, pid, checked = None, None, 0.0
        while not self.stop_event.is_set():
            try:
                now = time.time()
                if now - checked >= self.WRITER_CHECK_S:
                    was = writing
                    (writing, pid), checked = log_open_for_writing(self.path, pid), now
                    if was and writing is False:
                        self.monitor.on_log_closed(now)
                st = os.stat(self.path)
                if f is None or st.st_ino != ino or st.st_size < f.tell():
                    if f:
                        f.close()
                    f = open(self.path, "r", errors="ignore")
                    ino, rest = st.st_ino, ""
                    if first:
                        if writing is False:
                            f.seek(0, os.SEEK_END)      # an old run's log: follow only what a new run writes
                            print(f"[ROCO DDS] {self.path} is not open in g1_ctrl (an old run's log): state unknown "
                                  "until g1_ctrl runs with --log")
                        else:
                            # last session only: lines after the latest "Config:" line
                            f.seek(max(0, st.st_size - self.BACKFILL_BYTES))
                            lines = f.read().splitlines()
                            start = max((i for i, ln in enumerate(lines) if "] Config: " in ln), default=None)
                            if start is not None:
                                self._feed(lines[start:], history=True)
                        first = False
                chunk = f.read()
                if chunk:
                    rest += chunk
                    *lines, rest = rest.split("\n")
                    self._feed(lines)
            except FileNotFoundError:
                f, first = None, False      # no old log: a log that appears later is a new run's, read from its start
            except Exception as e:
                print(f"[ROCO DDS] log tail error: {e!r}")
            self.stop_event.wait(self.poll_s)


# ==============================================================================
# Replay of g1_record recordings (folder or zip, read-only)
# ==============================================================================
class Store:
    """Read-only access to a folder tree or a zip file, by relative name."""

    def __init__(self, path: str):
        self.path = path
        self.zip = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None
        if self.zip:
            self.names = [i.filename for i in self.zip.infolist() if not i.is_dir()]
        else:
            self.names = []
            for d, _, files in os.walk(path):
                self.names += [os.path.relpath(os.path.join(d, f), path) for f in files]
        self.names.sort()

    def open(self, name: str):
        if self.zip:
            return self.zip.open(name)
        return open(os.path.join(self.path, name), "rb")

    def size(self, name: str) -> int:
        return self.zip.getinfo(name).file_size if self.zip else os.path.getsize(os.path.join(self.path, name))

    def recordings(self) -> List[str]:
        """Prefixes (relative names without _lowstate.csv) that have both CSV files."""
        names = set(self.names)
        return [n[: -len("_lowstate.csv")] for n in self.names
                if n.endswith("_lowstate.csv") and n[: -len("_lowstate.csv")] + "_lowcmd.csv" in names]


def resolve_replay(spec: str) -> Tuple[Store, str]:
    """<prefix> | <dir> | <zip> | <zip>:<prefix|name> | <dir>:<prefix|name>  ->  (store, recording prefix inside it)."""
    path, _, inner = spec.partition(".zip:") if ".zip:" in spec else (spec, "", "")
    if inner:
        path += ".zip"
    elif ":" in spec and not os.path.exists(spec) and os.path.isdir(spec.rpartition(":")[0]):
        path, _, inner = spec.rpartition(":")
    if os.path.isfile(path + "_lowstate.csv"):
        d = os.path.dirname(os.path.abspath(path))
        store = Store(d)
        return store, os.path.relpath(os.path.abspath(path), d)
    if not os.path.exists(path):
        raise SystemExit(f"replay source not found: {spec}")
    store = Store(path)
    recs = store.recordings()
    if inner:
        match = [r for r in recs if r == inner or r.endswith("/" + inner) or os.path.basename(r) == inner]
        if len(match) != 1:
            raise SystemExit(f"'{inner}' matches {len(match)} recordings in {path}:\n  " + "\n  ".join(recs))
        return store, match[0]
    if len(recs) == 1:
        return store, recs[0]
    listing = "\n  ".join(f"{r}  ({store.size(r + '_lowstate.csv') / 1e6:.0f} MB)" for r in recs)
    raise SystemExit(f"{path} holds {len(recs)} recordings, pick one with {path}:<name>:\n  {listing}")


class CsvStream:
    """One g1_record CSV: rows parsed lazily in file order, with a coarse (t, byte offset) index for seeking."""

    INDEX_EVERY = 1000

    def __init__(self, store: Store, name: str, kind: str):
        self.store, self.name, self.kind = store, name, kind
        self.f = store.open(name)
        header = self.f.readline().decode().strip().split(",")
        self.cols = {c: i for i, c in enumerate(header)}
        self.data_offset = self.f.tell()
        self.ncols = len(header)
        self.index: List[Tuple[float, int]] = []
        self.t_first: Optional[float] = None
        self.t_last: Optional[float] = None
        self.index_done = False
        col = lambda pre: [self.cols[f"{pre}{i}"] for i in range(N_BODY)]
        self.it = self.cols["unix_t"]
        if kind == "ls":
            self.ci = {k: col(p) for k, p in (("q", "q"), ("dq", "dq"), ("tau", "tau_est"), ("t0", "temp0_"),
                                               ("t1", "temp1_"), ("vol", "vol_"), ("ms", "motorstate_"))}
            self.hi = [self.cols[c] for c in ("tick", "mode_pr", "mode_machine", "quat_w", "quat_x", "quat_y", "quat_z",
                                              "gyro_x", "gyro_y", "gyro_z", "acc_x", "acc_y", "acc_z",
                                              "rpy_r", "rpy_p", "rpy_y")]
        else:
            self.ci = {k: col(k) for k in ("q", "dq", "kp", "kd", "tau")}
        self.peeked = None
        self.eof = False

    def build_index(self):
        """Background pass over the file (own handle): offsets every INDEX_EVERY rows and the last time."""
        f = self.store.open(self.name)
        f.readline()
        off, n, last = f.tell(), 0, None
        time_of = lambda ln: float(ln.split(b",", self.it + 1)[self.it])
        for line in f:
            if n % self.INDEX_EVERY == 0:
                t = time_of(line)
                self.index.append((t, off))
                if self.t_first is None:
                    self.t_first = t
            last = line
            off += len(line)
            n += 1
        if last:
            self.t_last = time_of(last)
        self.rows = n
        f.close()
        self.index_done = True

    def _parse(self, line: bytes):
        v = np.fromstring(line, sep=",")
        if v.size != self.ncols:
            return None
        t = float(v[self.it])
        if self.kind == "ls":
            s = LowStateSample()
            s.t = t
            h = v[self.hi]
            s.version = (0, 0)
            s.tick, s.mode_pr, s.mode_machine = int(h[0]), int(h[1]), int(h[2])
            s.quat, s.gyro, s.acc, s.rpy = tuple(h[3:7]), tuple(h[7:10]), tuple(h[10:13]), tuple(h[13:16])
            s.imu_temp = 0
            pad = lambda a, dt: np.concatenate([a.astype(dt), np.zeros(MOTOR_COUNT - N_BODY, dt)])
            s.q, s.dq, s.tau = (pad(v[self.ci[k]], np.float32) for k in ("q", "dq", "tau"))
            s.ddq = np.zeros(MOTOR_COUNT, np.float32)
            s.temp0, s.temp1 = pad(v[self.ci["t0"]], np.int16), pad(v[self.ci["t1"]], np.int16)
            s.vol = pad(v[self.ci["vol"]], np.float32)
            s.motorstate = pad(v[self.ci["ms"]], np.uint32)
            s.mode = np.zeros(MOTOR_COUNT, np.uint8)        # not recorded by g1_record
            s.sensor0 = s.sensor1 = np.zeros(MOTOR_COUNT, np.uint32)
            return s
        c = LowCmdSample()
        c.t = t
        c.mode = np.zeros(MOTOR_COUNT, np.uint8)
        c.q, c.dq, c.kp, c.kd, c.tau = (v[self.ci[k]].copy() for k in ("q", "dq", "kp", "kd", "tau"))
        return c

    def peek(self):
        while self.peeked is None and not self.eof:
            line = self.f.readline()
            if not line:
                self.eof = True
                break
            self.peeked = self._parse(line)
        return self.peeked

    def pop(self):
        s = self.peek()
        self.peeked = None
        return s

    def seek(self, t: float):
        """Positions the stream at the first row with time >= t (coarse index, then a forward scan)."""
        off = self.data_offset
        for ti, oi in self.index:
            if ti > t:
                break
            off = oi
        self.f.close()
        self.f = self.store.open(self.name)
        if self.store.zip:
            # forward decompression in 1 MB reads: ZipExtFile.seek reads 16 MB at a time and leaves a
            # huge zlib unconsumed_tail that every later readline copies (replay ran at ~2x for ~30 s)
            left = off
            while left > 0:
                n = len(self.f.read(min(left, 1 << 20)))
                if n == 0:
                    break
                left -= n
        else:
            self.f.seek(off)
        self.peeked, self.eof = None, False
        while True:
            s = self.peek()
            if s is None or s.t >= t:
                return
            self.peeked = None


def replay_timeline(log_events: List[Tuple[float, str, str]], t0: float) -> dict:
    """Every g1_ctrl state change in a recording's log window. The page draws the whole recording's state band from this
    before it is played (the events it gets while playing only reach back from the current position)."""
    states = []
    for t, _level, text in sorted(log_events):
        m = _CHANGE_RE.search(text)
        if m:
            states.append({"t": t, "from": m[1], "to": m[2], "session": False})
        elif text.startswith("Config:"):
            states.append({"t": t, "from": None, "to": "Passive", "session": True})    # a new g1_ctrl run starts in Passive
    return {"type": "timeline", "t0": t0, "states": states}


class Replayer:
    """Plays a recording into a Monitor on a virtual clock (play, pause, speed, seek)."""

    SPEEDS = (0.25, 0.5, 1.0, 2.0, 4.0, 8.0)

    def __init__(self, store: Store, prefix: str, monitor: Monitor, log_events: List[Tuple[float, str, str]]):
        self.store, self.prefix, self.monitor = store, prefix, monitor
        self.ls = CsvStream(store, prefix + "_lowstate.csv", "ls")
        self.lc = CsvStream(store, prefix + "_lowcmd.csv", "lc")
        first = self.ls.peek()
        if first is None:
            raise SystemExit(f"{prefix}_lowstate.csv has no rows")
        self.t0 = first.t
        self.cursor = self.t0
        self.log_events = sorted(log_events)
        self.log_i = 0
        self.speed = 1.0
        self.playing = True
        self.ended = False
        self.busy = None        # "seeking" while a seek runs
        for s in (self.ls, self.lc):
            threading.Thread(target=s.build_index, name=f"index_{s.kind}", daemon=True).start()

    @property
    def t1(self) -> Optional[float]:
        return self.ls.t_last if self.ls.index_done else None

    def advance(self, wall_dt: float):
        """Feeds every row up to the new cursor. Ties go log line -> lowstate -> lowcmd, as in real_log.py."""
        if not self.playing or self.ended or self.busy:
            return
        target = self.cursor + wall_dt * self.speed
        m = self.monitor
        states, cmds = [], []
        while True:
            s, c = self.ls.peek(), self.lc.peek()
            tl = self.log_events[self.log_i][0] if self.log_i < len(self.log_events) else math.inf
            ts = s.t if s is not None else math.inf
            tc = c.t if c is not None else math.inf
            tmin = min(tl, ts, tc)
            if tmin > target:
                break
            if tl == tmin:
                if states or cmds:          # a state change splits the batch, as it splits real_log's segments
                    m.ingest(states, cmds)
                    states, cmds = [], []
                m.on_log_line(*self.log_events[self.log_i])
                self.log_i += 1
            elif ts == tmin:
                states.append(self.ls.pop())
            else:
                cmds.append(self.lc.pop())
            if len(states) >= 256:
                m.ingest(states, cmds)
                states, cmds = [], []
        if states or cmds:
            m.ingest(states, cmds)
        self.cursor = target
        if self.ls.peek() is None:
            self.ended = True
            self.playing = False
            if self.ls.t_last is not None:
                self.cursor = self.ls.t_last

    def seek(self, t: float):
        """Blocking (run it off the event loop). Streams restart at t; statistics restart there too."""
        t = max(self.t0, t if self.t1 is None else min(t, self.t1))
        self.ls.seek(t)
        self.lc.seek(t - 0.5)               # the latest command before t applies to the first state
        m = self.monitor
        with m.lock:
            m.reset_streams()
            m.alerts.clear()
            while True:
                c = self.lc.peek()
                if c is None or c.t >= t:
                    break
                m.cmd = self.lc.pop()
            m.fsm_events.clear()
            m.fsm_new = []
            m.segments = []
            m.segments_changed = True
            m.fsm_state, m.fsm_since = None, None
            m.segment = m._new_segment(None, t)
            self.log_i = 0
            while self.log_i < len(self.log_events) and self.log_events[self.log_i][0] <= t:
                m.on_log_line(*self.log_events[self.log_i], history=True)
                self.log_i += 1
            m.segment = m._new_segment(m.fsm_state, t)
            m.segments = []
            m.fsm_rebuilt = True
        self.cursor = t
        self.ended = False
        # the row at t, so a paused seek shows that moment (playback would feed it next anyway)
        first = self.ls.peek()
        if first is not None:
            m.ingest([self.ls.pop()], [])
            self.cursor = first.t

    def timeline(self) -> dict:
        return replay_timeline(self.log_events, self.t0)

    def status(self) -> dict:
        return {"type": "replay", "file": self.prefix, "store": os.path.basename(self.store.path),
                "t0": self.t0, "t1": self.t1, "t": self.cursor, "speed": self.speed, "playing": self.playing,
                "ended": self.ended, "indexing": not (self.ls.index_done and self.lc.index_done),
                "busy": self.busy, "speeds": list(self.SPEEDS)}


def find_replay_context(store: Store, prefix: str, ctrl_log: Optional[str], ctrl_config: Optional[str]
                        ) -> Tuple[List[Tuple[float, str, str]], Optional[dict], Optional[str], List[str]]:
    """g1_ctrl log lines for the recording's window, plus the config / model used that day when present.
    Logs: every log*.txt in the same top folder (zip or dir) and --ctrl-log, deduplicated; the window
    filter [first - 30 s, last + 1 s] is real_log.py's."""
    notes = []
    top = prefix.split("/")[0] if "/" in prefix else ""
    logs = [n for n in store.names if os.path.basename(n).startswith("log") and n.endswith(".txt")
            and (not top or n.startswith(top + "/"))]
    lines = set()
    for n in logs:
        with store.open(n) as f:
            for ln in f.read().decode(errors="ignore").splitlines():
                p = parse_log_line(ln)
                if p:
                    lines.add(p)
    if ctrl_log and os.path.exists(ctrl_log):
        with open(ctrl_log, errors="ignore") as f:
            for ln in f:
                p = parse_log_line(ln)
                if p:
                    lines.add(p)
        logs.append(ctrl_log)

    # window: first row now, last row from the file tail (cheap for folders; zips use the index later)
    with store.open(prefix + "_lowstate.csv") as f:
        f.readline()
        t_first = float(f.readline().split(b",")[1])
    t_last = None
    if not store.zip:
        with store.open(prefix + "_lowstate.csv") as f:
            f.seek(max(0, store.size(prefix + "_lowstate.csv") - 65536))
            tail = f.read().splitlines()
            t_last = float(tail[-1].split(b",")[1]) if tail else None
    hi = (t_last + 1) if t_last else math.inf
    events = sorted(p for p in lines if t_first - 30 <= p[0] <= hi)
    notes.append(f"log lines in window: {len(events)} from {len(logs)} file(s)")

    cfg = None
    cfg_name = None
    named = [p[2].split("Config:", 1)[1].strip() for p in events if p[2].startswith("Config:")]
    if named:
        base = os.path.basename(named[-1])
        cands = [n for n in store.names if os.path.basename(n) == base and (not top or n.startswith(top + "/"))]
        cands.sort(key=lambda n: ("context" not in n, len(n)))
        if cands and HAS_YAML:
            with store.open(cands[0]) as f:
                cfg = yaml.safe_load(f.read().decode())
            cfg_name = f"{os.path.basename(store.path)}:{cands[0]}"
            notes.append(f"controller config of that run: {cfg_name}")
    if cfg is None and ctrl_config and os.path.exists(ctrl_config) and HAS_YAML:
        with open(ctrl_config) as f:
            cfg = yaml.safe_load(f)
        cfg_name = ctrl_config
        notes.append(f"controller config: {ctrl_config} (the run's own config was not found)")
    return events, cfg, cfg_name, notes


# ==============================================================================
# Server
# ==============================================================================
def dashboard_url(host: str, port: int, token: Optional[str]) -> str:
    ws = f"ws://{'localhost' if host in LOOPBACK_HOSTS else host}:{port}" + (f"/?token={token}" if token else "")
    from urllib.parse import quote
    return f"http://localhost:5173/?monitor=1&ws={quote(ws, safe='')}"


async def serve(args, monitor: Monitor, hello: dict, replayer: Optional[Replayer], dds: Optional[DdsSource]) -> int:
    ignored = {"n": 0}

    def on_message(payload: bytes):
        if replayer is not None:
            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                return
            if isinstance(msg, dict) and msg.get("type") == "replay_control":
                pending_controls.append(msg)
                return
        ignored["n"] += 1
        if ignored["n"] == 1:
            print("[ROCO DDS] ignoring dashboard commands: this bridge is read-only")

    def greeting():
        with monitor.lock:
            h = dict(hello, modeMachine=monitor.ls.mode_machine if monitor.ls else None)
            msgs = [json.dumps(h), json.dumps(monitor.fsm_frame(full=True))]
            if monitor.ls is not None:      # paused or ended replay: no new frame would come otherwise
                msgs.append(pack_roco_frame(monitor.ls, monitor.pelvis_position()))
        if replayer is not None:
            msgs.append(json.dumps(replayer.timeline()))
            msgs.append(json.dumps(replayer.status()))
        return msgs

    pending_controls: List[dict] = []
    server = BuiltinWebSocketServer(args.host, args.port, on_message, AccessPolicy(args.host, args.allow_origin, args.token),
                                    on_connect=greeting)
    try:
        await server.start()
    except OSError as e:
        print(f"[ROCO DDS] cannot listen on {args.host}:{args.port}: {e.strerror or e} (is another bridge running?)")
        return 2

    print(f"[ROCO DDS] dashboard: {dashboard_url(args.host, args.port, args.token)}")
    rate = min(200.0, max(1.0, args.rate))
    interval = 1.0 / rate
    last_wall = time.perf_counter()
    last_status = 0.0
    last_print = time.time()
    loop = asyncio.get_running_loop()
    try:
        while True:
            start = time.perf_counter()
            if replayer is not None:
                while pending_controls and not replayer.busy:
                    msg = pending_controls.pop(0)
                    act, val = msg.get("action"), msg.get("value")
                    if act == "play":
                        if replayer.ended:
                            replayer.busy = "seeking"
                            await loop.run_in_executor(None, replayer.seek, replayer.t0)
                            replayer.busy = None
                        replayer.playing = True
                    elif act == "pause":
                        replayer.playing = False
                    elif act == "speed" and isinstance(val, (int, float)) and val in Replayer.SPEEDS:
                        replayer.speed = float(val)
                    elif act == "seek" and isinstance(val, (int, float)) and math.isfinite(val):
                        replayer.busy = "seeking"
                        await server.broadcast(json.dumps(replayer.status()))
                        await loop.run_in_executor(None, replayer.seek, float(val))
                        replayer.busy = None
                    await server.broadcast(json.dumps(replayer.status()))
                now_wall = time.perf_counter()
                replayer.advance(min(0.25, now_wall - last_wall))
                last_wall = now_wall
                now = replayer.cursor
            else:
                dds.pump()
                now = time.time()

            frame, aux, fsm = monitor.snapshot(now, build=bool(server.clients))
            if frame is not None:
                await server.broadcast(frame)
            if aux is not None:
                await server.broadcast(json.dumps(aux, separators=(",", ":")))
            if fsm is not None:
                await server.broadcast(json.dumps(fsm))
            if replayer is not None and server.clients and time.perf_counter() - last_status > 0.2:
                await server.broadcast(json.dumps(replayer.status()))
                last_status = time.perf_counter()

            if time.time() - last_print >= 5.0:
                last_print = time.time()
                print(f"[ROCO DDS] lowstate {monitor.ls_hz:.0f} Hz, lowcmd {monitor.cmd_hz:.0f} Hz, "
                      f"state {monitor.fsm_state or '?'}, alerts {len(monitor.alerts.active)}, clients {len(server.clients)}")
            await asyncio.sleep(max(0.001, interval - (time.perf_counter() - start)))
    finally:
        await server.stop()


def manual_info(path: str = MANUAL_PATH) -> Optional[dict]:
    """Name, size and SHA-256 of the test manual (read only), or None when it is not there. The page compares the hash with
    the one its guided-check procedure was written for, so a manual that changed cannot pass unnoticed."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return {"file": os.path.basename(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def build_hello(args, limits: dict, source: str, extra: dict) -> dict:
    return {
        "type": "hello",
        "protocol": 1,
        "bridge": "roco_dds_bridge",
        "readOnly": True,
        "source": source,
        "iface": getattr(args, "iface", None),
        "domain": getattr(args, "domain", None),
        "rateHz": args.rate,
        "limits": limits,
        "manual": manual_info(),
        **extra,
    }


# ==============================================================================
# Self-test
# ==============================================================================
def run_self_test() -> bool:
    ok = True

    def check(cond, what):
        nonlocal ok
        print(f"  [{'✓' if cond else '✗'}] {what}")
        ok = ok and bool(cond)

    print("=" * 72 + "\nroco_dds_bridge self-test\n" + "=" * 72)
    rng = np.random.default_rng(7)

    print("\n--- No-publisher guard ---")
    install_no_publisher_guard()
    from cyclonedds.pub import DataWriter
    from unitree_sdk2py.core import channel as ch
    from unitree_sdk2py.idl.default import unitree_hg_msg_dds__LowCmd_, unitree_hg_msg_dds__LowState_
    from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowCmd_, LowState_
    for what, fn in (("ChannelPublisher", lambda: ch.ChannelPublisher("rt/lowcmd", LowCmd_)),
                     ("ChannelFactory.CreateSendChannel", lambda: ch.ChannelFactory().CreateSendChannel("rt/lowcmd", LowCmd_)),
                     ("Channel.SetWriter", lambda: ch.Channel.SetWriter(None)),
                     ("cyclonedds DataWriter", lambda: DataWriter(None, None))):
        try:
            fn()
            check(False, f"{what} raises")
        except RuntimeError as e:
            check("read-only" in str(e), f"{what} raises")

    print("\n--- Raw CDR parsers vs unitree_sdk2py deserialisation ---")
    for trial in range(3):
        m = unitree_hg_msg_dds__LowState_()
        m.version = [int(v) for v in rng.integers(0, 2 ** 32, 2)]
        m.mode_pr, m.mode_machine, m.tick = int(rng.integers(0, 256)), 6, int(rng.integers(0, 2 ** 32))
        imu = m.imu_state
        imu.quaternion, imu.gyroscope = [float(v) for v in rng.normal(size=4)], [float(v) for v in rng.normal(size=3)]
        imu.accelerometer, imu.rpy = [float(v) for v in rng.normal(size=3)], [float(v) for v in rng.normal(size=3)]
        imu.temperature = int(rng.integers(-300, 300))
        for k, ms in enumerate(m.motor_state):
            ms.mode = int(rng.integers(0, 256))
            ms.q, ms.dq, ms.ddq, ms.tau_est, ms.vol = (float(v) for v in rng.normal(size=5) * 10)
            ms.temperature = [int(v) for v in rng.integers(-100, 120, 2)]
            ms.sensor = [int(v) for v in rng.integers(0, 2 ** 32, 2)]
            ms.motorstate = int(rng.integers(0, 2 ** 32))
            ms.reserve = [int(v) for v in rng.integers(0, 2 ** 32, 4)]
        m.wireless_remote = [int(v) for v in rng.integers(0, 256, 40)]
        m.reserve = [int(v) for v in rng.integers(0, 2 ** 32, 4)]
        m.crc = int(rng.integers(0, 2 ** 32))
        data = m.serialize()
        ref = LowState_.deserialize(data)
        s = parse_lowstate_cdr(data, 0.0)
        f32 = lambda v: float(np.float32(v))
        good = s is not None and s.version == tuple(ref.version) and (s.mode_pr, s.mode_machine, s.tick) == (ref.mode_pr, ref.mode_machine, ref.tick)
        r = ref.imu_state
        good = good and all(f32(a) == f32(b) for a, b in zip(s.quat + s.gyro + s.acc + s.rpy,
                                                               r.quaternion + r.gyroscope + r.accelerometer + r.rpy))
        good = good and s.imu_temp == r.temperature
        for k, rm in enumerate(ref.motor_state):
            good = good and int(s.mode[k]) == rm.mode and all(
                f32(a) == f32(b) for a, b in ((s.q[k], rm.q), (s.dq[k], rm.dq), (s.ddq[k], rm.ddq), (s.tau[k], rm.tau_est), (s.vol[k], rm.vol)))
            good = good and [int(s.temp0[k]), int(s.temp1[k])] == list(rm.temperature)
            good = good and [int(s.sensor0[k]), int(s.sensor1[k])] == list(rm.sensor) and int(s.motorstate[k]) == rm.motorstate
        check(good, f"LowState_ trial {trial}: header, IMU and all 35 motors match (encapsulation {data[:2].hex()})")

        c = unitree_hg_msg_dds__LowCmd_()
        c.mode_pr, c.mode_machine = 1, 6
        for mc in c.motor_cmd:
            mc.mode = int(rng.integers(0, 256))
            mc.q, mc.dq, mc.tau, mc.kp, mc.kd = (float(v) for v in rng.normal(size=5) * 20)
            mc.reserve = int(rng.integers(0, 2 ** 32))
        data = c.serialize()
        refc = LowCmd_.deserialize(data)
        p = parse_lowcmd_cdr(data, 0.0)
        good = p is not None
        for k, rm in enumerate(refc.motor_cmd):
            good = good and int(p.mode[k]) == rm.mode
            if k < N_BODY:
                good = good and all(f32(a) == f32(b) for a, b in ((p.q[k], rm.q), (p.dq[k], rm.dq), (p.tau[k], rm.tau), (p.kp[k], rm.kp), (p.kd[k], rm.kd)))
        check(good, f"LowCmd_ trial {trial}: all 35 modes and 29 q/dq/tau/kp/kd match")

    from unitree_sdk2py.idl.default import unitree_go_msg_dds__SportModeState_
    from unitree_sdk2py.idl.unitree_go.msg.dds_ import SportModeState_
    o = unitree_go_msg_dds__SportModeState_()
    o.position, o.velocity = [float(v) for v in rng.normal(size=3)], [float(v) for v in rng.normal(size=3)]
    o.body_height, o.yaw_speed, o.progress = 0.7, 0.3, 0.5
    data = o.serialize()
    ref = SportModeState_.deserialize(data)
    pv = parse_odom_cdr(data)
    check(pv is not None and [f32(v) for v in pv[0]] == [f32(v) for v in ref.position]
          and [f32(v) for v in pv[1]] == [f32(v) for v in ref.velocity], "SportModeState_ position and velocity match")

    words = [int(v) for v in rng.integers(0, 2 ** 32, 522)]
    check(all(fast_crc32(w) == calc_crc32(w) for w in (words, [0] * 522, [0xFFFFFFFF] * 522, words[::-1])),
          "fast CRC32 equals the bridge's reference CRC32 (random, zero, all-ones, reversed words)")

    print("\n--- ROCO frame (C layout read back with the dashboard's offsets) ---")
    frame = pack_roco_frame(s, (1.25, -0.5, 0.78))
    good = len(frame) == LOW_STATE_BYTE_LENGTH
    v0, v1, mpr, mm, tick = struct.unpack_from("<2I2B2xI", frame, 0)
    good = good and (v0, v1, mpr, mm, tick) == (s.version[0], s.version[1], s.mode_pr, s.mode_machine, s.tick)
    good = good and struct.unpack_from("<3f", frame, 56) == tuple(np.float32(v) for v in s.rpy)
    good = good and struct.unpack_from("<4f", frame, 16) == tuple(np.float32(v) for v in s.quat)
    for k in range(MOTOR_COUNT):
        o = OFFSET_MOTOR_STATE_ARRAY + k * 56
        mode, q, dq, ddq, tau, t0, t1, vol, s0, s1, ms = struct.unpack_from("<B3x4f2hf3I", frame, o)
        good = good and (mode, q, dq, tau, t0, t1, vol, ms) == (s.mode[k], s.q[k], s.dq[k], s.tau[k], s.temp0[k], s.temp1[k], s.vol[k], s.motorstate[k])
    good = good and struct.unpack_from("<3f", frame, OFFSET_STATE_RESERVE) == tuple(np.float32(v) for v in (1.25, -0.5, 0.78))
    good = good and calc_crc32(struct.unpack_from("<522I", frame, 0)) == struct.unpack_from("<I", frame, OFFSET_CRC)[0]
    check(good, "header, IMU, 35 motors (mode/q/dq/tau/temps/vol/motorstate), reserve position and CRC32")

    print("\n--- Limits from the type-6 model and deploy_lock config ---")
    if os.path.exists(DEFAULT_MODEL) and os.path.exists(DEFAULT_CFG_SIM):
        L = load_limits(DEFAULT_MODEL, DEFAULT_CFG_SIM, 20, 40)
        exp_torque = [88, 139, 88, 139, 50, 50] * 2 + [88, 50, 50] + [25, 25, 25, 25, 25, 5, 5] * 2
        check(L["torque"] == exp_torque, f"torque limits {L['torque'][:6]} ... (hip roll 139, ankle 50)")
        check(L["range"][4] == [-0.87267, 0.5236] and L["range"][13] == [-0.52, 0.52], "joint ranges (ankle pitch, waist roll)")
        check(L["lockedJoints"] == [13, 14] and L["modeMachine"] == 6, "locked joints [13, 14], mode_machine 6")
        sf = L["safety"]
        check((sf.get("temp_warn"), sf.get("temp_stop"), sf.get("leg_speed_stop"), sf.get("leg_speed_ms"), sf.get("lowstate_timeout_ms"))
              == (65, 80, 15.0, 50, 200), f"safety {sf}")
        check(L["pdTargetRange"][3] == [-0.087267, 2.8798], "pd_target_range (knee)")
        check(L["imuSiteOffset"] == [0.04525, 0.0, -0.08339], f"imu site offset {L['imuSiteOffset']}")
        check(set(L["states"]) == {"Passive", "FixStand", "Velocity", "squat"}, f"FSM states {L['states']}")
        check(not L["warnings"], f"no warnings {L['warnings']}")
    else:
        print("  [-] deploy_lock files not found, skipped")

    print("\n--- PD demand vs real_log.py's formula on a g1_record CSV ---")
    pre = os.path.join(DEPLOY_LOCK, "robots/g1/hw_logs/2026-10-23/precheck")
    if os.path.exists(pre + "_lowstate.csv"):
        Ls = np.genfromtxt(pre + "_lowstate.csv", delimiter=",", names=True, max_rows=3000)
        Lc = np.genfromtxt(pre + "_lowcmd.csv", delimiter=",", names=True, max_rows=3000)
        col = lambda A, f: np.c_[[A[f"{f}{i}"] for i in range(29)]].T
        t, kt = Ls["unix_t"], Lc["unix_t"]
        ic = np.clip(np.searchsorted(kt, t) - 1, 0, len(kt) - 1)
        have = np.searchsorted(kt, t) > 0
        dem_ref = col(Lc, "kp")[ic] * (col(Lc, "q")[ic] - col(Ls, "q")) + col(Lc, "kd")[ic] * (col(Lc, "dq")[ic] - col(Ls, "dq")) + col(Lc, "tau")[ic]
        dem_ref[~have] = 0
        L = load_limits(DEFAULT_MODEL, DEFAULT_CFG_SIM, 20, 40)
        mon = Monitor(L, "replay")
        store, prefix = resolve_replay(pre)
        rp = Replayer(store, prefix, mon, [])
        got = []
        orig = mon.ingest

        def spy(states, cmds):
            orig(states, cmds)
            if states:
                got.extend(mon.batch_dem.copy())
        mon.ingest = spy
        while len(got) < len(t) and not rp.ended:
            rp.advance(0.05)
        got = np.array(got[: len(t)])
        diff = float(np.abs(got - dem_ref[: len(got)]).max()) if len(got) else math.inf
        check(len(got) == len(t) and diff < 1e-4, f"{len(got)} samples, max |demand - real_log| = {diff:.2e} Nm")
    else:
        print("  [-] hw_logs/2026-10-23/precheck not found, skipped")

    print("\n--- g1_ctrl log parsing and alert bookkeeping ---")
    p = parse_log_line("\x1b[32m[2026-10-16 10:32:15.421] [info] FSM: Change state from FixStand to Velocity\x1b[0m")
    check(p is not None and p[1] == "info" and p[2].endswith("to Velocity")
          and abs(p[0] - datetime.datetime(2026, 10, 16, 10, 32, 15, 421000).timestamp()) < 1e-6, "log line with ANSI colours")
    L = load_limits(DEFAULT_MODEL, DEFAULT_CFG_SIM, 20, 40) if os.path.exists(DEFAULT_MODEL) else load_limits(None, None, 20, 40)
    mon = Monitor(L, "sim")
    mon.on_log_line(100.0, "info", "FSM: Change state from Passive to FixStand")
    check(mon.fsm_state == "FixStand" and mon.fsm_events[-1]["to"] == "FixStand", "state change parsed")
    n0 = len(mon.fsm_events)
    mon.on_log_line(101.0, "info", "Velocity policy: 1274 steps, first after 0.3 ms, step interval max 22.9 ms")
    mon.on_log_line(102.0, "info", "FSM: first 2s in squat: max cmd step legs=0.3 arms=0.1 deg/tick, "
                                   "max joint speed legs=0.1 arms=0.2 rad/s")
    mon.on_log_line(103.0, "info", "Safety: motor temperatures [0]/[1] at start: 31/0 30/30 0/0")
    mon.on_log_line(104.0, "info", "Safety: motorstate at start: 0 0 1f 0")
    mon.on_log_line(105.0, "info", "Safety: stop at 80 C, warn at 65 C (temperature index 0,1)")
    mon.on_log_line(106.0, "info", "Safety: motorstate at start: 0 zz")
    hs = [e.get("health") for e in list(mon.fsm_events)[n0:]]
    check(len(hs) == 4 and hs[0] == {"kind": "policyTiming", "policy": "Velocity", "steps": 1274, "firstMs": 0.3,
                                      "intervalMaxMs": 22.9}, "policy timing line forwarded as numbers")
    check(hs[1] == {"kind": "first2s", "state": "squat", "cmdStepLegs": 0.3, "cmdStepArms": 0.1,
                    "speedLegs": 0.1, "speedArms": 0.2}, "first-2-s report parsed")
    check(hs[2] == {"kind": "startTemps", "maxC": 31, "motors": 3}, "start-up temperatures parsed")
    check(hs[3] == {"kind": "startMotorstate", "nonzero": [2], "motors": 4},
          "start-up motorstate parsed; other info lines and a malformed one are dropped")
    n1 = len(mon.fsm_events)
    mon.on_log_line(107.0, "info", "FSM: 'n' requested; waiting for the robot to stand still")
    mon.on_log_line(108.0, "info", "Exit")
    mon.on_log_line(109.0, "info", "Velocity: key 'w' ignored (keyboard_walk: false)")
    check([e["text"] for e in list(mon.fsm_events)[n1:]] == ["FSM: 'n' requested; waiting for the robot to stand still", "Exit"],
          "the squat request and Exit lines reach the page (the guided checks look for them); key-ignored spam does not")
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "TEST_MANUAL.md")
        with open(mp, "wb") as f:
            f.write(b"abc")
        mi = manual_info(mp)
        check(mi == {"file": "TEST_MANUAL.md", "bytes": 3,
                     "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}, "manual hash (SHA-256 of the bytes)")
        check(manual_info(os.path.join(d, "none.md")) is None, "a missing manual is None, not an error")
    check("manual" in build_hello(argparse.Namespace(rate=30, iface="lo", domain=1), L, "sim", {}), "hello carries the manual field")

    print("\n--- g1_ctrl log: an old run's state is never shown as current ---")
    import subprocess

    def wait_for(cond, s=3.0):
        end = time.time() + s
        while time.time() < end and not cond():
            time.sleep(0.05)
        return cond()

    def writer(path, lines):
        """Stands in for g1_ctrl run with --log: appends the lines and keeps the log open until killed."""
        code = "import sys,time; f=open(sys.argv[1],'a'); f.write(sys.argv[2]); f.flush(); print('ok',flush=True); time.sleep(60)"
        p = subprocess.Popen([sys.executable, "-c", code, path, "".join(ln + "\n" for ln in lines)], stdout=subprocess.PIPE)
        p.stdout.readline()
        return p

    old = ["[2026-10-16 10:32:15.421] [info] Config: /x/config_hw.yaml",
           "[2026-10-16 10:32:20.000] [info] FSM: Change state from Passive to Velocity"]
    with tempfile.TemporaryDirectory() as d:
        lp = os.path.join(d, "log.txt")
        with open(lp, "w") as f:
            f.write("\n".join(old) + "\n")
        if log_open_for_writing(lp)[0] is None:
            print("  [-] no /proc here, skipped")
        else:
            check(log_open_for_writing(lp)[0] is False, "a log no process writes is an old run's")
            with open(lp):
                check(log_open_for_writing(lp)[0] is False, "a reader (tail -f) does not count as g1_ctrl")
            mon = Monitor(L, "sim")
            lt = LogTailer(lp, mon, poll_s=0.02)
            lt.start()
            time.sleep(0.3)
            check(mon.fsm_state is None and not mon.fsm_events, "bridge started on an old run's log: state unknown, not Velocity")
            w = writer(lp, ["[2026-11-03 14:00:00.000] [info] Config: /x/config_hw.yaml",
                            "[2026-11-03 14:00:05.000] [info] FSM: Change state from Passive to FixStand"])
            check(wait_for(lambda: mon.fsm_state == "FixStand"), "a run started with --log after the bridge shows its state")
            check(log_open_for_writing(lp)[0] is True, "g1_ctrl holding the log open counts as writing")
            time.sleep(1.2)       # the tailer sees the writer before it stops
            w.kill()
            w.wait()
            check(wait_for(lambda: mon.fsm_state is None) and "closed its log" in mon.fsm_events[-1]["text"],
                  "g1_ctrl stopping clears the state, with a line saying why")
            lt.stop_event.set()
            w = writer(lp, [])
            mon = Monitor(L, "sim")
            lt = LogTailer(lp, mon, poll_s=0.02)
            lt.start()
            check(wait_for(lambda: mon.fsm_state == "FixStand"), "bridge started while g1_ctrl runs with --log: its current state")
            lt.stop_event.set()
            w.kill()
            w.wait()
        lp = os.path.join(d, "later.txt")
        mon = Monitor(L, "sim")
        lt = LogTailer(lp, mon, poll_s=0.02)
        lt.start()
        time.sleep(0.2)
        with open(lp, "w") as f:
            f.write(old[0] + "\n")
        check(wait_for(lambda: mon.fsm_state == "Passive"), "a log that appears after the bridge started is read from its start")
        lt.stop_event.set()
    mon = Monitor(L, "replay")
    mon.segment["n"] = 10
    mon.on_log_line(1.0, "info", "Config: /x/config_hw.yaml")
    split = len(mon.segments)
    mon.on_log_line(2.0, "info", "FSM: Change state from Passive to FixStand")
    check(split == 0 and [g["name"] for g in mon.segments] == ["Passive"] and mon.fsm_state == "FixStand",
          "\"Config:\" while Passive keeps the segment (real_log.py splits on state changes only)")
    mon.fsm_frame(full=False)
    mon.fsm_rebuilt = True
    check((mon.fsm_frame(full=False) or {}).get("full") is True and mon.fsm_frame(full=False) is None,
          "after a replay seek the next fsm frame is a full one")
    tl = replay_timeline([(5.0, "info", "FSM: Change state from FixStand to Velocity"), (1.0, "info", "Config: /x/config_hw.yaml"),
                          (3.0, "info", "FSM: Change state from Passive to FixStand"), (4.0, "info", "Exit")], 0.5)
    check(tl["type"] == "timeline" and tl["t0"] == 0.5 and [(x["t"], x["from"], x["to"], x["session"]) for x in tl["states"]]
          == [(1.0, None, "Passive", True), (3.0, "Passive", "FixStand", False), (5.0, "FixStand", "Velocity", False)],
          "replay timeline: state changes and run starts of the whole log, in time order")
    book = AlertBook()
    book.step(1.0, "ls", {"pd:4": ("warn", "pd_demand", 4, 85.0, "x")})
    book.step(1.2, "ls", {"pd:4": ("critical", "pd_demand", 4, 101.0, "x")})
    book.step(1.4, "ls", {})
    still = "pd:4" in book.active
    book.step(1.8, "ls", {})
    ev = book.take_pending()
    check(still and "pd:4" not in book.active and [e["event"] for e in ev] == ["open", "close"]
          and ev[1]["peakLevel"] == "critical" and ev[1]["peak"] == 101.0, "alert opens, escalates, holds 0.5 s, closes")

    print("\n" + "=" * 72)
    print("ALL TESTS PASSED" if ok else "SOME TESTS FAILED")
    print("=" * 72)
    return ok


# ==============================================================================
# Main
# ==============================================================================
def main():
    ap = argparse.ArgumentParser(description="ROCO read-only DDS monitor bridge (Unitree G1)")
    ap.add_argument("--iface", default="lo", help="DDS network interface (lo = unitree_mujoco on this PC)")
    ap.add_argument("--domain", type=int, default=0, help="DDS domain id (default 0, as g1_ctrl)")
    ap.add_argument("--odom-topic", default="auto",
                    help="odometry topic: auto (lo: rt/sportmodestate, else rt/odommodestate), a topic name, or none")
    ap.add_argument("--ctrl-config", default=None, help="g1_ctrl config (default: config.yaml on lo, else config_hw.yaml)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="robot MJCF for torque limits and joint ranges")
    ap.add_argument("--ctrl-log", default=None, help=f"g1_ctrl log to follow for the FSM state (default {DEFAULT_CTRL_LOG})")
    ap.add_argument("--no-ctrl-log", action="store_true", help="do not read g1_ctrl's log")
    ap.add_argument("--replay", default=None, metavar="SRC",
                    help="play a g1_record recording: <prefix> | <dir> | <file.zip> | <file.zip>:<name>")
    ap.add_argument("--source", choices=["sim", "robot"], default=None, help="label for live data (default: sim on lo)")
    ap.add_argument("--tilt-warn-deg", type=float, default=20.0, help="body tilt warning (ROCO default, not from g1_ctrl)")
    ap.add_argument("--tilt-crit-deg", type=float, default=40.0, help="body tilt critical alert (ROCO default)")
    ap.add_argument("--host", default="127.0.0.1", help="WebSocket bind host (loopback by default)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--rate", type=float, default=50.0, help="dashboard frame rate in Hz (1..200)")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN")
    ap.add_argument("--token", default=os.environ.get("ROCO_BRIDGE_TOKEN"))
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if run_self_test() else 1)
    if args.host not in LOOPBACK_HOSTS and not args.token:
        ap.error(f"--host {args.host} is not loopback: pass --token SECRET (or set ROCO_BRIDGE_TOKEN)")

    if args.replay:
        store, prefix = resolve_replay(args.replay)
        events, cfg, cfg_name, notes = find_replay_context(store, prefix, args.ctrl_log, args.ctrl_config or DEFAULT_CFG_HW)
        top = prefix.split("/")[0] if "/" in prefix else ""
        model_in_store = [n for n in store.names if os.path.basename(n) == os.path.basename(args.model or "")
                          and (not top or n.startswith(top + "/"))]
        model_path = args.model
        if model_in_store and not store.zip:
            model_path = os.path.join(store.path, model_in_store[0])
            notes.append(f"robot model of that day: {model_path}")
        limits = load_limits(model_path, None, args.tilt_warn_deg, args.tilt_crit_deg)
        if cfg is not None:
            apply_ctrl_config(limits, cfg)
            limits["ctrlConfig"] = cfg_name
        monitor = Monitor(limits, "replay")
        replayer = Replayer(store, prefix, monitor, events)
        for n in notes:
            print(f"[ROCO DDS] {n}")
        print(f"[ROCO DDS] replaying {store.path} :: {prefix}")
        hello = build_hello(args, limits, "replay", {"replay": {"store": store.path, "file": prefix, "notes": notes}})
        try:
            sys.exit(asyncio.run(serve(args, monitor, hello, replayer, None)) or 0)
        except KeyboardInterrupt:
            print("\n[ROCO DDS] stopped")
        return

    source = args.source or ("sim" if args.iface == "lo" else "robot")
    cfg = args.ctrl_config or (DEFAULT_CFG_SIM if args.iface == "lo" else DEFAULT_CFG_HW)
    limits = load_limits(args.model, cfg, args.tilt_warn_deg, args.tilt_crit_deg)
    for w in limits["warnings"]:
        print(f"[ROCO DDS] warning: {w}")
    if args.odom_topic == "auto":
        odom = ["rt/sportmodestate"] if args.iface == "lo" else ["rt/odommodestate", "rt/sportmodestate"]
    elif args.odom_topic == "none":
        odom = []
    else:
        odom = [args.odom_topic]
    monitor = Monitor(limits, source)
    dds = DdsSource(monitor, args.iface, args.domain, odom)
    dds.start()
    log_path = None if args.no_ctrl_log else (args.ctrl_log or DEFAULT_CTRL_LOG)
    if log_path:
        LogTailer(log_path, monitor).start()
    print(f"[ROCO DDS] read-only on {args.iface} (domain {args.domain}), source '{source}', odometry {odom or 'off'}, "
          f"g1_ctrl log {log_path or 'off'}")
    hello = build_hello(args, limits, source, {"odomTopics": odom, "ctrlLog": log_path})
    try:
        sys.exit(asyncio.run(serve(args, monitor, hello, None, dds)) or 0)
    except KeyboardInterrupt:
        print("\n[ROCO DDS] stopped")


if __name__ == "__main__":
    main()
