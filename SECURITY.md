# Security

## Reporting a problem

Please **do not open a public issue**. Report it privately on GitHub: the repository's **Security** tab, then
**Report a vulnerability**. Once a fix is out, the report is published with credit to
you, unless you ask otherwise.

Supported: the latest release only.

## What ROCO exposes

- **The bridge** (`scripts/roco_dds_bridge.py`) listens for WebSocket clients on **127.0.0.1 only** by default. It only
  sends telemetry; the one message it takes is replay control (play, pause, speed, jump) for a recording. It never
  publishes to DDS or commands the robot.
- **Any other address** (`--host 0.0.0.0`, for a page on another PC) needs `--token SECRET`; the page connects with
  `ws://host:port/?token=SECRET`. Browser pages from other origins are refused unless named with `--allow-origin`.
  Anyone on that network who has the token can see the telemetry. The token travels in the address over plain `ws://`
  (no encryption), so anyone who can watch that network can read it: use it on the robot's own wired network only.
- **To watch from another PC, prefer an SSH tunnel** and keep the bridge on loopback:
  `ssh -L 8765:127.0.0.1:8765 -L 8780:127.0.0.1:8780 testpc`, then open the link the launcher printed. The page sends no
  referrer, so the address with the token is not passed on to other sites.
- **The launcher** (`scripts/roco`) serves the built page on 127.0.0.1 only, and only files inside `dist/`.
- **The page** keeps marks, ticks and alert history in the browser's own storage for the day. It sends nothing anywhere
  except to the bridge address it was given.
- `tools/sim-drive/` is a simulator bridge that **does accept drive commands**. It has the same loopback and token rules.
  Never connect it to a robot.

## Not a safety system

ROCO is a monitor. It does not stop the robot, and an alert that does not appear is not proof that everything is fine.
Keep the robot's own E-stop within reach.
