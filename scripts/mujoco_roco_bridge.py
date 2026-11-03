#!/usr/bin/env python3
"""
MuJoCo & Unitree Binary WebSocket Bridge for ROCO Dashboard.
Broadcasts 2,092-byte Unitree LowState_ telemetry frames at 50 Hz and
receives 32-byte ROCO binary teleop velocity commands (0x524F434F).

Supports:
  1. Multi-Robot Registry profiles: g1_29dof (29 DOF), g1_23dof (23 DOF), g1_dual_arm (14 DOF)
  2. Optional ONNX RL policy inference (policy.onnx + deploy.yaml)
  3. Live MuJoCo 500 Hz physics simulation (when `mujoco` is installed)
  4. Standalone pure NumPy 50 Hz closed-loop physics simulator fallback
  5. Native websockets or built-in asyncio RFC-6455 server (zero external pip dependencies)
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import math
import os
import socket
import struct
import sys
import time
from collections import deque
from typing import Any, Deque, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# Try importing numpy; fallback to math if unavailable
try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

# Try importing mujoco
try:
    import mujoco
    HAS_MUJOCO = True
except ImportError:
    HAS_MUJOCO = False

# Try importing websockets
try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# Try importing pyyaml
try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# Try importing onnxruntime
try:
    import onnxruntime as ort
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False


# ==============================================================================
# Protocol Constants matching src/utils/unitreeBinaryCodec.ts
# ==============================================================================
LOW_STATE_BYTE_LENGTH = 2092
LOW_CMD_BYTE_LENGTH = 1004
TELEOP_CMD_BYTE_LENGTH = 32
TELEOP_MAGIC = 0x524F434F  # 'ROCO' in ASCII

CRC32_POLYNOMIAL = 0x04C11DB7

OFFSET_VERSION_0 = 0
OFFSET_VERSION_1 = 4
OFFSET_MODE_PR = 8
OFFSET_MODE_MACHINE = 9
OFFSET_TICK = 12

OFFSET_IMU_STATE = 16
OFFSET_IMU_QUATERNION = 16
OFFSET_IMU_GYROSCOPE = 32
OFFSET_IMU_ACCELEROMETER = 44
OFFSET_IMU_RPY = 56
OFFSET_IMU_TEMP = 68

OFFSET_MOTOR_STATE_ARRAY = 72
MOTOR_STATE_STRIDE = 56
MOTOR_COUNT = 35

OFFSET_WIRELESS_REMOTE = 2032
OFFSET_STATE_RESERVE = 2072
OFFSET_CRC = 2088

# Nominal segment lengths (m)
THIGH_LENGTH = 0.3366
SHIN_LENGTH = 0.3000


# ==============================================================================
# Multi-Robot Profiles matching src/config/robotRegistry.ts
# ==============================================================================
# mode_machine = the "G1 type" byte in LowState_ / LowCmd_. Unitree's published
# definition: 4 = 23-DoF, 5 = 29-DoF, 6 = 29-DoF with waist roll/pitch locked (listed by
# Unitree as "27-DoF"; confirmed as 6 on a real 29-DoF EDU with locked waist).
# The dual-arm torso has no Unitree value; 100 is a ROCO simulator-only code that
# cannot collide with a real robot. KEEP IN SYNC with src/config/robotRegistry.ts.
MODE_MACHINE_G1_23DOF = 4
MODE_MACHINE_G1_29DOF = 5
MODE_MACHINE_G1_29DOF_WAIST_LOCKED = 6
MODE_MACHINE_ROCO_DUAL_ARM_SIM = 100

# Each joint entry: (joint_id, default_pos_rad, sdk_motor_index)
ROBOT_PROFILES: Dict[str, dict] = {
    "g1_29dof": {
        "id": "g1_29dof",
        "name": "Unitree G1 (29-DOF)",
        "category": "biped",
        "mjcf_path": "public/models/g1_description/g1_29dof.xml",
        "nominal_pelvis_height": 0.793,
        "mode_machine": MODE_MACHINE_G1_29DOF,
        "joints": [
            ("left_hip_pitch_joint", -0.16, 0),
            ("left_hip_roll_joint", 0.0, 1),
            ("left_hip_yaw_joint", 0.0, 2),
            ("left_knee_joint", 0.32, 3),
            ("left_ankle_pitch_joint", -0.16, 4),
            ("left_ankle_roll_joint", 0.0, 5),
            ("right_hip_pitch_joint", -0.16, 6),
            ("right_hip_roll_joint", 0.0, 7),
            ("right_hip_yaw_joint", 0.0, 8),
            ("right_knee_joint", 0.32, 9),
            ("right_ankle_pitch_joint", -0.16, 10),
            ("right_ankle_roll_joint", 0.0, 11),
            ("waist_yaw_joint", 0.0, 12),
            ("waist_roll_joint", 0.0, 13),
            ("waist_pitch_joint", 0.0, 14),
            ("left_shoulder_pitch_joint", 0.20, 15),
            ("left_shoulder_roll_joint", 0.15, 16),
            ("left_shoulder_yaw_joint", 0.0, 17),
            ("left_elbow_joint", 0.90, 18),
            ("left_wrist_roll_joint", 0.0, 19),
            ("left_wrist_pitch_joint", 0.0, 20),
            ("left_wrist_yaw_joint", 0.0, 21),
            ("right_shoulder_pitch_joint", 0.20, 22),
            ("right_shoulder_roll_joint", -0.15, 23),
            ("right_shoulder_yaw_joint", 0.0, 24),
            ("right_elbow_joint", 0.90, 25),
            ("right_wrist_roll_joint", 0.0, 26),
            ("right_wrist_pitch_joint", 0.0, 27),
            ("right_wrist_yaw_joint", 0.0, 28),
        ],
    },
    "g1_23dof": {
        "id": "g1_23dof",
        "name": "Unitree G1 (23-DOF)",
        "category": "biped",
        "mjcf_path": "public/models/g1_description/g1_23dof.xml",
        "nominal_pelvis_height": 0.793,
        "mode_machine": MODE_MACHINE_G1_23DOF,
        "joints": [
            ("left_hip_pitch_joint", -0.16, 0),
            ("left_hip_roll_joint", 0.0, 1),
            ("left_hip_yaw_joint", 0.0, 2),
            ("left_knee_joint", 0.32, 3),
            ("left_ankle_pitch_joint", -0.16, 4),
            ("left_ankle_roll_joint", 0.0, 5),
            ("right_hip_pitch_joint", -0.16, 6),
            ("right_hip_roll_joint", 0.0, 7),
            ("right_hip_yaw_joint", 0.0, 8),
            ("right_knee_joint", 0.32, 9),
            ("right_ankle_pitch_joint", -0.16, 10),
            ("right_ankle_roll_joint", 0.0, 11),
            ("waist_yaw_joint", 0.0, 12),
            ("left_shoulder_pitch_joint", 0.20, 15),
            ("left_shoulder_roll_joint", 0.15, 16),
            ("left_shoulder_yaw_joint", 0.0, 17),
            ("left_elbow_joint", 0.90, 18),
            ("left_wrist_roll_joint", 0.0, 19),
            ("right_shoulder_pitch_joint", 0.20, 22),
            ("right_shoulder_roll_joint", -0.15, 23),
            ("right_shoulder_yaw_joint", 0.0, 24),
            ("right_elbow_joint", 0.90, 25),
            ("right_wrist_roll_joint", 0.0, 26),
        ],
    },
    "g1_dual_arm": {
        "id": "g1_dual_arm",
        "name": "Unitree G1 Dual-Arm Torso (14-DOF)",
        "category": "fixed_manipulator",
        "mjcf_path": "public/models/g1_description/g1_dual_arm.xml",
        "nominal_pelvis_height": 0.45,
        "mode_machine": MODE_MACHINE_ROCO_DUAL_ARM_SIM,
        "joints": [
            ("left_shoulder_pitch_joint", 0.20, 15),
            ("left_shoulder_roll_joint", 0.15, 16),
            ("left_shoulder_yaw_joint", 0.0, 17),
            ("left_elbow_joint", 0.90, 18),
            ("left_wrist_roll_joint", 0.0, 19),
            ("left_wrist_pitch_joint", 0.0, 20),
            ("left_wrist_yaw_joint", 0.0, 21),
            ("right_shoulder_pitch_joint", 0.20, 22),
            ("right_shoulder_roll_joint", -0.15, 23),
            ("right_shoulder_yaw_joint", 0.0, 24),
            ("right_elbow_joint", 0.90, 25),
            ("right_wrist_roll_joint", 0.0, 26),
            ("right_wrist_pitch_joint", 0.0, 27),
            ("right_wrist_yaw_joint", 0.0, 28),
        ],
    },
}

# Same body and 29 motor slots as g1_29dof; waist roll/pitch keep reporting but are held at default.
ROBOT_PROFILES["g1_29dof_waist_locked"] = {
    **ROBOT_PROFILES["g1_29dof"],
    "id": "g1_29dof_waist_locked",
    "name": "Unitree G1 (29-DOF, waist locked)",
    "mode_machine": MODE_MACHINE_G1_29DOF_WAIST_LOCKED,
    "locked_joints": ("waist_roll_joint", "waist_pitch_joint"),
}

MODE_MACHINE_TO_PROFILE: Dict[int, str] = {
    p["mode_machine"]: pid for pid, p in ROBOT_PROFILES.items()
}


# ==============================================================================
# Hardware CRC32 Lookup Table (Unitree 0x04C11DB7, MSB-First)
# ==============================================================================
CRC_LUT = []
for i in range(256):
    c = (i << 24) & 0xFFFFFFFF
    for _ in range(8):
        if c & 0x80000000:
            c = (((c << 1) ^ CRC32_POLYNOMIAL) & 0xFFFFFFFF)
        else:
            c = ((c << 1) & 0xFFFFFFFF)
    CRC_LUT.append(c)


def calc_crc32(words: Tuple[int, ...]) -> int:
    """Calculates Unitree standard 32-bit CRC over 522 32-bit words."""
    crc = 0xFFFFFFFF
    for w in words:
        crc = (CRC_LUT[((crc >> 24) ^ ((w >> 24) & 0xFF)) & 0xFF] ^ ((crc << 8) & 0xFFFFFFFF))
        crc = (CRC_LUT[((crc >> 24) ^ ((w >> 16) & 0xFF)) & 0xFF] ^ ((crc << 8) & 0xFFFFFFFF))
        crc = (CRC_LUT[((crc >> 24) ^ ((w >> 8) & 0xFF)) & 0xFF] ^ ((crc << 8) & 0xFFFFFFFF))
        crc = (CRC_LUT[((crc >> 24) ^ (w & 0xFF)) & 0xFF] ^ ((crc << 8) & 0xFFFFFFFF))
    return crc & 0xFFFFFFFF


# ==============================================================================
# Binary Teleop & LowState Codec
# ==============================================================================
def unpack_teleop_cmd(data: bytes) -> Optional[Dict[str, Any]]:
    """Unpacks a 32-byte ROCO teleop frame."""
    if len(data) < TELEOP_CMD_BYTE_LENGTH:
        return None
    magic, seq, vx, vy, wz, e_stop, mode_machine, ts = struct.unpack('<IIfffBB2xd', data[:32])
    if magic != TELEOP_MAGIC:
        return None
    return {
        "seq": seq,
        "vx": vx,
        "vy": vy,
        "wz": wz,
        "eStop": bool(e_stop),
        "mode_machine": mode_machine,
        "timestamp": ts,
    }


def pack_low_state_buffer(
    tick: int,
    pos_xyz: Tuple[float, float, float],
    rpy: Tuple[float, float, float],
    quat: Tuple[float, float, float, float],
    gyro: Tuple[float, float, float],
    accel: Tuple[float, float, float],
    motor_slots: Dict[int, Tuple[float, float, float]],
    mode_machine: int = MODE_MACHINE_G1_29DOF,
    battery_voltage: float = 24.8,
) -> bytes:
    """Serializes robot state into a 2,092-byte Unitree LowState_ buffer with CRC32."""
    buf = bytearray(LOW_STATE_BYTE_LENGTH)

    # 1. Header (0..15): <2I2B2xI
    struct.pack_into('<2I2B2xI', buf, 0, 1, 0, 0, mode_machine, tick)

    # 2. IMUState_ (16..71): <4f3f3f3fh2x
    qw, qx, qy, qz = quat
    gx, gy, gz = gyro
    ax, ay, az = accel
    roll, pitch, yaw = rpy
    struct.pack_into(
        '<4f3f3f3fh2x', buf, 16,
        qw, qx, qy, qz,
        gx, gy, gz,
        ax, ay, az,
        roll, pitch, yaw,
        38  # IMU temperature 38°C
    )

    # 3. 35 MotorState_ slots (72..2031): each 56 bytes: <B3x4f2hf7I
    for i in range(MOTOR_COUNT):
        offset = OFFSET_MOTOR_STATE_ARRAY + i * MOTOR_STATE_STRIDE
        if i in motor_slots:
            q, dq, tau = motor_slots[i]
            mode = 1  # PMSM mode active
            temp = 36 + (i % 5) * 2
            vol = battery_voltage
        else:
            mode = 0  # Inactive / unequipped slot
            q = dq = tau = 0.0
            temp = 25
            vol = battery_voltage

        struct.pack_into(
            '<B3x4f2hf7I', buf, offset,
            mode,
            float(q), float(dq), 0.0, float(tau),
            temp, max(25, temp - 3),
            vol,
            1000 + i, 2000 + i,
            0,  # motorstate
            0, 0, 0, 0  # reserve[4]
        )

    # 4. Footer (2032..2087):
    # wireless_remote[40]: 2032..2071 (zeroed)
    # reserve[0..2] = pos_xyz (2072..2083): <3f
    # reserve[3] = 0 (2084..2087): <I
    x, y, z = pos_xyz
    struct.pack_into('<3fI', buf, OFFSET_STATE_RESERVE, float(x), float(y), float(z), 0)

    # 5. Trailing Hardware CRC32 (2088..2091):
    words = struct.unpack('<522I', buf[:2088])
    crc = calc_crc32(words)
    struct.pack_into('<I', buf, OFFSET_CRC, crc)

    return bytes(buf)


# ==============================================================================
# Optional ONNX Policy Runner
# ==============================================================================
class ONNXPolicyRunner:
    """Executes trained RL policy via ONNX Runtime configured with deploy.yaml."""

    def __init__(self, policy_path: str, config_path: str, profile: dict):
        if not HAS_ONNX:
            raise RuntimeError("onnxruntime is required for --policy execution.")
        if not HAS_YAML:
            raise RuntimeError("pyyaml is required for --config execution.")
        if not os.path.exists(policy_path):
            raise FileNotFoundError(f"ONNX policy file not found: {policy_path}")
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Policy config file not found: {config_path}")

        self.policy_path = policy_path
        self.config_path = config_path
        self.profile = profile

        with open(config_path, "r", encoding="utf-8") as f:
            self.cfg = yaml.safe_load(f) or {}

        # 1. Control Decimation (Physics substeps per policy step)
        self.decimation = int(
            self._get_nested(["policy", "decimation"])
            or self._get_nested(["control", "decimation"])
            or self.cfg.get("decimation", 10)
        )

        # 2. Action Scale
        raw_scale = (
            self._get_nested(["policy", "action_scale"])
            or self._get_nested(["control", "action_scale"])
            or self.cfg.get("action_scale", 0.25)
        )
        self.action_scale = float(raw_scale) if isinstance(raw_scale, (int, float)) else raw_scale

        # 3. Joint Stiffness (kp) and Damping (kd)
        raw_kp = (
            self._get_nested(["control", "stiffness"])
            or self._get_nested(["control", "kp"])
            or self._get_nested(["robot", "kp"])
            or self.cfg.get("kp", 40.0)
        )
        raw_kd = (
            self._get_nested(["control", "damping"])
            or self._get_nested(["control", "kd"])
            or self._get_nested(["robot", "kd"])
            or self.cfg.get("kd", 2.0)
        )

        self.kp: Dict[str, float] = {}
        self.kd: Dict[str, float] = {}
        for name, _, _ in profile["joints"]:
            self.kp[name] = float(raw_kp.get(name, 40.0)) if isinstance(raw_kp, dict) else float(raw_kp)
            self.kd[name] = float(raw_kd.get(name, 2.0)) if isinstance(raw_kd, dict) else float(raw_kd)

        # 4. Default Joint Angles
        raw_defaults = (
            self._get_nested(["robot", "default_joint_angles"])
            or self._get_nested(["env", "default_joint_angles"])
            or self.cfg.get("default_joint_angles", {})
        )
        self.default_q: Dict[str, float] = {}
        for name, def_pos, _ in profile["joints"]:
            if isinstance(raw_defaults, dict) and name in raw_defaults:
                self.default_q[name] = float(raw_defaults[name])
            else:
                self.default_q[name] = def_pos

        # 5. Observation Scaling
        obs_scales = self.cfg.get("obs_scales", self.cfg.get("scales", {}))
        self.scale_ang_vel = float(obs_scales.get("ang_vel", 0.25))
        self.scale_dof_pos = float(obs_scales.get("dof_pos", 1.0))
        self.scale_dof_vel = float(obs_scales.get("dof_vel", 0.05))
        self.scale_commands = float(obs_scales.get("commands", 2.0))

        # 6. Initialize ONNX Session
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(policy_path, opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.input_shape = self.session.get_inputs()[0].shape
        self.output_name = self.session.get_outputs()[0].name
        self.expected_obs_dim = self.input_shape[-1] if len(self.input_shape) > 1 else None

        self.num_actions = len(profile["joints"])
        self.last_actions = np.zeros(self.num_actions, dtype=np.float32)

    def _get_nested(self, keys: List[str]):
        curr = self.cfg
        for k in keys:
            if isinstance(curr, dict) and k in curr:
                curr = curr[k]
            else:
                return None
        return curr

    def infer(
        self,
        omega: Tuple[float, float, float],
        gravity_proj: Tuple[float, float, float],
        cmd_vel: Tuple[float, float, float],
        joint_q: Dict[str, float],
        joint_dq: Dict[str, float],
    ) -> Dict[str, float]:
        """Performs observation assembly, policy evaluation, and target angle scaling."""
        scaled_omega = [w * self.scale_ang_vel for w in omega]
        gx, gy, gz = gravity_proj
        scaled_cmds = [
            cmd_vel[0] * self.scale_commands,
            cmd_vel[1] * self.scale_commands,
            cmd_vel[2] * self.scale_ang_vel,
        ]

        dof_pos = [
            (joint_q.get(name, self.default_q[name]) - self.default_q[name]) * self.scale_dof_pos
            for name, _, _ in self.profile["joints"]
        ]
        dof_vel = [
            joint_dq.get(name, 0.0) * self.scale_dof_vel
            for name, _, _ in self.profile["joints"]
        ]
        actions = list(self.last_actions)

        obs = np.array(scaled_omega + [gx, gy, gz] + scaled_cmds + dof_pos + dof_vel + actions, dtype=np.float32)

        if self.input_shape is not None and all(isinstance(d, int) for d in self.input_shape):
            total = int(np.prod(self.input_shape))
            if len(obs) < total:
                obs = np.pad(obs, (0, total - len(obs)), mode="constant")
            else:
                obs = obs[:total]
            obs_batch = obs.reshape(self.input_shape)
        else:
            obs_dim = (
                self.input_shape[-1]
                if (self.input_shape and isinstance(self.input_shape[-1], int))
                else len(obs)
            )
            if len(obs) < obs_dim:
                obs = np.pad(obs, (0, obs_dim - len(obs)), mode="constant")
            else:
                obs = obs[:obs_dim]
            obs_batch = np.expand_dims(obs, axis=0)

        raw_output = self.session.run([self.output_name], {self.input_name: obs_batch})[0]
        action_out = np.asarray(raw_output, dtype=np.float32).flatten()

        if len(action_out) >= self.num_actions:
            self.last_actions = np.array(action_out[:self.num_actions], dtype=np.float32)
        else:
            self.last_actions[:len(action_out)] = action_out

        targets: Dict[str, float] = {}
        for i, (name, _, _) in enumerate(self.profile["joints"]):
            act = float(action_out[i]) if i < len(action_out) else 0.0
            scale = self.action_scale[i] if isinstance(self.action_scale, (list, tuple)) else self.action_scale
            targets[name] = self.default_q[name] + scale * act

        return targets


# ==============================================================================
# Adaptive Kinematic Synthesizer
# ==============================================================================
class G1GaitSynthesizer:
    """Kinematic gait & gesture generator for Unitree G1 variants."""

    def __init__(self, profile: dict):
        self.profile = profile
        self.phase = 0.0
        self.thigh = THIGH_LENGTH
        self.shin = SHIN_LENGTH
        self.max_reach = 0.995 * (self.thigh + self.shin)

        # Sagittal nominal crouch
        hip0 = -0.16
        knee0 = 0.32
        self.nominal_ankle_x = -self.thigh * math.sin(hip0) - self.shin * math.sin(hip0 + knee0)
        self.nominal_ankle_z = -self.thigh * math.cos(hip0) - self.shin * math.cos(hip0 + knee0)

    def _leg_ik(self, x: float, z: float) -> Tuple[float, float]:
        r = min(self.max_reach, max(abs(self.thigh - self.shin) + 1e-3, math.hypot(x, z)))
        c_knee = min(1.0, max(-1.0, (self.thigh**2 + self.shin**2 - r**2) / (2 * self.thigh * self.shin)))
        knee = math.pi - math.acos(c_knee)
        alpha = math.atan2(-x, -z)
        c_beta = min(1.0, max(-1.0, (self.thigh**2 + r**2 - self.shin**2) / (2 * self.thigh * r)))
        beta = math.acos(c_beta)
        return (alpha - beta, knee)

    def step(
        self,
        dt: float,
        vx: float,
        vy: float,
        wz: float,
        base_pitch: float = 0.0,
        base_roll: float = 0.0,
    ) -> Dict[str, float]:
        # Branch 1: Fixed Manipulator Torso (Coordinated Dual-Arm Gestures)
        if self.profile["category"] == "fixed_manipulator":
            speed = math.hypot(vx, vy, wz)
            rate = 1.0 + 1.5 * min(1.0, speed)
            self.phase = (self.phase + 2.0 * math.pi * 0.5 * rate * dt) % (2.0 * math.pi)

            wave = math.sin(self.phase * 0.8)
            reach = math.cos(self.phase * 0.5)
            twist = math.sin(self.phase * 1.2) * 0.3
            spread = 0.15 + 0.1 * math.sin(self.phase * 0.4)

            targets = {name: def_pos for name, def_pos, _ in self.profile["joints"]}
            targets["left_shoulder_pitch_joint"] = 0.20 + 0.3 * reach + 0.2 * wave
            targets["left_shoulder_roll_joint"] = 0.15 + spread
            targets["left_shoulder_yaw_joint"] = twist
            targets["left_elbow_joint"] = 0.90 + 0.5 * reach + 0.5 * wave
            targets["left_wrist_roll_joint"] = twist
            targets["left_wrist_pitch_joint"] = -0.3 * reach
            targets["left_wrist_yaw_joint"] = twist

            targets["right_shoulder_pitch_joint"] = 0.20 + 0.3 * reach - 0.2 * wave
            targets["right_shoulder_roll_joint"] = -0.15 - spread
            targets["right_shoulder_yaw_joint"] = -twist
            targets["right_elbow_joint"] = 0.90 + 0.5 * reach - 0.5 * wave
            targets["right_wrist_roll_joint"] = -twist
            targets["right_wrist_pitch_joint"] = -0.3 * reach
            targets["right_wrist_yaw_joint"] = -twist
            return targets

        # Branch 2: Bipedal Locomotion (29-DOF and 23-DOF)
        speed = math.hypot(vx, vy)
        blend = min(1.0, max(speed / 0.8, abs(wz) / 1.0))
        gait_period = 1.0 / (1.0 + 0.6 * blend)

        if blend > 0.01:
            self.phase = (self.phase + ((2.0 * math.pi) / gait_period) * dt) % (2.0 * math.pi)

        stride_x = vx * (gait_period / 2.0)
        stride_y = vy * (gait_period / 2.0)
        stride_yaw = wz * (gait_period / 2.0)
        leg_height = -self.nominal_ankle_z - 0.02 * blend
        sway = -0.022 * blend * math.sin(self.phase)

        cos_p = math.cos(-base_pitch)
        sin_p = math.sin(-base_pitch)

        targets = {name: def_pos for name, def_pos, _ in self.profile["joints"]}

        def solve_leg(side: str, phase_offset: float):
            s = (((self.phase + phase_offset) / (2.0 * math.pi)) % 1.0 + 1.0) % 1.0
            if s < 0.5:
                along = 0.5 - s / 0.5
                lift = 0.0
            else:
                u = (s - 0.5) / 0.5
                along = -0.5 + (1.0 - math.cos(math.pi * u)) / 2.0
                lift = math.sin(math.pi * u)

            x_level = self.nominal_ankle_x + stride_x * along
            z_level = -leg_height + 0.07 * blend * lift
            x = x_level * cos_p + z_level * sin_p
            z = -x_level * sin_p + z_level * cos_p

            hip, knee = self._leg_ik(x, z)
            lateral = stride_y * along + sway
            hip_roll = math.atan2(lateral, leg_height) - base_roll
            toe_up = -0.12 * blend * lift

            if f"{side}_hip_pitch_joint" in targets:
                targets[f"{side}_hip_pitch_joint"] = hip
            if f"{side}_hip_roll_joint" in targets:
                targets[f"{side}_hip_roll_joint"] = hip_roll
            if f"{side}_hip_yaw_joint" in targets:
                targets[f"{side}_hip_yaw_joint"] = stride_yaw * along
            if f"{side}_knee_joint" in targets:
                targets[f"{side}_knee_joint"] = knee
            if f"{side}_ankle_pitch_joint" in targets:
                targets[f"{side}_ankle_pitch_joint"] = -(base_pitch + hip + knee) + toe_up
            if f"{side}_ankle_roll_joint" in targets:
                targets[f"{side}_ankle_roll_joint"] = -(base_roll + hip_roll)
            return x_level

        x_l = solve_leg("left", 0.0)
        x_r = solve_leg("right", math.pi)

        # Arm swing & Thoracic balance
        left_arm = 1.6 * (x_l - self.nominal_ankle_x)
        right_arm = 1.6 * (x_r - self.nominal_ankle_x)

        if "waist_yaw_joint" in targets:
            targets["waist_yaw_joint"] = 0.3 * (x_l - x_r)
        if "left_shoulder_pitch_joint" in targets:
            targets["left_shoulder_pitch_joint"] = 0.20 + left_arm
        if "right_shoulder_pitch_joint" in targets:
            targets["right_shoulder_pitch_joint"] = 0.20 + right_arm
        if "left_elbow_joint" in targets:
            targets["left_elbow_joint"] = 0.90 + 0.6 * left_arm
        if "right_elbow_joint" in targets:
            targets["right_elbow_joint"] = 0.90 + 0.6 * right_arm

        return targets


# ==============================================================================
# Simulation Backend: Pure NumPy Standalone
# ==============================================================================
class StandaloneSimulator:
    """Pure NumPy 50 Hz closed-loop physics/PD simulator."""

    def __init__(self, profile: dict, policy_runner: Optional[ONNXPolicyRunner] = None):
        self.profile = profile
        self.policy_runner = policy_runner
        self.gait = G1GaitSynthesizer(profile)
        self.tick = 0
        self.t = 0.0

        # Planar odometry
        self.pos_x = 0.0
        self.pos_y = 0.0
        self.pos_z = profile["nominal_pelvis_height"]
        self.yaw = 0.0
        self.pitch = 0.0
        self.roll = 0.0

        self.current_vx = 0.0
        self.current_vy = 0.0
        self.current_wz = 0.0

        self.q = {name: def_pos for name, def_pos, _ in profile["joints"]}
        self.dq = {name: 0.0 for name, _, _ in profile["joints"]}
        self.tau = {name: 0.0 for name, _, _ in profile["joints"]}

    def switch_profile(self, new_profile: dict):
        """Hot-swaps robot profile, re-initializing joint positions and gait synthesizer."""
        self.profile = new_profile
        self.gait = G1GaitSynthesizer(new_profile)
        self.tick = 0
        self.t = 0.0

        self.pos_x = 0.0
        self.pos_y = 0.0
        self.pos_z = new_profile["nominal_pelvis_height"]
        self.yaw = 0.0
        self.pitch = 0.0
        self.roll = 0.0

        self.current_vx = 0.0
        self.current_vy = 0.0
        self.current_wz = 0.0

        self.q = {name: def_pos for name, def_pos, _ in new_profile["joints"]}
        self.dq = {name: 0.0 for name, _, _ in new_profile["joints"]}
        self.tau = {name: 0.0 for name, _, _ in new_profile["joints"]}

    def update(self, target_vx: float, target_vy: float, target_wz: float, e_stop: bool, dt: float = 0.02) -> bytes:
        self.tick += 1
        self.t += dt

        if e_stop:
            target_vx = target_vy = target_wz = 0.0

        # Fixed Manipulator: locked base pose
        if self.profile["category"] == "fixed_manipulator":
            self.pos_x = 0.0
            self.pos_y = 0.0
            self.pos_z = self.profile["nominal_pelvis_height"]
            self.yaw = 0.0
            self.pitch = 0.0
            self.roll = 0.0
        else:
            # Biped inertial acceleration smoothing
            def ramp(curr: float, tgt: float, accel: float, decel: float) -> float:
                is_braking = (curr * tgt < 0) or (abs(tgt) < abs(curr))
                rate = decel if is_braking else accel
                step = rate * dt
                if abs(tgt - curr) <= step:
                    return tgt
                return curr + math.copysign(step, tgt - curr)

            self.current_vx = ramp(self.current_vx, target_vx, 2.5, 4.0)
            self.current_vy = ramp(self.current_vy, target_vy, 2.5, 4.0)
            self.current_wz = ramp(self.current_wz, target_wz, 4.0, 6.0)

            vx, vy, wz = self.current_vx, self.current_vy, self.current_wz

            self.yaw = math.atan2(math.sin(self.yaw + wz * dt), math.cos(self.yaw + wz * dt))
            cos_y = math.cos(self.yaw)
            sin_y = math.sin(self.yaw)
            self.pos_x += (vx * cos_y - vy * sin_y) * dt
            self.pos_y += (vx * sin_y + vy * cos_y) * dt
            self.pitch = 0.06 * vx
            self.roll = -0.05 * vy - 0.05 * vx * wz

        # Target articulation: Policy vs Kinematic Gait
        if self.policy_runner:
            gravity_proj = (
                -math.sin(self.pitch),
                math.sin(self.roll) * math.cos(self.pitch),
                -math.cos(self.roll) * math.cos(self.pitch),
            )
            targets = self.policy_runner.infer(
                omega=(0.0, 0.0, self.current_wz),
                gravity_proj=gravity_proj,
                cmd_vel=(target_vx, target_vy, target_wz),
                joint_q=self.q,
                joint_dq=self.dq,
            )
        else:
            targets = self.gait.step(dt, self.current_vx, self.current_vy, self.current_wz, self.pitch, self.roll)

        alpha = 1.0 - math.exp(-25.0 * dt)
        motor_slots: Dict[int, Tuple[float, float, float]] = {}

        for i, (name, def_pos, sdk_idx) in enumerate(self.profile["joints"]):
            target_q = def_pos if name in self.profile.get("locked_joints", ()) else targets.get(name, def_pos)
            prev_q = self.q[name]
            self.q[name] = prev_q + (target_q - prev_q) * alpha
            self.dq[name] = (self.q[name] - prev_q) / dt

            is_leg = "leg" in name
            blend = min(1.0, math.hypot(self.current_vx, self.current_vy) / 0.8)
            load = (0.2 + 0.3 * blend) if is_leg else 0.15
            self.tau[name] = 0.0 if e_stop else (load * 35.0 + math.sin(self.t * 2.0 + i) * 1.5)
            motor_slots[sdk_idx] = (self.q[name], self.dq[name], self.tau[name])

        cy = math.cos(self.yaw * 0.5)
        sy = math.sin(self.yaw * 0.5)
        cp = math.cos(self.pitch * 0.5)
        sp = math.sin(self.pitch * 0.5)
        cr = math.cos(self.roll * 0.5)
        sr = math.sin(self.roll * 0.5)
        quat = (
            cr * cp * cy + sr * sp * sy,
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
        )

        return pack_low_state_buffer(
            tick=self.tick,
            pos_xyz=(self.pos_x, self.pos_y, self.pos_z),
            rpy=(self.roll, self.pitch, self.yaw),
            quat=quat,
            gyro=(0.0, 0.0, self.current_wz),
            accel=(0.0, 0.0, 9.81),
            motor_slots=motor_slots,
            mode_machine=self.profile["mode_machine"],
        )


# ==============================================================================
# Simulation Backend: MuJoCo Physics Engine
# ==============================================================================
class MuJoCoSimulator:
    """High-fidelity MuJoCo physics simulation with multi-profile and policy support."""

    def __init__(
        self,
        profile: dict,
        model_path: Optional[str] = None,
        policy_runner: Optional[ONNXPolicyRunner] = None,
        use_viewer: bool = False,
    ):
        if not HAS_MUJOCO:
            raise RuntimeError("MuJoCo Python library is not installed in the active environment.")

        self.profile = profile
        self.policy_runner = policy_runner
        self.model_path = model_path or profile["mjcf_path"]

        if not os.path.exists(self.model_path):
            raise FileNotFoundError(f"MuJoCo model not found at: {self.model_path}")

        self.model = mujoco.MjModel.from_xml_path(self.model_path)
        self.data = mujoco.MjData(self.model)
        self.use_viewer = use_viewer
        self.viewer = None

        self.gait = G1GaitSynthesizer(profile)
        self.tick = 0
        self.physics_dt = self.model.opt.timestep

        self.joint_id_map: Dict[str, int] = {}
        self.actuator_id_map: Dict[str, int] = {}

        for name, default_pos, sdk_idx in self.profile["joints"]:
            j_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if j_id >= 0:
                self.joint_id_map[name] = j_id

            a_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if a_id >= 0:
                self.actuator_id_map[name] = a_id

        # Set initial posture in qpos
        for name, default_pos, _ in self.profile["joints"]:
            if name in self.joint_id_map:
                j_id = self.joint_id_map[name]
                self.data.qpos[self.model.jnt_qposadr[j_id]] = default_pos

        # Floating base initialization (bipeds)
        if self.profile["category"] != "fixed_manipulator" and self.model.nq >= 7:
            self.data.qpos[2] = self.profile["nominal_pelvis_height"]
            self.data.qpos[3] = 1.0
            self.data.qpos[4:7] = 0.0

        mujoco.mj_forward(self.model, self.data)

        # PD Controller Gains
        if self.policy_runner:
            self.kp = self.policy_runner.kp
            self.kd = self.policy_runner.kd
        else:
            self.kp = {}
            self.kd = {}
            for name, _, _ in self.profile["joints"]:
                if "knee" in name:
                    self.kp[name], self.kd[name] = 180.0, 9.0
                elif "hip" in name:
                    self.kp[name], self.kd[name] = 140.0, 7.0
                elif "ankle" in name:
                    self.kp[name], self.kd[name] = 60.0, 3.0
                elif "waist" in name:
                    self.kp[name], self.kd[name] = 100.0, 5.0
                elif "shoulder" in name:
                    self.kp[name], self.kd[name] = 60.0, 3.0
                elif "elbow" in name:
                    self.kp[name], self.kd[name] = 40.0, 2.0
                else:
                    self.kp[name], self.kd[name] = 20.0, 1.0

    def switch_profile(self, new_profile: dict, model_path: Optional[str] = None):
        """Hot-swaps robot profile in MuJoCo, reloading XML model and re-binding actuators."""
        self.profile = new_profile
        self.model_path = model_path or new_profile["mjcf_path"]

        if not os.path.exists(self.model_path):
            raise FileNotFoundError(f"MuJoCo model not found at: {self.model_path}")

        self.model = mujoco.MjModel.from_xml_path(self.model_path)
        self.data = mujoco.MjData(self.model)
        self.gait = G1GaitSynthesizer(new_profile)
        self.tick = 0
        self.physics_dt = self.model.opt.timestep

        self.joint_id_map.clear()
        self.actuator_id_map.clear()

        for name, default_pos, sdk_idx in self.profile["joints"]:
            j_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if j_id >= 0:
                self.joint_id_map[name] = j_id

            a_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if a_id >= 0:
                self.actuator_id_map[name] = a_id

        # Set initial posture in qpos
        for name, default_pos, _ in self.profile["joints"]:
            if name in self.joint_id_map:
                j_id = self.joint_id_map[name]
                self.data.qpos[self.model.jnt_qposadr[j_id]] = default_pos

        # Floating base initialization (bipeds)
        if self.profile["category"] != "fixed_manipulator" and self.model.nq >= 7:
            self.data.qpos[2] = self.profile["nominal_pelvis_height"]
            self.data.qpos[3] = 1.0
            self.data.qpos[4:7] = 0.0

        mujoco.mj_forward(self.model, self.data)

        # PD Controller Gains
        if self.policy_runner:
            self.kp = self.policy_runner.kp
            self.kd = self.policy_runner.kd
        else:
            self.kp = {}
            self.kd = {}
            for name, _, _ in self.profile["joints"]:
                if "knee" in name:
                    self.kp[name], self.kd[name] = 180.0, 9.0
                elif "hip" in name:
                    self.kp[name], self.kd[name] = 140.0, 7.0
                elif "ankle" in name:
                    self.kp[name], self.kd[name] = 60.0, 3.0
                elif "waist" in name:
                    self.kp[name], self.kd[name] = 100.0, 5.0
                elif "shoulder" in name:
                    self.kp[name], self.kd[name] = 60.0, 3.0
                elif "elbow" in name:
                    self.kp[name], self.kd[name] = 40.0, 2.0
                else:
                    self.kp[name], self.kd[name] = 20.0, 1.0

    def step_physics(
        self,
        target_vx: float,
        target_vy: float,
        target_wz: float,
        e_stop: bool,
        num_substeps: int = 10,
    ):
        """Advances physics and applies PD or ONNX policy torques."""
        dt = self.physics_dt
        dec = self.policy_runner.decimation if self.policy_runner else num_substeps
        decimation = max(1, int(dec))
        targets: Dict[str, float] = {}

        for sub in range(num_substeps):
            if sub % decimation == 0:
                if self.policy_runner:
                    if self.model.nq >= 7:
                        qw, qx, qy, qz = (
                            float(self.data.qpos[3]),
                            float(self.data.qpos[4]),
                            float(self.data.qpos[5]),
                            float(self.data.qpos[6]),
                        )
                        omega = (float(self.data.qvel[3]), float(self.data.qvel[4]), float(self.data.qvel[5]))
                        gravity_proj = (
                            -2.0 * (qx * qz + qw * qy),
                            -2.0 * (qy * qz - qw * qx),
                            -(1.0 - 2.0 * (qx * qx + qy * qy)),
                        )
                    else:
                        omega = (0.0, 0.0, 0.0)
                        gravity_proj = (0.0, 0.0, -1.0)

                    current_q = {}
                    current_dq = {}
                    for name, _, _ in self.profile["joints"]:
                        if name in self.joint_id_map:
                            j_id = self.joint_id_map[name]
                            current_q[name] = float(self.data.qpos[self.model.jnt_qposadr[j_id]])
                            current_dq[name] = float(self.data.qvel[self.model.jnt_dofadr[j_id]])
                        else:
                            current_q[name] = 0.0
                            current_dq[name] = 0.0

                    targets = self.policy_runner.infer(
                        omega=omega,
                        gravity_proj=gravity_proj,
                        cmd_vel=(target_vx, target_vy, target_wz),
                        joint_q=current_q,
                        joint_dq=current_dq,
                    )
                else:
                    targets = self.gait.step(dt * decimation, target_vx, target_vy, target_wz)

            # Apply PD torques
            for name, def_pos, _ in self.profile["joints"]:
                if name not in self.actuator_id_map or name not in self.joint_id_map:
                    continue

                act_id = self.actuator_id_map[name]
                jnt_id = self.joint_id_map[name]
                q_adr = self.model.jnt_qposadr[jnt_id]
                v_adr = self.model.jnt_dofadr[jnt_id]

                q = self.data.qpos[q_adr]
                dq = self.data.qvel[v_adr]

                if e_stop:
                    tau = -self.kd[name] * dq
                else:
                    locked = name in self.profile.get("locked_joints", ())
                    q_des = def_pos if locked else targets.get(name, def_pos)
                    tau = self.kp[name] * (q_des - q) - self.kd[name] * dq

                ctrl_range = self.model.actuator_ctrlrange[act_id]
                if ctrl_range[0] < ctrl_range[1]:
                    tau = max(ctrl_range[0], min(ctrl_range[1], tau))

                self.data.ctrl[act_id] = tau

            mujoco.mj_step(self.model, self.data)

    def get_low_state_buffer(self) -> bytes:
        """Extracts live telemetry from MjData and packages the 2,092-byte LowState_ buffer."""
        self.tick += 1

        if self.model.nq >= 7:
            pos_xyz = (float(self.data.qpos[0]), float(self.data.qpos[1]), float(self.data.qpos[2]))
            quat = (
                float(self.data.qpos[3]),
                float(self.data.qpos[4]),
                float(self.data.qpos[5]),
                float(self.data.qpos[6]),
            )
            qw, qx, qy, qz = quat
            sinr_cosp = 2.0 * (qw * qx + qy * qz)
            cosr_cosp = 1.0 - 2.0 * (qx * qx + qy * qy)
            roll = math.atan2(sinr_cosp, cosr_cosp)

            sinp = 2.0 * (qw * qy - qz * qx)
            pitch = math.copysign(math.pi / 2.0, sinp) if abs(sinp) >= 1.0 else math.asin(sinp)

            siny_cosp = 2.0 * (qw * qz + qx * qy)
            cosy_cosp = 1.0 - 2.0 * (qy * qy + qz * qz)
            yaw = math.atan2(siny_cosp, cosy_cosp)
            rpy = (roll, pitch, yaw)
            gyro = (float(self.data.qvel[3]), float(self.data.qvel[4]), float(self.data.qvel[5]))
        else:
            pos_xyz = (0.0, 0.0, self.profile["nominal_pelvis_height"])
            quat = (1.0, 0.0, 0.0, 0.0)
            rpy = (0.0, 0.0, 0.0)
            gyro = (0.0, 0.0, 0.0)

        accel = (0.0, 0.0, 9.81)

        motor_slots: Dict[int, Tuple[float, float, float]] = {}
        for name, def_pos, sdk_idx in self.profile["joints"]:
            if name in self.joint_id_map:
                j_id = self.joint_id_map[name]
                q = float(self.data.qpos[self.model.jnt_qposadr[j_id]])
                dq = float(self.data.qvel[self.model.jnt_dofadr[j_id]])
            else:
                q = def_pos
                dq = 0.0

            if name in self.actuator_id_map:
                a_id = self.actuator_id_map[name]
                tau = float(self.data.actuator_force[a_id])
            else:
                tau = 0.0

            motor_slots[sdk_idx] = (q, dq, tau)

        return pack_low_state_buffer(
            tick=self.tick,
            pos_xyz=pos_xyz,
            rpy=rpy,
            quat=quat,
            gyro=gyro,
            accel=accel,
            motor_slots=motor_slots,
            mode_machine=self.profile["mode_machine"],
        )


# ==============================================================================
# Access Policy (Origin allow-list + optional shared token)
# ==============================================================================
# The bridge accepts velocity commands and E-stop release, so it must not be
# reachable by arbitrary web pages or LAN hosts.
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
BROWSER_DEFAULT_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
MAX_MESSAGE_BYTES = 4096  # teleop frames are 32 B; JSON commands are < 1 KB
MAX_CLIENTS = 8
HANDSHAKE_TIMEOUT_S = 5.0
# A client whose oldest unsent frame is this old while its socket is full is disconnected; the page reconnects and gets a
# full greeting. Frames are not dropped instead: fsm and alert events are sent once, so a gap would go unseen.
MAX_CLIENT_LAG_S = 1.0
# Kernel send buffer per client (Linux doubles it). Data queued there is invisible to the lag check, so keep it to a fraction
# of a second instead of the auto-tuned megabytes.
CLIENT_SNDBUF_BYTES = 64 * 1024
CLOSE_TIMEOUT_S = 1.0


class AccessPolicy:
    """Decides whether a WebSocket upgrade request may connect."""

    def __init__(self, host: str, allow_origins: Iterable[str] = (), token: Optional[str] = None):
        self.loopback = host in LOOPBACK_HOSTS
        self.allow_origins = {o.strip().rstrip("/").lower() for o in allow_origins if o.strip()}
        self.token = token or None

    def check(self, origin: Optional[str], path: str) -> Optional[str]:
        """Returns None when allowed, otherwise a short human-readable reason."""
        if origin is None:
            # Non-browser clients (scripts, ROS tools) send no Origin; only trust them on loopback.
            if not self.loopback and not self.token:
                return "missing Origin on a non-loopback bind"
        else:
            norm = origin.strip().rstrip("/").lower()
            if norm not in self.allow_origins:
                parsed = urlparse(norm)
                if parsed.scheme not in ("http", "https") or parsed.hostname is None:
                    return f"origin '{origin}' not allowed"
                host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
                if not (self.loopback and (host in BROWSER_DEFAULT_ORIGIN_HOSTS or parsed.hostname in BROWSER_DEFAULT_ORIGIN_HOSTS)):
                    return f"origin '{origin}' not allowed"
        if self.token:
            supplied = parse_qs(urlparse(path).query).get("token", [""])[0]
            if not hmac.compare_digest(supplied.encode("utf-8"), self.token.encode("utf-8")):
                return "invalid or missing token"
        return None


# ==============================================================================
# Built-in Lightweight RFC-6455 Asyncio WebSocket Server (Zero-Dependency)
# ==============================================================================
class _Client:
    """One connected client: its unsent frames and the task that writes them, so a slow reader only delays itself."""

    def __init__(self, writer: asyncio.StreamWriter):
        self.writer = writer
        self.queue: Deque[Tuple[float, bytes]] = deque()   # (monotonic time queued, frame)
        self.wake = asyncio.Event()
        self.draining_since: Optional[float] = None        # set while drain() waits for a full socket
        self.task: Optional[asyncio.Task] = None


class BuiltinWebSocketServer:
    """Minimal, robust RFC-6455 WebSocket server implemented on asyncio.start_server."""

    def __init__(self, host: str, port: int, on_message_cb, policy: Optional[AccessPolicy] = None, on_connect=None):
        self.host = host
        self.port = port
        # Optional () -> list of str/bytes messages sent to each new client right after the handshake.
        self.on_connect = on_connect
        self.on_message_cb = on_message_cb
        self.policy = policy or AccessPolicy(host)
        self.clients: Dict[asyncio.StreamWriter, _Client] = {}
        self.server: Optional[asyncio.Server] = None
        self.dropped_slow = 0

    async def start(self):
        self.server = await asyncio.start_server(self._handle_client, self.host, self.port)

    async def stop(self):
        # Clients first: from Python 3.12 the server's wait_closed() waits for every connection to end.
        if self.server:
            self.server.close()
        for c in list(self.clients.values()):
            c.writer.transport.abort()
        self.clients.clear()
        if self.server:
            await self.server.wait_closed()

    @staticmethod
    def _frame(data) -> bytes:
        """Server-to-client frame (unmasked): str -> text (0x81), bytes -> binary (0x82)."""
        if isinstance(data, str):
            opcode, data = 0x81, data.encode("utf-8")
        else:
            opcode = 0x82
        length = len(data)
        if length < 126:
            header = bytes([opcode, length])
        elif length < 65536:
            header = struct.pack('!BBH', opcode, 126, length)
        else:
            header = struct.pack('!BBQ', opcode, 127, length)
        return header + data

    async def broadcast_binary(self, data: bytes):
        await self.broadcast(data)

    async def broadcast(self, data):
        """Queues the frame for every client and returns at once; each client's own task writes it."""
        if not self.clients:
            return
        frame = self._frame(data)
        now = time.monotonic()
        for c in list(self.clients.values()):
            # Only a client whose socket is full counts as behind: after a stall of the bridge itself, every queue has
            # old frames but no writer has had a turn yet.
            if c.draining_since is not None and c.queue and now - c.queue[0][0] > MAX_CLIENT_LAG_S:
                self._drop_slow(c, now - c.queue[0][0])
            else:
                self._enqueue(c, frame, now)

    @staticmethod
    def _enqueue(c: _Client, frame: bytes, now: float):
        c.queue.append((now, frame))
        c.wake.set()

    def _drop_slow(self, c: _Client, lag: float):
        self.clients.pop(c.writer, None)
        self.dropped_slow += 1
        peer = c.writer.get_extra_info("peername")
        print(f"[ROCO Bridge] Disconnected a client that fell {lag:.1f} s behind ({len(c.queue)} frames unsent, peer {peer}); "
              "it can reconnect")
        c.writer.transport.abort()   # close() would wait to flush to a reader that is not reading

    @staticmethod
    async def _send_loop(c: _Client):
        w = c.writer
        try:
            while True:
                while not c.queue:
                    c.wake.clear()
                    await c.wake.wait()
                _, frame = c.queue.popleft()
                w.write(frame)
                c.draining_since = time.monotonic()
                await w.drain()
                c.draining_since = None
        except (ConnectionError, OSError):
            pass   # the reader side sees the same loss and cleans up

    @staticmethod
    async def _reject(writer: asyncio.StreamWriter, status: str):
        body = status.encode("latin1")
        writer.write(
            b"HTTP/1.1 " + body + b"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        )
        try:
            await writer.drain()
        except Exception:
            pass

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        client: Optional[_Client] = None
        try:
            sock = writer.get_extra_info("socket")
            if sock is not None:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, CLIENT_SNDBUF_BYTES)
            try:
                request_bytes = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HANDSHAKE_TIMEOUT_S)
            except (asyncio.TimeoutError, asyncio.LimitOverrunError):
                return
            lines = request_bytes.decode('latin1', errors='ignore').split('\r\n')
            request_line = lines[0].split(' ')
            path = request_line[1] if len(request_line) >= 2 else "/"
            headers = {}
            for line in lines[1:]:
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()

            key = headers.get('sec-websocket-key')
            if not key:
                await self._reject(writer, "400 Bad Request")
                return

            reason = self.policy.check(headers.get('origin'), path)
            if reason:
                print(f"[ROCO Bridge] Rejected connection: {reason}")
                await self._reject(writer, "403 Forbidden")
                return
            if len(self.clients) >= MAX_CLIENTS:
                await self._reject(writer, "503 Service Unavailable")
                return

            guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            accept = base64.b64encode(hashlib.sha1((key + guid).encode('utf-8')).digest()).decode('utf-8')
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            writer.write(response.encode('latin1'))
            await writer.drain()

            # Greeting, then broadcasts, all through the client's queue: nothing awaits between these lines, so no
            # broadcast can come before the greeting.
            client = _Client(writer)
            now = time.monotonic()
            for msg in (self.on_connect() if self.on_connect else ()):
                self._enqueue(client, self._frame(msg), now)
            self.clients[writer] = client
            client.task = asyncio.ensure_future(self._send_loop(client))

            while True:
                hdr = await reader.readexactly(2)
                b1, b2 = hdr[0], hdr[1]
                opcode = b1 & 0x0F
                has_mask = (b2 & 0x80) != 0
                payload_len = b2 & 0x7F

                if payload_len == 126:
                    payload_len = struct.unpack('!H', await reader.readexactly(2))[0]
                elif payload_len == 127:
                    payload_len = struct.unpack('!Q', await reader.readexactly(8))[0]

                if payload_len > MAX_MESSAGE_BYTES:
                    # 1009 = message too big. Written past the queue (writes are whole frames, so it cannot split one);
                    # close() below flushes it.
                    writer.write(bytes([0x88, 0x02]) + struct.pack('!H', 1009))
                    break

                mask_key = await reader.readexactly(4) if has_mask else None
                payload = await reader.readexactly(payload_len)

                if has_mask and mask_key:
                    payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))

                if opcode == 0x08:  # Close
                    break
                elif opcode == 0x09:  # Ping: echo the payload in the pong (control frames are <= 125 B)
                    payload = payload[:125]
                    self._enqueue(client, bytes([0x8A, len(payload)]) + payload, time.monotonic())
                elif opcode in (0x02, 0x01):  # Binary or Text
                    self.on_message_cb(payload)

        except (
            asyncio.IncompleteReadError,
            ConnectionResetError,
            BrokenPipeError,
            asyncio.CancelledError,
            OSError,
        ):
            pass
        finally:
            self.clients.pop(writer, None)
            if client is not None and client.task is not None:
                client.task.cancel()
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), CLOSE_TIMEOUT_S)
            except Exception:
                writer.transport.abort()   # the peer is not reading what is left: do not hold the socket open


