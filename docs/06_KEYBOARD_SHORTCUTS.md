# Keyboard shortcuts

Press **`?`** anywhere in the portal for the live cheat-sheet overlay — it
reads from the same table the shortcuts run from, so it's always current.
This page mirrors that table, organized by what you're doing.

All Cmd shortcuts work as Ctrl on non-Mac Chrome. Bare-key shortcuts are
ignored while a text input has focus (press Esc to release a search box
first), so they never hijack typing.

## Transport and playback

| Keys | Action |
|---|---|
| **Space** | Play / pause |
| **Cmd+]** | Next song in setlist |
| **Cmd+[** | Previous song in setlist |
| **Cmd+→** | Nudge playhead +5 s |
| **Cmd+←** | Nudge playhead −5 s |
| **Cmd+J** | Jump to next section |
| **Cmd+Shift+J** | Jump to previous section |
| **Cmd+.** | Toggle drum machine (persists per song) |
| **Cmd+T** | Tap tempo (4+ taps to set BPM) |

## Mixer

| Keys | Action |
|---|---|
| **Cmd+1** … **Cmd+6** | Mute Vocals / Drums / Bass / Guitar / Piano / Other |
| **Cmd+Shift+1** … **Cmd+Shift+6** | Solo the corresponding stem |
| **V D B G P O** *(bare keys)* | Toggle the matching stem solo |

## Sections

| Keys | Action |
|---|---|
| **1** … **9** *(bare keys)* | Drop a section divider at the playhead (1=Intro, 2=Verse, 3=Chorus, 4=Bridge, 5=Solo, 6=Pre, 7=Outro, 8=Break, 9=Tag) |

## Setlist and song state

| Keys | Action |
|---|---|
| **+** *(bare key)* | Add the current song to the active setlist |
| **−** *(bare key)* | Remove the current song from the active setlist |
| **Cmd+Shift+F** | Toggle the favorite ★ on the current song |

## Navigation and view

| Keys | Action |
|---|---|
| **Cmd+S** | Focus the search bar |
| **/** | Quick-search (vim-style) — same as Cmd+S |
| **Cmd+G** | Focus the gig picker |
| **Cmd+L** | Focus the YouTube URL box (ingest) |
| **Cmd+Shift+U** | Toggle Performer ↔ Librarian view |
| **Cmd+Shift+/** | Toggle the lyrics overlay |
| **?** | Show the shortcut cheat sheet |

## Utility

| Keys | Action |
|---|---|
| **Cmd+Shift+P** | Flash cache (gig-prep precache) |
| **Cmd+Shift+;** | Take a debug snapshot |
| **Cmd+Shift+R** | Restart the server (with confirmation) |

## Meta combos

These chain several actions with timed spacing — built for Keyboard Maestro
automation and the regression scripts, but usable by hand.

| Keys | What it runs |
|---|---|
| **Cmd+Shift+M** | META: mute every stem in sequence (1 s spacing) |
| **Cmd+Shift+N** | META: next song + auto-play (1 s) |
| **Cmd+Shift+D** | META: toggle drum machine + play (1 s) |
| **Cmd+Shift+B** | META: bounce through 4 songs (3 s each) — setlist auto-advance stress test |
| **Cmd+Shift+A** | META: A/B test — drum machine on, 2 s, back to stems |

## Keyboard Maestro

KM can bind any of these directly as Type-a-Keystroke actions, or trigger
the in-portal meta combos with a single hot key. When choosing new
bindings, avoid Chrome-reserved combos (Cmd+T, Cmd+W, Cmd+R, Cmd+L, Cmd+F,
Cmd+S, Cmd+Q without Shift); Cmd+Shift variants are safe. New shortcuts are
added to the `SHORTCUTS` array in `bt-construction-kit/public/app.js` — the
`?` overlay regenerates from the same array automatically.
