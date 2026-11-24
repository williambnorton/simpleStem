# 19 · MPL Library

The MPL library stores MPL sequences as **sets**. A set is a program: an
entry point (`main`, or a `start` list for AI songs whose parts start
together) plus the named parts it calls with `@name` or launches with
`@name&`. Loading a set writes each part into the bank slot with that name,
or into an empty slot, so a set loads anywhere in the 36-slot bank.

## Where

`<Mark5 data root>/MPL_LIBRARY/<id>.mpl.json` — one file per set, next
to `STEMS/` (song scans never look here). Google Drive syncs it to the
Librarian. 🗑 moves a file to `MPL_LIBRARY/_trash/`; nothing is hard-deleted.

## In the MIDI console (📚 library row)

- **💾 Save selected slot** — saves the selected slot as `main`, plus every
  slot it reaches through `@` calls and `&` launches, with names, volumes
  and the current tempo. Unnamed slots are saved as `s<key>` (e.g. `s3`,
  `sB`) and the calls are rewritten to match. Saving under an existing
  set's name asks whether to replace it or keep a new copy.
- **⤵ Load** — writes the parts into the bank, restores their volumes, sets
  the tempo when nothing is playing, and selects `main` (Space plays it).
  For a `start` set, ▶▶ Start song plays the parts together.
- **AI results are saved automatically** with `created_by.kind = "ai"` and
  the prompt (chat text, or the song style/key/bars).

## File format

```json
{
  "format": "simplestem-mpl-set",
  "version": 1,
  "id": "ghost-hunt-20261111-091502",
  "name": "Ghost hunt",
  "description": "",
  "created_by": { "kind": "ai", "name": "Claude", "model": "", "via": "Claude Code CLI on the Performer" },
  "prompt": "make a sequence like ghostbusters",
  "ai_reply": "…what the AI said it made…",
  "created_at": "2026-11-11T17:15:02.000Z",
  "modified_at": "2026-11-11T17:15:02.000Z",
  "host": "performer",
  "tags": ["ai", "chat"],
  "key": "E",
  "bpm": 116,
  "main": "song",
  "parts": [
    { "name": "song", "src": "@bass&,4(@beat)", "vol": 100 },
    { "name": "bass", "src": "m13,p38,…", "vol": 80, "channel": 13 },
    { "name": "beat", "src": "m10,p0,…", "vol": 100, "channel": 10 }
  ]
}
```

| Field | Meaning |
|---|---|
| `created_by.kind` | `"user"` (with `name` = the Mac user) or `"ai"` (with `name`, `model`, `via`) |
| `prompt` | what the AI was asked; empty for user sets |
| `main` / `start` | entry point: one part Space plays, or parts started together |
| `parts[].name` | letter first, letters/digits/`_`, ≤ 48 chars (was 16 until 2026-11-15) — what `@name` calls |
| `parts[].src` | MPL text (grammar: 18_MPL_LANGUAGE.md) |
| `parts[].velocity` | the part's level as MIDI velocity 1–127: what a note at the default velocity (100) sends from it; 100 = fader at 75 % (on par). Wins over `vol` |
| `parts[].vol` | slot fader 0–100 % (older files; 75 = on par) |
| `parts[].channel` | first MIDI channel the part plays (informational; sets its colour) |

Updating a set keeps `created_by`, `prompt` and `created_at`, and adds
`modified_by` / `modified_at`. For your own metadata, use a `meta` object
(e.g. `"meta": { "style": "80s", "inspired_by": "…", "rating": 4 }`) or any
other top-level field: re-saves keep fields they don't know, and a `meta`
sent with a save is merged into the stored one.

## Bank files (`*.mpl-bank.json`)

A whole bank in one file — the easy way to hand sequences around (ask
Claude for "a bank file of …" and open it). In the MIDI console's 🗂 row:
**📂 Open…**, dropping the file anywhere on the page, or pasting its JSON
(⌘V) loads it at once: everything stops, the bank is replaced, each
sequence goes into its slot with its name, volume, the tempo and the song
name, and the main slot is selected so Space plays it. **↶ Undo replace**
puts the previous bank back. **💾 Save bank as file** downloads the
current bank in the same format. Open also accepts a library set or a
pattern file (their parts go into 0, 1, 2 …). A slot's optional `note` shows
as the tooltip on its name box. Examples ship in `bt-construction-kit/public/mpl-banks/`.

**Bank list (2026-11-14).** Every file named in
`bt-construction-kit/public/mpl-banks/index.json` (`"banks": [file names]`)
is a button in the list at the top left of the MPL BANK panel; a click loads
it exactly like 📂 Open…, and the loaded one is yellow. **A new bank file
must be added to `index.json` or it will not appear.** To the right of the
list is the bank's subroutine tree: rows nothing calls are the roots, with
the rows they call (`@name`) and launch (`@name&`) nested under them. Below
both is the 🤖 chatbot field (same request as the Shape-it box). The yellow
**RESET** button next to ⛔ KILL ALL stops everything and empties all 36
slots without asking (↶ Undo replace brings the bank back).
**The selected bank and its file are one thing (2026-11-14).** While a
bank from the list is selected (yellow), every change to it (sequence
text, names, volumes, tempo, song name, a channel or sound picked from a
chip) is written to its JSON file within a second, through
`PUT /api/mpl/banks/<file>` (existing bank files only, tmp + rename, local
disk in the code folder so it works with no internet). The line under the
list says which file is being written and when, or says in red that it was
NOT written. RESET, 🧹 Clear bank, 📂 Open, paste and drop leave no bank
selected, so they never empty or overwrite a bank file; ↶ Undo replace
selects the previous bank again. In a row, hover a channel or sound name
to see the coded `m#` / `p#`; click it for the list of alternatives.

