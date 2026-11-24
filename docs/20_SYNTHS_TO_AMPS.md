# 20 · Synths to the amps (V D B G P O)

Status: **decided 2026-11-12** — MIDI channels *are* the amps. MPL text
says the channel directly (Bill chose this over remapping at send time),
and every bank, library and pattern file was rewritten. Drums stay
hard-wired to GM channel 10 and play through the D amp; MIDI channel 12
is empty for now (Bill, same day).

## Channel = amp = XR18 output

The Performer sends stems to XR18 USB channels 11-16, one amp each. The
MIDI channel of a part is the same number, except drums:

| MIDI ch (MPL `m#`) | Amp | Stem | Logic track | Logic output |
|---|---|---|---|---|
| 11 | V | vocals | Lead ch11 | 11 |
| 10 | D | drums | Drums ch10 | 12 |
| 13 | B | bass | Bass ch13 | 13 |
| 14 | G | guitar | Guitar ch14 | 14 |
| 15 | P | piano / keys | Keys ch15 | 15 |
| 16 | O | other | Strings ch16 | 16 |

Old role channels were rewritten: 4 lead → 11 (guitar programs p24-31 →
14, keys p0-20 → 15), 2 bass → 13, 7 guitar → 14, 3 pad and 6 keys →
15, 8 strings and 9 FX → 16; drums stay on 10. Channel 12 carries no
notes; channel 5 stays the Helix.

**One sound per amp at a time.** A channel has one program: pad and keys
both on 15 play the same sound, and the last `p#` sent wins.

## Program changes (`p#`)

Logic's own instruments (Alchemy, Retro Synth, Drum Kit Designer …)
ignore incoming program changes. Each amp track instead hosts **Apple
DLSMusicDevice** (AU Instruments › Apple), a General MIDI synth: `p#`
picks one of the 128 GM sounds — the same list as the console's sound
palette wheel. Its sounds are basic; a better GM plug-in can replace it
later without changing any MPL.

GM synths play drums only on channel 10 — which is why drums stay on
channel 10: the drums track needs no channel tricks.

## Logic setup (Performer, once, then save as template)

1. Track › New Tracks › Software Instrument, Number 6, Create.
2. Name them as in the table.
3. Instrument slot → AU Instruments › Apple › DLSMusicDevice (each track).
4. Inspector › Track: MIDI Input = IAC Driver Bus 1, MIDI In Channel =
   the track's channel (10, 11, 13-16).
5. Output slot → Mono → Output 11 … 16 (or the pair starting there,
   panned hard left, if Mono is not offered).
6. Record-enable all six.
7. File › Save as Template… "Mark5 Gig".

Logic and the Performer both play into the XR18 at once — Core Audio
mixes the two apps, so a synth and a stem on the same amp simply add.

## What changes in Mark5

- MPL: parts say their amp with `m10` (drums), `m11`, `m13`-`m16`
  (docs/18 · Channels).
- MIDI console: row colours follow the table; drum features (metronome,
  count-in, drum wheel, kit names, octave buttons skip drums) use ch 10.
  Default channel ⌂11.
- AI prompt (server.js) teaches the 11-16 convention.
- Performer routing buttons (Split, Swirl, Flip) do **not** move Logic's
  audio — Logic writes to fixed outputs.

## Open questions

1. Should the Performer's per-amp faders also control the synths (needs
   Logic's audio to come into the Performer via BlackHole), or are
   Logic's track faders enough?
2. A better-sounding GM plug-in than DLSMusicDevice?
