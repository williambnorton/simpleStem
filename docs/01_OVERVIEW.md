# Overview — what simpleStem is

simpleStem turns songs from YouTube into six separated instrument tracks —
vocals, drums, bass, guitar, piano, and "other" — and plays them back through
a web app the band drives at rehearsals and gigs. Because each instrument is
its own track, you can mute the vocals to sing lead, kill the guitar to solo
over the record, or strip a song down to just drums and bass. Off-the-shelf
backing tracks can't do that; simpleStem exists because we needed it.

The app (we call it **the portal**) runs in Chrome at `http://localhost:3000`
on the band's MacBook Pro. It shows the whole song library, organizes songs
into **gigs** and **setlists**, mixes the six stems live, and — at shows —
feeds each stem to its own channel on the Behringer XR18 mixer.

![Portal at a glance](images/overview_portal.png)
*SCREENSHOT: the portal with the gig sidebar, player, and library visible*

## Two machines, one library

simpleStem is split across two Macs that share one Google Drive folder:

- **The Performer** — the MacBook Pro that travels to gigs. It runs the
  portal, renders new songs (the CPU-heavy stem separation), and drives the
  XR18. Everything it needs at a show is copied to a local cache
  (`~/.bt-cache`) ahead of time, so the portal works with **no internet at
  the venue**. That offline guarantee is the system's most important rule.
- **The Librarian** — a Mac mini that runs 24/7 at home. It watches for new
  YouTube URLs, downloads the audio, analyzes tempo and key, keeps the
  library index (`CATALOG.json`) current, and pulls the band's Google Sheet
  song list daily so singer assignments and readiness flags stay in sync.
  It has its own dashboard at `http://localhost:3000/librarian`.

You rarely need to think about which machine does what — paste a YouTube URL
into the portal and the two machines hand the work back and forth on their
own. The split exists so the gig laptop is never busy, never waiting on the
network, and never surprised.

## What each bandmate can do with it

- **Practice at home.** Load any song, mute or solo your part, slow it down
  to 0.75×, loop the tricky section with the LOOPER, and boost a buried stem
  +5 or +10 dB to hear what it's actually playing.
- **Learn the vocal.** Pull the vocal fader down (or mute it) and sing; pop
  lyrics on screen with the lyric overlay if the song has them placed.
- **Fix the key.** The SEMI knob shifts pitch up to ±3 half-steps in ½-step
  clicks — enough to move a song into your range without a re-render.
- **Plan a set.** Star favorites, tag songs (upbeat, singalong, closer…),
  set who sings what, and use the Gig Builder to assemble setlists filtered
  by who's actually available that night.
- **Play the gig.** Load the gig, hit play; songs auto-advance through the
  setlist, per-stem audio routes to the XR18, and MIDI actions on each
  song's timeline can switch Helix patches or ride Logic faders for you.

Bill operates the system end to end; everyone else mostly needs the portal
basics in [02_GETTING_STARTED.md](02_GETTING_STARTED.md) and the player
controls in [03_PLAYER_REFERENCE.md](03_PLAYER_REFERENCE.md).