`rock-blues-drums.mpl-bank.json` is the worked example of MPL features on
drums: fourteen grooves, each row three one-bar patterns in the form
A-B-A-B-C-A-B-A-B-B.

```json
{
  "format": "simplestem-mpl-bank",
  "version": 1,
  "name": "Synth-pop in D minor (original)",
  "description": "…",
  "created_by": { "kind": "ai", "name": "Claude" },
  "prompt": "…what was asked…",
  "bpm": 118,
  "key": "Dm",
  "song": "Synth-pop Sketch",
  "main": "0",
  "slots": [
    { "key": "0", "name": "sp_song", "src": "@sp_bass&,@sp_pad&,@sp_riff&,4(@sp_drums)" },
    { "key": "3", "name": "sp_hat", "src": "m10,8(F#2e)", "velocity": 70 }
  ]
}
```

`key` is the slot's key (`0`-`9`, `A`-`Z`); `velocity` (MIDI 1-127, 100 = on par) sets the row's level on load — the older `vol` (fader 0-100) still works; both are optional;
`main` (a key or a slot name) is selected after placing, so Space plays it.

## API (Performer server)

| Method | Path | |
|---|---|---|
| GET | `/api/mpl/library` | summaries of every set, newest first |
| GET | `/api/mpl/library/:id` | one full set |
| POST | `/api/mpl/library` | save (new id from name + time) or update (`id` given) |
| DELETE | `/api/mpl/library/:id` | move to `_trash/` |

The pattern menus (`mpl-patterns.json`, `mpl-library/*.json`) are separate:
read-only starter content shipped with the code.

## The song file: `<folder>_MPL.json` (2026-11-15)

One per song, beside its stems (`STEMS/<folder>/<folder>_MPL.json`), written by `drumscribe_all.py`.
It is a bank file (the console opens it with the bank file button) with three extra parts:

| Part | What it holds |
|---|---|
| `slots` | The playable rows. Row `0` `aid_<Title>` = the whole song's drums in one string. Rows `1`… `aid_<Title>_sN` = the drums of section N. Each row has `grade` (how closely it reproduces the hits detected in the drum stem) and, when named, `label` + `label_confidence`. |
| `sections` | The song, section by section: `section`, `t0`/`t1` (seconds in the recording), `bars`, `label` (Intro, Verse 2, Chorus 1 (part 1 of 2), Bridge, Solo, Interlude, Break, Outro, or Part A… when no singing was found), `kind`, `confidence` (high / medium / low), `why` (the reasons), `repeats` (the earlier section whose harmony it repeats) + `repeat_similarity`, `enters` / `drops` (stems that come in or drop out together on its first beat), `playing` (stems sounding), `singing`, `loudness_db`, and `stems`. |
| `sections[].stems` | One entry per stem — `vocals`, `drums`, `bass`, `guitar`, `piano`, `other` — with `channel`, `program`, `playing`, `src` (the MPL string, `null` until written), `row` (the slot that plays it, if any), `status` (`empty` / `measured`) and `grade`. Today only `drums` is filled. |
| `stems` | The song-wide default for each stem: `channel` (10 drums, 11 voice, 13 bass, 14 guitar, 15 keys, 16 other), `program` + `program_name` (a General MIDI starting point), `suggested: true` until measured. |
| `analysis.beat_t` | The recording's beat times in seconds (2026-11-17): `beat_t[k]` is where beat `k` of row `0` falls (`k` = 0 is the row's first note), plus one last entry for the end of the final beat. Steps inside a beat are spaced evenly between two entries. A player that follows these stays in step with the other stems; `analysis.bpm` is only the typical tempo, and a steady clock at that tempo drifts by a second or more over a song. |

A song has more section × stem sequences than the bank's 36 rows, so `sections` is the full model and
`slots` is the part loaded for playing. `drumscribe_all.py --upgrade` adds any missing per-stem places
to existing files and keeps what is already filled in. `<folder>_MPL.mid` carries the same sections as
Logic markers on a tempo map that follows the recording.

### MPL DRUMS in the Performer (2026-11-17)

The **MPL Drums** pill beside the Drum and Backing pills plays the song's whole-song row (row `0`) as
MIDI on the drum channel (m10 → IAC → Logic), on its own. The six stems go silent but stay loaded:
they are the song's clock, so play, pause, stop, beginning, the timeline, next section, loop, the
section looper and the speed dial all work unchanged and the drums follow. The beats are placed on
the recording's own beat times (`analysis.beat_t`); a file without them falls back to a steady
`analysis.bpm` from `analysis.first_bar_t`. Tempo marks (`94T`) in the string are skipped. The
row plays as written: the console's note map does not reach the Performer. Code: `public/mpl-drums.js`; the parser both pages share is
`public/mpl-core.js` (also where `MPL_MAX_NOTES`, 4096, lives).

