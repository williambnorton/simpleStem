# Getting started

This guide takes you from a cold laptop to playing a song in each of the
three playback modes. Everything here happens on the **Performer** (the
MacBook Pro) unless it says otherwise.

## First launch on the Performer

Once per machine, install the portal's dependencies. Run this in Terminal
on the Performer:

```
cd ~/simpleStem-code/bt-construction-kit
npm install
```

Then, any time you want the system up:

```
cd ~/simpleStem-code
./performer.sh start
```

That single command starts both halves of the Performer: the render queue
(which turns downloaded songs into stems) and the portal web server. Open
**Chrome** and go to:

```
http://localhost:3000
```

Other useful commands, all from `~/simpleStem-code`:

```
./performer.sh status
./performer.sh logs runner
./performer.sh restart
./performer.sh stop
```

`status` shows the queue depth and the current render phase; `restart` picks
up freshly pulled code.

The first time the portal boots it copies every song's stems into the local
cache at `~/.bt-cache`. That's the **offline contract**: every song in the
library must play end-to-end with no wifi. If the library banner ever warns
about uncached songs, click its **Flash Cache** button (see the
[Gig Day Runbook](08_GIG_DAY_RUNBOOK.md)).

![First launch](images/getting_started_first_launch.png)
*SCREENSHOT: the portal just after boot — idle player ("Select a Song to Begin Construction"), sidebar, library filling in*

## Adding a song from YouTube

There are two front doors; both end up in the same place.

**The portal box.** In the left sidebar, find the input labeled
**"Paste YouTube URL + Enter to ingest"**. Paste a link and press Enter.
You can paste:

- a single video (`https://www.youtube.com/watch?v=...`),
- a **playlist** — every video becomes its own song, grouped into a setlist
  named after the playlist,
- a **chaptered "full album" video** — each chapter becomes its own song.

The **ingest tracker** appears under the box and follows your submission
through its stages: *pasted → librarian → queued → rendering → done*. It
polls every few seconds and fades once the song lands in the library.

**The .webloc drop.** Drag a YouTube URL from Chrome's address bar to the
Desktop (macOS makes a `.webloc` file) and drop it into
`~/ClaudeDrive/simpleStem/INCOMING_WEBLOC/`. This works from any Mac that
syncs the Drive folder, and it's what the Chrome Quick Action does behind
the scenes.

![Ingest tracker](images/getting_started_ingest_tracker.png)
*SCREENSHOT: the sidebar URL box with the ingest tracker showing "rendering" state*

## What happens during ingest

You don't have to do anything — but here's the relay race you just started:

1. **The Librarian (Mac mini)** notices the new URL within seconds. It
   downloads the audio once at 48 kHz (`source.wav`), analyzes BPM and key,
   writes the song's `metadata.json`, and drops a render job in the queue.
2. **The Performer (this laptop)** picks the job up and runs **Demucs**, the
   AI stem separator, producing the six stems, then converts them to m4a.
   This is the slow part: **10–25 minutes per song on CPU**. A new request
   simply queues behind the current one.
3. When the render finishes, section boundaries are auto-detected, the
   catalog updates, and the song appears in the library, fully cached and
   playable.

You can watch all of this live on the Librarian dashboard
(`http://localhost:3000/librarian` — see [07_LIBRARIAN.md](07_LIBRARIAN.md)),
where the **Living Pipeline** animation shows the actual files flying between
folders. Render phases also show in `./performer.sh status`:
*downloading source → analyzing (BPM/key) → separating stems · demucs →
mixing m4a*.

**Note for home use:** the Performer must be on the same network as the
Drive folder syncs happen over (i.e., at home on wifi). At a gig, you don't
ingest — you play what's already cached.

## Loading and playing a song

Click any row in the **Song Library** table. The player fills the top of the
page: title and artist, BPM / Key / Drum / Backing pills, the waveform
visualizer, transport controls, and the six-strip **Stem Mixer Console**.

- **Space** (or the ▶ button) plays and pauses.
- Drag the timeline slider, or double-click the waveform to zoom in.
- The six faders control the stems; **M** mutes, **S** solos a strip.
- **Cmd+]** jumps to the next song in the active setlist.

Press **?** at any time for the keyboard shortcut overlay.

![Loaded song](images/getting_started_player_loaded.png)
*SCREENSHOT: a song loaded — header pills, visualizer, transport, mixer console*

## The three playback modes

Every song plays in one of three modes, and **the portal remembers the mode
per song** — pick it once, and the song comes up that way next time (it's
stored in the song's metadata as `playback_mode`).

1. **6-stem mixer** (the default). All six stems play through the mixer
   console; full per-stem control, XR18 routing, boosts, pitch, looper.
2. **Backing track.** One pre-mixed stereo m4a from the band's
   `BACKING_TRACKS/` collection plays instead of the stems. Click the
   **Backing** pill in the header row to toggle it. The pill is only enabled
   when the server has matched a backing track to this song.
3. **Drum machine.** The song's audio is replaced by a looping drum pattern
   from `DRUM_MACHINE/` — for songs the band plays live with just a beat.
   Click the **Drum** pill to toggle. While engaged, a banner reminds you:
   *"Drum Machine playing — press Play to switch back to the song."*
   **Right-click** the Drum pill to pick a different pattern near the song's
   BPM (the current one is marked); a right-click choice lasts for the
   session without changing the song's saved pattern.

Drum machine and backing track are mutually exclusive — engaging one
disengages the other. **Cmd+.** toggles the drum machine from the keyboard
and persists the choice.

![Mode pills](images/getting_started_mode_pills.png)
*SCREENSHOT: the header pill row — BPM, Key, Drum pill engaged (green), Backing pill, clock*

## Where to go next

- Every player control, explained: [03_PLAYER_REFERENCE.md](03_PLAYER_REFERENCE.md)
- Building gigs and setlists: [04_GIGS_AND_SETLISTS.md](04_GIGS_AND_SETLISTS.md)
- The night before a show: [08_GIG_DAY_RUNBOOK.md](08_GIG_DAY_RUNBOOK.md)
