import { CircleHelp, Keyboard } from 'lucide-react'
import { Dialog } from './Dialog'
import { G1_CTRL_ABORT, G1_CTRL_KEYS } from '../utils/monitorFormat'
import { ACTIONS } from '../config/actions'

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['W', '↑'], action: 'Walk forward' },
  { keys: ['S', '↓'], action: 'Walk backward' },
  { keys: ['A'], action: 'Strafe left' },
  { keys: ['D'], action: 'Strafe right' },
  { keys: ['Q', '←'], action: 'Turn left' },
  { keys: ['E', '→'], action: 'Turn right' },
  { keys: ['Space'], action: 'Emergency stop (latches; click the button to reset)' },
  { keys: ['?'], action: 'Show this help' },
]

/** Plain meanings for the names the plots, tables and alerts use. */
const GLOSSARY: [string, string][] = [
  ['Angle (q)', 'Joint angle as measured, in degrees on the page (radians in the data).'],
  ['Target (q_cmd)', 'The angle the controller (g1_ctrl) is aiming for. It is shown only while the joint is held (stiffness above zero).'],
  ['Speed (dq)', 'Joint speed, in rad/s.'],
  ['Torque (τ, tau_est)', 'Torque the motor reports, in Nm.'],
  ['PD demand', 'Torque the controller asks for: stiffness × angle error + damping × speed error + feed-forward. It can exceed what the motor can give.'],
  ['peak between frames', 'The largest PD demand among the ~1000 samples a second between two page updates, so a short spike still shows.'],
  ['rt/lowstate', 'The robot’s state message (angles, speeds, torques, IMU), about 500 to 1000 a second.'],
  ['rt/lowcmd', 'The commands g1_ctrl sends to the motors.'],
  ['Passive, FixStand, Velocity', 'Controller states: motors damped; standing on a fixed pose; the walking policy (standing still with no command).'],
  ['first-out', 'The first alert of a burst. Later ones are often a result of it.'],
  ['Left and right', 'Overlays the same joint on the other side of the body, in the second plot colour.'],
]

const kbd = 'min-w-8 text-center px-2 py-1 rounded-md bg-raised border border-line-bold font-mono text-xs text-ink'

function KeyRow({ action, keys }: { action: string; keys: string[] }) {
  return (
    <li className="flex items-center justify-between gap-4">
      <span className="text-ink">{action}</span>
      <span className="flex gap-1 shrink-0">
        {keys.map((k) => (
          <kbd key={k} className={kbd}>
            {k}
          </kbd>
        ))}
      </span>
    </li>
  )
}

/** monitor: a read-only bridge session, where the only keys that matter are g1_ctrl's own. */
export function ShortcutHelp({ onClose, monitor = false, onTour }: { onClose: () => void; monitor?: boolean; onTour?: () => void }) {
  if (monitor) {
    return (
      <Dialog
        title="Help"
        icon={<CircleHelp className="w-5 h-5 text-accent" aria-hidden="true" />}
        onClose={onClose}
      >
        <p className="mb-3 text-sm text-ink-soft">
          ROCO only watches the robot. Everything below is also in the command palette (Ctrl+K).
        </p>
        {onTour && (
          <button
            type="button"
            data-action="tour"
            onClick={onTour}
            className="mb-4 px-3 min-h-9 rounded-lg bg-accent-solid hover:bg-accent-solid/85 text-on-accent font-semibold text-sm"
          >
            Take the tour
          </button>
        )}

        <h3 className="mb-2 text-sm font-semibold text-ink">What you can do, and where</h3>
        <table className="w-full text-sm">
          <caption className="sr-only">Every action of the page, where its control is, and its key</caption>
          <thead className="text-xs text-ink-muted text-left">
            <tr>
              <th scope="col" className="font-medium pb-1 pr-2">Action</th>
              <th scope="col" className="font-medium pb-1 pr-2">Where</th>
              <th scope="col" className="font-medium pb-1">Key</th>
            </tr>
          </thead>
          <tbody>
            {ACTIONS.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <th scope="row" className="font-normal text-left text-ink py-1 pr-2">{a.label}</th>
                <td className="text-ink-soft py-1 pr-2">{a.where}</td>
                <td className="py-1 whitespace-nowrap">
                  {a.key?.split(' ').map((k) => (
                    <kbd key={k} className={kbd + ' mr-1'}>
                      {k}
                    </kbd>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">g1_ctrl keys</h3>
        <p className="mb-2 text-sm text-ink-soft">
          To change what the robot does, type these in g1_ctrl's own terminal, or use the Unitree remote.
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {G1_CTRL_KEYS.map((k) => (
            <KeyRow
              key={k.to}
              action={`${k.from} → ${k.to}${k.note ? ` (${k.note})` : ''}`}
              keys={k.remote ? [k.key, k.remote] : [k.key]}
            />
          ))}
          <KeyRow action="Abort to Passive, from any state" keys={[G1_CTRL_ABORT.key, G1_CTRL_ABORT.remote]} />
        </ul>
        <p className="mt-3 text-xs text-ink-muted">{G1_CTRL_ABORT.text}</p>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Keys on this page</h3>
        <ul className="flex flex-col gap-2 text-sm">
          <KeyRow action="Run, Analyze or Review workspace" keys={['1', '2', '3']} />
          <KeyRow action="Command palette: workspaces, joints, settings" keys={['Ctrl', 'K']} />
          <KeyRow action="Filter the joint table" keys={['/']} />
          <KeyRow action="Acknowledge all active alerts" keys={['A']} />
          <KeyRow action="Add a mark to the timeline, with an optional note" keys={['M']} />
          <KeyRow action="Move the cursor on the timeline or a plot (focus it first); Shift moves ten times as far" keys={['←', '→']} />
          <KeyRow action="On the timeline: jump the recording, or freeze the plots, at the cursor" keys={['Enter']} />
          <KeyRow action="Play or pause a replay" keys={['K']} />
          <KeyRow action="Resize columns (focus a divider first)" keys={['←', '→']} />
          <KeyRow action="Show this help" keys={['?']} />
        </ul>

        <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Words on this page</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          {GLOSSARY.map(([term, meaning]) => (
            <div key={term} className="contents">
              <dt className="font-mono text-xs text-accent-ink pt-0.5">{term}</dt>
              <dd className="text-ink-soft">{meaning}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    )
  }
  return (
    <Dialog
      title="Keyboard & gamepad controls"
      icon={<Keyboard className="w-5 h-5 text-accent" aria-hidden="true" />}
      onClose={onClose}
    >
      <ul className="flex flex-col gap-2 text-sm">
        {SHORTCUTS.map(({ keys, action }) => (
          <KeyRow key={action} action={action} keys={keys} />
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-muted">
        Gamepad: left stick moves and strafes, right stick turns, B or Start latches the emergency stop. Keyboard
        driving is paused while this dialog or the settings dialog is open; Space still stops the robot.
      </p>
    </Dialog>
  )
}