**MPL on the Drum fader (2026-11-17).** The **MPL** button beside M and S on the Drums strip makes the
same row the drum track: only the drum stem goes silent (the strip's pre-fader gain is held at
zero, which covers the looper's buffers too) and the other five stems play on. The
transport drives it exactly as above; inside the section looper the follower reads the looper's own
audio clock, so the MPL wraps with the loop and the section's first hit lands on time. The Drum
fader, M and S act on the MPL through note velocity: 80% plays the velocities as written, lower is
softer, muted (or another strip soloed) is silence. The button and the pill are two uses of one MPL
and switch each other off; the button also lets go when the song changes or when the drum machine,
a backing track, a song source or a jam takes over the drum strip.

**D on the other five faders (2026-11-17).** On Vocals, Bass, Guitar, Piano and Other the **D**
button is no longer an audio route to the Drums amp: it sends the same drum sequence to that
strip's MIDI channel (m11, m13, m14, m15, m16) with the strip's program (`stems.<stem>.program` in
the song file), each drum played as a note of the song's key (`metadata.json` `key`; with none, the
console's current key, else C). The notes are chosen per strip from the key's root, third, fifth and
sixth (major) or seventh (minor), in the strip's register, so several strips together make a chord:
on Bass the bass drum is the root, the snare the fifth and the hi-hat the root an octave up. A line
in the console's NOTE MAP that points a drum at that strip's channel is used in place of the
automatic note (its step of the key and octave). A synth note is held for 85% of its step; a drum
stays a 90 ms tap. The strip's own stem keeps playing; its fader sets how hard the notes play (80% =
as written) and its M and S act on the stem only. Any number of D sends can run with or without the
MPL button or the pill; they let go when the song changes. Audio routes to the Drums amp that
presets make (All Amps, Split, Swirl) still work; they just have no button on those strips.

**MPL on every fader that has a part (2026-11-18).** A song file written by songscribe (version 2) holds a
part row per stem on its channel (m10 drums, m11 voice, m13 bass, m14 guitar, m15 piano, m16 other).
Beside M and S on the Vocals, Bass, Guitar, Piano and Other strips there is now an **MPL** button, shown
only when the song's MPL has a part on that strip's channel (a drums-only file shows just the Drum
fader's). Pressing it works like the Drum fader's MPL button: that stem's pre-fader gain is held at
zero (it keeps time) and the part plays in its place as MIDI on the strip's channel, in step with the
other stems, driven by the transport, the timeline, sections, the looper and the speed dial. The
program is the first `p#` in the part, else the song file's `stems.<stem>.program`. The strip's fader,
M and S set how hard it plays (80% = as written; muted, or another strip soloed, is silence), and a
note is held for 85% of its step. Several strips can play their parts together. **D** and **MPL** on
one strip are one thing at a time: pressing one lets go of the other. The buttons let go when the song
changes. The bass, voice, guitar, piano and other parts are sketches followed from the stems, not
transcriptions. `mplDrumsBuild` keeps the notes of every channel in `mplDrums.parts[strip]`; the
follower reads one list per part, each with its own place in the loop.

**MPL or MPL+ (2026-11-18).** The MPL button is shown on all six strips once the song has an MPL; where the
song's MPL has no part for a strip (Piano in most trial songs) it is dim and its tooltip says so. A click
makes the MPL replace the stem (stem silent, part plays); a second click goes back to the stem. **Hold the
button down (0.45 s) or Option-click it** and the stem keeps playing too: the button reads **MPL+** (blue)
and stem and MPL are heard together, still under the strip's fader, M and S. The hold stays latched after
the button is let go; the next click, with or without Option, turns the MPL off and leaves the stem. The
same rules apply to the Drum fader's button. State per strip is `'off' | 'replace' | 'both'`
(`mplStripMode`, `mplParts[strip]`, `mplDrumsStripBoth`).

**Click on the Drum fader (2026-11-17).** The click track now plays through the Drums strip (it was
the Other strip): the Drum fader, M, S and output routing set its level and where it goes. It joins
the strip at the fader, after the point where the MPL button silences the drum stem, so it still
sounds with the MPL as the drum track. The clock button has a twin beside M, S and MPL on the Drum
fader; both buttons do the same thing.

`drumscribe_all.py --beats [--copy <cache STEMS dir>]` adds `analysis.beat_t` to existing files and
changes nothing else; it re-measures the drum stem and skips (status `differs`) any file whose row
`0` no longer matches.

## The song file, version 2: a song you can read top-down (2026-11-17)

`songscribe.py` / `songscribe_all.py` rewrite `<folder>_MPL.json` (`"version": 2`) from all six stems.
The rows form four levels, each row short enough to read:

```
Back_in_Black=@intro,@intro2,@verse,@verse2,@chorus,...;     the song: its sections in order
verse=@verseA,@verseB;                                        a section: its phrases (4 bars each)
verseA=@verseADrums&,@verseABass&,@verseAGuitar&,4Rw;         a phrase: its parts started together, then its length in rests
verseADrums=m10,4e(|C,F#|,F#,|D,F#|,F#);                      a part: one stem on its channel
```

**At most 15 sections back to back (Bill 2026-11-17).** More than that are variations of fewer
sections, so: neighbouring detected sections of one kind are one stretch; a stretch is cut into 4-bar
phrases from its first beat and tiled with blocks of that kind's length (8 bars, doubled until the song
has 15 blocks or fewer; if kinds still alternate too often the shortest block joins a neighbour);
blocks of one kind and one length are one section row, played everywhere as the block among them that
fits them all best. Folding variations costs some grade: the rows are simpler than the recording.

