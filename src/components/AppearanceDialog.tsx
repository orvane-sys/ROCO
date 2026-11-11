import { SunMoon } from 'lucide-react'
import { Dialog } from './Dialog'
import { playTestTone, prepareAudio, soundSupported, speak, speechSupported, useAudioRunning } from '../services/alertCues'
import {
  SCENE3D_PREFS,
  TEXT_SCALES,
  THEME_PREFS,
  setScene3d,
  setSound,
  setSpeech,
  setTextScale,
  setTheme,
  useUiPrefs,
  type Theme,
  type TextScale,
} from '../services/uiPrefs'

const THEME_NAME: Record<Theme, string> = { dark: 'Dark', light: 'Light', contrast: 'High contrast' }
const SCALE_NAME: Record<TextScale, string> = { 100: 'Standard', 115: 'Large', 130: 'Larger' }

const choice =
  'flex items-start gap-3 min-h-11 rounded-lg border border-line-strong bg-sunken/60 px-3 py-2 cursor-pointer ' +
  'hover:border-line-hot has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus'

/** Theme and text size. Both apply at once and are remembered in this browser only. */
/** onResetColumns: put the column widths of this workspace back to the default (also a double-click on a divider). */
export function AppearanceDialog({ onClose, onResetColumns }: { onClose: () => void; onResetColumns?: () => void }) {
  const ui = useUiPrefs()
  const audioRunning = useAudioRunning()
  const canSound = soundSupported()
  const canSpeak = speechSupported()
  return (
    <Dialog
      title="Display settings"
      icon={<SunMoon className="w-5 h-5 text-accent" aria-hidden="true" />}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <fieldset data-action="theme" className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink mb-1">Theme</legend>
          {THEME_PREFS.map((t) => (
            <label key={t.value} className={choice}>
              <input
                type="radio"
                name="roco-theme"
                value={t.value}
                checked={ui.theme === t.value}
                onChange={() => setTheme(t.value)}
                className="mt-1 accent-accent"
              />
              <span className="flex flex-col">
                <span className="text-sm text-ink">{t.label}</span>
                <span className="text-xs text-ink-muted">
                  {t.hint}
                  {t.value === 'auto' && ui.theme === 'auto' ? `. Now: ${THEME_NAME[ui.resolvedTheme]}.` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset data-action="text" className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink mb-1">Text size</legend>
          <div className="grid grid-cols-3 gap-2">
            {TEXT_SCALES.map((s) => (
              <label key={s} className={choice + ' items-center justify-center'}>
                <input
                  type="radio"
                  name="roco-text-scale"
                  value={s}
                  checked={ui.textScale === s}
                  onChange={() => setTextScale(s)}
                  className="accent-accent"
                />
                <span className="text-sm text-ink">
                  {SCALE_NAME[s]}
                  <span className="block text-xs text-ink-muted">{s}%</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-ink-muted">
            Scales the text, controls and plots together. The browser's own zoom (Ctrl +) works as well, up to 200%.
          </p>
        </fieldset>

        <fieldset data-action="3d" className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink mb-1">3D view</legend>
          {SCENE3D_PREFS.map((q) => (
            <label key={q.value} className={choice}>
              <input
                type="radio"
                name="roco-scene3d"
                value={q.value}
                checked={ui.scene3d === q.value}
                onChange={() => setScene3d(q.value)}
                className="mt-1 accent-accent"
              />
              <span className="flex flex-col">
                <span className="text-sm text-ink">{q.label}</span>
                <span className="text-xs text-ink-muted">{q.hint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-muted">
            TEST_MANUAL section 4 asks to close heavy programs, since the policy runs on this PC. The cost of the 3D view is shown under
            Analyze, in Link and body.
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink mb-1">Alert cues for eyes-off use</legend>
          <label className={choice}>
            <input
              type="checkbox"
              checked={ui.sound}
              disabled={!canSound}
              onChange={(e) => {
                setSound(e.target.checked)
                // the click is the gesture the browser needs before it allows sound
                if (e.target.checked) void prepareAudio().then((ok) => ok && playTestTone())
              }}
              className="mt-1 accent-accent"
            />
            <span className="flex flex-col">
              <span className="text-sm text-ink">Tone for a new critical alert</span>
              <span className="text-xs text-ink-muted">
                {canSound
                  ? ui.sound && !audioRunning
                    ? 'On, but the browser is waiting for a click or key press on the page before it allows sound.'
                    : 'Three short pulses. Off by default. The status bar shows whether it is on.'
                  : 'This browser cannot play sound.'}
              </span>
            </span>
          </label>
          <label className={choice}>
            <input
              type="checkbox"
              checked={ui.speech}
              disabled={!canSpeak}
              onChange={(e) => {
                setSpeech(e.target.checked)
                if (e.target.checked) speak('Spoken alerts on')
              }}
              className="mt-1 accent-accent"
            />
            <span className="flex flex-col">
              <span className="text-sm text-ink">Speak state changes and new critical alerts</span>
              <span className="text-xs text-ink-muted">
                {canSpeak ? "Uses the browser's own voice, so nothing is fetched. Off by default." : 'This browser has no speech.'}
              </span>
            </span>
          </label>
          <p className="text-xs text-ink-muted">
            Screen readers hear a new critical alert through a separate live region whatever these are set to, at most once every few seconds.
          </p>
        </fieldset>

        {onResetColumns && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-ink">Layout</h3>
            <button
              type="button"
              data-action="reset-cols"
              onClick={onResetColumns}
              className="self-start px-3 min-h-9 rounded-lg border border-line-bold text-sm text-ink hover:bg-raised"
            >
              Reset column widths
            </button>
            <p className="text-xs text-ink-muted">Puts the columns of this workspace back to their first widths. A double-click on a divider does the same.</p>
          </div>
        )}

        <p className="text-xs text-ink-muted">Saved in this browser only. Nothing is sent to the bridge or the robot.</p>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2.5 rounded-lg bg-accent-solid hover:bg-accent-solid/85 text-on-accent font-bold text-sm transition-colors"
        >
          Done
        </button>
      </div>
    </Dialog>
  )
}