# ==============================================================================
# Bridge Application Coordinator
# ==============================================================================
class RocoBridge:
    """Coordinates simulation, WebSocket broadcasting at 50 Hz, and teleop reception."""

    def __init__(
        self,
        profile_id: str,
        mode: str,
        model_path: Optional[str],
        policy_path: Optional[str],
        config_path: Optional[str],
        host: str,
        port: int,
        use_viewer: bool = False,
        policy: Optional[AccessPolicy] = None,
    ):
        if profile_id not in ROBOT_PROFILES:
            raise ValueError(f"Unknown robot profile: {profile_id}. Choices: {list(ROBOT_PROFILES.keys())}")

        self.profile = ROBOT_PROFILES[profile_id]
        self.host = host
        self.port = port
        self.policy = policy or AccessPolicy(host)
        self.mode = mode
        self.model_path = model_path or self.profile["mjcf_path"]
        self.use_viewer = use_viewer

        self.target_vx = 0.0
        self.target_vy = 0.0
        self.target_wz = 0.0
        self.e_stop = False
        self.last_cmd_time = time.time()

        # Optional ONNX Policy runner
        self.policy_runner: Optional[ONNXPolicyRunner] = None
        if policy_path and config_path:
            print(f"[ROCO Bridge] Initializing ONNX RL policy runner ({policy_path}) with config ({config_path})...")
            self.policy_runner = ONNXPolicyRunner(policy_path, config_path, self.profile)

        # Simulation backend
        if self.mode == "mujoco" or (self.mode == "auto" and HAS_MUJOCO):
            print(f"[ROCO Bridge] Initializing MuJoCo engine with {self.model_path} [{self.profile['name']}]...")
            self.sim = MuJoCoSimulator(
                self.profile,
                model_path=self.model_path,
                policy_runner=self.policy_runner,
                use_viewer=self.use_viewer,
            )
            self.active_mode = "mujoco"
        else:
            print(f"[ROCO Bridge] Initializing Standalone NumPy physics [{self.profile['name']}]...")
            self.sim = StandaloneSimulator(self.profile, policy_runner=self.policy_runner)
            self.active_mode = "standalone"

        self.server: Optional[BuiltinWebSocketServer] = None
        self.ws_server_handle = None

    def switch_profile(self, new_profile_id: str) -> bool:
        """Hot-swaps the active physics simulation profile."""
        if new_profile_id not in ROBOT_PROFILES:
            print(f"[ROCO Bridge] Warning: Unknown profile '{new_profile_id}' requested, ignoring.")
            return False
        if new_profile_id == self.profile["id"]:
            return True

        old_id = self.profile["id"]
        print(f"[ROCO Bridge] Hot-swapping physics profile: {old_id} -> {new_profile_id}")
        self.profile = ROBOT_PROFILES[new_profile_id]
        self.model_path = self.profile["mjcf_path"]

        # Reset velocities to avoid transients
        self.target_vx = 0.0
        self.target_vy = 0.0
        self.target_wz = 0.0

        if self.policy_runner:
            self.policy_runner.profile = self.profile

        if self.active_mode == "mujoco":
            self.sim.switch_profile(self.profile, self.model_path)
        else:
            self.sim.switch_profile(self.profile)

        return True

    def on_teleop_message(self, data: bytes):
        """Processes incoming 32-byte binary or JSON teleop commands from ROCO."""
        self.last_cmd_time = time.time()

        # 1. Binary 32-byte frame (0x524F434F)
        if len(data) >= TELEOP_CMD_BYTE_LENGTH:
            cmd = unpack_teleop_cmd(data)
            if cmd is not None:
                self.target_vx = cmd["vx"]
                self.target_vy = cmd["vy"]
                self.target_wz = cmd["wz"]
                self.e_stop = cmd["eStop"]
                mode_machine = cmd.get("mode_machine", 0)
                if mode_machine > 0 and mode_machine in MODE_MACHINE_TO_PROFILE:
                    target_profile = MODE_MACHINE_TO_PROFILE[mode_machine]
                    if target_profile != self.profile["id"]:
                        self.switch_profile(target_profile)
                return

        # 2. JSON Fallback frame
        try:
            msg = json.loads(data.decode("utf-8"))
            msg_type = msg.get("type")
            if msg_type == "switch_profile":
                prof_id = msg.get("profileId")
                if prof_id and prof_id in ROBOT_PROFILES and prof_id != self.profile["id"]:
                    self.switch_profile(prof_id)
            elif msg_type == "cmd_vel":
                linear = msg.get("linear", {})
                angular = msg.get("angular", {})
                self.target_vx = float(linear.get("x", 0.0))
                self.target_vy = float(linear.get("y", 0.0))
                self.target_wz = float(angular.get("z", 0.0))
            elif msg_type == "emergency_stop":
                self.e_stop = bool(msg.get("latched", False))
                if self.e_stop:
                    self.target_vx = self.target_vy = self.target_wz = 0.0
        except Exception:
            pass

    async def broadcast_loop(self):
        """50 Hz (20ms) broadcast loop emitting 2,092-byte Unitree LowState_ frames."""
        interval = 0.02
        print(f"[ROCO Bridge] Broadcaster active @ 50 Hz on ws://{self.host}:{self.port} [{self.active_mode}] (Profile: {self.profile['id']}, mode_machine: {self.profile['mode_machine']})")

        while True:
            loop_start = time.perf_counter()

            if time.time() - self.last_cmd_time > 0.5:
                self.target_vx = 0.0
                self.target_vy = 0.0
                self.target_wz = 0.0

            if self.active_mode == "mujoco":
                self.sim.step_physics(self.target_vx, self.target_vy, self.target_wz, self.e_stop, num_substeps=10)
                frame = self.sim.get_low_state_buffer()
            else:
                frame = self.sim.update(self.target_vx, self.target_vy, self.target_wz, self.e_stop, dt=0.02)

            if self.server:
                await self.server.broadcast_binary(frame)
            elif HAS_WEBSOCKETS and hasattr(self, 'ws_clients'):
                # Not `await ws.send()` client by client: one slow reader would hold up every other. Each frame is a full
                # LowState_, so a client that is behind just skips this one and gets the next.
                ready = [ws for ws in self.ws_clients
                         if getattr(ws, "transport", None) is None
                         or ws.transport.get_write_buffer_size() <= CLIENT_SNDBUF_BYTES]
                websockets.broadcast(ready, frame)

            elapsed = time.perf_counter() - loop_start
            sleep_time = max(0.001, interval - elapsed)
            await asyncio.sleep(sleep_time)

    async def run(self):
        """Starts WebSocket server and background 50 Hz physics loop."""
        if HAS_WEBSOCKETS:
            self.ws_clients = set()

            async def ws_handler(websocket):
                # websockets >= 13 exposes .request; older releases expose .request_headers/.path.
                req = getattr(websocket, "request", None)
                req_headers = req.headers if req is not None else websocket.request_headers
                req_path = req.path if req is not None else websocket.path
                reason = self.policy.check(req_headers.get("Origin"), req_path)
                if reason is None and len(self.ws_clients) >= MAX_CLIENTS:
                    reason = "too many clients"
                if reason:
                    print(f"[ROCO Bridge] Rejected connection: {reason}")
                    await websocket.close(1008, "forbidden")
                    return
                sock = websocket.transport.get_extra_info("socket") if getattr(websocket, "transport", None) else None
                if sock is not None:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, CLIENT_SNDBUF_BYTES)
                self.ws_clients.add(websocket)
                try:
                    async for message in websocket:
                        if isinstance(message, str):
                            self.on_teleop_message(message.encode('utf-8'))
                        elif isinstance(message, bytes):
                            self.on_teleop_message(message)
                except websockets.ConnectionClosed as e:
                    # e.g. a client that stopped reading misses the keepalive pings; not worth a traceback
                    print(f"[ROCO Bridge] Client closed: {e}")
                finally:
                    self.ws_clients.discard(websocket)

            self.ws_server_handle = await websockets.serve(ws_handler, self.host, self.port, max_size=MAX_MESSAGE_BYTES)
        else:
            self.server = BuiltinWebSocketServer(self.host, self.port, self.on_teleop_message, self.policy)
            await self.server.start()

        await self.broadcast_loop()


