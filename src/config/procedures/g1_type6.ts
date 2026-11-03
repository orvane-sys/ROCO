import type { ProcItem, Procedure } from './types'

/**
 * G1 type 6 (waist-locked) test procedure, written from TEST_MANUAL.md in deploy_lock: the section 4 checklist, stages T0 to T9
 * of section 6, and the section 5 simulator rehearsal. Every item says which section it comes from. Where the manual gives a
 * number, the number is the manual's; where it says "much more" or "about", ROCO's reading is in alertPolicy.ts.
 *
 * The manual records different values for the simulator and for the real robot (ankle torque standing: 6 to 7.5 Nm in the
 * simulator, 1 to 2 Nm on the robot). Each reference below is therefore labelled by where it came from, and the page shows
 * only the ones that match the data source.
 *
 * To update after the manual changes: read the diff, edit the items below, then replace the hash. `npm run lint` fails while
 * the hash differs from the manual on this machine, so an outdated procedure cannot pass unnoticed.
 */
export const MANUAL_SHA256 = '8e7f0527fd08bec39a6c9d260cf95dcfc6cb0dbfdbbdbf4fd3198036a24c1739'

const manual = (id: string, ref: string, text: string, extra: Partial<ProcItem> = {}): ProcItem => ({ id, kind: 'manual', ref, text, ...extra })

const LOG_ROBOT_REPORTS: Partial<ProcItem> = {
  log: { seen: /robot reports 6\b/, stop: /robot reports (?!6\b)\d/ },
}

