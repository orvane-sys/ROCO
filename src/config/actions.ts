/**
 * Every command of the palette (Ctrl+K) also has a control on screen. This list says where, in words, for the palette and the Help
 * sheet. The control itself carries `data-action="<id>"`; scripts/check-meta.mjs fails when an id here has no such control in src/,
 * and scripts/check-layout.mjs checks that the ones on a workspace are visible there.
 *
 * `id` is a palette command id, or a family prefix such as `ws` for `ws-run`, `ws-analyze`, `ws-review`.
 */

export type ActionPlace = 'header' | 'run' | 'analyze' | 'review' | 'dock' | 'replay' | 'display' | 'settings' | 'help' | 'alerts-shelved'

export interface ActionInfo {
  id: string
  /** What it does, as the Help sheet lists it. */
  label: string
  /** Where the control is, in words. */
  where: string
  place: ActionPlace
  key?: string
}

export const ACTIONS: ActionInfo[] = [
  { id: 'ws', label: 'Switch workspace', where: 'Header: Run, Analyze, Review tabs', place: 'header', key: '1 2 3' },
  { id: 'alerts', label: 'See the alerts', where: 'Run: Alerts panel', place: 'run' },
  { id: 'ack-all', label: 'Acknowledge all active alerts', where: 'Run: Alerts panel, Acknowledge all', place: 'run', key: 'A' },
  { id: 'unshelve', label: 'Restore shelved warnings', where: 'Run: Alerts panel, Restore all (shown when a warning is shelved)', place: 'alerts-shelved' },
  { id: 'sound', label: 'Alert sound on or off', where: 'Header: Sound, speech and battery; or Display', place: 'header' },
  { id: 'voice', label: 'Spoken alerts on or off', where: 'Header: Sound, speech and battery; or Display', place: 'header' },
  { id: 'joint-filter', label: 'Filter the joint table', where: 'Analyze: box above the joint table', place: 'analyze', key: '/' },
  { id: 'joint', label: 'Choose a joint to plot', where: 'Analyze: click a row of the joint table', place: 'analyze' },
  { id: 'freeze', label: 'Freeze or resume the plots', where: 'Analyze: Freeze button above the plots', place: 'analyze' },
  { id: 'win', label: 'Plot time window', where: 'Analyze: 5 s, 10 s … buttons above the plots', place: 'analyze' },
  { id: 'set', label: 'Plot set', where: 'Analyze: Plot set list above the plots', place: 'analyze' },
  { id: 'mark', label: 'Add a mark to the timeline', where: 'Timeline: Add mark', place: 'dock', key: 'M' },
  { id: 'replay-toggle', label: 'Play or pause a replay', where: 'Replay row: Play or Pause', place: 'replay', key: 'K' },
  { id: 'report', label: 'Session report', where: 'Review: Session report', place: 'review' },
  { id: 'theme', label: 'Theme: dark, light, high contrast', where: 'Display', place: 'display' },
  { id: 'text', label: 'Text size', where: 'Display', place: 'display' },
  { id: '3d', label: '3D view quality, or off', where: 'Display', place: 'display' },
  { id: 'reset-cols', label: 'Reset column widths', where: 'Display: Reset column widths; or double-click a divider', place: 'display' },
  { id: 'display', label: 'Display settings', where: 'Header: Display', place: 'header' },
  { id: 'settings', label: 'Settings: connection, robot model, protocol', where: 'Header: Settings', place: 'header' },
  { id: 'reconnect', label: 'Reconnect to the bridge', where: 'Settings: Reconnect', place: 'settings' },
  { id: 'help', label: 'Help: actions, keys and words', where: 'Header: Help', place: 'header', key: '?' },
  { id: 'tour', label: 'Welcome tour', where: 'Help: Take the tour; or the sample banner', place: 'help' },
]

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]))

/** The entry for a palette command id: an exact match, else its family (`ws-run` → `ws`, `joint-left_knee_joint` → `joint`). */
export function actionFor(commandId: string): ActionInfo | undefined {
  const exact = BY_ID.get(commandId)
  if (exact) return exact
  const dash = commandId.indexOf('-')
  return dash > 0 ? BY_ID.get(commandId.slice(0, dash)) : undefined
}
