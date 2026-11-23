# MPL — the MIDI Programming Language

Born 2026-07-26 on the MIDI Console; grown feature by feature at Bill's
dictation. MPL is a tiny textual language for quarter-note-grid MIDI
sequences, played over the IAC bus to Logic Pro (and, via `m#` channel
switches, to anything on the wire). 36 bank slots (keys 0-9 then A-Z)
on the MIDI Console hold programs that loop polyphonically, bar-synced,
with MIDI clock broadcast while any slot runs.

## The syntax tree

```
program
└─ sequence
   └─ element*                     (comma / whitespace separated)
      ├─ note-event
      │  ├─ letter        A B C D E F G          (CAPITALS only — case matters since 2026-11-11)
      │  ├─ accidental?   # | b                  (sharp or flat: F#2, Bb2, Ebe; Cb = B, E# = F)
      │  ├─ octave?       0-9                    (absolute — F#2, B3; default 2: C = MIDI 36, the bass drum; middle C = C4 = C++)
      │  ├─ oct-shift*    + | -                  (relative to center, stackable — B+, C#++, F#--)
      │  ├─ chord?        ! | m!                 (! = major triad, m! = minor triad, on the root)
      │  └─ duration?     (w | h | q | e | s) "."?   (whole, half, quarter [default], eighth, sixteenth; "." = dotted, 1.5 times as long)
      ├─ rest
      │  ├─ R | -                                (standalone - only; attached - is an oct-shift)
      │  ├─ duration?     w | q | e | s
      │  └─ ,,                                   (each EXTRA comma = one quarter rest: A,,,D)
      ├─ channel-set      m 1-16                 (m13 → all following notes on ch 13)
      ├─ program-change   p 0-127                (p3 → send PC 3 on the current channel)
      ├─ control-change   c 0-127 = 0-127        (c69=2 → send CC69 value 2; zero time, like p#/m#.
      │                                           Added so MUSE can transcribe everything it hears)
      ├─ group
      │  ├─ ( sequence )                         (grouping, plays once)
      │  ├─ N ( sequence )                       (loop: N = 1-99, groups nest)
      │  ├─ [N] dur( sequence )                  (group duration, 2026-11-14: e/q/s/w glued to the
      │  │                                        paren is the default length of every note, chord,
      │  │                                        rest and comma pause inside: 4e(E,F,G) = 4(Ee,Fe,Ge).
      │  │                                        A note's own letter wins; groups nest; called slots
      │  │                                        keep their own defaults. Order: count, dur, octave:
      │  │                                        2e-(C,E))
      │  └─ [N] +( sequence ) | -( sequence )    (octave group, 2026-11-11: 1-3 marks glued to the
      │                                           paren shift every note inside: -(C,E,G) = an octave
      │                                           down, ++(A) = two up, 2-(C,E) = loop it twice. Calls
      │                                           inside are shifted too; & launches are not. A rest
      │                                           before a group needs a comma: -,(C,E))
      ├─ call             @ (0-9 | name)         (subroutine — runs and returns: inline the slot's
      │                                           program by number or its case-insensitive shorthand
      │                                           NAME (@1 ≡ @verse ≡ @Verse); N@x repeats it N times)
      ├─ launch           call &                  (fire-and-forget: start the called sequence as an
      │                                           independent voice and continue immediately —
      │                                           @1&@2&@3 starts three parts together; max 24 voices,
      │                                           voices die when their parent slot stops; a slot
      │                                           of launches only — a section, @a&@b& — loops
      │                                           every pass of its longest launched part)
      ├─ exclusive        #+                      (a standalone run of #s marks the sequence's
      │                                           exclusivity group: starting a # sequence stops any
      │                                           running # sequence; ### only evicts other ###s.
      │                                           Note accidentals (C#) are untouched)
      ├─ tempo            88T                     (2026-11-15: sets the bank tempo to 88 bpm from here on,
      │                                           30T-300T. One tempo for the whole bank: it becomes the
      │                                           new default and every playing row follows it. Zero
      │                                           time. Capital T only. A row that should always play
      │                                           at its own speed starts m10,94T,…)
      ├─ stack            |C,F#|                  (2026-11-15: the notes between the bars sound TOGETHER on one
      │                                           step: kick + hat. Inside: notes with commas, each may take
      │                                           ^ or v (|C,Dvv,F#|). After the closing bar: an optional
      │                                           length letter and feel marks for the whole stack
      │                                           (|C,F#|e, |D,F#|s\\). A count repeats it: 2|C,F#|.
      │                                           A | glued to a note opens a stack; the straight-feel
      │                                           mark is still a | on its own (",|,") or after a note)
      ├─ dynamics         ^ ^^ ^^^ | v vv vvv   (2026-11-14, on a note or chord, this note only:
      │                                           ^ a little louder (40 % of the way to 127: 100→111),
      │                                           ^^ a lot (75 %: →120), ^^^ max (127); v a little
      │                                           softer ×0.8, vv a lot
      │                                           ×0.55, vvv max (×0.25, a ghost note). Applied after
      │                                           the row fader. After the duration, with or beside
      │                                           feel marks: Ee^, D--s\\v, A!^^. Not both ^ and v)
      ├─ feel             | · / · \\              (timing feel, 1 mark = 1/24 beat = one MIDI-clock
      │                                           tick. / leans AHEAD of the beat (pushing, upbeat),
      │                                           \\ lays BEHIND (bluesy pocket), | dead straight.
      │                                           Standalone = sticky mode for following notes;
      │                                           attached to a note (Ee/, E\\\\) = that note only.
      │                                           Stackable to ±4 ticks. The PLAYER applies the
      │                                           micro-timing; pass length stays grid-true so
      │                                           loops and bar-sync never drift)
      ├─ note-repeat      N note-event | N rest  (bare count, no parens: 2Ae = two eighth-note As,
      │                                           3R = three rests, 2C! = two chords)
      ├─ range-loop       token .. N ( sequence )
      │                                          (TWO dots: iterate the token's VALUE from its
      │                                           written value to N inclusive, body after each —
      │                                           p1..3(E,D) = body under programs 1,2,3;
      │                                           descending allowed (p5..3); works on m# and notes.
      │                                           ..N( always binds as a range end, never a N() loop)
      ├─ inc-loop         token ... N ( sequence )
      │                                          (the token before ... re-fires each iteration,
      │                                           value +1 each time — works on notes, chords, p#, m#:
      │                                           p1...3(A,B,C) = body under programs 1,2,3)
      └─ trajectory       ...                    (between notes:
                                                  two priors → continue their interval to the target
                                                    E,F,...,E+  = chromatic climb
                                                  one prior  → walk the natural/white-key scale
                                                    m13,C...E   = C,D,E · C...C+ = C major scale)
```

