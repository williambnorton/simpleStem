# The EAVFA object model — Educate · Animate · Visual · Flow · Action

Date 2026-07-19. This is the underlying theme of the entire desk,
named and made law. Every visual icon is a main control for regular
operation of a real object; measurement points are consistent across
every object; and the whole hierarchy honors one factory law.

## The five letters

- **Educate** — every surface explains itself (tooltips, peeks, the
  docs reader, the wire log's plain-English decoding).
- **Animate** — state changes are shown as motion (chip flights, wire
  flows, paper in/stems out, folder tints).
- **Visual** — the icon IS the interface; its color/graphic/animation
  auto-updates with the object's live state.
- **Flow** — objects compose into workflows graphically (drag machine
  onto machine) and verbally (HOLODECK).
- **Action** — every gesture does something REAL: real files, real
  MIDI, real OSC, real apps.

## Object anatomy (the contract every object must satisfy)

Every desk object carries:

1. **object-id** — unique across the system (`stemcutter`, `xr18`,
   `helix`, `clock`, `wirelog`, …). The id is the key into layout
   persistence, config storage, verdicts, and the hierarchy tree.
2. **Internal instrumentation** — measurement points exposed the same
   way everywhere: verdict (state), live values, wire-log traces.
3. **Methods exposed as APIs** — right-click menu items map 1:1 to
   HTTP endpoints (`/api/midi/send`, `/api/xr18/set`,
   `/api/desktop/logic-key`, …). The menu is the API made touchable.
4. **Properties with defaults and test apparatus** — every property
   has a factory default (⌂), and ships a ⚗ TEST that demonstrates the
   current value against the live system (send a tap-tempo probe on
   the candidate channel; probe /xinfo at the candidate IP; run the
   clock for 3 s; re-render the log).

## The factory law

**Across the entire hierarchy, every object has a factory default
configured to operate at minimum functionality given the resources
available.** A fresh browser, an empty localStorage, an untouched
config store: the desk must WORK — auto-discover the mixer, channel 5
for the Stadium, 120 bpm, 16 log lines, factory layout. Customization
is always optional and always reversible.

## The back ⟷ forward switch

Every configured object wears one switch, top of its config bank:

```
◀ DEFAULT / UNDO   |   CUSTOMIZE ▶
```

Left is metaphorically *behind*: each press steps one change back
through the object's history (previous, previous-previous, …n), ending
at factory defaults. Right is *forward*: it unlocks the inputs for
customization. The switch's color states: green D = factory, amber C =
customized — the same D/C chip everywhere the object appears.

## Three scales, one instrument

The same D/C instrumentation renders at three sizes and stays in sync:

1. **Icon badge** — a mini D/C chip pinned to the desk object itself.
2. **Perimeter mini** — the same chip inside the object's rack/dock
   panel (always visible, click = open the editor).
3. **Editor (double-size, editable)** — click any chip: a large view
   takes a chunk of screen with (a) the object's ANIMATED ILLUSTRATION
   (the Stemcutter's editor shows a paper strip feeding into the
   machine, six colored stems rolling out the tray, and L/R speaker
   circles pulsing on either side of the centered form), (b) the
   property bank — label · ⌂ default · current value · ⚗ test — and
   (c) the OBJECT HIERARCHY tree: the whole system as objects composed
   of objects, each configured node wearing its live D/C chip,
   clickable to jump between editors.

## The hierarchy

```
🌐 simpleStem SYSTEM
├─ 🤖 LIBRARIAN (Mac mini)
└─ 💻 PERFORMER (MacBook Pro)
   ├─ 🎛 portal :3000
   ├─ 🛰 midi_sidecar :5555 ── ⏱ clock
   ├─ ⚙ pipeline ── 🖨 stemcutter · 🗳 tagger · 🗄 library
   ├─ 🎸 stage rig ── 🎚 xr18 · 🔁 ditto (factory-locked) · 🏟 helix · 🎹 logic
   └─ 🖥 desk UI ── 📡 wirelog
```

The Ditto is the teaching example of *factory-locked*: channel 4 is
hardware-fixed, so its config would show read-only properties — the
tree still shows its D because a lock IS a default.

## The URL is the base object

Drag a URL from Chrome onto the desk: the drop BECOMES the object — a
URL chip with an object-id, a resolved title (oEmbed), and methods
(stem it, open source, feed to an aggregate). Everything else in the
system is this same idea at larger scale: the thing on screen is the
thing itself, with methods.

## The target experience (roadmap — the show layer)

The verbal/graphical workflow this all builds toward:

> **ME:** Drag the Chrome URL to the STEM QUEUE. I want to hear that
> one in surround when it's ready.
> **HOLODECK:** Starting stem — estimated completion in 8 minutes,
> around noon.
> **HOLODECK (later):** Message pending — stem complete. Ready to play
> Roundabout?
> *The desk dresses the stage: album art over the amps, one still
> musician per stem; side screens fill with how-to-play videos sorted
> by favorite teacher, the chord chart in the song's key, and the
> HOLODECK tutor advising on the desk itself.*
> **ME:** Put dancing clowns on either side and dance them to the beat.

Concrete steps toward it, in order: (1) HOLODECK verbs for the config
layer ("reset the stadium", "set the clock to one-forty"); (2) job
futures — enqueue returns an ETA and completion fires a spoken
notification + a Ready-to-play card; (3) the show layer — per-stem
character sprites over amp icons, beat-synced via the existing beat
grid (the dancing clowns are a beat-grid consumer, exactly like the
click track); (4) knowledge screens — YouTube lesson search + chord
render from the song's key metadata, both already in metadata.json.

## Implementation notes (v1, shipped 2026-07-19)

Store: `desk.config.v2` — per object `{values, history[≤20], custom}`.
API: `cfgGet/cfgSet/cfgBack/cfgSetCustom/cfgIsCustom`; `apply` hooks
push writes to the real system (the XR18 ip property POSTs
`/api/xr18/ip` on change). Consumers read the store live: Stadium
channel (menus, decoder, sub-label), clock default bpm, wire-log line
count. Migration: a legacy `desk.helixMidiChannel` is absorbed on
first boot. The editor is `showCfgEditor(id)`; the tree is
`MODEL_TREE`; illustrations are `cfgArt(id)`.