export const G1_TYPE6: Procedure = {
  id: 'g1_type6',
  title: 'Real-robot test (T0 to T9)',
  summary: 'The pre-session checklist, then the test stages in the order of the manual.',
  manual: { file: 'TEST_MANUAL.md', sha256: MANUAL_SHA256 },
  stages: [
    {
      id: 'Before',
      title: 'Pre-session checklist',
      where: 'robot hanging, powered off',
      intro: 'Tick every line. If one fails, do not start (manual §4).',
      items: [
        manual('pre-machine-type', '§4', 'App → Device → Data → Robot: Machine Type = 6.', { group: 'Robot' }),
        manual('pre-battery', '§4', 'Battery fully charged.', { group: 'Robot' }),
        manual('pre-hands', '§4', 'Rubber hands fitted and tight, no extra mass on the arms or torso.', { group: 'Robot' }),
        manual('pre-waist', '§4', 'Waist lock intact, no play when you gently push the torso forward or back (robot off).', { group: 'Robot' }),
        manual('pre-cables', '§4', 'No loose cables, no damage on the feet or ankle linkages.', { group: 'Robot' }),
        manual('pre-cooled', '§4', 'Robot powered off for at least 30 minutes since the last session.', { group: 'Robot' }),
        manual('pre-remote', '§1, §7', 'Wireless remote has charged batteries, is paired and tested.', { group: 'Robot' }),

        manual('pre-rehearsal', '§4, §5', 'Simulator rehearsal passed today with the same binary and configs.', { group: 'PC and software' }),
        manual('pre-newer', '§4', 'g1_ctrl is newer than every source file (rebuild if in doubt).', { group: 'PC and software' }),
        manual('pre-release', '§4', 'Release build: grep CMAKE_BUILD_TYPE robots/g1/build/CMakeCache.txt shows Release.', { group: 'PC and software' }),
        manual('pre-no-inject', '§4', 'Normal build, never a NaN-test build: strings robots/g1/build/g1_ctrl | grep -c G1_INJECT prints 0.', { group: 'PC and software' }),
        manual('pre-binary', '§4', 'You start exactly deploy_lock/robots/g1/build/g1_ctrl. Older builds stay non-executable.', { group: 'PC and software' }),
        manual('pre-aarch64', '§4', 'If running on the robot’s own computer (aarch64): rebuilt there.', { group: 'PC and software', note: 'Skip when running on this PC.' }),
        manual('pre-link', '§0, §4', 'Wired link up: ip -br addr show enp2s0 shows UP and 192.168.123.222/24; ping -c 5 192.168.123.161 shows 0% loss, under 1 ms.', { group: 'PC and software' }),
        manual('pre-wifi', '§0, §4', 'Wi-Fi off.', { group: 'PC and software' }),
        manual('pre-local', '§1, §4', 'g1_ctrl runs in a local terminal on this PC, not over a Wi-Fi SSH session.', { group: 'PC and software' }),
        manual('pre-one-sender', '§4', 'No other program publishing rt/lowcmd (no other g1_ctrl, no Unitree demo).', { group: 'PC and software' }),
        manual('pre-heavy', '§4', 'Other heavy programs closed. The policy runs at 50 Hz on this PC.', { group: 'PC and software' }),
        manual('pre-mains', '§4', 'Laptop on mains power, sleep and screen lock disabled.', { group: 'PC and software' }),

        manual('pre-rope', '§4', 'Rope attached, robot hanging with its feet a few centimetres above the floor.', { group: 'Area' }),
        manual('pre-spotter', '§4', 'Spotter has practised paying out and taking in about 35 cm of rope smoothly over 3 s.', { group: 'Area' }),
        manual('pre-clear', '§4', 'Floor clear, nobody within reach except the spotter at the hoist.', { group: 'Area' }),
      ],
    },
    {
      id: 'T0',
      title: 'Controller start',
      where: 'hanging',
      states: ['Passive'],
      keys: 'Start g1_record, then g1_ctrl -n enp2s0 -c config_hw.yaml --log',
      intro: 'T0 stays in Passive. It proves the connection works before anything moves (manual §6 T0).',
      items: [
        manual('t0-debug-mode', '§0, §6', 'Robot in zero-torque mode, then L2+R2 for debug mode, before g1_ctrl starts.'),
        {
          id: 't0-reports-6', kind: 'log', ref: '§6 T0', text: 'Log: “robot reports 6”.', stop: 'Any other value, or “Refusing to start”.',
          ...LOG_ROBOT_REPORTS,
        },
        { id: 't0-locked', kind: 'log', ref: '§6 T0', text: 'Log: “locked joints: 13,14”.', log: { seen: /locked joints: 13,14\b/ } },
        {
          id: 't0-crc', kind: 'log', ref: '§6 T0', text: 'Log: “State_squat: motion CRC32 135fd6f8 (matches deploy.yaml)”.',
          log: { seen: /CRC32 135fd6f8 \(matches deploy\.yaml\)/ },
        },
        {
          id: 't0-temps', kind: 'auto', ref: '§6 T0', text: 'Motor temperatures at start: none at 60 °C or above.',
          stop: 'A motor at 60 °C or more. On the real robot, all readings 0 (a placeholder, so the 80 °C stop would not see them).',
          refs: { sim: '0 °C (the simulator reports 0).', real: 'Legs 34 to 42 °C, arms 40 to 56 °C (2026-10-23; arms run warmer).' },
          auto: { type: 'startTemps', stopAtC: 60 },
        },
        manual('t0-temps-even', '§6 T0', 'Temperature line: both indices about equal, no motor far above its neighbours; only the 14th and 15th pairs (motors 13/14) read 0/0.', {
          stop: 'A temperature far above the others.',
        }),
        {
          id: 't0-motorstate', kind: 'auto', ref: '§6 T0', text: 'Motorstate at start: all the same value, none odd.',
          stop: 'A motorstate that differs from the rest.',
          refs: { sim: '0.', real: 'All the same value (2026-10-23).' },
          auto: { type: 'startMotorstate' },
        },
        {
          id: 't0-no-critical', kind: 'log', ref: '§6 T0', text: 'No “critical” or “Refusing to start” line in the log.',
          stop: 'Any such line. Do not continue; send the log for review.',
          log: { stop: /Refusing to start/, stopLevels: ['critical', 'error'], okWhenNone: true },
        },
        {
          id: 't0-one-sender', kind: 'auto', ref: '§0, §4', text: 'Only one program commands the robot: rt/lowcmd rate under 1500 Hz.',
          stop: 'About 1900 messages a second means a second sender.',
          refs: { real: 'About 910 per second from g1_ctrl (manual §0).' },
          auto: { type: 'lowcmdRate', stopHz: 1500 },
        },
      ],
    },
    {
      id: 'T1',
      title: 'Emergency stop checks',
      where: 'hanging',
      states: ['Passive', 'FixStand'],
      keys: 'f, then LT+B; f, then p',
      intro: 'LT is the L2 button, so “L2+B” in Unitree’s manual is the same combo. If LT+B does not work, stop the session (manual §6 T1).',
      items: [
        manual('t1-damped', '§6 T1', 'In Passive, gently move a leg by hand: it feels damped, not stiff.'),
        manual('t1-ltb', '§6 T1', 'Press f. After 2 s press LT+B. The robot goes soft within a fraction of a second.', {
          stop: 'LT+B does not work. Stop the session: the remote is the only stop that needs no terminal.',
        }),
        { id: 't1-log-ltb', kind: 'log', ref: '§6 T1', text: 'Log: “Change state from FixStand to Passive”.', log: { seen: /Change state from FixStand to Passive/ } },
        manual('t1-p', '§6 T1', 'Press f again. After 2 s press p. The robot goes soft within a fraction of a second.'),
        { id: 't1-log-p', kind: 'log', ref: '§6 T1', text: 'Log: “keyboard abort ’p’ -> Passive”.', log: { seen: /keyboard abort 'p' -> Passive/ } },
      ],
    },
    {
      id: 'T2',
      title: 'FixStand',
      where: 'hanging',
      states: ['FixStand'],
      keys: 'f, wait the full 4 s ramp, press nothing during it',
      intro: 'v and RT+A are ignored until the ramp ends; press RT+A again afterwards (manual §6 T2).',
      items: [
        {
          id: 't2-step', kind: 'auto', ref: '§6 T2', text: 'First 2 s in FixStand: largest command step 1 deg/tick at most.',
          stop: 'Above 1 deg/tick.',
          refs: { sim: 'Legs 0.0, arms 0.0 deg/tick.' },
          auto: { type: 'first2s', state: 'FixStand', parts: ['legs', 'arms'], measure: 'step', stop: 1 },
        },
        {
          id: 't2-speed', kind: 'auto', ref: '§6 T2', text: 'First 2 s in FixStand: fastest joint 1 rad/s at most.',
          stop: 'Above 1 rad/s.',
          refs: { sim: 'Legs 0.1 or less, arms 0.3 or less rad/s.' },
          auto: { type: 'first2s', state: 'FixStand', parts: ['legs', 'arms'], measure: 'speed', stop: 1 },
        },
        manual('t2-visual', '§6 T2', 'Wait about 10 s and watch the joints: a smooth move to the stance, then still.', { stop: 'Any shaking.' }),
      ],
    },
    {
      id: 'T3',
      title: 'Ctrl-C and what happens after exit',
      where: 'hanging, FixStand only',
      states: ['FixStand'],
      keys: 'Ctrl-C in the g1_ctrl terminal',
      intro: 'Recommended once. Never with the feet on the floor. Write the result down (manual §6 T3).',
      items: [
        manual('t3-ready', '§6 T3', 'Robot hanging in FixStand, spotter ready.'),
        manual('t3-ctrlc', '§6 T3', 'Pressed Ctrl-C in the g1_ctrl terminal. The robot goes soft at once.'),
        { id: 't3-log-signal', kind: 'log', ref: '§6 T3', text: 'Log: “Signal 2: Passive (damping) for 1.0 s, then exit”.', log: { seen: /Signal 2: Passive \(damping\) for 1\.0 s, then exit/ } },
        { id: 't3-log-exit', kind: 'log', ref: '§6 T3', text: 'Log: “Exit”.', log: { seen: /^Exit\b/ } },
        manual('t3-after', '§6 T3', 'For 10 s after Exit, noted whether the robot stays soft and damped, goes limp, or does something else; wrote it down.', {
          stop: 'Anything violent after Exit: run no ground test until it is understood.',
        }),
      ],
    },
    {
      id: 'T4',
      title: 'Velocity, hanging',
      where: 'hanging',
      states: ['Velocity'],
      keys: 'From FixStand after the ramp: v. Then wait 10 s.',
      items: [
        manual('t4-v', '§6 T4', 'From FixStand (after the ramp) pressed v and waited 10 s.'),
        {
          id: 't4-step', kind: 'auto', ref: '§6 T4', text: 'First 2 s in Velocity: legs’ largest command step 3 deg/tick at most.',
          stop: 'Above 3 deg/tick.',
          refs: { sim: 'Legs 0.2 to 2.5 deg/tick (depends on how the feet meet the ground).' },
          auto: { type: 'first2s', state: 'Velocity', parts: ['legs'], measure: 'step', stop: 3 },
        },
        {
          id: 't4-speed', kind: 'auto', ref: '§6 T4', text: 'First 2 s in Velocity: legs’ fastest joint 2 rad/s at most.',
          stop: 'Above 2 rad/s.',
          refs: { sim: '0.5 rad/s or less.' },
          auto: { type: 'first2s', state: 'Velocity', parts: ['legs'], measure: 'speed', stop: 2 },
        },
        {
          id: 't4-n-refused', kind: 'log', ref: '§6 T4', text: 'Press n: the log shows “request cancelled … need >= 1.5”.',
          stop: 'The squat starts in the air: LT+B at once.',
          refs: { sim: 'Ankle pitch |tau| L 0.2 R 0.2 Nm, need >= 1.5.', real: 'Hanging in Velocity: 0.8 to 0.9 Nm (2026-10-23).' },
          log: { seen: /request cancelled/ },
        },
        manual('t4-w', '§6 T4', 'Press w: the log prints “Velocity: key ’w’ ignored (keyboard_walk: false)”.'),
        manual('t4-visual', '§6 T4', 'Legs held still, maybe small balancing movements.', { stop: 'Stepping or kicking in the air.' }),
        {
          id: 't4-interval', kind: 'auto', ref: '§3, §6', text: 'Policy step interval 50 ms at most.', stop: 'Above 50 ms: half of the 100 ms stall limit.',
          refs: { sim: '20 to 23 ms.', real: 'About 20 ms.' },
          auto: { type: 'policyInterval', stopMs: 50 },
        },
      ],
    },
    {
      id: 'T5',
      title: 'Lowering onto the feet',
      where: 'feet on the floor, rope slack',
      states: ['Velocity'],
      intro: 'If the robot cannot stand still on its own: LT+B, hang it up, and end the session (manual §6 T5).',
      items: [
        manual('t5-lower', '§6 T5', 'Spotter lowered the robot slowly until both feet are flat and carrying weight. The rope stays attached with a little slack and would catch the robot within a few centimetres.'),
        manual('t5-stand', '§6 T5', 'Stood for 30 to 60 s without pushing the robot.'),
        manual('t5-stance', '§6 T5', 'Stance upright, still, feet flat.', { stop: 'Rocking, a foot lifting or sliding.' }),
        {
          id: 't5-ankle', kind: 'auto', ref: '§6 T5', text: 'Ankle pitch torque in Velocity: 15 Nm at most.',
          stop: 'Above 15 Nm, or very different left and right.',
          note: 'ROCO shows one maximum over the whole Velocity visit (as real_log.py does), not the standing value per side.',
          refs: { sim: 'About 6 to 7.5 Nm each side.', real: 'Left 1.0 to 1.2, right 1.5 to 2.0 Nm (2026-10-23, rope slack).' },
          auto: { type: 'segment', state: 'Velocity', field: 'tauAnkP', stop: 15 },
        },
        manual('t5-lr', '§6 T5', 'Ankle pitch torque similar on the left and right (from g1_record, or the 5 s window table in the test report).'),
        {
          id: 't5-knee', kind: 'auto', ref: '§6 T5', text: 'Knee torque in Velocity: 25 Nm at most.', stop: 'Above 25 Nm.',
          note: 'One maximum over the whole Velocity visit.',
          refs: { sim: 'About 5 Nm (4.5 to 5.7).', real: 'Left about 10, right about 5 Nm (2026-10-23).' },
          auto: { type: 'segment', state: 'Velocity', field: 'tauKnee', stop: 25 },
        },
        manual('t5-sound', '§6 T5', 'Quiet: no buzzing or whining from a joint.', { stop: 'Buzzing or whining.' }),
      ],
    },
    {
      id: 'T6',
      title: 'First squat',
      where: 'feet on the floor, spotter follows with the rope',
      states: ['Velocity', 'squat'],
      keys: 'n (only from Velocity). v does not stop a squat; the only aborts are LT+B and p.',
      intro: 'The pelvis goes down 33 cm. The spotter pays out rope on the way down and takes it in on the way up, keeping 5 to 10 cm of slack (manual §6 T6).',
      items: [
        manual('t6-ready', '§6 T6', 'Standing still in Velocity for at least 10 s. Spotter ready on the rope and has said “ready”.'),
        { id: 't6-requested', kind: 'log', ref: '§6 T6', text: 'Log: “’n’ requested; waiting for the robot to stand still”.', log: { seen: /'n' requested; waiting for the robot to stand still/ } },
        { id: 't6-entered', kind: 'log', ref: '§6 T6', text: 'Log: “Change state from Velocity to squat” within about 1 s.', log: { seen: /Change state from Velocity to squat/ } },
        { id: 't6-returned', kind: 'log', ref: '§6 T6', text: 'Log: “Change state from squat to Velocity”, by itself after about 9 to 10 s.', log: { seen: /Change state from squat to Velocity/ } },
        {
          id: 't6-step', kind: 'auto', ref: '§6 T6', text: 'First 2 s in squat: legs’ largest command step 3 deg/tick at most.', stop: 'Above 3 deg/tick.',
          refs: { sim: 'Legs 1.5 deg/tick or less.' },
          auto: { type: 'first2s', state: 'squat', parts: ['legs'], measure: 'step', stop: 3 },
        },
        {
          id: 't6-speed', kind: 'auto', ref: '§6 T6', text: 'First 2 s in squat: legs’ fastest joint 2 rad/s at most.', stop: 'Above 2 rad/s.',
          refs: { sim: '0.2 rad/s or less.' },
          auto: { type: 'first2s', state: 'squat', parts: ['legs'], measure: 'speed', stop: 2 },
        },
        {
          id: 't6-lean', kind: 'auto', ref: '§6 T6, §3', text: 'Torso leans forward to about 12 to 13° at most.', stop: 'Leans back, or much more than 13°.',
          refs: { sim: 'Smoothly to about 12 to 13°, never backward.' },
          auto: { type: 'squatLean' },
        },
        manual('t6-back', '§6 T6', 'Torso never leans backward (ROCO reads the size of the lean, not its direction).', { stop: 'Any backward lean.' }),
        {
          id: 't6-knee', kind: 'auto', ref: '§6 T6', text: 'Knee torque peak in the squat: 45 Nm at most.', stop: 'Above 45 Nm.',
          refs: { sim: 'About 33 Nm left, 27 Nm right.' },
          auto: { type: 'segment', state: 'squat', field: 'tauKnee', stop: 45 },
        },
        {
          id: 't6-ankle', kind: 'auto', ref: '§6 T6', text: 'Ankle pitch torque peak in the squat: 15 Nm at most.', stop: 'Above 15 Nm.',
          refs: { sim: 'About 7 to 8 Nm.' },
          auto: { type: 'segment', state: 'squat', field: 'tauAnkP', stop: 15 },
        },
        manual('t6-depth', '§6 T6', 'Knee bend at the bottom about 118°, reached about 4 s after the change into squat.', { stop: 'Much deeper.' }),
        manual('t6-feet', '§6 T6', 'Feet flat throughout.', { stop: 'Heel or toe lifting, sliding.' }),
        manual('t6-rope', '§6 T6', 'Rope never tight during the motion.', { stop: 'Rope pulled tight: the robot was being held up.' }),
        manual('t6-return', '§6 T6', 'Return: first 2 s in Velocity, legs 1.4 deg/tick and 0.2 rad/s at most, no stumble or step after the hand-off.', {
          refs: { sim: 'Legs 1.4 deg/tick or less, 0.2 rad/s or less.' },
          stop: 'A stumble or step.',
        }),
        {
          id: 't6-interval', kind: 'auto', ref: '§3, §6', text: 'Policy step interval 50 ms at most.', stop: 'Above 50 ms.',
          refs: { sim: '20 to 23 ms.', real: 'About 20 ms.' },
          auto: { type: 'policyInterval', stopMs: 50 },
        },
      ],
    },
    {
      id: 'T7',
      title: 'After the first squat',
      where: 'hanging, in Passive',
      intro: 'Continue only if everything matched (manual §6 T7).',
      items: [
        manual('t7-stop', '§6 T7', 'LT+B pressed, spotter has the weight, Ctrl-C in g1_ctrl and then in g1_record.'),
        manual('t7-temps', '§6 T7', 'Motor temperatures checked in the log and by touch: knees, ankles, hips.'),
        manual('t7-inspect', '§6 T7', 'Waist lock and ankle linkages inspected.'),
        manual('t7-report', '§6 T7, §8', 'real_log.py run on the recording (or the CSVs and log sent for analysis) and compared with the references.'),
        {
          id: 't7-gap', kind: 'auto', ref: '§6 T7', text: 'Longest gap between rt/lowstate messages well under 200 ms.',
          stop: 'A gap approaching 200 ms: the lost-state stop could trip by itself. ROCO calls 100 ms “watch” and 150 ms “stop”; the manual gives no number.',
          refs: { real: 'About 20 ms on the wired link.' },
          auto: { type: 'lowstateGap', watchMs: 100, stopMs: 150 },
        },
        {
          id: 't7-legspeed', kind: 'auto', ref: '§6 T7', text: 'Fastest leg joint outside Passive under the 15 rad/s runaway limit.', stop: '15 rad/s or more.',
          refs: { sim: 'Under 3 rad/s outside Passive.' },
          auto: { type: 'legSpeed', stop: 15 },
        },
        manual('t7-logs', '§8', 'Recording CSVs and log.txt saved in one folder for this run, with notes on what was pressed, seen and heard.'),
      ],
    },
    {
      id: 'T8',
      title: 'Repeat squats',
      where: 'feet on the floor, spotter follows with the rope',
      states: ['Velocity', 'squat'],
      intro: 'Run the full sequence again from T0. One squat per run at first, then at most two. About 5 squats a session: each puts about 20 to 22 Nm on the locked waist pitch, which has no published rating (manual §6 T8).',
      items: [
        manual('t8-sequence', '§6 T8', 'Full sequence run again from T0, one squat in this run (at most two once it is routine).'),
        {
          id: 't8-count', kind: 'auto', ref: '§6 T8', text: 'About 5 squats in the session at most.', stop: 'The manual says to limit the session to about 5.',
          note: 'Counts squats in this g1_ctrl run only.',
          auto: { type: 'squatCount', about: 5 },
        },
        manual('t8-rest', '§6 T8', 'No motor reports above 50 °C; if one does, rest the robot.', { stop: 'Above 50 °C: rest. The 65 °C warning and 80 °C stop are last lines of defence.' }),
      ],
    },
    {
      id: 'T9',
      title: 'Rope-free standing or squat',
      where: 'later session only',
      intro: 'Only after several sessions with every squat clean and the T3 behaviour known (manual §6 T9).',
      items: [
        manual('t9-history', '§6 T9', 'Several sessions with every squat clean, and the T3 result known.'),
        manual('t9-rope', '§6 T9', 'Spotter and rope ready at hand, even when detached.'),
      ],
    },
  ],
}

