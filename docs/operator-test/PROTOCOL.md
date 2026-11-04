# ROCO operator test (plan step 7)

Purpose: find out whether people who operate, or would operate, the G1 can do the core jobs with ROCO, and change the design
from what they **do**, not what they say. Five people is enough to find the big problems; it is not enough to prove a rate.
Report counts ("4 of 5"), never percentages from this sample.

ROCO is read-only. Nothing in this test sends anything to a robot.

## Who and how long

- 3 to 5 participants who operate, or would operate, the robot. At least one who has never seen ROCO. If possible, one who uses
  a keyboard only and one who uses a screen reader.
- You run it (facilitator) and a second person times and writes (observer). If you are alone, see "If you are testing alone"
  below.
- Record rows with `docs/operator-test/observer.html`: open it in a browser, no server needed. It times each task, keeps the
  rows in the browser, and downloads `results.csv`.
- About 45 minutes each: 5 minutes brief, 30 minutes tasks, 10 minutes questions.

## Before the first participant (do once)

1. `npm run build`, then `npm run lint` must pass.
2. Pilot the whole protocol on yourself or a colleague. Fix wording in this file, not in the middle of a session.
3. Rehearse each glance scene (below) on your build and check the answer key against what the screen actually shows.
   Reach each scene by playing from 0 and pausing at the time, or jump straight to it once the Review card no longer says
   "Preparing numbers for jumps"; both give the same status bar (checked for scenes C to E on the 2026-10-24 squat recording).
   A jump made while that text is shown restarts the numbers at the target and the page says "since X s".
4. Start from a clean browser profile for each participant (no saved plot sets, tour not yet seen, text size 100 %).
5. Wi-Fi does not matter for the test, but ROCO makes no external requests anyway.

## Say this, and nothing more

"We are testing the screen, not you. If something is hard, that is a finding. I will not help during a task. If you are stuck
for longer than the limit, say so and we move on. You can stop at any time."

Do not explain the interface before the tasks. Do not hint. Write down what you wanted to say.

## Tasks

Order: tasks 1 to 4 for every participant, in the order given. Rotate which input method comes first: participants 1, 3, 5
start with the mouse, participants 2 and 4 with the keyboard only. A participant who uses a screen reader does all tasks with it.

Recordings are replayed with `scripts/roco replay "<zip>:<prefix>"`. Paths below are under
`unitree_rl_mjlab/deploy_lock/robots/g1/hw_logs/`.

### Task 1: Glance (2 s)

Setup: replay `g1_hw_test_2026-10-24.zip:2026-10-24/run3_squat_cal16/squat_cal16`, paused at the time shown. The observer covers
the screen, uncovers it for 2 seconds by the clock, covers it again.

Ask: "What state is the robot in? Does the screen show anything wrong, and if so what? What is the next step?"

Answer key, from a re-capture on 2026-11-03 after the frame was added round the state and status (replay played at 8× to 16 s before the target, then 1×; the frozen screen was read). Rehearse again
on your build and correct this table before the first participant:

| Scene | Pause at (picture shows) | Robot state | Status bar says | Alert panel |
|---|---|---|---|---|
| A | 17 s (19.5 s) | FixStand | No abort condition seen | none active |
| B | 40 s (42.0 s) | Velocity | No abort condition seen | none active |
| C | 80 s (82.3 s) | squat | 2 guided-check limits crossed | none active |
| D | 112 s (113.8 s) | Velocity | 5 guided-check limits crossed | none active |
| E | 228 s (230.0 s) | Passive | 5 guided-check limits crossed | none active (History 2) |

Add two scenes from the simulator fall recording (see task 2), played from 0 and paused at the time shown:

| Scene | Pause at | Robot state | Status bar says |
|---|---|---|---|
| F | 40 s (41.7 s) | Velocity | No abort condition seen |
| G | 58 s (59.5 s) | Passive | 5 critical, first: Joint range · Right Ankle Pitch (5 after Passive) |

The "guided-check limits crossed" in scenes C to E are the real-robot procedure's own stop limits (for example ankle pitch torque 29.8 Nm
in the squat against the 15 Nm limit at §6 T6), evaluated by the guided checks. No abort check and no alert is tripped. This
is a real case: the 2026-10-24 report says the same squats were stopped for review, and the manual's own limits (knee peak
45 Nm, ankle peak 15 Nm) were crossed. Score what the person **reads from the screen**, and whether they say the test should
stop for review.

