# CLAUDE.md — the Sound Desktop's machine & voice-instrumentation grammar

Read this before touching the Sound Desktop (prototype:
`bt-construction-kit/public/desktop-proto.html`, design:
`docs/13_SOUND_DESKTOP.md`). This file is the contract for how machines,
aggregates, and voice-built instrumentation work — and where each run of
Claude should record what it learned.

## The desk's purpose (Bill 2026-07-18 — the north star)

The desk is a demonstration of **education–instrumentation–
illustration**: live data and active icons that represent the
underlying code, activities, and hardware. Every icon IS the real
thing; the instrumentation is the educator — always on, always showing
what it measures AND explaining what that means (tooltips, peeks, the
docs reader); the animation illustrates how the system works (wire
flows, chip flights, state tints). When adding anything to the desk,
ask: does it teach, does it measure, does it illustrate — with real
data? If not, it doesn't belong. The desk is a first-class VIEW next
to Performer and Librarian (brand toggle on every page), and the full
project documentation is readable in place via the 📚 DOCS object
(`/api/docs/list|get`, restricted to the repo's .md files).

## EAVFA — the named theme (Bill 2026-07-19)

The manifesto now has a name: **Educate-Animate-Visual-Flow-Action**.
Spec: docs/17_EAVFA_OBJECT_MODEL.md. The config layer implements it:
every configured object has an object-id, factory defaults satisfying
the FACTORY LAW (minimum functionality with zero customization), an
undo history walked by the ◀ DEFAULT/UNDO side of the back⟷forward
switch (left = behind/undo·n, right = forward/customize), a ⚗ test
apparatus per property that proves the value against the live system,
and ONE D/C indicator at three scales (icon badge → perimeter mini →
full editor with animated illustration + the object hierarchy tree).
Store desk.config.v2; API cfgGet/cfgSet/cfgBack/cfgSetCustom;
consumers MUST read cfgGet, never their own localStorage keys.

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
- 2026-07-18 (channel plan final + interactive topology): Helix channel
  answered definitively — NOT 4 (Ditto's fixed channel; CC9 collides
  with Stadium panel-button emulation on a shared wire). Map: ch 1-3
  reserved (XR18 chart), ch 4 Ditto, ch 5 Stadium global (6 bypass).
  Console topology nodes are now interactive: click highlights the
  device's panel, dblclick opens the real app; app opens now WAIT for
  `open`'s exit code and report "app not installed?" instead of failing
  silently (that silence read as "double-click does nothing").
- 2026-07-18 (desk surround round two): the WIRE LOG is now ON THE DESK
  — a wide dock panel polling /api/midi/monitor every 6 s, rendering
  →SENT/←HEARD with the same semantics decoder as the console
  (deskDecode; Stadium channel from desk.helixMidiChannel). The rack
  gained a 💻 MIDI HUB panel at top: chain head, clock, full output +
  input port lists with device marks — the XR18-card "live MIDI
  properties" without any clicking. Right-click on ANY rack/dock panel
  now bridges to the corresponding desk object's real method menu
  (bridgeCtx dispatches a synthetic contextmenu on the object's el so
  ONE menu builder serves every surface) — no more browser menu on the
  perimeter. Stemcutter's slot-machine emoji replaced with STEMCUT_ART:
  an inline SVG of a machine with one paper in the intake tray and six
  stem-colored sheets fanned in the out tray.
- 2026-07-18 (bug-hunt round, browser-driven): THIRD TDZ boot crash
  (chainLoop/deskMon declared mid-file, boot renderDock() ran first) —
  the lesson is now a RULE: every `let` the desk shares goes on the ONE
  state line at the top (`let libState … midiState, xr18Slow, chainLoop,
  deskMon`), and any new boot-time call must be checked against it.
  Other fixes: Stadium desk channel default unified to 5 everywhere
  (menu, prompt, object sub — decoder already assumed 5, menus sent
  ch1); disassemble() defaults to newest aggregate instead of throwing;
  MacBook card reads bootVersion; chain in/out candidates exclude
  '*virtual*' ports (Logic Pro Virtual Out was polluting loop-test
  listen list); console mixer-IP prefills from /health xr18_ip; XR18
  sub + rack panel say ctrl=OSC / chart-ignored so pass-thru can't
  mislead. Verified by driving Chrome: menus, bridges, cards, browser,
  aggregate make/unmake, wire log accumulating SENT+HEARD.
- 2026-07-18 (Logic repair + guard): enabled the IAC bus FOR Bill via
  computer use (Audio MIDI Setup > IAC Driver > Device is online — the
  box was unchecked; Bus 1 already existed). Ports appear WITHOUT a
  sidecar restart (names enumerated per call). Verified end-to-end:
  note 60 out IAC, loopback in the wire log, Logic node green. Guard
  added in get_output: IAC/Logic-bound sends NEVER chain-fallback (they
  were routing to the DIN chain when the bus was missing); they try
  'Logic Pro Virtual In' instead, else 404. Test plan for every desk
  method: docs/15_DESK_METHOD_TEST_PLAN.md — wire-log line + physical
  proof + safety class per method; Ditto/Stadium sections gated on the
  DIN loop test passing.
- 2026-07-18 (architecture doc + instrumentation tooltips): the full
  system map lives in docs/16_SYSTEM_ARCHITECTURE.md (mermaid diagram
  of both machines, Drive, pipeline, sidecar, OSC, DIN chain, IAC,
  Logic, PA; GUI description; acronym glossary — MIDI/CC/PC/DIN/PPQN/
  CoreMIDI/IAC/OSC/UDP/APIPA; instrumentation philosophy: verdicts +
  wire log + active probes = "is the system telling the truth"). Every
  rack panel, dock panel, and the wire log now carries a native title
  tooltip explaining WHAT that instrument shows and HOW it collects it;
  console topology nodes carry SVG <title> tooltips; console panels
  too. Desk objects keep their richer hover peeks — tooltips are for
  the PERIMETER instrumentation.
- 2026-07-18 (dock truthfulness): Bill unplugged the rig and the dock
  kept looking healthy — the panels had NO status borders (only the
  rack did) and their bodies are static CC maps that read as "fine".
  Fix: dock panels now carry the same on/chain/off border classes from
  the SAME midiVerdict source (off = red border + red header + explicit
  "UNREACHABLE" text), sidecar/robot panels get up/down states, and a
  failed /api/xr18/info fetch resets xr18Slow={ok:false} instead of
  leaving stale green OSC data. Rule: any surface showing device state
  MUST wear the verdict — a static instrument that can't go red is a
  lie waiting to happen. Verified live against the actually-disconnected
  rig (ports down to IAC + Logic Virtual only).
- 2026-07-18 (views + docs): Desk and MIDI Console joined the brand
  role toggle on Performer AND Librarian pages (Performer · Librarian ·
  Desk · MIDI); the desk hint bar links back and teaches the three
  gestures up front. 📚 DOCS object: click = in-desk reader (list from
  /api/docs/list, minimal md renderer — headers/bold/code/lists/fenced
  blocks/tables-as-pre), right-click = curated shortcuts (architecture,
  test plan, MIDI research), dblclick = reader + Finder. The educator
  manifesto is now the top section of this contract.
- 2026-07-19 (EAVFA v1): config layer shipped and browser-verified
  end-to-end (customize helix ch 5→6 propagated to sub/badge/decoder/
  menus; two ◀ presses walked history back to factory; stem editor
  shows the paper-in/six-stems-out/L-R-speakers illustration; 17-node
  hierarchy tree with live D/C chips, cross-linked editors). Objects
  configured so far: stemcutter (ro pipeline facts), helix (channel),
  xr18 (OSC ip pin, apply→POST /api/xr18/ip), clock (default bpm),
  wirelog (line count). Gotcha: keep CFG consts ABOVE the boot calls
  (same TDZ law as all desk state). Roadmap in the spec: HOLODECK
  config verbs, job futures with spoken ETA, the show layer (beat-grid
  driven sprites — Bill's dancing clowns), knowledge screens.
- 2026-07-19 (loop verified + screenshot review): the DIN chain went
  LOOP-VERIFIED (12 ms, echo on U2MIDI Pro) — Ditto/Stadium method
  testing unblocked. Bill's eye caught: Helix panel had no verdict tag
  (drawTopo painted xr/dt/lg tags but never hx-tag — when adding a
  panel, grep for the tag-paint line); wire-log tenths rendered '.10'
  (Math.round carry — use min(9,floor)); the log drowned in loop-test
  markers because desk + console each auto-test per minute — sidecar
  now caches /chain/test results 30 s (auto polls share; the manual
  'test now' buttons pass ?fresh=1). Field insight from the RX state:
  CC1/CC2 traffic on ch1 labeled 'XR18 faders' is actually the
  STADIUM'S EXP PEDALS — its Global MIDI channel is still 1; the chart
  labels only hold once it moves to 5.
- 2026-07-19 (Stadium SEND MSG pulldown): the Helix Stadium console
  panel gained a named-message pulldown — all 29 documented Stadium
  commands in 5 groups (Preset/Snapshots/Looper/Song·Transport/Tempo·
  Expression), each emitting the well-formed PC/CC on the Stadium
  channel with a will-log preview; parameterized messages (PC program,
  snapshot 1-8 with the 0-based CC69 mapping, song cue, EXP position)
  show a value field. HX_MSGS is the catalog — extend it there, never
  ad-hoc buttons. Verified live: tap-tempo send appeared in the wire
  log off the real chain.
- 2026-07-22 (drum-mode load wedge): Bill played Blowin' In the Wind
  (drum-machine song) — app died with 'hard timeout with zero loaded
  stems' + wedged UI. Root cause: engageDrumMachine/engageBackingTrack
  DELIBERATELY stop the six stems (their mode owns the audio), but the
  stem-buffering watchdog armed by loadSong doesn't know that — it saw
  zero loaded stems and failed the whole song. Fixes: (a) both engage
  paths cancel _bufferWatchCancel + hide the buffering box when they
  stop stems; (b) watchdog hard-timeout treats drumMachineActive ||
  backingTrackActive as SUCCESS ('alt-source'), never failure. The
  backing-pick 404 in the log was benign-by-design (no backing matched).
  Repro note: CDP-created automated tabs stall ALL media element loads
  (readyState 0 forever) even though fetch() to the same URLs is
  instant — do NOT chase media stalls seen only in automation tabs;
  verify on Bill's real session.
- 2026-07-22 (setlist live UI): .sls-row.playing = 3px bright green
  border + glow (the now-playing song pops in the sidebar). New
  .ss-tr-remain readout right of the setlist Next button: rest of the
  current song from the playhead + all following songs, mm:ss, ticked
  every 1 s by updateSetRemaining() (durations via mergedLibrary
  lookup). ACCEPT button removed — candidates still auto-seed songs
  with zero sections, and SAVE (saveAutomationForSong) persists
  sections + actions + lyrics + count-in together as it already did.
  Buffering watchdog patience: soft warn 1.5s→3s, hard fail 3s→8s
  (Bill saw loads failing that just needed one more second; partial
  loads already proceed at hard timeout). Verified live: border + 58:47
  countdown on the Heritage Plaza set.
- 2026-07-22 (RECENT SENDS): console panel remembering the last 5 MIDI
  messages (localStorage console.recentSends.v1, dedupe by content,
  newest first, survives reloads). Each row is a LIVING message: kind
  pulldown (PC/CC/Note/CC32+PC), port pulldown (chain + live ports),
  channel + per-kind value inputs, one 📤 SEND. The CC32+PC preset
  recall is ONE compound slot — one button, two messages 60 ms apart.
  Captures hook sendCC / hxMsgSend / mcSend / logicNote / logicPC at
  the SEMANTIC level (never inside send(), or compounds fragment).
  Resending re-records to the top. Verified live: capture, compound
  slot, kind edit, dedupe, reorder.
- 2026-07-22 (unified RECALL): Stadium panel's top row is now one
  pulldown — 128 presets (each sends the verified trio CC0=0 CC32=1
  PC n) + snapshots 1-8/next/prev (CC69) — one send button for either.
  RECENT SENDS gained the 'snap' kind (editable snapshot number,
  9=next 10=prev) and rows are single-line (nowrap, compact inputs,
  label moved to tooltip). Old saved compound slots resend as the trio
  automatically since resend logic owns the wire format, not the slot.
