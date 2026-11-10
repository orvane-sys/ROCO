# Changelog

All notable changes to ROCO. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

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