# ==============================================================================
# Self-Test Validation
# ==============================================================================
def run_self_test() -> bool:
    """Validates 2,092-byte LowState_ buffer layout, byte offsets, CRC32, and teleop codec across all profiles."""
    print("=" * 72)
    print("ROCO Multi-Robot Bridge & Codec Validation Test")
    print("=" * 72)

    profiles_to_test = list(ROBOT_PROFILES)

    for pid in profiles_to_test:
        prof = ROBOT_PROFILES[pid]
        print(f"\n--- Testing Profile: {prof['id']} ({prof['name']}) ---")

        sim = StandaloneSimulator(prof)
        buf = sim.update(target_vx=0.5, target_vy=0.0, target_wz=0.2, e_stop=False, dt=0.02)

        # 1. Validate Size
        if len(buf) != LOW_STATE_BYTE_LENGTH:
            print(f"FAILED: Expected packet length {LOW_STATE_BYTE_LENGTH}, got {len(buf)}")
            return False
        print(f"  [✓] Buffer Size: {len(buf)} bytes exact")

        # 2. Validate Header & mode_machine
        v0, v1, mode_pr, mode_mach, tick = struct.unpack_from('<2I2B2xI', buf, 0)
        if mode_mach != prof["mode_machine"]:
            print(f"FAILED: mode_machine mismatch: expected {prof['mode_machine']}, got {mode_mach}")
            return False
        print(f"  [✓] Header: version=({v0},{v1}), mode_pr={mode_pr}, mode_machine={mode_mach} (Match)")

        # 3. Validate IMU and Reserve[0..2]
        px, py, pz = struct.unpack_from('<3f', buf, OFFSET_STATE_RESERVE)
        if abs(pz - prof["nominal_pelvis_height"]) > 0.05:
            print(f"FAILED: Pelvis Z height mismatch: expected ~{prof['nominal_pelvis_height']}, got {pz}")
            return False
        print(f"  [✓] Pelvis Pos @ byte {OFFSET_STATE_RESERVE}: ({px:.3f}, {py:.3f}, {pz:.3f})")

        # 4. Validate Motor Slot Population
        active_indices = {sdk_idx for _, _, sdk_idx in prof["joints"]}
        for i in range(MOTOR_COUNT):
            offset = OFFSET_MOTOR_STATE_ARRAY + i * MOTOR_STATE_STRIDE
            mode, = struct.unpack_from('<B', buf, offset)
            if i in active_indices:
                if mode != 1:
                    print(f"FAILED: Expected active motor slot {i} (mode=1), got mode={mode}")
                    return False
            else:
                if mode != 0:
                    print(f"FAILED: Expected inactive motor slot {i} (mode=0), got mode={mode}")
                    return False
        print(f"  [✓] Motor Slots: {len(active_indices)} active slots (mode=1) correctly mapped to sdkMotorIndex")

        # 5. Validate Hardware CRC32 Checksum
        words = struct.unpack('<522I', buf[:2088])
        expected_crc = calc_crc32(words)
        packet_crc = struct.unpack_from('<I', buf, OFFSET_CRC)[0]
        if expected_crc != packet_crc:
            print(f"FAILED: CRC mismatch! Expected 0x{expected_crc:08X}, packet has 0x{packet_crc:08X}")
            return False
        print(f"  [✓] Hardware CRC32 @ byte {OFFSET_CRC}: 0x{packet_crc:08X} (Bit-exact match)")

    # 6. Validate Teleop Command Decoding
    print("\n--- Testing 32-Byte Teleop Frame Codec with mode_machine (Byte 21) ---")
    test_cmd = struct.pack('<IIfffBB2xd', TELEOP_MAGIC, 204, 0.7, -0.4, 0.6, 0, MODE_MACHINE_G1_29DOF, time.time())
    parsed_cmd = unpack_teleop_cmd(test_cmd)
    if not parsed_cmd or parsed_cmd["seq"] != 204 or abs(parsed_cmd["vx"] - 0.7) > 1e-4 or parsed_cmd["mode_machine"] != MODE_MACHINE_G1_29DOF:
        print("FAILED: Teleop command frame unpacking mismatch")
        return False
    print(f"  [✓] Teleop Frame (0x524F434F): seq={parsed_cmd['seq']}, vx={parsed_cmd['vx']:.2f}, vy={parsed_cmd['vy']:.2f}, wz={parsed_cmd['wz']:.2f}, mode_machine={parsed_cmd['mode_machine']}")

    # 7. Validate ONNX Runtime and YAML
    print("\n--- Testing Runtime Dependencies & ONNX Policy Pipeline ---")
    print(f"  [✓] ONNX Runtime: {'Available' if HAS_ONNX else 'Not available'}")
    print(f"  [✓] PyYAML: {'Available' if HAS_YAML else 'Not available'}")
    print(f"  [✓] MuJoCo: {'Available' if HAS_MUJOCO else 'Not detected (Standalone NumPy simulator ready)'}")
    print(f"  [✓] WebSockets: {'Native websockets' if HAS_WEBSOCKETS else 'Built-in Asyncio RFC-6455'}")

    # a small model that ships with onnxruntime, wherever it is installed
    sample_onnx = os.path.join(os.path.dirname(ort.__file__), "datasets", "mul_1.onnx") if HAS_ONNX else ""
    if HAS_ONNX and HAS_YAML and os.path.exists(sample_onnx):
        import tempfile
        test_cfg = {
            "policy": {"decimation": 5, "action_scale": 0.25},
            "control": {"kp": 50.0, "kd": 2.5},
            "default_joint_angles": {"left_hip_pitch_joint": -0.16},
        }
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as tf:
            yaml.dump(test_cfg, tf)
            cfg_path = tf.name

        try:
            for pid in profiles_to_test:
                runner = ONNXPolicyRunner(sample_onnx, cfg_path, ROBOT_PROFILES[pid])
                targets = runner.infer(
                    omega=(0.0, 0.0, 0.0),
                    gravity_proj=(0.0, 0.0, -1.0),
                    cmd_vel=(0.4, 0.0, 0.2),
                    joint_q={},
                    joint_dq={},
                )
                assert len(targets) == len(ROBOT_PROFILES[pid]["joints"])
            print("  [✓] ONNX Policy Runner: Successfully verified inference & observation mapping across all profiles")
        finally:
            if os.path.exists(cfg_path):
                os.unlink(cfg_path)

    # 8. Validate Bidirectional Live Profile Synchronization & Hot-Swapping
    print("\n--- Testing Live Profile Hot-Swapping via Teleop Frame (Byte 21) ---")
    bridge = RocoBridge(
        profile_id="g1_29dof",
        mode="standalone",
        model_path=None,
        policy_path=None,
        config_path=None,
        host="127.0.0.1",
        port=8765,
    )
    for target_mode, expected_pid in [(MODE_MACHINE_ROCO_DUAL_ARM_SIM, "g1_dual_arm"), (MODE_MACHINE_G1_23DOF, "g1_23dof"), (MODE_MACHINE_G1_29DOF_WAIST_LOCKED, "g1_29dof_waist_locked"), (MODE_MACHINE_G1_29DOF, "g1_29dof")]:
        swap_cmd = struct.pack('<IIfffBB2xd', TELEOP_MAGIC, 999, 0.0, 0.0, 0.0, 0, target_mode, time.time())
        bridge.on_teleop_message(swap_cmd)
        if bridge.profile["id"] != expected_pid:
            print(f"FAILED: Profile hot-swap failed: expected {expected_pid}, got {bridge.profile['id']}")
            return False
        buf = bridge.sim.update(0.0, 0.0, 0.0, False, 0.02)
        _, _, _, mode_mach, _ = struct.unpack_from('<2I2B2xI', buf, 0)
        if mode_mach != target_mode:
            print(f"FAILED: LowState mode_machine mismatch after swap: expected {target_mode}, got {mode_mach}")
            return False
        words = struct.unpack('<522I', buf[:2088])
        if calc_crc32(words) != struct.unpack_from('<I', buf, OFFSET_CRC)[0]:
            print(f"FAILED: CRC mismatch after hot-swap to {expected_pid}")
            return False
        print(f"  [✓] Hot-Swap to {expected_pid} (mode_machine={target_mode}): LowState emitted with CRC32 valid")

    print("\n" + "=" * 72)
    print("ALL TESTS PASSED: Bridge is 100% compliant with ROCO Multi-Robot Registry.")
    print("=" * 72)
    return True


