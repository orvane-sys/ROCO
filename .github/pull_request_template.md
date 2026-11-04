## What changes for the operator

<!-- One or two sentences: what they see or can do differently. -->

## Checks

- [ ] `npx tsc -b`, `npm run lint`, `npm run build`
- [ ] Bridge self-tests and `python3 scripts/regress.py` (if the bridge or the launcher changed)
- [ ] New behaviour has a check (`scripts/check-*.mjs`, a `--self-test` case, or a `regress.py` case)
- [ ] Nothing new runs per sample or per frame (or: before/after numbers below)
- [ ] Still read-only: nothing is sent to the robot or the controller
- [ ] Screenshots at 390 px and desktop width (UI changes)
