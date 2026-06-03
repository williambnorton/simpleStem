# simpleStem — user guide

This guide is for bandmates using the simpleStem portal to rehearse and play
live. You don't need to know how the audio gets prepared; you just need to
know how to drive the portal once a song is in it.

If you're a developer, [ARCHITECTURE.md](ARCHITECTURE.md) is the document for
you instead.

---

## What this is

A web page (we call it "the portal") that runs on the band's MacBook. It
shows every song the band has ever asked for, along with versions you can
play instantly:

- **Full mix** — the original, untouched, for reference listening.
- **Minus mixes** — the original with some instruments stripped out, so the
  player whose part is missing can sing or play along live.
  - `-V` — minus vocals (sing over the band)
  - `-V-G` — minus vocals and guitar (guitar player practice)
  - `-V-G-B` — minus vocals, guitar, and bass (rhythm-section practice)
  - `DO` — drums only (a click track for the drummer)
- **Stems** — every instrument as its own track, with faders. Lets you
  rebalance the band live: turn the vocal down, pull the guitar up, mute
  drums, whatever.

You can chain songs into a **setlist** with start times and play them through
in order for a gig.

---

## Getting started

Open `http://localhost:3000` on whichever Mac is running the portal. You'll
see three regions:

```
┌───────────────┬──────────────────────────────────┬─────────────────┐
│  Left rail    │   Player & mixer (top half)      │  Setlist        │
│  search,      │   Library table (bottom half)    │  planner        │
│  filters,     │                                  │                 │
│  stats        │                                  │                 │
└───────────────┴──────────────────────────────────┴─────────────────┘
```

The left rail is for finding songs. The center is for playing them and
rebalancing the mix. The right rail is for building a setlist.

---

## Adding a song from YouTube

Paste a YouTube link into the **"Paste a YouTube URL"** box on the left rail
and click **Add**. The song goes into a queue; over the next 10–25 minutes it
gets downloaded, analyzed (BPM and key), and separated into stems. While that
happens you can keep using everything else.

You can paste any of these:

