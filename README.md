# ROCO

A read-only monitor for a Unitree G1 (29-DoF EDU, type 6, waist roll and pitch locked) running Unitree's `g1_ctrl`
deploy controller, in the MuJoCo simulator or on the robot. It shows what the robot is doing, warns when a limit from
the controller's own config is approached, and replays recordings. It never commands anything.

React 19, Vite, Tailwind v4 and three.js in the browser; a Python bridge reads DDS.

## What it shows

- A 3D model driven by `rt/lowstate`.
- The `g1_ctrl` state (Passive, FixStand, Velocity, squat) read from its log, with the keys for the next state.
- Alerts for ankle PD demand, torque and joint-range limits, temperature, motor state, tilt, and stream gaps. The first
  alert of a burst is pinned on top, alerts after a change into Passive say so, each one has a "Do:" line with its manual
  section, and warnings can be shelved for the session (critical alerts cannot). The responses and the state-aware severity
  rules are data in `src/config/alertPolicy.ts`.
- The manual §3 abort criteria as named checks: step interval, abort lines in the `g1_ctrl` log, and torso lean in the squat.
  "Not tripped" never means "safe": the bar says "No abort condition seen".
- Optional tone and spoken cues (off by default, switches in the status bar) and screen reader announcements for new
  critical alerts.
- Guided checks for the test stages T0 to T9 and the sim rehearsal (`src/config/procedures/g1_type6.ts`, plain data, so
  another robot can add its own). Each item says where it comes from in `TEST_MANUAL.md` and is one of: measured by ROCO,
  a log line that must appear, or ticked by a person. A stage moves on only when you say so. A crossed stop limit cannot
  be hidden or marked "not applicable", and "Within limit" never means "safe to continue". Reference values are labelled
  sim or robot and a sim value is not shown as the robot's. The bridge sends a hash of `TEST_MANUAL.md` (read only); if it
  differs from the one the procedure was written for, the card says so. Ticks on live data are kept in the browser for the
  rest of the day; ticks made on a replay are never kept.
- One session timeline under every workspace: the `g1_ctrl` state as a band, alerts as ticks (diamond critical, triangle
  warning, circle info) and your marks. Click it in a replay to jump there; on live data it freezes the plots at that moment
  (Resume on the timeline or in Analyze). `M` adds a mark with an optional note (live marks are kept in the browser for the
  rest of the day, replay marks are not). The table view lists the same events for keyboard and screen reader use, with
  arrow keys, Shift for ten times as far, Enter and Escape on the band. For a replay the band shows the whole recording
  from the first moment (the bridge sends every state change); an older bridge shows it only as far as it was played.
- Plots in Analyze: windows of 5, 10, 30 and 60 s, a plot set (Selected joint, Ankles, Knees, Balance, Squat check, or one
  you saved) and a Left and right switch. At most four lines share an axis and a unit; torque, angle and tilt get their own
  plots, never a second y-axis. Hovering a plot moves one cursor across all plots, the timeline, the joint table (angle,
  target, torque and PD demand at that time) and, in a replay, the 3D pose. **CSV** saves the visible window, with the
  unix time first, and PlotJuggler opens it directly. Names are plain first ("Joint angle (q)"); the `?` help has a glossary.
- A per-state table (the same numbers as `real_log.py`), and all 29 motors.
- A **session report** in Review, as Markdown laid out like the hardware test reports (summary, setup, timeline, per-state
  numbers, guided checks, abort checks, alerts, marks). It lists what ROCO saw and says it is not a clearance.
- Replay of `g1_record` recordings, from a folder or a zip.
- A short first-run tour of the Run workspace, skippable, shown once per browser and restartable from `?`.

Values were checked against `g1_record` CSVs from live simulator runs (differences below 5e-6).

## Run it

Needs Node 20+ for the page, and Python 3.10 with `unitree_sdk2py` and CycloneDDS for the bridge. The page needs no
internet at run time (no external fonts, scripts or models).

The quickest start is the launcher (Python only, no Node on the test PC). Build the page once with `npm run build`, then:

```bash
./scripts/roco sim                      # simulator on this PC
./scripts/roco robot enp2s0             # real robot, on the wired interface that reaches it
./scripts/roco replay <folder-or-zip>   # a g1_record recording (or <zip>:<prefix>)
```

