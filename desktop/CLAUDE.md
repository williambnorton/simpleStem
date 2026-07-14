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
- **Machine (verb)**: `{ id, art, label, accepts[], work }`. Machines are
  furniture; they move (and combine) only with ⌃control-drag.
- **Aggregate**: two machines latched into one, built by ⌃control-dragging
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

## Debug handle

`window.__desk = { makeAggregate, disassemble, voiceCommand, machines(),
aggregates() }` — drive the desk from the console or tests without
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