- A single video — `https://www.youtube.com/watch?v=...`
- A playlist — `https://www.youtube.com/playlist?list=...` (each video
  becomes its own song, grouped into a setlist with the playlist's name)
- A chaptered "full album" video — each chapter becomes its own song

When the song is ready, it appears in the library with green chips for every
format you can play. Until then, the "Queue empty / N awaiting render" status
in the toolbar tells you how many songs are still cooking.

---

## Finding a song

The library is the table at the bottom of the page. Each row is a song.
Above the table, you have:

- **Search** — type a title, artist, or partial — matches narrow the table
  live.
- **All / Stems / M4As** — filter to songs with stems (full mixer), with
  m4a minus-mixes (single-fader playback), or both.
- **Any Key / Any Tempo** — narrow to a specific musical key or tempo band.
- **Library analytics** — sidebar shows the count of songs in each tempo
  bucket (slow / medium / fast) and which keys are over-represented.

To play a song, click anywhere on its row (or hit the play button next to
the title for an instant start, or **Load** in the Action column to load it
without playing).

---

## What the chips mean

Each row shows chips for what's available:

| Chip | What it is | When to use |
|---|---|---|
| **STEMS** (purple) | 6 separate tracks, with the full mixer | When you want to rebalance the band live |
| **READY** (green) | Stems are pre-cached on disk; will start instantly | Use this for the song you're about to play live |
| **-V** | Source minus vocals — single AAC file | Sing-along practice |
| **-V-G** | Source minus vocals and guitar | Guitar practice |
| **-V-G-B** | Source minus vocals, guitar, and bass | Rhythm-section practice |
| **DO** | Drums only | Drummer practice / click track |

Clicking a chip directly loads *that* variant. Clicking the row picks the
richest available variant (stems if present, otherwise the best m4a).

---

## Playing a song

Once a song is loaded, the player section (top half) shows the title, BPM,
key, and a waveform/scrubber. Standard transport controls:

- **▶ / ‖** play / pause
- **■** stop (also resets position)
- **⤺** loop the current selection
- **1.00x** tempo dial — slow the song down for learning (or speed it up if
  you're feeling brave)

Above the waveform, the **Outro Jam Stretch** toggle extends the song's last
loop section (2x / 4x / 8x / ∞) for soloing — useful when the band wants to
keep going past the song's recorded ending.

---

## The Stem Mixer

When you load a song with STEMS available, the **Stem Mixer Console** in the
middle of the page gives you a fader per instrument:

- Vocals · Drums · Bass · Guitar · Piano · Other

For each channel:

- **Fader** — volume
- **M** — mute this channel (won't play at all)
- **S** — solo this channel (everything else mutes)
- **Loop** buttons (next to faders, when present) — play just this stem
  through a detected jam loop

Use solo to learn a part. Use mute to make a practice track on the fly —
mute the singer so you can sing, mute the bass so the bassist can play
along. The **Reset Faders** button at the right snaps everything back to
neutral.

---

## Loops

The portal automatically detects the most-repeated sections of a song
(verse, chorus, bridge, etc.) and offers them as loops. You can play just
the **drums** of a chorus on repeat while the bassist practices their part
over it, or jam over the song's main groove indefinitely.

Loops appear as buttons next to each stem channel once they've been
detected. Up to 4 loops per stem; loop1 is usually the chorus or main groove.

---

## Setlists

The right rail is the **Setlist Planner**. To build a setlist:

1. Check the box in the **SET** column of each song you want to add.
2. Each song shows up in the right rail with a default start time; drag
   the handle (`∷`) to reorder.
3. Type a name in **Setlist Name**, pick a **Start Time**, and click
   **Save**.
4. When it's gig night, hit the saved setlist from **Saved SetLists** —
   the planner loads it and the player walks through in order.

Use the **Clear** button at the top right to start a fresh setlist.

---

## Common workflows

### Practicing a song at home

1. Find the song in the library (search by title).
2. Click **Load** to bring it into the player.
3. In the **Stem Mixer**, solo or mute the parts you want to focus on.
4. Drop the tempo dial to **0.75x** or **0.80x** to learn fast passages.
5. Use a **Loop** button on a stem to repeat just that section.

### Preparing for a gig

1. Build the setlist (check the SET boxes, name it, save it).
2. The night before, click the songs you're about to play and let them
   pre-cache — the chip will turn green (**READY**). This means they'll
   play instantly with no buffering, even if the WiFi is bad at the venue.
3. On gig night, load the saved setlist. Each song will be ready to go.

### Learning a song you don't know

1. Paste the YouTube URL into the **"Paste a YouTube URL"** box.
2. Wait for the song to appear in the library (10–25 min for the first
   render; you'll see it in the queue status while it cooks).
3. Once ready, click **Load** and use the **Stem Mixer** to solo your
   instrument's part. Listen to it on repeat with the loop feature.

### Pulling up a key/tempo-specific track for a singer

1. Use the **Any Key** filter to find every song in that key.
2. Or use **Any Tempo** to find songs at the singer's tempo range.
3. Click the song to audition; the player shows BPM and key in the
   header for confirmation.

---

## Troubleshooting

**The song I added doesn't show up.**
Check the queue indicator in the toolbar. If it shows "N awaiting render",
your song is in line. If it's empty and the song still isn't there, the
download may have failed silently — try pasting the URL again.

**Audio is slow to start, then stutters.**
First play of an uncached song streams from cloud storage and can take a
few seconds. Subsequent plays are instant. Look for the **READY** green
chip — those songs are pre-cached and start instantly.

**The mixer disappears when I load a song.**
That song doesn't have STEMS available (no purple chip on the row). Only
songs marked **STEMS** have the full mixer. You can still load and play
the song's m4a versions via the format chips.

**The song's tempo or key is wrong.**
Both are auto-detected and occasionally miss. They're labels, not active
processing — the audio itself is correct.

**The Re-stem in Logic button** (under each song's `⋯` options menu)
is for advanced use only; ignore it unless you've been shown how to set
it up.

---

## More

- For the band's developer / forker — [ARCHITECTURE.md](ARCHITECTURE.md).
- The full project repo — [github.com/williambnorton/simpleStem](https://github.com/williambnorton/simpleStem).