Channels: m10 drums, m11 voice, m13 bass, m14 guitar, m15 piano, m16 other (no program changes are
written: the target is Logic with Drum Designer on 10 and Alchemy elsewhere). A section or phrase that
comes back is called again by the same name; a phrase is shared when it has the same length, the same
drums fit it, its harmony matches and the voice is in both or neither. Names are automatic
(`"auto_name": true`): sections by kind (intro, verse, verse2, chorus …), phrases after the section
they first appear in (verseA, verseB), parts by stem (verseADrums). Drums are measured as before; bass
and voice are followed one note at a time and guitar, piano and other as one chord per beat — sketches,
not graded. `grade` (song, section, phrase, drum part) is the A-F fit of the drum rows to the hits found
in the drum stem: A 90%+, B 80-90, C 70-80, D 60-70, F below. `text` holds the same rows as `name=MPL;`
lines; `sections` lists the sections in time order with the row each plays; `analysis.beat_t` is
unchanged. Rows past the 36 keyed ones carry no `key`. `check_song.js <mpl-core.js> <files>` parses
every row with the real parser and checks every length.

**Register of each part (2026-11-18).** Every note is relative to MPL's C = MIDI 36, the bass drum: a bare
note is MIDI 36-47, `+` one octave up, `-` one down, and the octave marks in a group (`2e-(...)`) shift
every note inside it; the parts are written so that the played pitch is the stated one. Bass is written
**one octave above where the bass was recorded** (`BASS_UP` in `songscribe.py`, 1; `SONGSCRIBE_BASS_UP=2`
raises it again, and re-running the catalog applies it): a bass guitar's open E is MIDI 28, which a
synth plays too low to hear, so it is written at E (40). Across the catalog the lowest bass note of a
song is E (40) in the median song and the bass sits around C+ (48), the register this document gives
the bass. Voice is written where it is sung (median about G+ to C++, MIDI 55-72); guitar chords are
rooted in MIDI 36-47 (`CHORD_OCT` 0), piano and other one octave higher (48-59). The tiling loop that
folds a song to at most 15 sections now stops when no kind can be made longer; before that, 19 songs
with many short runs of different kinds never finished.

**In the MIDI console.** The left list starts with **SONGS**: every song as `Title = @intro,@verse…`
with its drum grade, sortable by grade (best or worst first) or title, with a find box
(`GET /api/mpl/songs`, read from the `~/.bt-cache` copies). Clicking one opens it in the song pane.
Every row that calls other rows hides them until its ▸ is pressed (Option-click opens everything under
it), for songs and bank files alike. The bank now has 180 rows: 0-9 and A-Z keep their keys, the rest
are `r37` … and exist for song files. A song opened from the list is a copy in the browser; changes are
not written back to the song's file. Version 1 files still open and are marked "not re-processed yet".

**In the Performer.** `mpl-drums.js` walks the calls and launches from row 0 and gathers the drum-channel
notes, so the MPL button, the pill and the D sends play version 2 files exactly as the rows are graded.

## Headings above the bank list, and Mute / Solo on rows (2026-11-18)

The MIDI console's bank list is shown under three headings: **Archive**, **Experimental** and **Active**.
They are presentation only: no file is moved. A bank's first heading comes from `"classes"` in
`mpl-banks/index.json` (default `archive`; `active.mpl-bank.json` is `active`); the line under the headings
is no longer used: every bank and every song has a ⋮ that moves it to another heading, and each heading
has a ⋮ that moves everything under it (2026-11-18). Those choices, like the heading that is open, are kept
in the browser (`console.mplBankClass.v1`, keyed by bank file name or `song:<folder>`;
`console.mplBankClassShow.v1`). Songs start under Archive.
`active.mpl-bank.json` ("Active") is the bank for experimenting: it starts empty, and an empty bank file
takes the bank on screen when it is selected instead of wiping it; from then on changes are written to it.

Every row has **M** and **S** right of its play buttons. Mute silences the row's notes and the notes of
everything it calls or starts, wherever they play, while it keeps running; Solo lets only the soloed rows
and what is under them be heard. Both act as each note goes out and are cleared when another bank is loaded.

## Active Workbench, channel test, describe box (2026-11-18)

The **Active** heading is now **Active Workbench** and its bank (`active.mpl-bank.json`) carries the same name.
**🧹 Clear the Active Workbench** (under that heading) empties the bank on screen and in its file and selects
it; ↶ Undo replace brings back what was on screen. **🔊 channel test** (beside count-in) plays, for each amp in
turn, middle C as MIDI on its channel and then its name through its own audio output: Voice m11 / output 11,
Drums m10 / 12, Bass m13 / 13, Guitar m14 / 14, Piano m15 / 15, Other m16 / 16. The words are
`public/channel-test/*.wav` (synthesized speech); with an output device of fewer than 16 channels they come
out of the stereo pair. `channel-test.mpl-bank.json` holds the MIDI half as an MPL row
(`m11,C++,R,m10,C++,R,…`). The chatbot field is now a two-line **describe** box directly above the bank
list and song pane: say what sequences you want, Return sends it (Shift+Return = new line).


## Half notes, and the BUILD A SONG panel (2026-11-19)