/** Manual §5: the same-day rehearsal in the simulator, with its pass list. */
export const G1_TYPE6_SIM: Procedure = {
  id: 'g1_type6_sim',
  title: 'Simulator rehearsal',
  summary: 'The same-day rehearsal before the robot (manual §5), with its pass list.',
  manual: { file: 'TEST_MANUAL.md', sha256: MANUAL_SHA256 },
  stages: [
    {
      id: 'Steps',
      title: 'Do the hardware sequence in the simulator',
      where: 'unitree_mujoco and g1_ctrl -n lo -c config_hw.yaml',
      intro: 'The robot starts on the band. In the simulator window press 8 (about 6 times) to lower it onto its feet and 9 to release it (manual §5).',
      items: [
        manual('r-start', '§5', 'Terminal 1: unitree_mujoco with sim/g1/scene_type6.xml. Terminal 2: g1_ctrl -n lo -c config_hw.yaml.'),
        manual('r-refuse', '§5', 'Press f, wait 4 s, press v, press n. The squat must be refused while the robot hangs.'),
        manual('r-squat', '§5', 'Lower and release the band, wait 10 s, press n. The squat runs and hands back to Velocity by itself.'),
        manual('r-p', '§5', 'Press p: Passive. The simulated robot falls over; that is expected without a rope.'),
        manual('r-ctrlc', '§5', 'Press Ctrl-C: “Signal 2: Passive (damping) for 1.0 s, then exit”, then “Exit”, and the terminal echoes typing again.'),
      ],
    },
    {
      id: 'Pass',
      title: 'Pass list',
      where: 'from the g1_ctrl log',
      items: [
        {
          id: 'rp-reports-6', kind: 'log', ref: '§5', text: 'The log shows “robot reports 6”.', stop: 'Any other value.', ...LOG_ROBOT_REPORTS,
        },
        {
          id: 'rp-refused', kind: 'log', ref: '§5', text: 'The hanging n prints “request cancelled … need >= 1.5”.',
          refs: { sim: 'Ankle pitch |tau| L 0.2 R 0.2 Nm, need >= 1.5.' },
          log: { seen: /request cancelled/ },
        },
        { id: 'rp-squat-ends', kind: 'log', ref: '§5', text: 'The squat ends with “Change state from squat to Velocity”.', log: { seen: /Change state from squat to Velocity/ } },
        { id: 'rp-p', kind: 'log', ref: '§5', text: '“p” prints “keyboard abort ’p’ -> Passive”.', log: { seen: /keyboard abort 'p' -> Passive/ } },
        {
          id: 'rp-interval', kind: 'auto', ref: '§5, §3', text: 'Every policy timing line shows a step interval well under 50 ms.', stop: 'Above 50 ms.',
          refs: { sim: '20 to 23 ms.' },
          auto: { type: 'policyInterval', stopMs: 50 },
        },
        manual('rp-no-fall', '§5', 'The robot never falls before p.'),
      ],
    },
  ],
}

export const PROCEDURES: Procedure[] = [G1_TYPE6, G1_TYPE6_SIM]
