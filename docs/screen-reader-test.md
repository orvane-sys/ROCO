# Screen-reader test (about 30 minutes)

`npm run check:a11y` tests what a program can test: axe-core, reflow, and that every keyboard stop has a name, a focus mark and is not
covered. It cannot tell whether the page makes sense when spoken. This script is for that. Run it once before a release and write down
what the reader said where this page says **Expect**.

**Set-up.** Ubuntu with Orca (`Super+Alt+S` starts and stops it) and Firefox. Open the hosted demo, or `npm run build && npm run preview`
and add `?demo=1`. Close the tour with its Skip button first. Use the keyboard only; do not touch the mouse.

Orca keys used below: `Insert+Space` opens Orca's settings, `Insert+F` says the font and the colour under the cursor, and
the arrow keys read line by line in browse mode. Press `Insert+Z` to switch Orca's layered mode off if a key does nothing.

## 1. The page announces itself
1. Load the page. **Expect:** the tab title, then, reading from the top, the banner with the ROCO heading and,
   after the toolbar, "Sample recording · Unitree G1 squat test · recorded … · not a live robot".
2. Press `H` to walk the headings. **Expect:** one level-1 heading, then the names of the cards (Alerts, Abort checks, g1_ctrl state,
   Guided checks, Session timeline …). Nothing is called "heading" with no text.
3. Press `D` to walk the landmarks. **Expect:** header (banner), "Workspaces and settings" navigation, the main area, and the columns
   named "alerts column", "3D view column", "state and keys column".

## 2. Workspaces
1. `Tab` to the tab list. **Expect:** "Workspace, tab, Run, selected, 1 of 3".
2. `Right arrow` twice, then `Home`. **Expect:** Analyze, then Review, then Run, each read with "tab" and its position, and the panel
   changes with the tab.
3. Leave and come back to Analyze for the first time. **Expect:** the note "Plots and the full joint table …" is read before the
   panel, and its button is "Dismiss the note about Analyze". After you press it, focus is on the workspace, not lost at the top.

## 3. The status line
1. `Tab` back to the header. **Expect:** the state chip reads "g1_ctrl state Velocity", then the abort chip reads
   "No abort condition seen" or the full alert text (never "No abort …" cut off).
2. Let the demo play until it raises its limit alerts (watch the Alerts card, or use the Review tab's per-state table to find the time) and leave the page alone. **Expect:** one interruption, spoken immediately, "Critical alert:
   …" with what to do. If several come together **Expect:** "N new critical messages. First: …", once, not N times.
3. The state changes (Velocity to squat). **Expect:** a polite "g1_ctrl state: squat", not more than one every 1.5 seconds.

## 4. Alerts and the timeline
1. In the Alerts card, `Tab` to a row. **Expect:** level in words (Critical or Warning), what it is, the joint and the value. The colour
   is never the only thing said.
2. `Tab` to the timeline canvas ("Session timeline"). Press the arrow keys. **Expect:** each press says the time and what is there
   ("Velocity", "squat", "Critical: …"), and `Enter` jumps the recording to that time.
3. Press `Table view`. **Expect:** a table with a caption and a header row; each row is a time and a sentence.

## 5. Replay controls
1. `Tab` to the Replay region. **Expect:** "Play" or "Pause", then "Speed, combo box", then the position "12.3 s / 60.0 s", then
   "Seek, slider" with its value as time ("12 seconds of 60").
2. Press `Right arrow` on the slider and release. **Expect:** the position moves once on release, not on every key repeat, and the
   state word (Paused, Playing at 1×, Seeking…) is read when it changes.

## 6. On a phone-width window (resize Firefox to about 360 px)
1. **Expect:** a "Tone, voice and battery" button with the battery level in its name. `Enter` opens it: Tone, Voice and the battery,
   each read. `Escape` closes it and focus returns to the button.

## What to write down
For each step: what Orca said, and anything missing, doubled, or confusing ("black diamond", unlabeled button, a heading with no
text, focus jumping to the top). Send the list as a GitHub issue using the bug template, and say in it that it is a screen-reader pass.
