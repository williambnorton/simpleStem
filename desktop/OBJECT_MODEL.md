# Sound Desktop — object attributes & methods (brainstorm, 2026-07-15)

A working list of what every desk object SHOULD carry, so the desk stops
being "divs with special cases" and becomes a uniform object system.
Legend: ✅ exists in the prototype today · ◇ proposed. This doc is the
brainstorm; the contract lives in `desktop/CLAUDE.md` once we commit to
pieces of it.

## Design stance

Every desk object is the same five things:

1. **Identity** — who it is and what real thing it stands for.
2. **Reality binding** — the path/endpoint/app behind the icon. An icon
   with no binding is a lie; every attribute below that reads reality
   must say HOW it reads it.
3. **State** — a small, enumerable lifecycle every animation hangs off.
4. **Gestures** — the three universal inspections (hover / double-click
   / right-click) expressed as methods, never re-implemented per object.
5. **Verbs** — what the object can DO, which is also exactly what voice
   and drag-drop are allowed to invoke.

## The base: DeskObject

Attributes:

| attribute | notes |
|---|---|
| `id` ✅ | stable, used for layout persistence + wires |
| `kind` ✅ | `url · folder-raw · folder-tagged · machine · aggregate · building · instrument · port` |
| `art`, `label`, `sub` ✅ | glyph, name, one-line status. `sub` is LIVE — pollers rewrite it |
| `x, y` ✅ / `layoutKey` ◇ | position; persisted as viewport fractions in `desk.layout.v1` |
| `state` ◇ | `idle · working · done · error · down` — one enum, CSS classes derive from it (today: ad-hoc classes like `.working`, `.alive`, `.down`) |
| `realBinding` ◇ | `{ type: 'dir'\|'file'\|'endpoint'\|'app'\|'tab', ref }` — what double-click opens and peek inspects. Today this knowledge is smeared across the `idMap`/`map` dblclick tables |
| `machineRole` ◇ | `performer · librarian · stage` — which zone owns it; drives placement + which host really runs its verbs |
| `pollSpec` ◇ | `{ endpoint, everyMs, apply(o, data) }` — one declarative slot instead of the hand-rolled `pollSystem`/`pollSlowInstruments` branches |
| `staleness` ◇ | ms since last successful poll; peek shows "as of 12 s ago", objects grey out past a threshold |
| `voiceNames` ◇ | aliases HOLODECK/desk-mic resolve ("board", "mixer" → xr18). Shares `holodeck.training.v1` |
| `userActions` ✅ | starred right-click actions, persisted per kind in `desk.actions.v1` |

Methods:

| method | gesture / caller | notes |
|---|---|---|
| `peek()` ✅ | hover 350 ms | returns popover HTML; async-enriched for folders (real sizes, full path) |
| `open()` ✅ | double-click | opens the REAL thing behind `realBinding` (Finder, app, tab, tree card) |
| `menu()` ✅ | right-click | default actions + verbs + user actions + "Add action…" |
| `moveTo(x, y)` ✅ | drag engine | machines remember via `rememberPosition` |
| `setState(s)` ◇ | everything | single choke-point so state→CSS→sound stays consistent |
| `refresh()` ◇ | menu, poller | force one poll now (today only the queue tray has "Refresh now") |
| `speak()` ◇ | voice "what does X do / how is X" | say intake→output, or current status ("Stemcutter: separating Boys of Summer, phase demucs") |
| `serialize()` ◇ | debug/tests | plain-JSON snapshot for `__desk` assertions |

## Nouns (things that flow through machines)

**URL chip** — attrs: `url` ✅, `title` (oEmbed) ✅, `resolved` ✅, `sourceKind` ◇ (single/playlist/album — playlists should LOOK different before you drop them). Methods: `resolve()` ✅, `enqueue()` ✅ (via Stemcutter), `openSource()` ✅ (dblclick → YouTube tab), `split()` ◇ (playlist chip → N song chips you can drop selectively).

