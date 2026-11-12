# Changelog

All notable changes to ROCO. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `roco demo` plays the sample recording from your own PC, with no robot and no internet.
- `roco record IFACE OUT` records `rt/lowstate` and `rt/lowcmd` to CSV files that `roco replay` plays. It only subscribes,
  writes only into OUT (never into the deploy folder, never over a recording) and writes in batches every 0.2 s.
- `--ctrl-log FILE` on `roco sim` and `roco robot`, for a `g1_ctrl` log that is not in the deploy folder.
- The README has a Quick start for each way in (no robot, the simulator, the robot, a recording), a supported-platform line,
  a Controller state section, a Deploy folder section and a Troubleshooting table. The checks, regression tests and
  performance tools moved to CONTRIBUTING.md.
- `docs/recording-format.md` describes the recording files ROCO replays, so other tools can write them.
- SECURITY.md and the README say that a bridge token travels in the address over plain `ws://`, and suggest an SSH tunnel for
  watching from another PC. The page sends no referrer.
- Dependabot proposes weekly updates for the npm packages, the GitHub Actions and the Python packages: one grouped pull
  request for minor and patch updates, one per major update, each release at least 7 days old. cyclonedds stays at 0.10.2,
  which unitree_sdk2py needs. It leaves the setuptools build requirement alone, and keeps `@types/node` on its major
  (CI runs Node 22).
- CodeQL scans the page, the Python scripts and the workflows on every push and pull request to `main`, and weekly.

### Changed
- The GitHub workflows run each action at a fixed commit (named by its release in a comment), so a moved tag cannot change what CI
  or a release runs. `npm run lint` fails on an action that is not pinned.