**`h` is a half note** (2 beats): `w h q e s` are the duration letters, anywhere `w q e s` were allowed
(`Ch`, `Rh`, `|C,F#|h`, `2h(C,E)` as a group default, and the Defaults row's `dur` pick). It is
parsed in `mpl-core.js`, so the console, the Performer's MPL engine and `check_song.js` all accept it.

The **🏗 BUILD A SONG** panel sits above the bank and puts the construction workflow in one place:

1. **Pick an instrument.** One icon per category: the 16 General MIDI families (Piano, Chromatic, Organ,
   Guitar, Bass, Strings, Ensemble, Brass, Reed, Pipe, Synth Lead, Synth Pad, Synth FX, Ethnic,
   Percussive, Sound FX) and the **Drum kits** (m10). Click a category, then a sound: you hear it on its
   channel and `m#,p#` are written at the start of the selected row (an `m#`/`p#` already there is replaced; a
   tempo or controller token in front is kept; the notes are untouched). The channel is automatic
   (piano m15, guitar m14, bass m13, synth lead m11, drum kits m10, everything else m16) and can be
   overridden with the channel pick. The tap-record fields (`ch`, `p`) follow the pick, so ⏺ Record uses it.
2. **Play / record.** ▶ ⏹ Play row (Space does the same) and ⏺ Record (the tap recorder).
3. **➕ Next empty row** selects the next empty row for another instrument.
4. **📸 Capture playing → section** (the existing capture): the playing rows become a named section row
   such as `<Song>Intro = @introDrumsV&@introBassV&`.
5. The song is a row that calls the sections in order: `@Intro,@Verse,@Chorus` (slot 0 / `main` is the entry).

Logic's own instruments ignore program changes, so the palette is the General MIDI sound set (what
DLSMusicDevice and other GM synths answer to) plus the drum kits.

## Dotted notes (2026-11-19)

A **`.` after the duration letter dots the note: 1.5 times as long.** `Ce.` is a dotted eighth (0.75 beat),
`Cq.` 1.5, `Ch.` 3, `Rh.` and `-e.` are dotted rests, `|C,F#|e.` a dotted stack. A dot with no letter
dots the current default (`C.` = a dotted quarter when the default is `q`). `e.(…)` makes the dotted
eighth the default length inside a group; a note's own letter still wins (`e.(C,D,Es)` = 0.75, 0.75,
0.25). One dot only: `Ce..` is an error, and a dot followed by another dot is never a dotted note, so the
range `C..3(` and loop `C...3(` operators still work. A dotted eighth plus a sixteenth (`Ce.,Cs`) is
exactly one beat: the hard "dotted shuffle" feel.

