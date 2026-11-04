#!/usr/bin/env python3
"""
What both ROCO bridges share: the LowState wire format the page decodes (src/utils/unitreeBinaryCodec.ts), the robot
profiles (src/config/robotRegistry.ts), Unitree's CRC32, and the small RFC 6455 WebSocket server with its access policy.

scripts/roco_dds_bridge.py (the read-only monitor) and tools/sim-drive/mujoco_roco_bridge.py (the simulator that can be
driven) both import it. Standard library only.
"""

import asyncio
import base64
import hashlib
import hmac
import os
import socket
import struct
import time
from collections import deque
from typing import Deque, Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# The repository root, so the profiles' model paths work from any working directory
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
        "mjcf_path": os.path.join(REPO_ROOT, "public/models/g1_description/g1_29dof.xml"),
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
        "mjcf_path": os.path.join(REPO_ROOT, "public/models/g1_description/g1_23dof.xml"),
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
        "mjcf_path": os.path.join(REPO_ROOT, "public/models/g1_description/g1_dual_arm.xml"),
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