## EBNF

```ebnf
program     = sequence ;
sequence    = { element | "," } ;
element     = note-event | stack | rest | channel-set | program-change | tempo
            | group | call | inc-loop | trajectory ;

note-event  = letter [ "#" | "b" ] [ digit ] { "+" | "-" } [ chord ] [ dur ] ;
tempo       = int "T" ;                        (* 30-300 bpm, the bank's one tempo from here on *)
stack       = "|" stack-note { "," stack-note } "|" [ dur ] { "/" | "\\" | "|" } ;   (* notes sound together *)
stack-note  = letter [ "#" | "b" ] [ digit ] { "+" | "-" } [ dynamics ] ;
dynamics    = "^" [ "^" [ "^" ] ] | "v" [ "v" [ "v" ] ] ;   (* suffix after dur, mixes with feel marks *)
letter      = "A".."G" ;                       (* capitals only: lowercase never starts a note *)
chord       = "!" | "m!" ;
dur         = "w" | "q" | "e" | "s" ;

rest        = ( "R" | "-" ) [ dur ] ;          (* plus the empty-slot comma rule *)

channel-set = "m" int ;                        (* 1-16 *)
program-change = "p" int ;                     (* 0-127 *)
control-change = "c" int "=" int ;             (* controller 0-127 = value 0-127 *)

group       = [ count ] [ duration ] [ octave ] "(" sequence ")" ;   (* duration = default length inside *)
octave      = "+" [ "+" [ "+" ] ] | "-" [ "-" [ "-" ] ] ;   (* glued to "(": each mark = one octave *)
count       = int ;                            (* clamped 1-99 *)
call        = [ count ] "@" ( digit | name ) ;
name        = letter { letter | digit | "_" } ;  (* a slot's shorthand name, case-insensitive *)
launch      = call "&" ;
exclusive   = "#" { "#" } ;                       (* standalone only; C# stays a note *)
feel        = ( "|" | "/" | "\\" ) { "|" | "/" | "\\" } ;   (* sticky when standalone, per-note as suffix *)
note-repeat = count ( note-event | rest ) ;
range-loop  = ( note-event | channel-set | program-change ) ".." int "(" sequence ")" ;
inc-loop    = ( note-event | channel-set | program-change ) "..." count "(" sequence ")" ;
trajectory  = "..." ;                          (* when NOT followed by count "(" *)
```