The answer key above depends on the pause time. An earlier capture (before the frame was added) overshot by 1 to 4 s, and
scene C then showed 3 stage limits (the chip said "stage limits" then) and scene E showed no active alert; the second capture overshot by about 2 s, hence the
"picture shows" times above. The pictures in `drill/` and `glance-drill.html` use what each picture shows. They were taken before the chip was renamed from "N stage limits crossed" to "N guided-check limits crossed" (1.8, W3), so the picture still reads "stage limits"; re-capture them before the real run. The pictures were
re-captured on 2026-11-03 after the frame was added, so a drill run made on the earlier pictures (for example ID `P1`)
saw the old top bar and is a baseline for that design only. If you pause live for a human observer, re-read the screen at the moment you
pause and write that down, rather than trusting the table.

Scene G is the only critical-alert scene, and it comes from a simulator run (the real controller, a simulated robot).

Record per scene: state right (yes/no), screen status read right (yes/no), next step plausible (yes/no). `pass` = state and
status both right.

### Task 2: First alert after a fall

Setup: replay `~/ROCO_test_recordings/sim_fall_2026-11-03` (SIM: `g1_ctrl` with the MuJoCo simulator, recorded with
`g1_record`; made with `docs/operator-test/make_sim_fall.py`, about 150 MB, kept outside the repository). It is the manual's §5 step 3: the robot stands in Velocity, the operator presses `p`
at 52.0 s, and the simulated robot, with no rope, collapses. Play from 0 at 4×, pause at 63 s.

Ask: "Something went wrong in this recording. Which alert came first, what caused it, and what does the screen say to do?"

Answer key, from the rehearsal on 2026-11-03:
- Cause: `keyboard abort 'p' -> Passive` at 52.0 s. ROCO labels the alerts that follow as "after the change to Passive".
- First alert: Joint range, right ankle pitch (52.4 s; the left ankle pitch tripped at the same time). ROCO pins it as the first-out
  and marks it "First after Passive". Accept either ankle pitch, or "the change to Passive" as the cause.
- What to do, as the alert says: abort with LT+B or `p` if still in a policy state; after a fall, check the robot on the rope (manual §3).
- By 63 s the status bar reads "7 critical", and the first-out shown has moved to the right ankle roll, because ROCO starts a
  new burst after a 2 s quiet gap. Watch whether people are misled by that; note it either way.

Time from "go" to the answer. Target: under 10 s. `pass` = named an accepted first alert, or the change to Passive as the cause.
This is a rehearsal-style fall with a command to Passive, not a fall with the policy still running, so say so to the team
reading the result.

### Task 3: Launch and reach live sim data, new user, no help

Setup: the participant has only `README.md` and a terminal in the ROCO folder. The simulator and `g1_ctrl` are installed but not
running. Facilitator does not say which command to use.

Ask: "Get ROCO showing the simulated robot's live data."

Time from "go" until the status bar shows live data from the simulator. Target: under 3 minutes, no help (`help` = yes if you
had to say anything beyond repeating the task). `pass` = reached live data within the limit without help.

### Task 4: Ankle left versus right peak during the squat

Setup: replay `g1_hw_test_2026-10-24.zip:2026-10-24/run3_squat_cal16/squat_cal16`, at the start, paused.

Ask: "During the squats, which ankle works harder, left or right, and about how much torque at the peak?"

Answer key (ankle pitch |τ|, computed from `squat_cal16_lowstate.csv`, joints 4 and 10, inside the four squat states; checked by
one script, not by a second tool): left peaks at 29.8 Nm (208.8 s, last squat), right peaks at 15.1 Nm (84.8 s, second squat).
Left works harder. `pass` = says left, and a value within 3 Nm of 29.8. Target: under 30 s.

### Task 5: The same core tasks by keyboard only, and with a screen reader

Repeat tasks 1 and 4 (the others are mouse-independent by design) with keyboard only; with a screen reader, do the same and
add: "Add a mark called 'check ankle' at the point where the last squat starts." `pass` = completed without the mouse and
without help. Time is recorded but there is no time target. Say what you could not do, not only that you could not.

## If you are testing alone

One person, who also built the design, cannot show that other operators can use it. Report a solo run as "one builder, N
passes", not as an operator result. It can still find real problems, and it makes later sessions with other people shorter.
In order of value:

