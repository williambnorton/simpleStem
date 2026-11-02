# simpleStem User's Guide

*Updated 2026-08-28. Covers portal build V1.0828 and later.*

This guide is for the band. Part 1 is for anyone driving the portal at
rehearsal or on stage. Part 2 is for the operator who runs the machines
(Bill). Developers should read [ARCHITECTURE.md](ARCHITECTURE.md) instead,
and Claude-the-coding-agent reads [CLAUDE.md](CLAUDE.md).

Every view of the portal has a **? button** in the bottom-right corner
that explains that view's features in place. This guide goes deeper and
adds the workflows.

---

## What this is

A web app ("the portal") on the band's MacBook at `http://localhost:3000`.
Every song the band has asked for lives in it as six separated stems
(vocals, drums, bass, guitar, piano, other). The portal mixes those six
stems live in the browser, so any part can be muted, soloed, boosted, or
routed to its own channel on the XR18 mixer. Songs group into setlists,
setlists group into gigs.

Everything plays from the laptop's own disk. The venue needs no internet:
that is a design guarantee, not a hope, and there is a test for it.

### The four views

| View | What it is for |
|---|---|
| 🎛 **Performer** | The main mixer. Rehearsal and the gig itself. |
| 🤖 **Librarian** | The song pipeline dashboard: what is downloading, rendering, failing. |
| 🎹 **MIDI** | The control room for the Helix, XR18, and Logic. Test patches here first. |
| 🖥 **Desktop** | A file-level inspection view: song folders, the cache, device cards. |

The buttons under the simpleStem logo switch views. The lit button is
where you are.

---

# Part 1: Playing

## Getting started

Open `http://localhost:3000`. Three regions:

```
+-------------------+------------------------------------------+
|  Gig sidebar      |   Player + Stem Mixer (top)              |
|  - active gig     |   Library table (bottom)                 |
|  - setlists       |                                          |
|  - songs in order |                                          |
+-------------------+------------------------------------------+
```

The sidebar decides WHAT to play (gig, setlist, song). The player area
decides HOW it sounds.

## Adding a song from YouTube

Paste a YouTube link into the **"Paste YouTube URL + Enter"** box and hit
Enter. The laptop downloads it, analyzes BPM and key, and separates it
into six stems. That takes 10 to 25 minutes per song; everything else
keeps working while it cooks, and the queue chips in the toolbar show
the phase (downloading, analyzing, separating, mixing).

You can paste a single video, a playlist (every video becomes a song,
grouped into a setlist named after the playlist), or a chaptered full
album video (each chapter becomes its own song).

If a red **✕ webloc failed** chip appears, the download failed: usually
a deleted, age-restricted, or heavily protected video. Hover the chip
for the fix.

## The library

Each row is one song:

| Column | What's in it |
|---|---|
| **SET** | Checkbox. Batch-adds the song to the active setlist. |
| **★ / Title** | Star toggles Favorite; clicking the row loads the song. |
| **Artist** | |
| **Dur** | Song length, mm:ss. |
| **Tempo** | BPM. |
| **Key** | Musical key. |
| **Singer** | Pulldown: Bill / Matt / Dan / JD / All. Changing it re-buckets the singer views immediately. |
| **Drum** | The drum pattern tag from the band sheet, like `120@130`. |
| **Action** | `⋯` per-song menu. |

Filters above the table cover tempo, key, singer, and readiness. A song
with no BPM or tags stays visible when all filters are checked.

## Picking a gig

The sidebar picker lists every real gig plus built-in views the portal
assembles on the fly:

| Gig | What it contains |
|---|---|
| ▶ **YouTube Sync** | Setlists mirrored from YouTube playlists. Read-only: the next sync would overwrite edits. |
| ✎ **Manual Setlists** | Setlists you saved by hand. Fully editable. |
| ⟲ **Recents** | The last 50 songs you loaded. |
| ★ **Favorites** | Every starred song. |
| 🎤 **Bill / Matt / Dan / JD Songs** | Singer-filtered buckets. |
| 🎙 **RoundRobin** | All four buckets shuffled and interleaved so no singer goes twice in a row. |

RoundRobin is the tool for a singer stepping out mid-set: the rotation
keeps moving with no dead air.

## Building a setlist

Check the SET box on the songs you want and batch-add them, or drag a
song row between setlists inside the same gig. A brand-new standalone
setlist gets created from the "+ New Manual Setlist" entry and lives
under Manual Setlists, surviving restarts.

## Playing a song

