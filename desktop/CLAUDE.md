# CLAUDE.md — the Sound Desktop's machine & voice-instrumentation grammar

Read this before touching the Sound Desktop (prototype:
`bt-construction-kit/public/desktop-proto.html`, design:
`docs/13_SOUND_DESKTOP.md`). This file is the contract for how machines,
aggregates, and voice-built instrumentation work — and where each run of
Claude should record what it learned.

## Object model

- **Noun**: URL chip, folder (`raw` → `tagged` → shelved), setlist, gig.
  Nouns are draggable; a noun mid-transformation (`kind: 'building'`) is
  NOT draggable — the folder becomes grabbable only after its completion
  dance ends.
- **Machine (verb)**: `{ id, art, label, accepts[], work }`. Machines
  drag PLAINLY (2026-07-15): drop one on another to aggregate, drop on
  empty desk to rearrange; a press without movement is still a click.
- **Aggregate**: two machines latched into one, built by dragging
  machine A onto machine B, or by voice. `accepts` = A's accepts; running
  it chains A's output into B automatically (B's lid opens, the folder
  climbs in). ⌥option-double-click takes an aggregate apart.

## Legality rule for aggregation

`connect A to B` is legal iff **A's output type matches B's intake type**.
The demo wires STEMCUTTER (URL → folder-raw) → TAGGER (folder-raw →
folder-tagged). Extending the chain set means extending this type table,
never special-casing pairs:

| Machine | intake | output |
|---|---|---|
| Stemcutter | url | folder-raw |
| Tagger | folder-raw | folder-tagged |
| Click Forge | folder-tagged | folder-tagged (adds beat grid) |
| Setlist Press | folder-tagged (many) | setlist |
| Gig Binder | setlist | gig |
| Library | folder-tagged | (terminal) |
| The Amp | anything playable | (terminal, live) |

Aggregates of aggregates are currently refused with a hint — that's the
declared next round, not an oversight.

## The animation contract (what Bill signed off on)

0. FLIGHT PACE: every airborne chip glides for 2.2 s with a 12 px
   readable label that fades only in the last half-second — the operator
   must be able to READ what is flying (Bill 2026-07-15).
1. Drop on Stemcutter → a folder NAMED AFTER THE SONG pops out beside it.
2. File chips (`vocals.m4a` … `source.wav`) FLY from machine to folder,
   one at a time, with a whoosh; the folder's sub-label counts `n/7`.
3. While working, the folder is SLICED horizontally into three bands that
   pull apart and reassemble on loop (the stemming, made visible).
4. On completion the folder stands tall and DANCES — rocking side to side
   with a smiling face — for exactly 5 seconds, with a little melody.
5. Only after the dance does the folder become draggable.
6. Aggregate runs add: second machine's lid hinges open, the folder rises,
   drops in, lid closes, stage-2 works, folder pops out the far side
   tagged, then the dance.

## Voice instrumentation grammar (v1 — live in the prototype's 🎤)

The desk has its own mini voice builder (the full HOLODECK stack lives in
`mic_listener.js` and should eventually absorb this). Wake word rules are
HOLODECK's (liberal aliases + training). The building verbs:

```
connect <machine> to <machine>     → makeAggregate(A, B)   [legality table]
take it apart | disassemble        → disassemble(newest aggregate)
run|feed the url|link|song         → feed the URL chip to the best target
                                      (aggregate first, else stemcutter)
```

Machine-name matching is substring-fuzzy: "stem"/"cut" → Stemcutter,
"tag" → Tagger, "libr" → Library, "amp" → Amp. Follow HOLODECK's
philosophy: unknown phrases suggest, taps train, twice-confirmed phrases
auto-execute. The training store is `holodeck.training.v1` — SHARE it,
don't fork it.

Planned v2 verbs (design before building; keep the grammar small):

```
build a pipeline from url to library   → chain every machine the type
                                          table allows, in one aggregate
watch downloads with <machine>         → rule-3 watcher install by voice
what does <machine> do                 → speak its intake/output
```

## Universal object interactions (Bill 2026-07-12)

Every desk object obeys the same three inspection gestures — new machines
and nouns MUST implement all three:

- **Hover** (350 ms) exposes the object temporarily: a peek popover of
  what's inside (folder: file list + metadata state; machine: intake →
  output; aggregate: its chain). Disappears on mouse-out or any press.
- **Double-click** opens for detailed examination and EDITING: folders
  open the REAL Finder on the song's directory via
  `POST /api/desktop/reveal {base}` (server-side `open`, restricted to
  STEMS via safeSongDir; unknown demo folders fall back to the STEMS
  root). Machines open their spec card (round three: the machine's own
  claude.md edits live there).
