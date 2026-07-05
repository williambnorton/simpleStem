# Loop Overdub — record layers over a looping stem section

*Shipped 2026-07-05 (v1). The OVERDUB panel sits next to the LOOPER in the
player. It reproduces the Logic Pro loop-building ritual — drums loop, record
bass, loop plays from the top while guitar 1 joins, then guitar 2, then organ —
with stems as the seed and every kept take auto-saved.*

## One-time rig setup (BlackHole path — wet signal with your amp sims)

1. **Audio MIDI Setup → “+” → Create Aggregate Device.** Check the XR18 and
   BlackHole 2ch. Set 48 kHz. Enable Drift Correction on BlackHole. Name it
   `XR18+Loop`.
2. **Logic → Settings → Audio → Output Device = `XR18+Loop`.** Your existing
   Out 1–2 still lands on the XR18’s first pair — nothing audible changes.
   BlackHole appears as extra output channels.
3. **On every instrument channel strip in Logic: add a Send → a spare Bus
   (name it LOOP), pre-fader, unity.** Create one Aux with Input = that bus,
   Output = the BlackHole channel pair. Leave the sends up permanently.
   Do NOT put a LOOP send on click tracks or Logic-side backing.
4. In Chrome the capture device is **“BlackHole 2ch”** (starred in the
   OVERDUB input picker). Grant the mic permission once when prompted.

Why this topology wins: the performer monitors through the XR18 → amps as
always (zero added latency, nothing changes at the wedge), the loop bus
carries ONLY live instruments (the app’s stem playback goes Chrome → XR18
directly, so there is no bleed and no feedback path), and “what gets
recorded” is simply “whoever is playing during the take” — no per-take
configuration, ever.

## The workflow

1. **Load a song. Shape the seed.** Solo the drum stem (or any mix you want
   under the loop). Play, park the playhead inside the section you want.
2. **Engage LOOPER.** The section cycles seamlessly; the OVERDUB panel wakes
   up. If a saved session exists for this song + section, its layers load
   automatically and join at the next loop top.
3. **Pick the input** (★ BlackHole 2ch) — first click on the picker asks for
   mic permission and then lists devices. The level meter confirms signal.
4. **● REC.** The button blinks amber: *armed*. Recording punches in exactly
   at the next loop top — start playing on the downbeat.
5. **● REC again** when the pass feels done. Punch-out lands on the NEXT
   loop-top, so takes are always whole cycles (auto punch-out after 8
   cycles). The take immediately plays layered into the loop.
6. **✓ KEEP or ✗ DISCARD.** Keep = it becomes a layer chip (M mutes,
   ✕ deletes) and auto-saves in the background. Discard = gone, loop clean.
7. **Repeat** for the next instrument. Nobody touches Logic between takes.
8. **⟲ UNDO** removes the most recent layer — from the loop AND from disk.
9. **Disengage LOOPER** when done. Layers stop; the session stays on disk
   and reloads the next time you loop this section of this song.

## The latency trim

Recorded audio arrives slightly late (interface + BlackHole buffering). The
`latency` field (default 30 ms, remembered) shifts every take EARLIER by that
amount when it is placed on the grid. Calibrate once by ear: record a sparse,
percussive take against the drum stem, listen, nudge the number, re-take.
When a **TEST** take (see below) locks perfectly with the drums, your trim is
right. Typical values for this rig: 15–60 ms.

## TEST button — self-test without an instrument

TEST records a synthetic take: square-wave beeps generated ON the loop’s beat
grid, injected straight into the capture chain (silent to the speakers). It
exercises arming, punch quantization, slicing, save, and reload end-to-end.
After keeping a TEST take, the beeps should click exactly with the drum
stem — if they sit early or late, adjust the latency trim; that same trim
then applies to real takes.

## Where things live

```
STEMS/<song>/loops/<sessionId>/
  layer1_take1_<timestamp>.m4a     fast-start AAC, house format
  layer2_take2_<timestamp>.m4a
  loop.json                        manifest: section, bpm, layers, trims
```

Sessions are keyed by song + section. Every keep writes through the server
(local scratch → ffmpeg → Drive), so the Librarian mirrors them like all
other song data.

## v1 limits (documented, not bugs)

- Takes are whole loop cycles (that’s the point); max 8 cycles per take.
- One pending take at a time; keep or discard before re-arming.
- Layer names are auto (`take1`, `take2`, …).
- Don’t change SEMI/FINE mid-session — layers are recorded at the engaged
  rate and won’t re-stretch until you re-engage.
- The overdub panel requires the LOOPER to be engaged; disengaging stops all
  layers (they reload on the next engage).
- Capture is stereo; whatever Logic’s LOOP bus carries is what you get.

## Troubleshooting

- **Meter dead while playing** → wrong input selected, or Logic’s LOOP sends
  are down, or the aggregate device isn’t Logic’s output.
- **“CAPTURE ERROR — worklet died”** → press REC again; if it persists,
  reload the page.
- **Take audibly early/late** → latency trim (above).
- **No OVERDUB response** → the LOOPER isn’t engaged; loop a section first.
