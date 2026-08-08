# MPL — the MIDI Programming Language

Born 2026-07-26 on the MIDI Console; grown feature by feature at Bill's
dictation. MPL is a tiny textual language for quarter-note-grid MIDI
sequences, played over the IAC bus to Logic Pro (and, via `m#` channel
switches, to anything on the wire). Ten bank slots (0-9) on the MIDI
Console hold programs that loop polyphonically, bar-synced, with MIDI
clock broadcast while any slot runs.

## The syntax tree

```
program
└─ sequence
   └─ element*                     (comma / whitespace separated)
      ├─ note-event
      │  ├─ letter        A B C D E F G          (case-insensitive)
      │  ├─ accidental?   #
      │  ├─ octave?       0-9                    (absolute — F#2, B3; default 4: C = middle C = MIDI 60)
      │  ├─ oct-shift*    + | -                  (relative to center, stackable — B+, C#++, F#--)
      │  ├─ chord?        ! | m!                 (! = major triad, m! = minor triad, on the root)
      │  └─ duration?     w | q | e | s          (whole, quarter [default], eighth, sixteenth)
      ├─ rest
      │  ├─ R | -                                (standalone - only; attached - is an oct-shift)
      │  ├─ duration?     w | q | e | s
      │  └─ ,,                                   (each EXTRA comma = one quarter rest: A,,,D)
      ├─ channel-set      m 1-16                 (m2 → all following notes on ch 2)
      ├─ program-change   p 0-127                (p3 → send PC 3 on the current channel)
      ├─ control-change   c 0-127 = 0-127        (c69=2 → send CC69 value 2; zero time, like p#/m#.
      │                                           Added so MUSE can transcribe everything it hears)
      ├─ group
      │  ├─ ( sequence )                         (grouping, plays once)
      │  └─ N ( sequence )                       (loop: N = 1-99, groups nest)
      ├─ call             @ (0-9 | name)         (subroutine — runs and returns: inline the slot's
      │                                           program by number or its case-insensitive shorthand
      │                                           NAME (@1 ≡ @verse ≡ @Verse); N@x repeats it N times)
      ├─ launch           call &                  (fire-and-forget: start the called sequence as an
      │                                           independent voice and continue immediately —
      │                                           @1&@2&@3 starts three parts together; max 8 voices,
      │                                           voices die when their parent slot stops)
      ├─ exclusive        #+                      (a standalone run of #s marks the sequence's
      │                                           exclusivity group: starting a # sequence stops any
      │                                           running # sequence; ### only evicts other ###s.
      │                                           Note accidentals (C#) are untouched)
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
                                                    m2,C...E    = C,D,E · C...C+ = C major scale)
```

## EBNF

```ebnf
program     = sequence ;
sequence    = { element | "," } ;
element     = note-event | rest | channel-set | program-change
            | group | call | inc-loop | trajectory ;

note-event  = letter [ "#" ] [ digit ] { "+" | "-" } [ chord ] [ dur ] ;
letter      = "A".."G" | "a".."g" ;
chord       = "!" | "m!" ;
dur         = "w" | "q" | "e" | "s" ;

rest        = ( "R" | "-" ) [ dur ] ;          (* plus the empty-slot comma rule *)

channel-set = "m" int ;                        (* 1-16 *)
program-change = "p" int ;                     (* 0-127 *)
control-change = "c" int "=" int ;             (* controller 0-127 = value 0-127 *)

group       = [ count ] "(" sequence ")" ;
count       = int ;                            (* clamped 1-99 *)
call        = [ count ] "@" ( digit | name ) ;
name        = letter { letter | digit | "_" } ;  (* a slot's shorthand name, case-insensitive *)
launch      = call "&" ;
exclusive   = "#" { "#" } ;                       (* standalone only; C# stays a note *)
note-repeat = count ( note-event | rest ) ;
range-loop  = ( note-event | channel-set | program-change ) ".." int "(" sequence ")" ;
inc-loop    = ( note-event | channel-set | program-change ) "..." count "(" sequence ")" ;
trajectory  = "..." ;                          (* when NOT followed by count "(" *)
```

## Semantics

- **Defaults row** (console bank): bpm ⌂120 · start channel ⌂2 ·
  default octave ⌂4 (where a bare letter lands) · velocity ⌂100 ·
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
  starts on ch 2 by default (Logic interferes with PCs on ch 1; see
  doc 14's DLSMusicDevice notes for making PCs audible).
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

Slots 0-9 each hold one program. Number keys toggle: first slot in
defines the beat grid and tempo and starts the MIDI clock; later
slots arm (⏳) and join on the next quarter-note beat; the same key
stops just that slot; the last slot out stops the clock. Layers are free — drums
on `m10`, bass under `home -`, chords, and a lead can all loop at once.

## Worked examples

```
4(C,C#,D,D#,E,F,F#,G,G#,A,A#,B)      the original: chromatic scale ×4
m2,C...E                             C,D,E on channel 2
C...C+                               C major scale (white-key walk)
E,F,...,E+                           chromatic climb, half-step trajectory
p1...3(A,B,C)                        A,B,C under programs 1, 2, 3 (3 iterations)
F,P1..3(E,D,E,D)                     F, then E,D,E,D under programs 1→2→3 (range)
2(A,D,,E),2@2                        riff ×2 (with a pause), then slot 2 ×2
(A,,,D,,,A,,,D,,,E,,,A,,,)           sparse figure — notes every 3rd beat
C!,,Am!,,F!,,G!w                     I-vi-IV-V, whole-note V
m10 F#2e,F#2e,As2e,F#2e              hats-and-snare figure on GM drums
m10,2Ae,B                            two eighth-note As then a B on the drum channel
p56 C,Ee,Ge,C+                       trumpet, mixed durations
m5,p5,Ee,D,c69=2,C                   what MUSE heard on the wire, as MPL
@verse&@chorus&                      start two named parts together, return instantly
#,4@verse,4@chorus                   exclusive arrangement: starting it evicts other # slots
```