- **Right-click** lists the object's available actions: Quick Look,
  Edit in Finder…/Spec card, Audition, machine verbs (Run with URL, Take
  apart), then the USER-CREATED actions (starred), then "＋ Add action…".
  User actions persist per object-kind in localStorage `desk.actions.v1`;
  round three binds them to voice phrases and real scripts.

## The stage rig (Bill 2026-07-15)

The desk also illustrates the PERFORMER'S LIVE AUDIO ARCHITECTURE as
objects + animated signal wires (SVG `#wires` layer, z between zones and
objects, redrawn every 1 s and after drags):

```
MICS 🎤 + INSTRUMENTS 🎸 ──XLR──▶ XR18 🎚️ ──USB 18ch──▶ LOGIC PRO 🎹
                                   ▲                        │
THE AMP (portal stems, 18 USB ─────┘◀──── USB Logic mix ────┘
        returns)                   │
                                   ├──▶ MAIN L/R 🔊 (front of house)
                                   └──▶ AUX 1–6 📢 (six monitor wedges)
```

Wire kinds are color/animation coded: `analog` yellow (XLR), `usb`
green (faster dash flow), `outs` orange. Each wire is a quadratic
curve between object centers; wires that share endpoints in opposite
directions (the XR18↔Logic USB pair) carry a perpendicular `off`
value — NOTE: because the direction vector negates between A→B and
B→A, giving the pair OPPOSITE off signs makes the offsets coincide;
same-sign `off` values bow them apart. Rig objects obey all three
universal gestures; double-click on any of them opens X-AIR-Edit
(that's where inputs, the main bus, and AUX sends actually live).

## The Object Browser (Bill 2026-07-15)

Double-click GIG BINDER → `#objb`, the live-use hierarchy AS OBJECTS:
tree pane (Gigs → embedded setlists → songs → 🧩 sections + ⚡ timeline
actions; standalone setlists as a second root) + inspector pane
(selection reveals PROPERTIES, buttons execute real METHODS). Lazy
loading: gig expand hits `/api/gigs/:slug`, standalone setlist expand
hits `/api/setlists/:slug`, song expand hits `/api/song/:base/automation`
(init events filtered out; lyric-line events show with their text).
Library rows are fetched once into `obLib` for song properties.

Methods + properties (Bill 2026-07-15 round two): `obMethods(spec)` is
the SINGLE registry of an object's methods — the inspector's buttons and
the tree's RIGHT-CLICK menu both render from it (menu via `showCtxAt`,
the extracted reusable ctx renderer, z-index above the browser card).
Selection also fills `#objb-props`, a full-width bottom strip listing
ALL properties of the object (songs: the entire library row — lyrics,
stems, stats included), nulls as ∅, objects JSON-ified, values >160
chars clipped with click-to-expand. Never curate this list down —
"all properties" means all.

Real methods wired: gig → open GIGS/ in Finder; setlist → open source
playlist, `POST /api/precache/setlist/:slug`; song → reveal in Finder,
favorite toggle (PUT), open source video, open portal; action → “Fire
now” builds the same body as app.js `sendMidiNow` (port/type/channel +
pc program | cc controller/value) and POSTs `/api/midi/send`. Sections
are read-only here — they're edited on the portal's timeline lane.
GIGS/-in-Finder stays reachable from the gig inspector button.

## Remembered layout (Bill 2026-07-15)

Machine positions persist in localStorage `desk.layout.v1` as VIEWPORT
FRACTIONS (`{id: {fx, fy}}`) so a saved layout survives reloads AND
window resizes. `machineDef` applies the saved spot (clamped into the
viewport) at boot; a plain machine drag that lands on empty desk saves
on pointerup (drops that build an aggregate do NOT save — the original
hides). Dynamic nouns (folders, chips, aggregates) are intentionally
not persisted. Right-click any machine → "↺ Reset desk layout" (or
`__desk.resetLayout()`) wipes the store and reloads.

## Debug handle

`window.__desk = { makeAggregate, disassemble, voiceCommand, machines(),
aggregates(), resetLayout }` — drive the desk from the console or tests without
pointer theatrics.

## Self-improvement log (append, never rewrite)

- 2026-07-12 (first build): Chrome navigates on OS file drops unless
  dragover AND drop both preventDefault at window level — the Stemcutter
  looked broken until then. Synthetic DragEvent with a DataTransfer works
  for testing both the link and .webloc file paths; stub /api/enqueue in
  tests or you WILL queue a real render.
- 2026-07-12 (aggregates): keep stage machines' state on the AGGREGATE
  element (classList working/lid) — reusing the hidden originals' els
  breaks getBoundingClientRect for the chip flights.