Example, four measures of blues shuffle on the drums (kick on 1 and 3, snare on 2 and 4, hat on every dotted
eighth and sixteenth, a tom fill in bar 4):

    90T,m10,p0,3(e.(|C,F#|,F#s,|D,F#|,F#s,|C,F#|,F#s,|D,F#|,F#s)),e.(|C,F#|,F#s,|D,F#|,F#s,|C,F#|,F#s,D+,Bs)

## Program ranges: p0..127 (2026-11-19)

The `..` range now allows up to **999 steps** (a program range is still 0-127, so at most 128), so `m16,p0..127(C++e,E++e,G++e,E++e,C++h)` plays the same
bar under every General MIDI program in turn (128 bars). A program range must stay inside 0-127: `p0..128`
is an error that says so (it used to be clamped; the old cap was 99 steps). Program changes and controller
changes are also sent 3 ms ahead of the grid time, so they reach the synth before the note on the same
beat. Only a synth that answers program changes (DLSMusicDevice, AUMIDISynth) will change sound; Alchemy
and Logic's own instruments keep the patch loaded in them.

## Paste `name = MPL` definitions into a row (2026-11-19)

Paste text of the form `intro = m13,p33,C,E,G  verse = @intro,D  song = @intro,@verse` into an **empty row**
(its MPL box or its name box) and every `name = MPL` becomes a row: the left side is the row's name, the right
side its MPL. The first goes in the row pasted into (if it is open), each next one in the next open row after it.
Definitions can be separated by spaces, new lines or `;`. A name that is already a row updates that row (the old
text stays under that row's ↶). The row that plays the others (calls them, is not called itself) is selected,
so Space plays the song. It is all or nothing: if the bank has too few open rows nothing changes. A controller
such as `c74=40` is not read as a name. Text that does not begin with `name =`, or a paste into the middle of
existing text, pastes as usual.

## SYNC slider (2026-11-19)

A yellow **sync** slider sits above the ALL ROWS fader. It slides every MPL message earlier (−) or later (+) against the music, ±100 ms, 1 ms steps; 0 is the middle and a double-click resets it. It is added where the play time is stamped (`mplPostAt`), so notes, note-offs, program/controller changes and the count-in all move together and keep their spacing. It needs send-ahead (the sidecar scheduler); an early setting uses up part of the 180 ms `MPL_LEAD` headroom (worst case 80 ms left), which the timing meter's headroom line shows.

It is remembered per song name in the browser. A bank file's `"offset_ms"` wins when it has one, and the slider writes `offset_ms` into the picked bank file only after you move it for that song (so a rig-latency setting never leaks into every bank). A new song with nothing remembered leaves the slider where it is.

Why it exists: measured against the original drum stems, Don't You Want Me plays about 65 ms early while I Feel Love and Tainted Love are within 10 ms (see claude/simpleStem-drum-accuracy-round1.md in the project).

## The bank grows: filled rows plus two open ones (2026-11-20)

The bank no longer shows all 36 slots. The pane lists the rows in use (text or a name) in call-tree order and, below them, exactly two open rows, always: type or paste into either. Typing into an open row makes it used and two new open rows appear below within a quarter of a second.

An empty row left between used rows stays as a separator, one row per gap however many empty slots lie there. A row with only a name counts as used.

There is no fixed size. Rows 0-35 keep the keys 0-9 and A-Z; after Z a row is r37, r38 … (a key like `r250` works in a bank file's "key"). The page starts with 180 rows, or the size of the bank stored in the browser (in steps of 60), and adds rows when a bank file, a paste of `name = MPL` definitions, 📸 capture or ➕ next empty row needs more (`mplEnsureRows`, `mplReserve`). A sanity stop at 5000 rows. Verified with a 250-row bank (a high row plays, the bank survives a reload) and a 200-definition paste.

## Samples: `*name` plays an audio clip (2026-11-20)

`*name` in a sequence plays the audio clip `SAMPLES/<name>.<ext>` — `A,B,*airhorn,C,D`. It takes **no time** (like `p#` and `m#`): the clip rings for its own length while the sequence carries on, so C starts at the same instant as the clip. Write a rest after it (`*airhorn,R`) to leave room. Names are letters, digits and `_`, up to 64.

- **Where the files live**: `SAMPLES/` under the simpleStem root on Drive (next to `MPL_LIBRARY/`). One file per sample: .wav .mp3 .m4a .aac .ogg .flac. The server keeps a local copy in `~/.bt-cache/SAMPLES`.
- **Drag and drop**: drop an audio file on a row. It is saved in `SAMPLES/` (the file name is cleaned to letters, digits and `_`; a different clip with a taken name gets `_2`; the same clip dropped again reuses its file) and `*name` goes into that row — at the cursor if the row is being edited, else at the end. Dropped anywhere else on the page it goes into the first open row.
- **Where it sounds**: the amp of the channel in effect, like the channel test — m11 voice (output 11), m10 drums (output 12), m13 bass, m14 guitar, m15 piano, m16 other. In stereo when the output device has fewer than 16 outputs or the channel has no amp. The audio is played by the console page itself (Web Audio), not by Logic.
- **Level, mute, solo**: follow the row faders and M / S like a note's velocity.
- **Timing**: scheduled on the audio clock for its grid time plus the SYNC offset. Clips are fetched and decoded when the bank is saved, so the first hit is on the beat.
- **Keys**: a row that holds only samples (`m13,*airhorn`) plays once per press of its key, at once (not on the next beat), and does not loop; press again to fire it again. A row with notes or rests as well loops like any row.
- **Stopping**: a stopped row drops the clips it has not started; KILL ALL silences every clip that is ringing.
- **Unknown name**: one warning toast; the rest of the sequence plays.
- Server: `GET /api/mpl/samples`, `POST /api/mpl/samples?name=<file>` (body = the audio), `GET /api/audio/sample/:file`. Restart the server once (⟳ reset) to get them.

Also: clicking the key in a row's first column starts / stops that row, the same as pressing the key.

## Copy to… and the Favorites bank (2026-11-20)

Every row has a **➜** button. It lists the bank files, **⭐ Favorites** first (the bank that is selected right now is left out). Choosing one copies the row, and every row it calls or launches, into that bank's file. The row stays where it is: this is a copy, not a move (Bill's choice).

In the other bank the copies arrive as new rows after the ones in use. A name that is already taken there by a different sequence gets `_2`, `_3` … and the calls inside the copied rows are rewritten to match. A row that is already there with the same name and the same text is not copied again, so copying two sections that share a part adds the part once. A called row with no name gets one (`seq` + its key) because a call needs a name in the other bank. The file is read fresh from the server just before it is written.

Favorites is `mpl-banks/favorites.mpl-bank.json`, shown under Active Workbench. Clicking it while it is empty does nothing (other empty bank files take over the bank on screen when clicked; Favorites does not).

The server now accepts bank files of up to 5000 rows (it refused more than 180, which the growing bank could exceed). That part needs a server restart.

## Kit-piece banks (2026-11-21)

`kitscribe.py` writes a song's MPL with the drums split into kit pieces. It reads the Logic Pro 13
kit-piece stems in the song folder (`STEMS/<song>/kick.m4a` and so on) and the song's own `<folder>_MPL.json`, keeps that file's
beat grid, sections, phrases and voice/bass/guitar/piano/other rows, and replaces each phrase's one
drum row with a row per piece: `<phrase>Kick` (C), `<phrase>Snare` (D), `<phrase>Hat` (F#),
`<phrase>Toms` (F, B, D+), `<phrase>Cym` (C#+ crash, D#+ where it rides) and `<phrase>Perc`
(tambourine F#+, hand clap D# or low conga E++, picked by how bright the stem is). All on m10.

    python3 kitscribe.py "<STEMS>/<song folder>" --out bt-construction-kit/public/mpl-banks/<name>-kit.mpl-bank.json

Each piece is measured from its own stem: hits found there, placed on the song's sixteenth-note
grid, written as the phrase's most common 1, 2 or 4 bar loop. A hit that lands with a much louder
hit in another piece's stem is treated as leakage and dropped. Grades say how closely a row
reproduces the hits in its stem everywhere the phrase is played; one-off fills and crashes do not
survive the loop, so toms and cymbals grade low. Hi-hats are all written closed.

The ten trial songs have banks named `<song>-kit.mpl-bank.json`, listed in `index.json`.

## Per-stem MPL and accuracy (2026-11-21)

`stemscribe.py` writes every Logic Pro 13 stem of a song as its own whole-song MPL file and records
how closely each follows the audio.

    python3 stemscribe.py "<STEMS>/<song folder>" --mpl <_MPL.json to read> --also <gig-cache copy to update too>

- `<stem>_MPL.json` in the song folder for kick, snare, hihat, toms, cymbals, percussion, vocals, bass, guitar,
  piano, other: a small bank whose first row plays the whole stem, every note where it was found (no
  loops), in rows of 16 bars. Drum pieces are on m10; vocals m11, bass m13, guitar m14, piano m15,
  other m16. A stem Logic found nothing in gets no file.
- `<folder>_MPL.json` gains a `logic13` block: `stems.<stem>.accuracy` (a percentage) and `letter`
  (A 90+, B 80–90, C 70–80, D 60–70, F below), `drums` (the six pieces pooled) and `grid_shift_ms`.
- Drum pieces: accuracy is the MPL's hits against the hits found in the stem, matched within 30 ms
  (F1). `energy_covered` is the share of the stem's energy that falls right after an MPL hit.
- Vocals and bass are one note at a time, guitar, piano and other one chord per beat. Their accuracy
  is the match, beat by beat, between the pitch classes the MPL plays and those heard in the stem.
  These are sketches; 60–80 % is usual.
- A low drum number usually means the part is not on the sixteenth-note grid (shuffled hats, swelling
  cymbals), not that hits were missed.

## INPUT ROUTING: MPL | STEM, and MPL strips (2026-11-23)

Under OUTPUT ROUTING and INSTRUMENT ROUTING in the Stem Mixer Console there is a third row, **INPUT ROUTING**, with two choices: **MPL** and **STEM** (`mplInput*` in `mpl-drums.js`).

- **MPL**: every strip whose MPL the song has plays it in place of its stem, the same as pressing the MPL button on each strip (drums on channel 10, the others on their own channels). A strip with no MPL part keeps its stem.
- **STEM**: every strip back on its stem; all the strips' MPL buttons go off.
- **When it switches.** Stopped: at once. Playing: on the downbeat of the next bar; the waiting choice has a blinking outline. A second click on it switches at once; a click on the other choice calls it off. With the section looper running the switch is at once.
  - To MPL: half a second before the downbeat the MPL joins beside the stems with its notes held back; on the downbeat the first notes sound and the stems go silent.
  - To STEM: no note from the downbeat on is sent, and the stems come back on the downbeat.
  - The stems' switch (and the kit pieces', with the drum stem) is set on the audio clock, so it does not depend on the page's timers.
- Neither is lit while the strips are mixed (some on MPL and some not, or an MPL+). MPL is greyed out when the song has no MPL or the six stems are not the source. The choice is not saved; a new song starts on STEM.

**MPL strips.** A strip that plays its MPL in place of its stem (through INPUT ROUTING or its own MPL button) becomes an MPL strip: purple outline, "MPL" before the fader value. The layout (ring of amp buttons, presets, M, S) stays.

- **Fader** = how hard that channel's notes play (80% = as written). It has its own value (`mplVol`, kept in the browser as `performer.mplVol.v1`), so the stem's level is where it was when the strip goes back to its stem. Moving it writes no stem level, no saved mixer state and no automation event. **M and S** are shared with the stem and work as before.
- **Under M and S: the controls of the sequence the strip is playing now** (`mpl-player.js`, "MPL controls on the faders"). They follow the song from sequence to sequence; while you type, the block stays on the one you are changing.
  - **⬇ ⬆** the sequence's notes an octave down / up (drum sequences are not shifted).
  - **◀ ▶** backwards / forwards. The lit one drops the sequence out at its next cycle; pressed again it comes back. The other turns it round at its next cycle.
  - **Text**: the sequence's MPL, to edit while it plays. A text that builds takes over at the sequence's next cycle; one that does not is shown in red and not used.
  - **what do you want here?** + 🤖: a request in words; the AI rewrites the sequence (`POST /api/mpl/ai`, `mode: "row"`), used only if it builds and keeps its length.
  - A sequence is shared by every place the song uses it. Nothing is written to the song file until **Save** in the MPL Player panel (● marks a changed sequence).
- **DRUM KIT row.** KIT is now ON by default (a KIT OFF saved before this change is not carried over). While the Drums strip is an MPL strip the row is shown for every song with a drum MPL, and its faders are MPL faders: each sets how hard that drum's notes of the drum sequence play (kick 35/36, snare 37/38/40, hi-hat 42/44/46, toms 41/43/45/47/48/50, cymbals 49/51/52/53/55/57/59, percussion = the rest), with its own value (`kit.mplVol`). M and S among the pieces are shared with the audio pieces. The Drums fader, M and S remain master.

**Song | Exact, scores, kit-piece MPL, LEDs and speakers (2026-11-23, second step).**

- **Two MPL versions per stem.** *Song* = the stem's part in the song MPL (sections and loops, editable). *Exact* = the stem's own transcription, `<stem>_MPL.json` from `stemscribe.py`: every note where it was found, no loops, scored against the stem's audio (the `logic13` block of the song MPL). The server hands a transcription out at `GET /api/song/:base/mpl/:stem` (gig-cache copy first, refreshed from Drive behind the reply).
- **Song | Exact** sits at the top of each MPL strip's control block (`mplSrc`, `mplSrcSet` in `mpl-drums.js`). Exact plays the transcription; nothing is editable there. For the Drums strip, Exact is the six kit pieces' transcriptions together. The choice stays from song to song; a song without a transcription plays Song.
- **MPL (%)**: each MPL button shows the score of what it plays. Exact: the transcription's accuracy (drum pieces: hits within 30 ms of the audio; pitched stems: pitch classes heard, beat by beat). Song: only the drum part has a score (the song MPL's drum grade); the other five song parts were never measured, so they show none.
- **DRUM KIT strips** now have the boost buttons (+5, +10, +20, +50 dB, one at a time, not saved) and an **MPL nn%** button: the piece's audio is swapped for its transcription (MIDI on channel 10); click again for the audio; hold the button or Option-click for both together (MPL+), which is the way to hear whether they line up. A piece with no transcription shows "MPL —". A piece on MPL has an MPL fader of its own. While a piece plays its transcription, the song MPL's drum part leaves that piece alone. INPUT ROUTING: STEM switches every piece back to audio.
- **Blue LED** beside the name of every strip that is sending MPL notes (six strips and kit pieces): lit for a moment on each note.
- **Speakers in MPL mode.** An MPL strip's sound is made in Logic, so its ring of amp buttons cannot move audio. Each lit button (blue) is instead a Logic track the strip's notes are sent to: V = MIDI 11, B = 13, G = 14, P = 15, O = 16, D = 10. The notes play with that track's instrument. A strip's own track is lit to begin with; click to add or remove. On the Drums strip the other five are the D sends (the drum sequence as notes of the song's key). Kit pieces have their own list (`kit.mplRoute`, D to begin with; another track gets the piece's hits as notes of the key). L and R have no track. The audio routing underneath is not changed.

## MPL Player panel in the Performer (2026-11-23)

`bt-construction-kit/public/mpl-player.js`. A small panel at the bottom left of the Performer, shown while the loaded song has an MPL file; click its title to fold or unfold it. It is the MIDI console's bank in miniature for the song that is playing: one line per row of the song's MPL (the song, its sections, their phrases, the parts), each with a button that carries the row's key (0-9, A-Z for the first 36 rows).

**Starting and stopping pieces.** Press a row's button, or its key while **⌨ Keys** is lit:

- A piece the song is playing drops out from its next cycle ("out from its next cycle", then "out"); pressed again it comes back at its next cycle. Everything a dropped row calls or starts is silent with it, so dropping a phrase or a section silences its parts.
- A part the song is playing while its strip still plays the stem ("stem playing"): the MPL takes over that strip, as the strip's own MPL button does.
- A piece the song is not playing loops on top, in time with the song, from the next bar ("looping on top"); pressed again it stops at the end of its cycle. Loops layer; they sound together with the stems, at the strip's fader level, and follow the strip's M and S.
- **Reset** stops every loop, brings every row back and clears M, S, backwards and the levels.
- **⌨ Keys**: while lit, 0-9 and A-Z belong to the rows and the Performer's own number and letter shortcuts are paused; Space still plays and pauses. Unlit, nothing changes for the Performer's shortcuts.

**Row buttons.** Each row also carries the MIDI console's row buttons:

- **⬇ ⬆** the row's own notes an octave down / up; drum notes and the rows it calls are left alone.
- **−\\ +\\** every note of the row 1/24 beat earlier / later.
- **🤖** opens the editor on the row with the Ask AI box ready. **🗑** clears the row to rests of the same length, so the song still lines up; pressed again (**↶**) its text comes back.
- **➜** copies the row, with the rows it calls, to the Favorites bank of the MIDI console (`PUT /api/mpl/banks/favorites.mpl-bank.json`).
- **Level** slider: the row's level and that of everything under it (75 = as written; double-click = 75).
- **◀ ▶** play the row backwards / forwards: the lit one stops it, the other turns it round at its next cycle.
- **M S** mute / solo the row and everything it calls or starts, at once.
- **≡** (in the editor) puts each sequence group of the row on its own line, or joins them again; it plays the same.

Octave, feel and 🗑 change the row's text, so they are saved with **Save** like any edit; level, direction, M and S are not saved and last until Reset or the next song.

**Edit** opens the editor for the selected row (click a row's name, or pick a strip to follow the row that strip is playing):

- **Row text.** Checked as you type; a text that does not build is shown in red and not used. A good one takes over at the row's next cycle ("new text next cycle"), or at once when the song is stopped or the row has no further cycle. A row whose length differs from the file's gets a warning, because it drifts against the other parts.
- **Step grid (drum parts).** Sixteen steps to the bar; click a step to add or remove a hit; the row is written as `m10,<repeats>s(...)`. Louder (`^`) and softer (`v`) marks are kept. "Loop" is the stretch the row repeats; choose a longer one to change a single bar. A row with timing marks or notes off the sixteenth grid is flagged: a click rewrites it as straight sixteenths.
- **Ask AI.** A request in words is sent with the row, its length, the song's key and tempo and the rows that play with it to `POST /api/mpl/ai` (`mode: "row"`, Claude Code on the Performer). The answer is used only if it builds and has the same length.
- **Undo, Revert row.** **Save** (in the bar) sends the changed rows to `PUT /api/song/:base/mpl`, which changes only those rows' `src` (and their `text` lines), marks them `edited_at`, writes Drive first and then the gig cache, and on the first save of a song keeps the file as it was in `<song>_MPL.orig.json`. Nothing is written until Save; unsaved changes are lost when another song is loaded (a toast says so). Which rows are out or looping is not saved: it lasts until Reset or the next song.

A row is shared by every phrase that calls it, so a change is heard everywhere the row is used. Grades, the `.mid` file and the per-stem MPL files still describe a row as it was measured.

Engine side (`mpl-drums.js`): `mplLive = { off, ov, mute, solo, vol, rev }` holds the rows dropped out, the loops on top, and the rows muted, soloed, turned in level or played backwards; `mplDrumsBuild` skips the notes of dropped rows (through launches and through the call path the parser leaves on in-line tokens), builds the loops into `overlays`, and returns `spans` (every pass of every row) and the bank; `mplDrumsRebuild(bank, soft)` builds again and, when soft, leaves the notes already on their way alone and continues every list after them, so a switch at a cycle boundary neither cuts nor doubles a note. The panel applies a waiting switch when the posted notes reach the boundary.