- CI runs once for a Dependabot pull request, not a second time for the push to its branch.
- The bridge finds the deploy folder on its own: `--deploy-dir` or `ROCO_DEPLOY_DIR`, else `~/unitree_rl_mjlab/deploy_lock`,
  else `~/unitree_rl_mjlab/deploy` (the folder Unitree's repository ships). It prints the folder it uses. Robot data uses
  `config.yaml` when there is no `config_hw.yaml`.
- The abort is given as LT+B on the remote first (Unitree's default), and `p` only for `g1_ctrl` builds that have the keyboard
  abort: in the tour, the alerts, the abort checks and Help.
- Without a controller log, the page and the bridge say how to get one from Unitree's `g1_ctrl` (run it through `tee`).
- The tour's first step says that a recorded simulator run can be played with no robot, and where to start with your own G1.
- Operator test: the glance-drill pictures are retaken from the current page, and the answer keys for tasks 1 and 2 are
  re-read (the simulated fall's first alert now shows as Tilt, at the same moment as the ankle pitch ranges).

### Fixed
- The bridge sends 50 frames a second, as set (it sent 47 to 48), with no frame dropped. It reads DDS every 10 ms instead of
  20 ms, so live data reaches the page sooner: about 5 ms, and 12 ms at worst for 99 % of frames (was 12 ms and 22 ms).
  The bridge uses no more CPU than before.
- The page's warnings about a robot model or controller config that could not be read showed the file's full path on this PC.
  They now show it as the rest of the page does (`deploy/...`, or only the file name).
- The launcher printed a `ConnectionResetError` traceback when a browser stopped a download part way.
- The 3D view's badge while a replay is paused ("Paused at 82.5 s / 236.2 s") stays inside its box: the robot's name gives way
  first. It ran past the edge on recordings of a few minutes at 1366 and 1440 px.

## [0.1.1] - 2026-11-12

A clearer page, a 3D robot that stands on the floor, and a hosted demo that crosses no limit.

### Added
- Every action has a control in sight, labelled in words: Help, Display and Settings in the header, Take the tour on the sample
  banner, and stage names on the guided checks' Previous and Next buttons. Help lists every action with where its control is and
  its key.
- A Follow heading button on the 3D view. The camera stays still unless it is on, and the choice is remembered.
- `scripts/make_sim_demo.py` records the simulator run the hosted demo is cut from, and `scripts/capture_demo.py --procedure`
  picks the checklist a sample opens on.

### Changed
- The hosted demo is now 60 s of the simulated G1 (MuJoCo) driven by the real g1_ctrl controller: it stands and squats twice,
  with no stop limit crossed. It opens on the simulator checklist, and `npm run lint` fails a sample that crosses one.
  `capture_demo.py` leaves out g1_ctrl's startup lines that name the run's motion and policy files.
- Plainer words: Controller state instead of g1_ctrl state, Target and Torque next to q_cmd and τ, Alert sound and Spoken
  alerts, and a state change before a recording starts reads "before the recording".
- The 3D floor is lighter than the background in every theme, and a soft contact shadow under the feet replaces the glowing ring,
  so the robot no longer looks like it floats. The grid lines are all one colour and the light no longer turns with the robot.
- The CI clone-size guard is now 40 MB (was 25 MB). Git keeps every past version of the demo and screenshots, so each refresh
  adds about 4 MB to a full clone.
- The package description says Unitree G1, and `docs/brand/README.md` says the name and logo are outside Apache-2.0.

### Fixed
- After a jump in a paused replay, the joint targets showed the moment before the jump.
- Opening another workspace briefly showed the robot's old pose in the 3D view.

## [0.1.0] - 2026-11-10

First public release. ROCO is a read-only browser monitor for the Unitree G1. ROS 2 support is planned; this version monitors
Unitree G1 over DDS. It is not a safety system and comes with no warranty.

### Added
- A hosted demo that replays 60 s of a real G1 squat test in the browser, with no robot, install or account. Play, pause, speed,
  seek, the alert timeline, Analyze and Review all work on it. It is labelled SAMPLE everywhere.
- Live 3D view of the robot, joint plots, limit and temperature alerts, the g1_ctrl state timeline and a session report
  (Review, Save report).
- Replay of g1_record folders and zips through the bridge, with jump-to-time and numbers that equal the played-through run.
- A page that works from the keyboard and is built to WCAG 2.2 AA: alerts use shapes as well as colour, live alerts are announced
  once and rate limited, and the layout holds at 320 px wide and at 400 % zoom. `npm run check:a11y` (axe in three themes
  plus a keyboard walk) runs in CI.
- `npm run check:layout`: no layout jumps while data streams, and no page scroll from 1280 px wide.
- A launcher (`scripts/roco`) that starts the bridge and the page, and prints the link only once the bridge listens.
- A Python wheel on each GitHub release with the built page inside, giving the commands `roco` and `roco-dds-bridge`. The extra
  `roco[dds]` adds CycloneDDS; `unitree_sdk2py` is still installed from a clone. CI builds the wheel and tries it in a clean
  environment on every push.
- The ROCO logo: an upright figure inside a ring that stays open. It is in the page header, the browser tab and the README.
- Community files: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue and pull request templates.
- `THIRD-PARTY-LICENSES.md` and `LICENSE` ship with the built page, in the demo, the zip and the wheel. The build fails if a
  bundled package has no notice.
- CI on every push: type check, lint and page checks, build, layout and accessibility in Chrome, Python lint, the bridge,
  launcher and simulator self-tests, regression tests against real bridge processes, and a clone-size guard (25 MB).
- Performance tools: `npm run perf:load` (cold-load report) and `npm run soak` (a long run that watches the heap and frame rate).

### Changed
- The robot's meshes ship as compressed GLB files: 18.7 MB of models become 3.9 MB, and a cold load of the demo goes from
  22.3 MB to 7.5 MB. The STL files stay as the source (`node scripts/pack-meshes.mjs` rebuilds the GLBs).
- The plot panel loads on demand, and the launcher sends cache headers (long for hashed assets, none for `index.html`).
- The plot CSV export is labelled with the rate of the page's samples (about 50 Hz) in its file name.
- The old MuJoCo simulator bridge moved to `tools/sim-drive/`. It is not part of the monitor.

### Fixed
- The launcher printed the page link before the bridge was ready.
- The built-in WebSocket server accepted unmasked client frames; it now closes the connection with code 1002.
- A recording that has no lowcmd.csv now gives a clear message instead of "holds 0 recordings".
- A bridge started by the launcher now exits when the launcher is killed.
- The `/` key opened the command palette in drive mode.
- The header no longer jumps between one and two rows while data streams, and timeline labels no longer pile up on long spans.
- Real g1_ctrl states such as `squat` were drawn hatched, as if unknown.

### Known limits
- Only Unitree G1 over DDS. Other robots are not supported yet.
- Importing a URDF, xacro or MuJoCo file shows the model only. Live data needs Unitree LowState, the robot's height above the
  floor is a default guess, and a model that is not Z-up comes in turned.
- The page shows about 50 samples a second; the recording's own CSV has every sample.
- The screen reader pass (`docs/screen-reader-test.md`) is done by a person and is not part of CI.
