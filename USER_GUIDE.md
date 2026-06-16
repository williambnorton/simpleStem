# simpleStem — user guide

This guide is for bandmates using the simpleStem portal to rehearse and play
live. You don't need to know how the audio gets prepared; you just need to
know how to drive the portal once a song is in it.

If you're a developer, [ARCHITECTURE.md](ARCHITECTURE.md) is the document for
you instead.

---

## What this is

A web page (we call it "the portal") that runs on the band's MacBook. It
shows every song the band has ever asked for, lets you play each one with
the original mix or as 6 separated stems (vocals · drums · bass · guitar
· piano · other), and lets you group songs into setlists tied to real
gigs.

You can drive it from a touch screen, a phone, or a regular keyboard —
the controls are sized for the stage.

---

## Getting started

Open `http://localhost:3000` on the MacBook running the portal. You'll
see three regions:

```
┌───────────────────┬──────────────────────────────────────────┐
│  Gig sidebar      │   Player + Stem Mixer (top)              │
│  - active gig     │   Library table (bottom)                 │
│  - setlists       │                                          │
│  - songs in order │   [tabs] Library · Loop Library          │
└───────────────────┴──────────────────────────────────────────┘
```

The sidebar drives WHAT to play (gig → setlist → song); the player area
drives HOW it sounds.

---

## Adding a song from YouTube

Type or paste a YouTube link into the **"Paste YouTube URL + Enter"** box
in the library header and hit Enter. The song goes into a queue; the next
10–25 minutes the laptop downloads it, analyzes BPM + key, and separates
the audio into 6 stems. While that happens you can keep using everything
else.

You can paste:

- A single video — `https://www.youtube.com/watch?v=...`
- A playlist — every video becomes its own song, automatically grouped
  into a setlist with the playlist's name.
- A chaptered "full album" video — each chapter becomes its own song.

When the song is ready it appears in the library with a green STEMS chip
and a duration. The queue counter in the toolbar tells you how many songs
are still cooking behind it.

---

## The library row

Each row is one song. Reading left to right:

| Column | What's in it |
|---|---|
| **SET** | Checkbox — adds the song to the active setlist's batch queue |
| **★ / Title** | Yellow star toggles Favorites; clicking the row loads the song |
| **Artist** | |
| **Dur** | mm:ss — total song length |
| **Tempo** | BPM (and original BPM if it differs after pitch-shift) |
| **Key** | Musical key |
| **Singer** | Pulldown: Bill / Matt / Dan / JD / All / — |
| **Action** | `⋯` — per-song menu (metadata, refetch, options) |

Click anywhere on the row to load the song with stems. The little play
icon next to the title starts it immediately. The star icon next to the
title (and on every other surface showing this song) marks it a Favorite.

---

## Picking a gig

The picker at the top of the sidebar lists every real gig (Joyce,
Sunday_Practice, May Day 26, …) plus several synthetic gigs that the
portal builds on the fly:

| Gig | What it contains |
|---|---|
| ▶ **YouTube Sync** | Every setlist that came from a YouTube playlist |
| ✎ **Manual Setlists** | Every setlist you saved by hand in the planner |
| ⟲ **Recents** | The last 50 songs you loaded |
| ★ **Favorites** | Every song with the star turned on |
| 🎤 **Bill Songs** | Every song where Singer = Bill (and Matt / Dan / JD) |
| 🎙 **RoundRobin** | Every singer-tagged song, alternating Bill → Matt → Dan → JD |

The four singer gigs + RoundRobin are great when a member is going to
sit a set out — pick the RoundRobin gig and the next song never lands
on the missing singer. Set who sings each song with the **Singer**
column dropdown in the library row, or let the Mitchell Park Band
sheet drive it automatically.

---

## Building a setlist

Two ways:

1. **Batch-add from the library.** Check the SET box on every song you
   want, then click the green + on any ghost row that appears in the
   sidebar. All checked songs land in the setlist in one shot.
2. **Drag and drop.** Drag a song row between setlists inside the same
   gig.

To save a brand-new setlist that's not part of any real gig, type a
title in the "+ New Manual Setlist" entry — it'll appear under the
Manual Setlists synthetic gig and survive restarts.

---

## Playing a song

The player lives above the library and gives you:

- Big ★ next to the title (Favorite toggle)
- **▶ / ‖** play / pause
- **■** stop
- **⏭** next song in the active setlist
- **⟲** plain looping toggle
- **Speed** — slow it down 0.5×–1.5× for practice (pitch follows speed)

Below those, the **LOOPER** button + **Pitch Fix** panel:

- **LOOPER** — loops the SECTION the playhead is currently in (sections
  are the colored boundaries on the timeline; place them with the
  number keys 1–9 during playback, drag the orange divider to move
  one). The big LOOPER button shows the section name and time range
  while engaged.
- **Click track** (alarm-clock icon) — plays a four-on-the-floor click
  at the song BPM during the current section.
- **Count-in 4** (hash icon) — plays four beats of clicks BEFORE the
  section starts.
- **Pitch Fix** — two knobs:
  - **CENT** — fine tune ±50 cents in 1-cent steps.
  - **SEMI** — half-steps in 0.5 increments, capped at ±3. The marked
    stops are −3, −2½, −2, −1½, −1, −½, 0, +½, +1, +1½, +2, +2½, +3.
    Drag, scroll, use −/+, or arrow keys. The numbered stops around
    the dial show where you'll land.
  - **RESET** zeroes both. (Pitch resets at song change too.)

---

## The Stem Mixer

One strip per instrument: Vocals · Drums · Bass · Guitar · Piano · Other.