Transport: play/pause, stop, next-in-setlist, plain loop, and **Speed**
(0.5x to 1.5x for practice; pitch follows speed). Click or drag anywhere
in the waveform to scrub; lyrics, sections, and automation all follow
the playhead in both directions.

**Pitch Fix** has two knobs. **SEMI** transposes up to 3 half-steps
either way in half-step stops; tempo moves with pitch by design, which
keeps the audio path glitch-free. **FINE** trims 50 cents either way in
1-cent steps for tuning to a recording. RESET zeroes both, and a song
change also resets pitch.

**LOOPER** repeats the section the playhead is in, seamlessly, for
practice. Next to it, the **click** button plays a click at song BPM
during the current section and **count-in** plays four beats before the
section starts. Both act on the current section only.

## The Stem Mixer

One strip per stem. Each has a fader, **M** mute, **S** solo, and two
latching boost buttons: **+5** and **+10** dB. Boost rides on top of the
fader and is never recorded into automation, so a quiet stem gets help
without rewriting the mix. The routing buttons send the stem to XR18
output channels; each stem's home channel is highlighted, and the
numbered buttons add extra outputs. With no XR18 connected the audio
goes to the laptop output and everything else still works.

## Sections

Press number keys 1 to 9 during playback to drop a section divider at
the playhead. Placement snaps to a detected boundary within 2 seconds
(the faint grey ticks show where the detector thinks sections start)
and falls back to the BPM grid. Drag a divider to move it, hover and
press Delete to remove it. Each section can carry a click-in flag so
the click and count-in fire automatically at its top.

## The timeline: actions and lyrics

The yellow lane under the visualizer holds the song's automation: MIDI
events to the Helix, XR18, or Logic, sample clips, and skip jumps. The
**+ Action**, **+ Clip**, and **Skip Section** buttons author them; each
event fires as the playhead crosses its timestamp.

**Nothing auto-saves. SAVE is the only commit.** SAVE persists all
actions including placed lyric lines. CLEAR wipes actions but keeps
sections. INIT replaces only the initial-state event.

**+ Lyric** places the next cached lyric line at the playhead; placed
lines paint the overlay during playback. When no lines remain, the same
button reads Fetch Lyrics and opens the editor, where lyrics get pasted
in from a search.

## Drum machine, clips, and backing tracks

The drum pattern pill next to BPM (like `120@130`) names the pattern
the drum machine plays for that song; the per-song pulldown changes it
and takes effect immediately. Clips curated into the library appear in
the Sampler panel and the + Clip picker. Backing tracks are matched to
songs automatically and available where the song loads.

## Library Analytics

Bottom of the sidebar: songs by tempo band, by key, and by singer.
Derived live from song metadata; the singer counts reflect the in-row
pulldowns and the band sheet sync.

---

# Part 2: Operating the system

## The machines

Three roles share one Google Drive folder:

| Role | Machine | Job |
|---|---|---|
| **Performer** | MacBook Pro (36 GB) | Runs the portal and the Demucs renders. The gig machine. |
| **Song Librarian** | Mac mini (8 GB, always on) | Ingests YouTube URLs, analyzes audio, keeps the catalog, pulls the band sheet daily. |
| **Clip Librarian** | Any Mac with Logic | Curates sample clips into the library. |

The mini never runs Demucs (it crashed on 8 GB). The laptop never runs
the ingest watcher. Commands for each machine are labeled; do not cross
them.

## Everyday commands

On the laptop, always from `~/simpleStem-code` (never the Drive copy):

```
./performer.sh start
./performer.sh status
./performer.sh test
./performer.sh reset
./performer.sh drill
./performer.sh pause
./performer.sh resume
./performer.sh logs runner
./performer.sh stop
```

`start` brings up all five services (render queue, MIDI sidecar, portal,
caffeinate, sidecar watchdog) and finishes with the gig test. `status`
shows queue depth and the current render phase. `pause` idles the queue
after the current song, without killing a render mid-song.

On the mini:

```
./librarian.sh start
./librarian.sh status
./librarian.sh catalog
./librarian.sh sheet
```

## The three safety commands

**`test`** is the gig readiness check: services up, portal answering
inside its latency budget, Drive answering, no stale lock, stems cached,
files fast-start, XR18 healthy, MIDI ports present, disk and power sane.
It prints PASS/WARN/FAIL lines and a verdict. `start` and `restart` run
it automatically.

**`reset`** is the retry when a start looks wrong. It stops everything,
clears whatever a reboot or a wedged Drive left behind (stale render
lock, port squatters, dead pidfiles), waits for Drive to actually
answer with visible progress, restarts all five services, and runs the
gig test. Drive being down never blocks it: the portal comes up on the
local cache and reset says so plainly.