It starts the bridge, serves `dist/` on loopback only (default port 8780) and prints the link to open. Ctrl-C, closing the
terminal or `kill` stops the bridge too. `--port` and `--web-port` change the ports.

The bridge reads g1_ctrl's config, the robot model, the test manual and its log from the deploy folder
(`~/unitree_rl_mjlab/deploy_lock` by default; read only). If yours is elsewhere, pass `--deploy-dir DIR` or set
`ROCO_DEPLOY_DIR`. Without the folder the bridge warns and starts with ROCO's own default limits.

For development, with Node:

```bash
npm install
npm run dev            # page at http://localhost:5173
```

In another terminal, one of:

```bash
# simulator on this PC (unitree_mujoco and g1_ctrl on the loopback interface)
python3 scripts/roco_dds_bridge.py --iface lo

# real robot, on the wired interface that reaches it
python3 scripts/roco_dds_bridge.py --iface enp2s0 --source robot

# replay a recording (g1_record folder or zip)
python3 scripts/roco_dds_bridge.py --replay <folder-or-zip>
```

A replay also starts a second, low-priority Python process (idle scheduling class, one thread) that plays the whole
recording once in the background. The page shows "Preparing numbers for jumps (N %)" while it runs (about 20 CPU seconds for
a 4-minute recording on a desktop PC). Until it has covered a jump target, a jump restarts the numbers there and the
page says "since X s". Once it has, a jump shows the same numbers as playing from the start. It keeps about 10 KB per
2 s of recording in memory and writes nothing to disk. `--no-checkpoints` turns it off.

The bridge prints a link; open it. Without a bridge the page shows a "Not connected" screen with these commands.
**The sample recording** is 60 s of a real G1 squat test, played in the page. It only starts if you press the button (or open `?demo=1`) and is labelled SAMPLE everywhere.

Checks: `npx tsc -b`, `npm run lint` (oxlint plus the colour, contrast, alert, profile, procedure and timeline checks),
`python3 -m pyflakes scripts tools`, `python3 scripts/roco_dds_bridge.py --self-test`, `scripts/roco --self-test`,
`python3 tools/sim-drive/mujoco_roco_bridge.py --self-test`. CI (`.github/workflows/ci.yml`) runs all of them, `regress.py`
and a check that a full clone stays under 25 MB. See `CONTRIBUTING.md`.

Regression tests against real bridge processes (about 1 minute, Python and Node only, writes its own 60 s recording to a temporary folder):
`python3 scripts/regress.py`. It starts bridges on free ports and checks that a client that stops reading does not hold up the others,
that recordings cut off mid-write open and play to the end, and that the session report after a jump equals the report of the played
run. `--live` adds an old run's log (state stays unknown) and a bridge restart (new session, its own alert history); these use a
synthetic LowState_ on DDS domain 42, so a simulator or robot on domain 0 never sees it. It prints PASS / FAIL / SKIP per case and
exits 1 on a failure. It is not part of `npm run lint`.

## Safety

- The bridge subscribes only. A guard stops any DDS writer from being created in the process, so it cannot command the
  robot and does not trip `g1_ctrl`'s other-publisher check. Frames from the page are ignored except replay controls.
- The bridge listens on loopback only. Another host needs `--host` with `--token`.
- ROCO does not show a "safe to start". It cannot see the rope, the spotter or the room. Abort with `p` (keyboard) or
  `LT+B` (remote) in `g1_ctrl`, as in `TEST_MANUAL.md`.
- Values from the simulator are not expectations for the real robot. For example, a calm stand loads the ankle pitch
  about 6 to 7.5 Nm in the sim and 1 to 2 Nm on the robot.

## Layout

- `src/` the page. `src/services/telemetryStream.ts` is the WebSocket client; `src/types/monitor.ts` the bridge frames.
- `scripts/roco` the launcher. `scripts/roco_dds_bridge.py` the read-only DDS bridge. `scripts/roco_common.py` the wire format,
  robot profiles and WebSocket server both bridges share.
- `tools/sim-drive/` an older MuJoCo simulator bridge that accepts drive commands. It is not part of the monitor; see its README.
- Other robots are not supported yet.

## Licence

ROCO is licensed under Apache-2.0 (see `LICENSE`). The robot model files in `public/models/g1_description/` are from
Unitree's [unitree_ros](https://github.com/unitreerobotics/unitree_ros), BSD-3-Clause, © 2016-2022 Unitree Robotics;
see the `LICENSE` file in that folder.