- 2026-07-14 (real data): the desk boots from /api/library — the demo
  chip is a RANDOM REAL SONG, the Tagger card shows that song's actual
  bpm/key/singer/duration, and pasted URLs resolve their true title via
  GET /api/desktop/oembed (server-side YouTube oEmbed proxy, 5s bound).
  Songs not yet in the library show "still rendering" honestly. The
  LIBRARY is a cabinet with a real DRAWER (.lib-drawer) that slides open
  to accept a tagged folder and closes with a latch — shelving is now
  rule-2 containment you can SEE.
- 2026-07-14 (real-mouse gestures): the drag engine must NOT apply
  .dragging (pointer-events:none) on pointerDOWN — real mice fire
  down/up pairs for clicks and button-2 downs before contextmenu, and
  losing hit-testing retargets the rest of the gesture at <body>:
  dblclick resolved to body (handler bailed) and contextmenu skipped our
  preventDefault (browser menu appeared). Rules: ignore non-left buttons
  in the drag engine, and add .dragging only on the first MOVE.
  Synthetic element-targeted events mask this class of bug — simulate
  the full down/move/up/contextmenu sequence when testing gestures.
- 2026-07-12 (inspection layer): /api/desktop/reveal must spawn `open`
  with an ARG ARRAY (never a shell string) and clamp to safeSongDir —
  it's a shell-adjacent endpoint on the gig machine. The prototype has
  two dblclick listeners (legacy card + new reveal); consolidate when
  the desk graduates out of prototype.
- 2026-07-15 (stage rig): perpendicular wire offsets negate with wire
  direction — an A→B / B→A pair needs SAME-sign `off` values to bow
  apart, opposite signs silently overlap (labels collide into garble).
  Verified by reading the rendered <text> x/y attrs, not just the code.
- 2026-07-15 (reveal matcher): oEmbed titles carry noise — "(Official
  Music Video)" etc. — that poisoned resolveDeskFolder's 60% token
  threshold; the newest-30-min fallback then opened a DIFFERENT song's
  folder (Sharp Dressed Man → It_s_A_Long_Way). Fix: strip
  parentheticals + a NOISE word set before matching, and when a title
  is given but unmatched return the STEMS root honestly — never guess
  "newest" past a failed title match.
- 2026-07-15 (folder health tint): the desk folder's .art gets
  `folder-state-empty` (brown filter) while nothing is on disk and
  `folder-state-working` (yellow filter) until all six m4a stems are
  done; classes are toggled inside pollRealFolder from the same
  size-stable-between-polls "done" logic the worklog rows use.
- 2026-07-15 (XR18 MIDI link): the XR18 desk object is now a live MIDI
  connectivity instrument. `pollSlowInstruments` hits `/api/midi/health`
  (new server proxy → sidecar :5555/health, which now reports `inputs`
  as well as outputs): green drop-shadow `.midi-ok` when an XR18/X-AIR
  port is on the bus, red `.midi-miss` when the sidecar is up but the
  board isn't, dimmed `.midi-down` when the sidecar is unreachable.
  CLICK (press without move) selects the XR18 → live properties card
  (per-port list, XR18/Helix/IAC tagged, in+out verdicts, clock state,
  probe time). Right-click adds: Probe MIDI, Start clock 120 → XR18,
  Stop clock, Open X-AIR-Edit. Requires the SERVER restarted for the
  proxy and the MIDI sidecar restarted for the inputs field.