**Song folder** — the richest noun. Attrs: `folderName` ✅ (REAL dir name — display slug is not identity), `title/artist` ✅, `stage` ✅ (raw→tagged→shelved), `stems[]` ✅ `{name, size, done}` (live-polled), `meta` ✅ (bpm, key, singer_lead, drum_pattern, readiness, favorite), `sizeBytes` ✅, `cached` ◇ (are its six m4a in ~/.bt-cache — the offline-gig contract, surfaced per song), `gigsUsedIn` ◇ (reverse index from GIGS/*.json). Methods: `revealInFinder()` ✅, `inspect()` ✅ (real listing), `audition()` ◇ (play 3 s of the mix — stubbed today), `loadInPortal()` ◇ (dblclick alternative: open the song IN the player), `restem()` ◇ (re-queue from cached source.wav — no YouTube), `retag()` ◇ (re-run metadata.py), `flashCache()` ◇ (push just this song's stems to cache), `star()` ◇ (favorite, same PUT the portal uses).

**Setlist** ◇ — attrs: `songs[]`, `origin` (manual/playlist — playlist ones are read-only), `durationSec` (sum of songs), `projectedTimes` (once gig start-time lands). Methods: `addSong`, `reorder`, `openPlanner`, `export()` (print/PDF for the music stand).

**Gig** — attrs: `setlists[]` ✅ (count shown), `date/venue` ◇, `readiness` ◇ (every song cached? every song InTheCan?). Methods: `openBinder()` ✅ (Finder on GIGS/), `preflight()` ◇ — THE killer method: checks cache contract + readiness for every song and returns a red/green board before you leave the house.

## Machines (verbs with a body)

Shared machine attrs: `accepts[]` ✅, `outputType` ◇ (today implied by `work`; making it explicit lets aggregation legality generalize), `work` ✅, `status/phase` ✅ (Stemcutter shows RENDERING + phase), `queueDepth` ✅ (badge), `currentJob` ✅, `progress` ◇ (n/total + ETA — same house rule as long-running scripts), `lastRun` ◇, `specCard` ✅. Shared methods: `run(input)` ✅, `canAccept(kind)` ✅, `aggregateWith(m)` ✅, `disassemble()` ✅, `watch(dir)` ◇ (rule-3: auto-run on new arrivals — "watch Downloads with Stemcutter").

Per-machine extras:

- **Stemcutter**: `renderPhases[]` ✅ (downloading→analyzing→demucs→mixing); `cancelJob()` ◇, `retryFailed()` ◇ (today _failed/ jobs need a terminal).
- **Tagger**: `card` ✅ (real bpm/key/singer); `editField(k, v)` ◇ (the card becomes a real metadata editor — writes through the existing PUT endpoints).
- **Library**: `count` ✅, `drawer` ✅; `find(title)` ◇ (voice: "library, find Boys of Summer" → folder pops out), `randomChip()` ✅ (the demo chip is a real random song).
- **The Amp**: `nowPlaying` ◇; `play(folder)` ✅ (opens portal tab), `stop()` ◇ — and the amp is where desk-audio ideas (audible drag, key chimes) live.

## Instruments (live system objects — the desk as dashboard)

- **Librarian robot**: `daemons[]` ✅ `{name, pid, running}` via heartbeat, `lastHeartbeatAt` ◇ (surfaced — the July-10 outage went unseen for 5 days). Methods: `openPortal()` ✅, `wake()` ◇ (POST that reruns `librarian.sh start` — needs a Librarian-side endpoint, worth it).
- **Queue tray**: `incoming[]` ✅, `queued[]` ✅ (names in peek); `listJobs()` ✅, `openIncoming()` ✅, `dedupe()` ◇ (the 6×-duplicate webloc problem, one right-click).
- **Catalog**: `songCount` ✅, `lastPass` ◇, `driftStatus` ◇ (the conformance check's verdict, surfaced). Methods: `openFile()` ✅, `runPassNow()` ◇.
- **Songlist sheet**: `sheetUrl` ✅, `lastSync` ◇, `unmatchedRows` ◇ (from mpb_sync_report.json — the triage list as a badge). Methods: `openSheet()` ✅, `syncNow()` ◇, `showUnmatched()` ◇.
- **Drive**: `syncState` ◇ (idle/syncing/offline — hooked to the offline-gig story). Methods: `openRoot()` ✅.
- **Cache**: `done/total` ✅, `bytes` ✅ (tree card), `contractOk` ◇ (done === library count, red otherwise). Methods: `showTree()` ✅, `flash()` ◇ (POST /api/cache/flash — the Flash Cache button, reachable from the desk).

## Stage rig (ports make it real)

Today the rig is objects + drawn wires. The upgrade that makes it an
OBJECT model: **ports**.

- Every rig object gets `ports[]` ◇: `{ id, dir: 'in'|'out', kind: 'analog'|'usb'|'bus', label }` — XR18: 16 analog in, USB 18 out, USB 18 in, Main L/R out, AUX 1–6 out. Mics: 1 analog out each. Logic: USB in/out.
- **Wire** becomes an object ◇: `{ from: port, to: port, kind, label, signal: 'live'|'idle' }` — peek on a wire tells you what's flowing; `signal` could someday read real meters (XR18 OSC) and make the dashes pulse with the actual audio.
- Methods: `xr18.openXAir()` ✅, `xr18.busFor(stem)` ◇ (show the portal's per-stem routing ON the wires), `wedges.mixFor(member)` ◇ (peek per wedge: whose monitor mix), `wire.trace()` ◇ (flash the whole path a signal takes, end to end — great for teaching the band how the rig works).

## Aggregates

Attrs: `chain[]` ✅ (A→B), `legality` ✅ (type table). Methods: `run()` ✅ (staged, lid animation), `takeApart()` ✅, `extend(m)` ◇ (aggregate+machine → longer chain — the declared next round), `name()` ◇ (persist a named pipeline: "the usual" = stemcut→tag→shelve), `savePipeline()` ◇ (named aggregates persist in `desk.pipelines.v1` and become voice verbs: "run the usual on this url").

## Priority read (if we build only three ◇ things)

1. `gig.preflight()` — turns the desk into the pre-gig checklist that
   would have caught both June-28 failures.
2. `pollSpec` + `state` + `staleness` on the base — one declarative
   live-data path instead of four hand-rolled pollers; everything else
   gets fresher for free.
3. `ports[]` + Wire-as-object — the rig graduates from picture to model,
   and per-stem routing becomes visible where it belongs.
