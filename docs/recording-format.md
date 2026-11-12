# Recording format

ROCO replays a recording of a G1 run made of two CSV files that share a name (the *prefix*), plus an optional `g1_ctrl` log.
This is the layout `g1_record` writes, and `roco record IFACE OUT` writes it too (see Quick start in the README). Anything
that writes the same files can be replayed with `roco replay <folder-or-zip>`.

```
my_run/
├── stand1_lowstate.csv     # required: the robot's state (rt/lowstate)
├── stand1_lowcmd.csv       # optional: the controller's commands (rt/lowcmd)
└── log.txt                 # optional: g1_ctrl's log, for the controller state
```

## `<prefix>_lowstate.csv`

One row per `rt/lowstate` sample, with a header row naming the columns. ROCO finds columns by name, so
their order does not matter and extra columns are ignored.

| Columns | Meaning |
|---|---|
| `t` | seconds since the recording started |
| `unix_t` | the sample's time, Unix seconds (ROCO's clock for the whole replay) |
| `tick`, `mode_pr`, `mode_machine` | the `LowState_` fields of the same names |
| `quat_w`, `quat_x`, `quat_y`, `quat_z` | IMU orientation |
| `gyro_x`, `gyro_y`, `gyro_z` | IMU angular velocity, rad/s |
| `acc_x`, `acc_y`, `acc_z` | IMU acceleration, m/s² |
| `rpy_r`, `rpy_p`, `rpy_y` | IMU roll, pitch, yaw, rad |
| `q0` … `q28` | joint angle, rad |
| `dq0` … `dq28` | joint speed, rad/s |
| `tau_est0` … `tau_est28` | estimated joint torque, Nm |
| `temp0_0` … `temp0_28`, `temp1_0` … `temp1_28` | the motor's two temperatures, °C |
| `vol_0` … `vol_28` | motor voltage, V |
| `motorstate_0` … `motorstate_28` | motor state word (0 when no fault) |

The joints are numbered as in Unitree's SDK for the 29-DoF G1 (0 to 5 left leg, 6 to 11 right leg, 12 to 14 waist,
15 to 21 left arm, 22 to 28 right arm).

## `<prefix>_lowcmd.csv`

One row per `rt/lowcmd` sample, with `t` and `unix_t` as above, then for each joint 0 to 28: `q<i>`, `dq<i>`, `kp<i>`,
`kd<i>` and `tau<i>` (target angle, target speed, gains and feed-forward torque). Without this file the recording plays the
robot's state only, with no targets or PD demand.

## The log

Every `log*.txt` beside the CSV files is read for `g1_ctrl`'s lines, in spdlog's default format:

```
[2026-11-12 10:41:07.123] [info] FSM: Change state from Passive to FixStand
```

The times are the PC's local time and are matched to `unix_t`, so the log must come from the PC that made the recording.
Lines from 30 s before the first sample to 1 s after the last are used. See
[Controller state](../README.md#controller-state) for getting this log from Unitree's `g1_ctrl`.

## Folders and zips

`roco replay` takes:

- a folder or a zip holding one recording;
- `<folder-or-zip>:<prefix>` to pick one when it holds several (it lists them otherwise);
- the prefix itself, as a path (`my_run/stand1`).

A recording whose last row was cut off (the recorder killed, or the disk full) still plays: the cut-off row is skipped.
