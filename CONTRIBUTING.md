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

For live data or a replay, see "Run it" in the README.

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
python3 scripts/regress.py                     # real bridge processes, about a minute; --live adds DDS cases (domain 42)
python3 scripts/check_wheel.py                 # needs `pip install build`: builds the wheel, tries it in a clean environment
```

CI runs the same commands on every push and pull request.

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
