# Contributing to ROCO

Thanks for helping. ROCO is used next to real robot tests, so a few rules matter more here than in most projects.

## Rules every change keeps

1. **ROCO only reads.** The monitor and its bridge never publish to DDS, send a command, or write to the robot's or
   controller's folders. A change that needs to write anywhere other than the browser's own storage will not be merged.
   (`tools/sim-drive/` is the one exception: a simulator bridge for the page's drive controls, never used with a robot.)
2. **No work per sample on the fast paths.** The bridge takes in DDS samples at up to 1 kHz (`_ingest_*` in
   `scripts/roco_dds_bridge.py`), and the page draws every frame. Do not add per-sample or per-frame work there; do it
   when something changes, or in batches. It must run on a small PC beside the robot, not only on a workstation.
3. **New behaviour comes with a check** in the same pull request: a case in `npm run lint` (the `scripts/check-*.mjs`
   files), in a bridge's `--self-test`, or in `scripts/regress.py`.
4. **Plain words in the UI.** Say what the operator sees and what to do. "Within limit" never means "safe".

## Set up

```bash
npm ci                     # Node 20 or newer
npm run dev                # the page on http://localhost:5173 (open ?demo=1 to play the sample recording without a robot)
pip install numpy pyyaml   # the bridge; unitree_sdk2py and CycloneDDS only for live data
```

For live data or a replay, see "Quick start" in the README.

## Checks to run before a pull request

```bash
npx tsc -b
npm run lint                                   # oxlint plus the page, demo, mesh and release checks
npm run build
npm run check:layout                           # Chrome: no layout jumps, no sideways scroll
npm run check:a11y                             # Chrome: axe in three themes, reflow, keyboard walk
python3 -m pyflakes scripts tools
python3 scripts/roco_dds_bridge.py --self-test
scripts/roco --self-test
python3 tools/sim-drive/mujoco_roco_bridge.py --self-test
python3 scripts/regress.py                     # real bridge processes, about 90 s; --live adds DDS cases (domain 42)
python3 scripts/check_wheel.py                 # needs `pip install build`: builds the wheel, tries it in a clean environment
```

CI runs the same commands on every push and pull request, and checks that a full clone stays under 40 MB.

`npm run lint` is oxlint plus the colour, contrast, alert, profile, procedure, timeline, preference, demo, mesh and licence
checks. `check:layout` and `check:a11y` drive Chrome on the built page: no layout jumps at any width, axe in three themes,
reflow at 200 % and 400 % zoom, and a keyboard walk.

### Regression tests

`python3 scripts/regress.py` runs real bridge processes (Python and Node only; it writes its own 60 s recording to a temporary
folder). It starts bridges on free ports and checks that a client that stops reading does not hold up the others, that
recordings cut off mid-write open and play to the end, that the session report after a jump equals the report of the played
run, and that `roco demo` serves the page and the sample and stops cleanly. `--live` adds an old run's log (state stays
unknown) and a bridge restart (new session, its own alert history); these use a synthetic LowState_ on DDS domain 42, so a
simulator or robot on domain 0 never sees it. It prints PASS / FAIL / SKIP per case and exits 1 on a failure. It is not part
of `npm run lint`.

### Performance tools, run by hand

`npm run perf:load` prints a cold-load report of the built page (requests, bytes, time to the robot), and
`npm run soak -- --minutes 120` plays the sample over and over and checks that the page's heap stays flat and its frame rate
holds. The robot's meshes ship as compressed GLB files (`public/models/g1_description/meshes_glb/`, made from Unitree's STL
files by `node scripts/pack-meshes.mjs`; the STL files stay as the source).

### Replay checkpoints

A replay also starts a second, low-priority Python process (idle scheduling class, one thread) that plays the whole recording
once in the background. The page shows "Preparing numbers for jumps (N %)" while it runs (about 20 CPU seconds for a 4-minute
recording on a desktop PC). Until it has covered a jump target, a jump restarts the numbers there and the page says
"since X s". Once it has, a jump shows the same numbers as playing from the start. It keeps about 10 KB per 2 s of recording
in memory and writes nothing to disk. `--no-checkpoints` turns it off.

### The sample recording

The sample (`public/demo/g1-sample.rocodemo.gz`) is 60 s of the simulated G1 (MuJoCo) with the real controller, made with
`scripts/make_sim_demo.py` and `scripts/capture_demo.py`. The page plays it only when asked (the button, `?demo=1` or
`roco demo`) and labels it SAMPLE everywhere.

## Pull requests

- One topic per pull request, with a short note on what an operator would see differently.
- Screenshots for UI changes, at a phone width (390 px) and a desktop width.
- If you touched a fast path, give a before and after number (frame gap p99, CPU, or the time of the function).

## Making a release

1. Set the same new version in `package.json` and `pyproject.toml`, and in the wheel links in the README. Update the lock file with
   `npm install --package-lock-only`.
2. Give its `CHANGELOG.md` entry a date (`## [x.y.z] - YYYY-MM-DD`).
3. Commit, push, and wait for CI to pass.
4. `git tag vx.y.z && git push origin vx.y.z`.

`.github/workflows/release.yml` then checks the tag, the date and that no placeholder is left in the project's contact address
(`node scripts/check-release.mjs --release vx.y.z` runs the same check on your PC), and publishes the GitHub release with the
page as a zip and the wheel.

## Reporting a bug

Use the bug form. The most useful thing to attach is the **session report** (Review, then Save report) and the bridge's
console output. Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

By contributing you agree that your work is licensed under the Apache License 2.0, as the rest of the project is.
