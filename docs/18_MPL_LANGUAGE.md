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
      ├─ group
      │  ├─ ( sequence )                         (grouping, plays once)
      │  └─ N ( sequence )                       (loop: N = 1-99, groups nest)
      ├─ call             @ 0-9                  (subroutine: inline slot N's program; N@d repeats it)
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

group       = [ count ] "(" sequence ")" ;
count       = int ;                            (* clamped 1-99 *)
call        = [ count ] "@" digit ;
inc-loop    = ( note-event | channel-set | program-change ) "..." count "(" sequence ")" ;
trajectory  = "..." ;                          (* when NOT followed by count "(" *)
```

## Semantics

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

## The bank as an instrument

Slots 0-9 each hold one program. Number keys toggle: first slot in
defines the bar grid (4 beats) and tempo and starts the MIDI clock;
later slots arm (⏳) and join at the next bar; the same key stops just
that slot; the last slot out stops the clock. Layers are free — drums
on `m10`, bass under `home -`, chords, and a lead can all loop at once.

## Worked examples

```
4(C,C#,D,D#,E,F,F#,G,G#,A,A#,B)      the original: chromatic scale ×4
m2,C...E                             C,D,E on channel 2
C...C+                               C major scale (white-key walk)
E,F,...,E+                           chromatic climb, half-step trajectory
p1...3(A,B,C)                        A,B,C under programs 1, 2, 3
2(A,D,,E),2@2                        riff ×2 (with a pause), then slot 2 ×2
(A,,,D,,,A,,,D,,,E,,,A,,,)           sparse figure — notes every 3rd beat
C!,,Am!,,F!,,G!w                     I-vi-IV-V, whole-note V
m10 F#2e,F#2e,As2e,F#2e              hats-and-snare figure on GM drums
p56 C,Ee,Ge,C+                       trumpet, mixed durations
```