## Semantics

- **Channels** (Bill 2026-11-12) — MIDI channels match the amps and the
  backing-track outputs 11-16, so a part's `m#` says which amp it plays
  through. Drums are hard-wired to GM channel 10 (their Logic track plays
  out of output 12, the D amp); MIDI channel 12 is empty for now:

  | ch | amp | role | colour | Logic track (XR18 output) |
  |---|---|---|---|---|
  | 11 | V | Lead | orange | Lead ch11 → out 11 |
  | 10 | D | Drums (GM drum notes; `p#` = kit) | brown | Drums ch10 → out 12 |
  | 13 | B | Bass | yellow | Bass ch13 → out 13 |
  | 14 | G | Guitar sounds | red | Guitar ch14 → out 14 |
  | 15 | P | Keys / organ / pad | green | Keys ch15 → out 15 |
  | 16 | O | Strings / brass / FX | light blue | Strings ch16 → out 16 |
  | 5 | — | Helix Stadium control — never notes | — | (Helix) |
  | 12 | — | empty for now | — | — |
  | 1-4, 6-9 | — | unused (the old role channels) | — | — |

  A channel plays one sound at a time: `p#` picks it (Logic plays them
  with DLSMusicDevice, doc 20), and the last `p#` sent on a channel wins —
  parts that share a channel share its sound. Bank slot colours, the AI
  and pattern files follow this table. (Until 2026-11-12 the channels were
  roles: 2 bass, 3 pad, 4 lead, 6 keys, 7 guitar, 8 strings, 9 FX, 10 drums;
  every bank and library was rewritten to this table.)
- **m#, p# and octave are optional** (Bill 2026-11-12) — a row without
  `m#` plays on the default channel from the Defaults row (⌂ 11); without
  `p#` it keeps whatever sound that channel has; a bare note (`A`, `C+`)
  lands in the default octave. Give a part its `m#`/`p#`/octave digit when
  it needs something other than the defaults — drums always say `m10`.
- **Starting sequences name their channel** (Bill 2026-11-14) — a row
  that nothing calls (a song, a section, a jam, a stand-alone part) starts
  with its `m#`: `m11,…`. The console puts the Defaults row's channel (⌂ 11)
  in front of one that has none when the bank is saved; click the channel
  name (mVoice, mDrum …) to change it. Subroutines usually carry no `m#`:
  they play on their caller's channel, and they may but usually do not
  change program.
- **Defaults first** (Bill 2026-11-14) — a bare note is in the bass drum's
  octave (C = MIDI 36), a quarter note, at 120 bpm unless it says otherwise, so write only what differs:
  `A,B,C+` not `Aq,Bq,C+q`. Never write `q` (the console drops it on save:
  `Cq` → `C`, `Rq` → `R`) except inside a group whose head sets another
  length. When a run of notes shares a length, put it on the group once:
  `A,B,4e(E,F,G,A,B,C+,D+,E+)` — the eight notes in the parens are eighths,
  the same as `Ee,Fe,Ge,…`.
- **C is the bass drum** (Bill 2026-11-14). Every note is written relative
  to the C that plays the bass drum: MIDI 36 (scientific C2; Logic labels
  it C1). On the drum channel the basic kit reads plainly — `C` bass drum,
  `C#` side stick, `D` snare, `D#` clap, `F#` closed hat, `G#` pedal hat,
  `A#` open hat, `F G A B C+ D+` toms, `C#+` crash, `D#+` ride, `F#+`
  tambourine, `G#+` cowbell. Pitched parts count from the same C: bass mostly
  sits at `C`–`C+`, middle C is `C++`, a lead around `C+++`. `C-` is one
  octave below the bass drum. To move a whole phrase use the octave group
  instead of marking every note: `++(C,E,G)` = middle-C arpeggio, and with a
  loop the count goes first, `4++(C,E,G)` (`-4(…)` would mean a rest, then
  `4(…)`). Every bank, pattern and library file was rewritten to this basis
  (same pitches). **Write octaves as + and -, never as digits**: a digit is
  still accepted as input and rewritten on save at the same pitch (`F#2`
  becomes `F#`, `C4` becomes `C++`), so banks and files only ever show
  marks. Older examples in this document that carry a
  digit predate the rule. To move a whole phrase use the octave group:
  `-(A,B)`; with a loop the count goes first, `4-(A,B)`. `-4(A,B)` means
  something else (a rest, then `4(A,B)`).
