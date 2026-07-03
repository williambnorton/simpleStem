# simpleStem keyboard shortcuts

Press **`?`** anywhere in the portal to see the live, in-app cheat sheet.

All shortcuts use **Cmd** (Mac) which Keyboard Maestro can bind directly.
On Windows / Linux Chrome maps Cmd → Ctrl automatically, so the same keys
work there too.

## Bare-key shortcuts (no modifier)

These work everywhere except when a text input has focus.

| Key | Action |
|---|---|
| **Space** | Play / pause transport |
| **+** | Add the currently-loaded song to the active setlist |
| **−** | Remove the currently-loaded song from the active setlist |
| **/** | Quick-search (vim-style) — focuses the song search bar |
| **?** | Open / close the shortcut cheat-sheet overlay |
| `V D B G P O` | Toggle the V/D/B/G/P/O stem solo (existing behavior) |
| `1` … `9` | Drop a section divider at the current playhead (existing) |

Bare-key shortcuts are silently ignored when a text input has focus, so
they never hijack what you're typing. Press `Esc` first if a search bar
swallowed your `+`.

## Focus & navigation

| Shortcut | Action |
|---|---|
| **Cmd+S** | Focus search bar — start typing immediately |
| **Cmd+G** | Focus gig picker — ↑↓ to select, then Tab into setlist |
| **Cmd+L** | Focus YouTube-URL ingest input |
| **Cmd+Shift+U** | Toggle Performer ↔ Librarian view |
| **Cmd+]** | Next song in setlist |
| **Cmd+[** | Previous song in setlist |
| **Cmd+→** | Nudge playhead +5 seconds |
| **Cmd+←** | Nudge playhead −5 seconds |
| **Cmd+J** | Jump to next section |
| **Cmd+Shift+J** | Jump to previous section |

## Mixer

| Shortcut | Action |
|---|---|
| **Cmd+1** | Mute Vocals |
| **Cmd+2** | Mute Drums |
| **Cmd+3** | Mute Bass |
| **Cmd+4** | Mute Guitar |
| **Cmd+5** | Mute Piano |
| **Cmd+6** | Mute Other |
| **Cmd+Shift+1..6** | Solo the corresponding stem (V/D/B/G/P/O) |

## Setlist / song state

| Shortcut | Action |
|---|---|
| **+** *(bare key)* | Add currently-loaded song to active setlist — was Cmd+Shift+= but that collided with Chrome zoom-in |
| **−** *(bare key)* | Remove currently-loaded song from active setlist |
| **Cmd+Shift+F** | Toggle the favorite ★ on the current song |
| **Cmd+.** | Toggle the drum machine for the current song (also persists `drum_machine_default` in metadata) |

## Utility

| Shortcut | Action |
|---|---|
| **Cmd+T** | Tap tempo — press 4 or more times in rhythm; the avg BPM is applied to the drum machine if engaged |
| **Cmd+Shift+P** | Flash cache (pre-warm `~/.bt-cache` from `STEMS/`, `DRUM_MACHINE/`, `CUSTOM_LOOPS/`) |
| **Cmd+Shift+;** | Take a debug snapshot (writes a manifest to `~/.simpleStem-catalog/snapshots/`) |
| **Cmd+Shift+/** | Toggle the lyrics overlay |
| **Cmd+Shift+R** | Restart server (with confirm) |

## Meta combos — chain shortcuts with timed spacing

These run several shortcuts as one macro, scheduled by setTimeout from the
moment of the keypress. Useful for Keyboard Maestro automation and for
the offline regression test scripts.

| Shortcut | What it runs |
|---|---|
| **Cmd+Shift+M** | Mute every stem in sequence — `Vocals → Drums → Bass → Guitar → Piano → Other` 800 ms apart. Total ~4 s. |
| **Cmd+Shift+N** | Next song + auto-play — `Cmd+]` then 1 s pause then `Space`. Lets KM advance through a setlist without watching the screen. |
| **Cmd+Shift+D** | Drum + play — toggle drum machine, 1 s pause, then `Space`. |
| **Cmd+Shift+B** | Bounce through 4 songs — play, 3 s pause, next, 3 s pause, next, 3 s pause, next. Stress-test for setlist auto-advance. |
| **Cmd+Shift+A** | A/B test the drum vs the stems — toggle drum on, 2 s pause, toggle drum off. Useful for ear comparison. |

Authoring more meta combos: edit `setupGlobalKeyboardShortcuts()` in
`bt-construction-kit/public/app.js` and add an entry to the `SHORTCUTS`
array. The `runMeta([[delayMs, fn], …])` helper schedules each step.

## How Keyboard Maestro picks these up

KM lets you bind any Cmd / Cmd-Shift combo as a hot-key trigger.
Example macro for "advance through the 5-song dress rehearsal":

```
1. Trigger: hot-key  ⌘⇧B  (or your choice)
2. Action:  Type a Keystroke  →  Space        (start playing)
3. Action:  Pause              5  seconds
4. Action:  Type a Keystroke  →  ⌘]
5. Action:  Pause              5  seconds
6. Action:  Type a Keystroke  →  ⌘]
...
```

If you'd rather not duplicate the logic in KM, just bind `⌘⇧B` to fire
the in-portal meta combo, which is already set up to do this with 3 s
spacing.

## Suggesting new shortcuts

When you tell Claude you want a new shortcut:

1. Pick a Cmd-based binding that doesn't collide with Chrome (Cmd+T,
   Cmd+W, Cmd+R, Cmd+L, Cmd+F, Cmd+S, Cmd+Q are all browser-reserved
   without `Shift`; Cmd-Shift variants are safe).
2. Describe what the shortcut should do in one sentence.
3. Claude adds it to the `SHORTCUTS` array and the cheat-sheet
   regenerates automatically — no separate doc update needed (the
   overlay reads from the same array).
