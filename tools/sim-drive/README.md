# sim-drive: the MuJoCo bridge that can be driven

`mujoco_roco_bridge.py` is ROCO's older simulator bridge. It runs a G1 in MuJoCo (or a small NumPy model when MuJoCo is
not installed), sends the same 2,092-byte LowState frames the page decodes, and **accepts drive commands** from the page:
velocity (WASD), E-stop and profile switches.

It is **not part of the monitor**. The monitor (`scripts/roco`, `scripts/roco_dds_bridge.py`) only reads, and never sends
anything to a robot. This bridge is kept for working on the page's drive controls and for trying the robot profiles
without g1_ctrl. Never point it at a real robot.

## Run

```bash
pip install numpy mujoco          # mujoco is optional; without it a NumPy model runs instead
python3 tools/sim-drive/mujoco_roco_bridge.py                       # G1 29-DOF on ws://127.0.0.1:8765
python3 tools/sim-drive/mujoco_roco_bridge.py --profile g1_23dof    # another robot profile
python3 tools/sim-drive/mujoco_roco_bridge.py --self-test           # codec, CRC32 and profile checks
```

Then open the page without `?monitor=1` (for example `npm run dev`, then `http://localhost:5173/`). Options:

- `--mode auto|mujoco|standalone`: physics backend (default `auto`).
- `--policy policy.onnx --config deploy.yaml`: run an RL policy (needs `onnxruntime` and `pyyaml`).
- `--viewer`: also open MuJoCo's own viewer.
- `--host`, `--allow-origin`, `--token`: who may connect. Loopback only by default; any other bind needs `--token`.

The wire format, the robot profiles and the WebSocket server are shared with the monitor's bridge, in
`scripts/roco_common.py`. The MuJoCo models are read from `public/models/g1_description/`, so the bridge works from any
working directory inside this repository.