- **Case matters** (Bill 2026-11-11): CAPITAL `A`-`G` are notes;
  lowercase letters modify or command — `b` flat (`Bb2`, `Ebe`), `w h q e s`
  durations (`Ae` = eighth-note A), `m` channel, `p` program, `c` control
  change, `r`/`R` rest. A lowercase note letter (`c2`) is an error that
  says to write `C2`. Flats are new: `Bb` = A#, `Cb4` = B3, and `E#`/`B#`
  now work too (`B#3` = C4).
- **Slot 0 is the main program** (Bill 2026-11-11): entry 0 is the one
  to start — the root of the tree. Every other slot is a part it calls
  (`@name`) or launches (`@name&`). Bank files, library sets and song
  sections should put their entry point in slot 0.
- **Octave shift buttons** (⬇ / ⬆ on each bank row, 2026-11-11) rewrite
  the slot's own notes one octave: a bare note gains or loses one `-`/`+`
  (counted from the default octave, the bass drum's C; max five either way), a
  note with an octave digit changes the digit (`C3` → `C2`). Drum notes
  (ch 10) and notes inside @called slots are left alone.
- **Defaults row** (console bank): bpm ⌂120 · start channel ⌂11 ·
  default octave ⌂2 (where a bare letter lands: C = MIDI 36) · velocity ⌂100 ·
  default duration ⌂q · home shift ⌂0. All persisted; parser-level
  defaults (octave, duration) are read at play time.
- **Time.** The grid is quarter notes at the session tempo (bank tempo
  pulldown, ⌂ 120; the desk card uses the desk clock's bpm). Duration
  letters scale one grid slot: w=4 beats, q=1, e=½, s=¼. Notes gate at
  85% of their duration (note_off before the next slot).
- **Pitch.** Letter + accidental → semitone; octave digit is absolute
  (MIDI = 12×(oct+1) + semitone), then each +/- shifts ±12. The bank's
  **home** pulldown (++/+/0/-/--, ⌂ 0) adds a final global shift at play
  time, folded back into 0-127 preserving pitch class.
- **Chords.** `!` sounds root+4+7 (major), `m!` root+3+7 (minor), all in
  one duration slot. Chords ride incrementing loops (`C!...4(R)` climbs
  the triad by semitones) but are skipped as trajectory anchors.
- **Channel / program.** `m#` and `p#` take effect immediately, consume
  no time, and reset to the start channel at each loop repeat. The bank
  starts on ch 11 (V amp) by default. Logic's own instruments ignore
  PCs; the amp tracks use DLSMusicDevice so `p#` changes the sound (doc 20).
- **Calls.** `@N` inlines slot N's *current text* at parse time — edits
  to a called slot are picked up on the caller's next loop pass.
  Circular calls (self or mutual) and empty slots are parse errors.
- **Errors.** Every parse error names the offending character position
  or construct in plain English; nothing plays on a bad program.

## Design direction — MPL as a Unix for music (Bill 2026-08-07)

MPL deliberately follows Unix job-control instincts, and grows that way:

- **`&`** backgrounds a job (done). **`@`** is a subroutine call (done).
  **`#`** groups are mutually exclusive job classes (done).
- **Pipes / filters (planned):** a command-line-style composition where
  a filter takes MPL in and emits transformed MPL out — `@verse | swing`
  (push off-beats late), `| densify` (fill with sixteenths), `| passing`
  (insert passing tones between chord tones), `| humanize` (velocity +
  micro-timing). Filters compose; output lands in a companion slot so
  the original is never destroyed. Same contract as MUSE: text in,
  text out — so filters can be deterministic algorithms or model-backed.
- **Timeline insertion (planned):** find a special effect for a spot in
  a song's timeline and inject it there — as a timeline action or
  spliced into an MPL slot at the matching bar.
- **Performer analysis (planned):** MUSE already transcribes the wire;
  next is ANALYSIS of a performer playing along with a song — what they
  play against what the song is, extracting style (intervals, rhythmic
  feel, note choices over chords) to drive the filters and companions.

## MUSE — next-token and next-character prediction

The console's MPL fields carry ghost-text completions from MUSE, a
two-model predictor trained on a persisted corpus:

- **Corpus.** Every program you play (weight 1) plus every phrase
  OBSERVED on the hardware return path (weight 3 — the wire outvotes
  the keyboard). The harvester transcribes the full message stream:
  note_on/note_off pairs give real held durations (w/q/e/s), silences
  become rests, program changes become `p#`, control changes become
  `c#=v`, channel switches become `m#`. IAC loopback of our own
  playback is excluded — MUSE learns from the room, not itself.
- **Token model.** Order-2 Markov over MPL lexemes; continues a phrase
  token by token, paren-aware so every completion parses.
- **Character model.** Order-5 character Markov over the same corpus;
  finishes the token you are mid-way through typing, after which the
  token model continues.
- **UI.** Ghost text under the active slot, Tab accepts, Escape
  discards. The MUSE line in the tools column reports corpus size,
  how much came from the wire, and message counts heard.

Roadmap: swap `musePredict` for a server endpoint backed by a real
model (Claude, or a small transformer trained on MIDI corpora
transcoded to MPL) — the UI contract is just text in, tokens out.

Next (Bill 2026-08-07): **generated companions** — beneath each user
sequence, MUSE proposes derived slots: variations (rhythmic/harmonic
mutations of the pattern) and transition alternatives (fills that
bridge into another named slot). Each proposal is a normal MPL slot —
auditionable alone, layerable with the original via the polyphonic
bank and bar-sync, and callable/launchable (@name, name&) so two or
more can be tried together seamlessly. The # exclusivity groups make
A/B-ing alternatives one keypress.

## The bank as an instrument

Slots 0-9 and A-Z each hold one program. Their keys toggle: first slot in
defines the beat grid and tempo and starts the MIDI clock; later
slots arm (⏳) and join on the next quarter-note beat; the same key
stops just that slot; the last slot out stops the clock. Layers are free — drums
on `m10`, bass under `home -`, chords, and a lead can all loop at once.

## Worked examples

```
4(C,C#,D,D#,E,F,F#,G,G#,A,A#,B)      the original: chromatic scale ×4
m13,C...E                            C,D,E on channel 13 (bass amp)
C...C+                               C major scale (white-key walk)
E,F,...,E+                           chromatic climb, half-step trajectory
p1...3(A,B,C)                        A,B,C under programs 1, 2, 3 (3 iterations)
F,p1..3(E,D,E,D)                     F, then E,D,E,D under programs 1→2→3 (range)
2(A,D,,E),2@2                        riff ×2 (with a pause), then slot 2 ×2
(A,,,D,,,A,,,D,,,E,,,A,,,)           sparse figure — notes every 3rd beat
C!,,Am!,,F!,,G!w                     I-vi-IV-V, whole-note V
\\,C2,,G2,A#2e/,G2e                  laid-back bass, one pushed eighth
m10,F#2e,F#2e,A#2e,F#2e             closed, closed, open hat, closed on GM drums
m10,2Ae,B                            two eighth-note As then a B on the drum channel
p56 C,Ee,Ge,C+                       trumpet, mixed durations
m5,p5,Ee,D,c69=2,C                   what MUSE heard on the wire, as MPL
@verse&@chorus&                      start two named parts together, return instantly
#,4@verse,4@chorus                   exclusive arrangement: starting it evicts other # slots
```

## Limits (2026-11-17)

One string may expand to at most **4096 notes and rests** (`MPL_MAX_NOTES` in `public/mpl-core.js`; it was 2048)
and a bank row holds at most **4096 characters**. The bank has **180 rows**: 0-9 and A-Z have keys, rows past them are `r37` … `r180` (no key) and exist for song files. Line breaks are free: the ≡ button on a row puts each
sequence group on its own line and joins it back, and the row plays the same either way.

## Note map (console, 2026-11-17)

The console's **NOTE MAP** panel sends a drum to a synth as a note, without changing the MPL text.
A line reads `Bass Drum:C:E:m13`: when a bass drum (`C` on the drum channel, m10) is about to play,
send `E` on m13 instead. Each drum's line has a note, an octave and a channel. The note is kept as a
step above the current key's root (root, 2, 3 … 7, with the flats between), so changing **Key** moves
every mapped note at once, also while rows play; the synth wheel's Key slider sets the same key.
Only notes on the drum channel are looked up, in bank rows and the drum wheel alike; inside a stack
(`|C,F#|`) each note goes its own way. The map and the key are kept in the browser
(`console.mplNoteMap.v2`). It replaces the earlier drum-for-drum map.


## Samples (2026-11-20)

`*name` plays the audio clip `SAMPLES/<name>.<ext>` from the simpleStem root on Drive. EBNF: `sample = "*" , name ;` with `name` = 1-64 letters, digits or `_`. Zero time, like `p#`, `m#` and `c#=#`: `A,B,*airhorn,C,D` starts C at the same instant as the clip, which rings for its own length. It sounds from the amp of the channel in effect and follows the row faders, mute and solo. A row of only samples is a one-shot. Details: doc 19, "Samples".
