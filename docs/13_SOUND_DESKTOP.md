# The Sound Desktop — a drag-and-drop paradigm for simpleStem

*Brainstorm, 2026-07-12. Rollback point if the experiment fails:
`git checkout snapshot-2026-07-12-pre-desktop`. Interactive prototype:
`http://localhost:3000/desktop-proto.html`.*

## The one-sentence idea

Extend the Mac desktop metaphor so that **folders are nouns, machines are
verbs, and dropping a noun on a verb applies the function** — with sound as
a first-class sense: every object can be *auditioned*, and every machine
*sounds like what it does*.

The deep insight is that simpleStem already lives this way on disk:
`INCOMING_WEBLOC/` is a hot folder, `STEMS/<song>/` is a document, the
pipeline scripts are machines. The desktop UI just makes the existing
architecture *visible and grabbable*.

## The grammar (what makes drops predictable)

The user should never have to guess what a drop does. Five rules give the
desktop deterministic physics:

1. **Noun → Verb = transform.** Dropping a folder (or URL, or selection)
   onto a machine runs that machine. The machine never destroys its input;
   the result appears as a NEW folder sliding out of the machine, or as
   new files inside the dropped folder (badged as updated).
2. **Noun → Noun = containment.** Dropping a song folder onto a setlist
   folder adds it. Dropping a setlist onto a gig binder adds the set.
   Order is position; duplicates bounce off with a thunk.
3. **Verb → Noun = install a watcher.** Dropping a machine onto a folder
   turns the folder HOT: everything that lands there afterwards is
   processed automatically (this is exactly `webloc_watch.sh` today — the
   Librarian is a machine permanently dropped on `INCOMING_WEBLOC/`).
4. **Type plates.** Every machine's intake is a shaped *plate* (slot, tray,
   turntable) and every noun carries a matching *badge* (link, waveform,
   folder-with-waveform, list). A drag that can't legally drop shows the
   plate greyed; a legal drop target glows and plays a soft "open" tone.
   The type system is iconography, not documentation.
5. **Everything auditions.** Select any object and press Space (Quick Look
   for sound): a folder plays 3 s of its mix, a stem badge plays its stem
   solo, a setlist plays 0.5 s of each song like riffling a book. Machines
   hum their idle sound on hover; while working they play their work sound
   (the Stemcutter saws, the Tagger ticks checkboxes).

## The machines (each one maps to something that already exists)

| Desktop object | Looks like | Input plate | Output | Existing code |
|---|---|---|---|---|
| **Stemcutter** | a jukebox with a saw blade | URL slot | `BackingTrack/` folder: `source.wav`, six stems, empty `metadata.json` | `webloc_watch.sh` + `stem.sh` (Demucs) |
| **Tagger** | a machine with checkboxes on its cover | folder tray | fills `metadata.json`: bpm, key, song details, empty section breaks, stem-mix trims, play count, last-played | `metadata.py` + `mpb_sync.py` + portal edits |
| **Click Forge** | an anvil with a metronome | folder tray | beat grid + click/count-in defaults into the folder | visualizer beat tracker + click actions |
| **Setlist Press** | a ring binder press | multi-folder tray | `Setlist/` folder of aliases, ordered | `SETLISTS/*.json`, Make-Gig-from-selection |
| **Gig Binder** | a road case | setlist tray | `Gig/` case; closing the lid = Flash Cache (offline contract) | `GIGS/*.json` + precache |
| **The Amp** | XR18 face with glowing valves | any playable noun | PLAYS it; its knobs are the live master/strips | the portal player itself |
| **Loop Lathe** | a lathe | section selection | `loops/` kit in the song folder | section looper + overdub |
| **Librarian** | a little robot | drop ON a folder | that folder becomes hot (rule 3) | `librarian.sh` daemons |

## The Library folder and the self-improvement loop

`Library/` is `STEMS/` seen honestly: a folder of song folders. Your
instinct about per-folder `claude.md` + git is the strongest part of this
paradigm, and it generalizes:

```
Library/
  Friend_of_the_Devil/
    vocals.m4a … other.m4a, source.wav
    metadata.json
    claude.md        ← standing instructions FOR THIS SONG ("JD sings it,
                        keep piano low, the bridge section marker tends to
                        land early — check it after re-stems")
    runlog.md        ← append-only: every machine that touched this folder
                        writes what it did, what it noticed, what to try
                        next time (self-improvement guidance for the next
                        Claude run over these files)
    .git/            ← per-song history: every metadata change, section
                        edit, and lyric pass is a commit; "go back a
                        version" works PER SONG
```

Machines read `claude.md` before acting and append to `runlog.md` after.
Reinforcement becomes tangible: the Tagger notices its last bpm guess was
hand-corrected (it's in the git history), says so in `runlog.md`, and
weighs the correction next time. This is HOLODECK's tap-training pattern
promoted to the whole pipeline.

## Sound as a desktop dimension (the genuinely new part)

- **Audible drag.** While dragging a song folder, its mix plays faintly
  *from the pointer* (pan follows x-position). Dragging vocals-badge only
  plays vocals. You can literally hear what you're holding.
- **Machines have voices.** Idle hum on hover, work sound while running,
  a completion chime in the KEY OF THE SONG they just processed (the
  Stemcutter finishing Friend of the Devil chimes in E).
- **Spatial mixing.** Objects placed left/right of the Amp pan there;
  distance from the Amp is send level. A rehearsal "mix" can be arranged
  ON THE DESK before touching a fader.
- **The desk is a soundboard.** Cmd-space on empty desktop plays the room:
  every hot folder ticks, every queued render whirs — a 5-second audio
  status report of the whole pipeline, no eyes needed.

## Two implementation paths (not exclusive)

1. **The real Finder** (data-first, zero new UI): the folders already live
   on Drive. Add per-song `claude.md`/`runlog.md`, install Folder Actions
   (or the existing watchers) so real Finder drops trigger the pipeline,
   and ship custom folder/machine icons. Weak on sound + animation, but it
   works TODAY with the two-machine split unchanged.
2. **The desk in the portal** (the prototype): a full-screen "desk" page in
   bt-construction-kit with the machines drawn as objects, real drag
   physics, sound, and the same server endpoints doing the work
   (`/api/enqueue`, `/api/song/:base/*`, `/api/gigs`). This is where the
   audible-drag and spatial ideas live.

## Prototype

`bt-construction-kit/public/desktop-proto.html` — self-contained demo of
the core loop you described: drag the YouTube URL chip onto the
**Stemcutter** → it saws → a **BackingTrack folder** pops out (open it:
m4a stems + an empty metadata card) → drag that folder onto the **Tagger**
→ checkboxes tick → metadata card fills (bpm, key, sections, mix trims,
plays, last-played) → drag the folder into the **Library**, which shows
each song folder carrying `claude.md` + `runlog.md` + git badges. Illegal
drops bounce. Every step makes its sound. No real pipeline is wired — it's
the grammar made touchable.

## Open questions for round two

- Does the desk REPLACE the library tab or live beside it? (Suggest:
  beside — the desk is for curation days, the list for gig nights.)
- Undo semantics: is dragging out of the Library a *remove* (scary) or an
  *alias* (safe)? Suggest: everything is aliases except explicit trash.
- Do machines queue visibly (a chute of pending folders, like the render
  queue today) — and is THAT the Librarian dashboard reborn?
- How far to take spatial audio before it's a gimmick? (Audible drag:
  clearly useful. Key-of-song chimes: delightful. Distance-as-send-level:
  needs a trial.)