# ==============================================================================
# Main Entry Point
# ==============================================================================
def main():
    parser = argparse.ArgumentParser(description="ROCO MuJoCo & Unitree Binary WebSocket Bridge")
    parser.add_argument(
        "--profile",
        type=str,
        choices=list(ROBOT_PROFILES),
        default="g1_29dof",
        help=f"Active robot profile from Registry: {', '.join(ROBOT_PROFILES)} (default: g1_29dof)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Optional custom path to MuJoCo XML (defaults to profile's MJCF in public/models/g1_description/)",
    )
    parser.add_argument("--policy", type=str, default=None, help="Optional path to RL ONNX policy file (e.g. policy.onnx)")
    parser.add_argument("--config", type=str, default=None, help="Optional path to deployment YAML config (e.g. deploy.yaml)")
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="WebSocket bind host (default: 127.0.0.1, loopback only). Non-loopback binds require --token.",
    )
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        metavar="ORIGIN",
        help="Extra browser Origin allowed to connect, e.g. http://cockpit.lan:5173 (repeatable). "
        "http(s)://localhost and 127.0.0.1 are always allowed on loopback binds.",
    )
    parser.add_argument(
        "--token",
        type=str,
        default=os.environ.get("ROCO_BRIDGE_TOKEN"),
        help="Shared secret; clients connect with ws://host:port/?token=SECRET (env: ROCO_BRIDGE_TOKEN).",
    )
    parser.add_argument("--port", type=int, default=8765, help="WebSocket bind port (default: 8765)")
    parser.add_argument(
        "--mode",
        type=str,
        choices=["auto", "mujoco", "standalone"],
        default="auto",
        help="Physics backend: 'mujoco', 'standalone', or 'auto' (default: auto)",
    )
    parser.add_argument("--viewer", action="store_true", help="Launch native MuJoCo interactive viewer")
    parser.add_argument("--self-test", action="store_true", help="Run multi-profile codec and CRC32 validation tests")

    args = parser.parse_args()

    if not args.self_test and args.host not in LOOPBACK_HOSTS:
        if not args.token:
            parser.error(
                f"--host {args.host} exposes velocity/E-stop control to the network; "
                "pass --token SECRET (or set ROCO_BRIDGE_TOKEN) to allow it."
            )
        print(f"[ROCO Bridge] WARNING: listening on non-loopback host {args.host}; token auth is required.")

    if args.self_test:
        success = run_self_test()
        sys.exit(0 if success else 1)

    bridge = RocoBridge(
        profile_id=args.profile,
        mode=args.mode,
        model_path=args.model,
        policy_path=args.policy,
        config_path=args.config,
        host=args.host,
        port=args.port,
        use_viewer=args.viewer,
        policy=AccessPolicy(args.host, args.allow_origin, args.token),
    )

    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print("\n[ROCO Bridge] Stopped by user.")


if __name__ == "__main__":
    main()