- 2026-07-15 (XR18 deep control): researched both control surfaces
  (docs/14_XR18_CONTROL.md). MIDI chart: PC1-64@ch1 = snapshots, CC@ch1
  = faders (31 = Main LR, 21-26 = the six wedges), ch2 = mutes, ch3 =
  pan, plus OSC-over-SysEx. OSC on UDP :10024: path with no args READS,
  with args WRITES; /xinfo broadcast discovers. midi_sidecar.py grew a
  dependency-free OSC client (encoder/decoder unit-tested, discovery
  cached 5 min, XR18_IP override, X32 piecewise fader<->dB). Endpoints
  /xr18/info|query|set proxied as /api/xr18/*. Desk card shows console
  identity + snapshot + Main LR + AUX 1-6; right-click gained recall
  snapshot (MIDI PC), set Main LR dB, mute/unmute Main LR (OSC, with
  readback). OSC needs the laptop ON THE XR18'S NETWORK — USB carries
  audio+MIDI only.
- 2026-07-15 (device rack + ambient dock): Helix Stadium (🏟️, MIDI ch1,
  snapshots CC69, looper CC52-62, presets CC32+PC) and Ditto X4 (🔁,
  ch4 fixed, L1 CC3/9/14, L2 CC22-24, all-stop CC29) are desk objects
  wired into the stage chain (instr→helix→ditto→xr18) with blue dashed
  MIDI control wires from the new 💻 MACBOOK object. Right-click =
  device methods over /api/midi/send; click = instrumentation card
  (live port verdict + CC map, docs/14_XR18_CONTROL.md holds the
  research). #dock is the AMBIENT PROPERTIES surface (Bill: "the area
  surrounding the desktop") — a bottom strip of always-on live panels
  (XR18/Helix/Ditto/sidecar/MacBook) rebuilt by renderDock() on every
  slow poll; clicking a panel opens the full card. XR18 OSC deep-probe
  refreshes into the dock every ~12 slow polls. Direction Bill set: the
  WHOLE desk should become objects — every action, every process, every
  physical device.
- 2026-07-15 (surround properties): the desk is now framed by live
  property surfaces. #rack (right column) holds the PHYSICAL devices —
  XR18 / Helix Stadium / Ditto X4 / Logic — each panel showing the FULL
  MIDI instrumentation map plus live values (XR18: OSC console, fw,
  snapshot, Main LR, per-AUX levels), with a GREEN border when the
  device is on the MIDI/OSC bus and red when not (same outline treatment
  on the desk objects themselves via .midi-ok/.midi-miss). #dock
  (bottom) covers the virtual components: MacBook, sidecar, Librarian
  daemons, Queue depth, Library+Catalog+Gigs. pollSurround() refreshes
  midi health + the XR18 OSC deep probe ONCE PER MINUTE (Bill's spec)
  and re-renders both surfaces; panels click through to the full cards.
  Default mains/wedges x moved 0.90→0.79 so the rack column doesn't
  cover them (saved layouts unaffected — drag + it persists).
- 2026-07-17 (daisy-chain diagnosis): TWO real-world lessons. (a) A
  boot-time call into a function that reads `let` state declared LATER
  in the script kills the WHOLE desk with a TDZ ReferenceError — and
  headless tests that pre-set globals MASK it. Declare shared state at
  the top; test boot order, not just functions. (b) Port-substring
  routing assumes each device has its own port; Bill's rig is a SERIAL
  DIN chain behind one "NUX B-8" interface, so the sidecar now falls
  back to chain_port() (env MIDI_CHAIN_PORT; auto skips virtual ports)
  and the desk says "CHAINED via <port>" rather than lying red.
  Channel map on the shared wire: XR18 ch1-3, Ditto ch4 (both fixed),
  Stadium configurable — desk channel for the Stadium lives in
  localStorage desk.helixMidiChannel (right-click → Desk MIDI
  channel…; recommend 5 after setting the Stadium global channel).
- 2026-07-17 (Logic Pro instrument): Logic's desk object now has real
  transport methods via `POST /api/desktop/logic-key` — osascript
  activates Logic Pro then System Events sends the keystroke. Server
  whitelist only: named actions (record/playstop/rtz/cycle/metronome/
  countin/undo/save), or single [a-z0-9] key / known key code + mods
  from {command,shift,option,control} — ARG ARRAYS to osascript, never
  a shell string, injection-tested. Desk right-click carries the
  built-ins plus USER-ADDED keys (localStorage desk.logicKeys.v1;
  "＋ Add Logic key…" parses specs like "cmd+shift+r" via
  parseLogicKeySpec — unit-tested). Click = instrumentation card.
  GOTCHA: System Events keystrokes need Accessibility permission for
  the node process, or they are silently swallowed — the card says so.
- 2026-07-17 (verdict unification + loop test): Bill caught the rack,
  dock, and peeks CONTRADICTING each other — three surfaces, three
  different "online" definitions (rack counted chain as ✓, dock was
  direct-only, peeks predated chaining, and the rack even showed Logic
  ONLINE via a DIN chain it isn't on). Rule going forward: ONE
  `midiVerdict(re, chainDevice)` is the only source of device MIDI
  state — states down/ok/chain/bad, rendered by verdictTag/verdictGlyph
  everywhere (rack, dock, peeks, cards, object outlines; chain = amber
  dashed, never green, until VERIFIED). Verification is real:
  GET /chain/test on the sidecar sends CC119 ch16 (nobody's channel)
  out the chain head and listens for the echo on the chain return input
  (the rig loops back to the Mac) — intact echo upgrades chained
  devices to "CHAINED ✓ loop-verified" green. Runs each pollSurround
  minute + on demand (XR18 right-click → Test DIN chain loop now).
- 2026-07-17 (MIDI Console): /midi-console.html is the topology + state
  + control surface (see docs/14). Sidecar grew /monitor — a daemon
  thread listening on ALL MIDI inputs with a filtered ring buffer and
  derived device state; that thread is THE read path for MIDI state.
  Console note/PC senders target port 'IAC' (Logic must have the IAC
  bus online); generic sends use port 'chain' to route out the chain
  head explicitly. Desk links: rack footer + sidecar dock panel.