For each strip:

- **Fader** — volume.
- **M** — mute the channel.
- **S** — solo the channel (everything else mutes).
- **+5 / +10** — boost the strip by +5 dB or +10 dB. They're latching
  3-state buttons: click +5 to engage, click again to disengage. +5 and
  +10 are mutually exclusive on the same strip. Boost rides on top of
  the fader; it does NOT change the fader position or any recorded
  automation.
- **Routing buttons** (V/O/L/R/G/B/P/D + numbered) — send this stem to
  one or more XR18 output channels. The "home" channel for each stem
  (V for vocals, D for drums, etc.) is highlighted by default. Click
  numbers (3–10, 17–18) to add extra outputs.

When no XR18 is connected the strips still light up — the audio just
goes to the laptop's built-in output.

---

## Sections + the section toolbar

While a song plays, press number keys 1–9 to drop a section divider
at the playhead. The section gets a color (1=red, 2=orange, …) and a
short label like "intro" or "chorus". Drag a divider with the mouse
to move it; if the LOOPER is engaged it follows automatically.

The section editor below the timeline lets you:

- Click a divider to rename / recolor it.
- Hover and hit Delete/Backspace to remove a divider — the previous
  section absorbs the gap.
- Toggle a section's **Click 4 beats in** flag so the click-track + 4
  pre-roll fire automatically when you start playback at the top of
  that section.

Section boundaries snap to a detected onset within ±2 seconds; the
faint grey ticks on the timeline show where the auto-detector thought
sections start.

---

## MIDI automation

A song can carry a small timeline of events that fire as the playhead
moves through it — typically Helix patch changes, XR18 fader rides,
or Logic Pro automation. The lane just below the visualizer is the
editor. M / V / D / B / G / P / O / F block-letter markers represent
the different event types; drag to move, click to edit, Delete to
remove.

For now events fire as one-shots (no continuous ramps); set up the
ramp targets on the receiving gear if you need a fade.

---

## Library Analytics (sidebar)

Bottom of the sidebar:

- **Songs by Tempo** — how many slow / medium / fast songs you've got.
- **Songs by Key** — count per key, sorted by count (read-only — use
  the Key dropdown to filter).
- **Songs by Singer** — Bill / Matt / Dan / JD / All / (unassigned).

These are derived from `metadata.json`; the Singer counts reflect the
in-row dropdown + the Mitchell Park Band sheet sync.

---

## Common workflows

### Practicing a song at home

1. Find the song. Click the title to load it.
2. In the Stem Mixer, solo or mute the parts to focus on. Boost a
   quiet stem with +5 or +10 dB if you need to hear it without
   touching the fader curve.
3. Drop **Speed** to 0.75× or 0.80× to learn fast passages.
4. Place section markers, then engage **LOOPER** to repeat the tricky
   section.

### Preparing for a gig

1. Build the setlist in the gig sidebar (drag from library, batch-
   add via checkboxes, or pull singer pseudo-gigs together).
2. Star the setlist's songs as Favorites so they're easy to relocate.
3. Click each row a day in advance so the audio caches locally.
4. The night of the gig, flip **Gig Mode** on to hide anything that
   isn't cached and could spin on cell-tether bandwidth.

### Sitting a singer out for a set

1. Open the **🎙 RoundRobin** pseudo-gig.
2. Confirm the missing singer's name in the Library Analytics → Songs
   by Singer is reasonable; tag mis-assigned songs by changing the
   row's Singer dropdown.
3. Skip the missing singer's slots in the RoundRobin's sequence (or
   manually drop those songs from your real gig's setlist).

### Adding a song you just heard at a venue

1. Paste the YouTube URL in the library header and hit Enter.
2. Walk away for 10–25 minutes (it's CPU-bound).
3. When the green STEMS chip shows up, set the Singer column to
   whoever in the band is going to sing it.

---

## Troubleshooting

**The song I added doesn't show up.**
Check the queue chip in the toolbar. If it says "N awaiting render",
your song is in line. If it's idle and the song still isn't there,
the download may have failed silently — try pasting the URL again.

**Audio is slow to start, then stutters.**
First play of an uncached song streams from Drive while the cache
warms in the background. Subsequent plays are instant. Flip Gig Mode
on for shows to hide anything that hasn't been pre-cached.

**LOOPER engages but the level jumps.**
Should be fixed — boost (+5/+10) is independent of LOOPER. If you
still hear a jump, check that the boost on the strip you're listening
to isn't latched.

**Sections aren't where I want them.**
Drop them with number keys 1–9 while playing; drag the orange divider
afterward to nudge. Delete a divider by hovering it and pressing
Delete/Backspace.

**The Singer dropdown change disappeared after a day.**
The band's Google Sheet ("New Mitchell Park Song List") is the
authoritative source. The portal pulls it daily, which can overwrite
an in-portal edit. Update the sheet for permanent changes; use the
in-row dropdown for one-off triage.

**Pitch Fix only goes to ±3 half-steps.**
By design — the band's vocal comfort range rarely needs more, and
capping it keeps the dial precise. Anything bigger should be a
re-render rather than a real-time shift.

**The Re-stem in Logic button** (under each song's `⋯` options menu)
is for advanced use only; ignore it unless you've been shown how to
set it up.

---

## More

- For the band's developer / forker — [ARCHITECTURE.md](ARCHITECTURE.md).
- For Claude-the-coding-agent — [CLAUDE.md](CLAUDE.md).
- The full project repo — [github.com/williambnorton/simpleStem](https://github.com/williambnorton/simpleStem).