**`drill`** is the venue simulation. It turns Wi-Fi off, runs the full
gig test, holds every page-load and song-load endpoint to a 2-second
budget, does an offline COLD BOOT (all services stopped, a stale lock
planted deliberately, full start, portal must answer within 30 seconds),
an offline reset round-trip, and turns Wi-Fi back on. VENUE READY or it
names the failing line. Run it before any gig at a new venue.

## The offline contract

If a song is in the library, its six stems are on the laptop's own disk
in `~/.bt-cache`, ready to play with no internet. The cache fills at
boot and hourly on its own. The **Flash Cache** button (hard-drive icon
in the mixer header) forces a full fill before leaving for a gig;
shift-click overwrites files already cached. The honest test: turn off
Wi-Fi at home and play a song end to end.

## Gig-day checklist

1. The night before: `./performer.sh drill`. Fix anything that FAILs.
2. Flash Cache, then spot-play two songs with Wi-Fi off.
3. At the venue: power first. Two gigs have failed on battery; the gig
   test FAILs on battery for that reason.
4. `./performer.sh start`, wait for GIG READY.
5. XR18 button in the portal so the mixer is the output device.
6. If anything looks wrong at any point: `./performer.sh reset`. It is
   the retry button and it is safe.

## Adding songs from audio files (not YouTube)

Drop any audio file (m4a, mp3, wav, aiff, flac) into `INCOMING_AUDIO/` in
the Drive folder. The Librarian ingests it: a stereo fast-start m4a lands
in `AUDIO_SOURCES/` (that folder is what you import into Easy Performer on
the iPad via the Drive app), and the song is queued for a normal six-stem
render on the laptop. Title and artist come from the file's tags, or from
an "Artist - Title" filename. Originals are kept in
`INCOMING_AUDIO/_ingested/` until you clear them.

The Librarian view's **Audio sources** panel lists these files with a play
button (listen-check through the speakers) and a delete. The library rows
there also carry a delete: it removes the stems folder, the stereo source,
and all caches after you type the folder name to confirm, and setlists
that referenced the song simply skip it.

For bulk triage of a folder of candidate files before dropping them in,
run `./filter_audio.sh <directory>` on either Mac: it plays 10 seconds of
each file; press D to delete, A to move to `Archive/`, space to keep, R to
replay, Q to quit. Deletes stage into a `.deleted/` folder and you get one
purge confirmation at the end.

## When the pipeline shows red

A **✕ webloc failed** chip means yt-dlp could not fetch a URL. The
`.failed` file sits in `INCOMING_WEBLOC/` on Drive. Update yt-dlp on
the mini, then rename the file back to `.webloc` to retry, or delete it
to dismiss. A **failed render** means Demucs crashed on a job; the job
waits in `STEM_QUEUE/_failed` and never retries on its own.

## The band sheet

The Google Sheet ("New Mitchell Park Song List") is the canonical source
for who sings what, who must be present, drum patterns, and readiness.
The mini pulls it daily and writes those fields into each song. An
in-portal singer change is for one-off triage; the next sheet sync may
overwrite it, so permanent changes belong in the sheet.

---

## Troubleshooting

**The song I added doesn't show up.** Check the queue chips. "N awaiting
render" means it is in line behind a 10-25 minute render. A red webloc
chip means the download failed; hover it.

**The portal didn't come up after a reboot.** `./performer.sh reset`.
This is exactly what it is for. If Drive is still mounting, reset says
so and the portal runs from the local cache meanwhile.

**A song won't play at the venue.** It should be impossible; the drill
and Flash Cache exist to make it so. If it happens anyway, the wedge
watchdog banner names the stall, and reset recovers the stack offline.

**The Singer change disappeared after a day.** The band sheet overwrote
it. Make the change in the sheet.

**Pitch only goes 3 half-steps.** By design. A bigger shift should be a
re-render, not a live stretch.

**LOOPER level jumps.** Check whether a +5/+10 boost is latched on the
strip you are hearing.

**The version number in the header tells you the build.** When
reporting a problem, include it: it is the timestamp of the newest code
file, like V1.08280845.

---

## More

- Developer's map: [ARCHITECTURE.md](ARCHITECTURE.md)
- Agent instructions: [CLAUDE.md](CLAUDE.md)
- How the system works, live: open `http://localhost:3000/README.html` on
  either machine. It explains each part of the pipeline with live readings
  on top: links waiting, the render queue in order, what is rendering, and
  which services are up. A red strip on Step 4 means the renderer has
  stalled; run `./performer.sh reset` on the laptop.