1. **Cold re-run by you.** Wait a few days. Open the app from the README only, with no notes, and do tasks 2 to 4 and the
   launch (task 3) as if new. Time yourself with `observer.html` and use participant IDs like `ME-day1`, `ME-day7`. Every place
   you hesitate or reread is a finding. Write it in notes.
2. **Blind the glance task with `glance-drill.html`.** Open it in a browser. It shows saved pictures of scenes A to G (in
   `drill/`) in random order, each for 2 s, then asks the state and what needs attention, and scores you against what the
   picture itself showed. It has two modes. **Timed** keeps the picture up until you press Space, Enter or click, and records your reading time (a
   scene with no key in 20 s is recorded as 20 s). **Flash** hides it after 1, 2 or 4 s. In the summary, a glance row only counts
   if it was right and read within 2 s. The 2 s limit is my assumption, not a measured number, so use the timed medians to
   decide whether to keep it. Download the rows and paste them under the header of `results.csv`. Only your first run counts,
   because repeating teaches you the pictures. Pictures are still images of the Run screen (taken at 1440 x 900) and fill the browser window while shown; a first version showed them in a narrow column, which made the text smaller than on the real screen and was fixed on 2026-11-03, so this tests reading
   the screen, not using it, and a screen-reader user cannot use it.
3. **Keyboard-only and screen-reader runs by you** (task 5). These need only you, because the question is whether the task
   is possible at all. Orca on this machine is still unverified.
4. **One outside person for 10 minutes** is worth more than any of the above. A friend, family member or classmate who has
   never seen the screen can do task 3 (launch) and the glance task on scenes A, B and G, after you tell them what the three
   states are. They cannot judge robot-specific decisions, so do not use them for task 4's meaning or for abort judgement.
5. **Screen recording** of each of your runs (the OS recorder is enough) so the times and the hesitations can be checked later.

What a solo run cannot do: show that an operator under test-day pressure reads the screen correctly, or that the wording
means the same to someone who did not write it. Keep that on the open items list.

## What the observer writes down

For every task row in `results.csv`: participant (P1, P2, ... no names), condition (`mouse`, `keyboard`, `screenreader`),
task, scene, pass (yes/no), seconds, help (yes/no), notes. Notes are what the person did and said, in their words, including
wrong paths and where they looked first. One row per scene for task 1.

After the tasks, ask three questions and write the answers verbatim:
1. What was the first thing you did not understand?
2. What did you look for that was not there?
3. Where would you look first if the robot started to fall?

## After the sessions

1. `node scripts/summarize-operator-test.mjs docs/operator-test/results.csv` prints each target with counts and medians.
2. Read the notes, group the problems, and rank them by how many participants hit them and how bad the result was.
3. Fix the top problems in the design, re-run only the task that failed with a new person, and say what changed.
4. A target "met" here means met in this small sample. It does not mean the screen is safe, and ROCO never says that.

## Open items before the real run

- **Fall recording is simulated.** No real-robot fall recording exists here. `sim_fall_2026-11-03` is the best available and is
  labelled SIM above. If a real log with a fall or abort turns up, swap it in and re-rehearse the key.
- **The recording script was run once as written in a scratch folder. I then changed the output log name to `log.txt`
  in the saved copy and checked only its syntax.** Run it once before relying on it.
- **Live sim for task 3:** `drive_squat.py` no longer exists here, so only the plain simulator start can be used.
- **Scenes were rehearsed by playing from 0 and by jumping** (after the background pass finished) on the 2026-10-24 squat
  recording: scenes C, D and E read 2, 5 and 5 (History 2) either way. The slider is not exact, so a jump lands within
  a few seconds of the time asked, not on it. Scenes F and G (simulated fall) were not re-checked by jumping.
- **Solo run:** if you do it alone, results are one person who knows the design. See "If you are testing alone".
- **glance-drill.html** was tested in headless Chrome only (shuffle, 2 s display, scoring, invalid answer, CSV, summarizer reads
  it). Its pictures come from replays on this PC: scenes A to E from the real 2026-10-24 squat log and F and G from the simulated
  collapse. Scene E has no alert in its picture, so no picture shows a real-robot alert.
- **observer.html** was tested in headless Chrome only (add rows, timer, reload keeps rows, download, summarizer reads the file,
  no horizontal scroll at 390 px). It has not been used with a screen reader.
- **People:** who the 3 to 5 participants are is your decision. Nothing in this folder contacts anyone.
