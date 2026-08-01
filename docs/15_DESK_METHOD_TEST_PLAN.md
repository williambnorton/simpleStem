# Desk method test plan — every object, every method, expected proof

Date 2026-07-18. How to verify each method on the desk (and MIDI
Console). Every test has the same shape: fire the method → watch the
WIRE LOG (desk bottom panel / console bottom) for the →SENT line →
check the physical/UI result. Safety classes: **safe** (no state
change), **state** (changes device/app state, reversible), **loud**
(can affect live audio — never mid-song).

Status legend: ✅ verified by Claude in-browser · 🖐 needs Bill's hands
/ ears · ⏳ blocked on a known open item.

## 🎚️ XR18 (control = OSC; MIDI chart dormant in pass-thru)

| Method | Fire | Expected wire log | Expected result | Safety | Status |
|---|---|---|---|---|---|
| Probe MIDI / properties card | click object or rack panel | — | card: ports ✓, OSC LIVE, console name/fw/snap, AUX levels | safe | ✅ (live board: fw 1.25, snap #10) |
| Recall snapshot… | right-click → 📸 | →SENT OSC /-snap/load [n] + ←reply | board loads snapshot n; card refreshes | **state/loud** — recalls full mixer state | 🖐 pick a safe test snapshot |
| Set Main LR fader | console slider → set | →SENT OSC /lr/mix/fader + readback | fader moves in X-AIR-Edit; card dB updates | **loud** | 🖐 at low volume |
| Mute / Unmute Main LR | right-click / console | →SENT OSC /lr/mix/on [0/1] | FOH goes silent / returns | **loud** | 🖐 |
| "turn off all amps" must not turn them ON | say it with the amps already off | the RESET program (48 writes) | amps stay off — regression guard: the on-command is exact-match-only for exactly this reason | safe | ✅ verified against the real COMMANDS array + fuzzy fallback |
| Amp program: all on (Main L→1/3/5, R→2/4/6) | voice "all amps" · console · right-click | 48 × →SENT OSC /ch/{01,02,11-16}/mix/01-06/level, first 6 with readback in the wire log | Main L in aux 1/3/5, Main R in 2/4/6, no stem left in any wedge; desk ring tagged L/R | **loud** — opens the track into every monitor | 🖐 wedge amps down first, one wedge at a time |
| Amp program: split by stem | voice "split by stem" · console · right-click | 48 × →SENT OSC /ch/{01,02,11-16}/mix/01-06/level + readback | each wedge carries exactly one stem, vocals→1 … other→6; desk ring shows V D B G P O | **loud** | 🖐 one wedge at a time; confirm the wedge carries the stem the ring claims |
| Programs are mutually exclusive | all-on, then split-by-stem, then probe | 48 writes each time | after the switch NO stem send and NO Main L/R send is left over from the previous program | **loud** | ✅ verified against the fake board; 🖐 on hardware |
| Rotate one step | voice "rotate amps left" · console ↺ | 48 writes, verified | every stem moves one wedge counter-clockwise; ring letters follow | **loud** | 🖐 |
| Rotation entry with the board unreachable | pull the network, then play into a rotate region | first write, no reply | the amp-rotate-on event reports the failure — the rotation does NOT silently write into the void | safe | 🖐 |
| Continuous rotation on the timeline | drop Amp rotate START + STOP around the bridge, play it | 48 fire-and-forget writes per tick, NOT in the wire log | wedges shift on the beat you set; ring letters walk; settles at step 0 on STOP | **loud** | 🖐 the headline test — do it at rehearsal volume first |
| Rotation survives scrubbing | scrub backwards and forwards through a rotation region | writes only when the computed step changes | step is a pure function of song time, so the wedges match the playhead wherever you drop it — no drift, no resync | safe | ✅ verified (step asserted across seeks, two regions, both directions) |
| Rotation stops on pause | pause mid-rotation | no further writes | wedges hold their last step; resume continues from the right step | safe | 🖐 |
| Preflight catches a linked pair | link ch 1-2 with the Sends pref on, then run all-on | 48 writes all reading back correctly | preflight WARNS; and note the program still reports 48/48 verified while the board is really in reset — this is why preflight exists | safe | ✅ verified against a simulated linked board |
| Unknown program id | POST an id that isn't in the registry | nothing on the wire | 400 with the valid ids listed — never a partial wedge move | safe | ✅ |
| Two amp changes at once | double-click the console button, or a rotation tick during a verified program | one walk on the wire, then the other | the sidecar HTTP server is single-threaded so requests SERIALIZE (the 409 lock path is unreachable today); final state is whichever finished last, and a rotation tick recovers on its next step | safe | ✅ serialization confirmed by inspection; 🖐 confirm no audible gap |
| Probe amps state | right-click → 🔎 | 12 × →SENT reads, no writes | reports on / off / mixed / unknown; corrects a stale cached flag | safe | 🖐 |
| Snapshot recall while amps live | 📸 recall, then watch the AUX object | reads 1.2 s later | ring reconciles to whatever the snapshot actually left (likely `mixed` → amber) | **state/loud** | 🖐 |
| Test DIN chain loop | right-click → 🔄 | →SENT ch16 CC119 marker (+ ←HEARD if intact) | INTACT + ms, or BROKEN | safe | ✅ fires; loop currently **BROKEN** |
| Start/stop MIDI clock | right-click ⏱/⏹ | clock state in hub panel | Ditto/Stadium sync lights blink | safe | ✅ API; 🖐 device lights |
| Open X-AIR-Edit | dblclick or menu | — | app comes forward | safe | ✅ |

## 🔁 DITTO X4 (MIDI ch 4, write-only — wire log + pedal LEDs are the proof)

| Method | Fire | Expected wire log | Expected result | Safety | Status |
|---|---|---|---|---|---|
| L1 rec/dub/play | menu or console | →SENT ch4 CC3=127 · Ditto L1 rec/dub/play | pedal L1 LED red (rec) → cycle | state | ⏳ chain loop BROKEN — message can't reach the pedal yet |
| L1 stop / clear | menu | →SENT ch4 CC9 / CC14 | L1 stops / clears | state / **destructive to loops** | ⏳ same |
| L2 rec/stop/clear | menu | →SENT ch4 CC22/23/24 | L2 LEDs | state | ⏳ same |
| ALL stop / ALL clear | menu | →SENT ch4 CC29 / CC30 | both tracks stop/clear | **destructive** | ⏳ same |
| FX toggle | menu | →SENT ch4 CC31=127 | FX LED toggles | state | ⏳ same |
| Clock sync | start clock 120 | (clock not logged) | loop lengths quantize to tempo | safe | ⏳ same |

**Gate for this whole section:** the DIN loop test must pass first.
Segment isolation: (1) XR18 DIN OUT → return IN direct — retest;
(2) insert Ditto (OUT→IN, THRU→return) — retest; (3) insert Stadium
(THRU→IN, OUT→return, MIDI Thru ON) — retest. The failing insertion
names the culprit.

## 🏟️ HELIX STADIUM (desk channel 5 — set the Stadium's Global MIDI Channel to 5 first)

| Method | Fire | Expected wire log | Expected result | Safety | Status |
|---|---|---|---|---|---|
| Snapshot 1-4 / next | menu or console | →SENT ch5 CC69=0..3/8 · Stadium snapshot | Stadium switches snapshot on its screen | state | ⏳ chain loop |
| Preset PC | console pgm+send | →SENT ch5 PC n | preset changes | state | ⏳ chain loop |
| Looper rec/play/stop/clear | menu/console | →SENT ch5 CC58/59/52 | looper block responds | state | ⏳ chain loop |
| Tap tempo | menu | →SENT ch5 CC64=127 | tap light re-syncs | safe | ⏳ chain loop |
| Desk MIDI channel… | right-click | — | menu label updates "(now n)" | safe | ✅ |
| Open Stadium app | dblclick | — | app opens (patch install surface) | safe | ✅ opened |
| Stadium → Mac telemetry | change preset ON the pedal | ←HEARD PC/CC69 (needs Send MIDI PC on + return leg) | RX shows "Stadium preset recall" | safe | ⏳ return leg |

## 🎹 LOGIC PRO (IAC bus — REPAIRED 2026-07-18, online ✓)

| Method | Fire | Expected wire log | Expected result | Safety | Status |
|---|---|---|---|---|---|
| Note On/Off | console note send | →SENT IAC note_on 60 + IAC loopback ←HEARD | armed instrument track sounds | safe | ✅ sent+echoed; 🖐 ears |
| Program Change | console PC send | →SENT IAC PC n | PC arrives on armed track / mapped function | safe | 🖐 |
| Record (R) | menu ⏺ | — (AppleScript, not MIDI) | Logic starts recording | **state** | 🖐 needs Accessibility grant |
| Play/Stop, RTZ, Cycle, Metronome, Undo, Save | menu | — | transport responds | state | 🖐 same gate |
| ＋ Add Logic key… | menu | — | new ★ method persists | safe | ✅ parser unit-tested |
| Engineer state | click object / console | — | app RUNNING · IAC ✓ · clock | safe | ✅ |

## 💻 MACBOOK / 🛰 SIDECAR / pipeline objects

| Method | Fire | Expected | Safety | Status |
|---|---|---|---|---|
| Host status card | click MacBook | build V1.x, library, cache, queue | safe | ✅ |
| Flash Cache | menu 🧰 | cache progress in CACHE object | state (disk) | 🖐 when wanted |
| Stemcutter render | drop REAL .webloc | queue badge, worklog, folder tint brown→yellow→done | state (queues render) | ✅ prior sessions |
| Aggregate build / take apart | drag machine on machine / menu | lid animation; disassemble restores | safe | ✅ incl. no-arg fix |
| Object Browser | dblclick GIG BINDER | gigs→setlists→songs→sections/actions; methods fire | safe | ✅ |
| Librarian / Queue / Catalog / Sheet | dblclick + menus | portal tab / Finder / Sheet open | safe | ✅ |

## Standing test ritual (5 minutes, before any gig)

1. Desk loads with zero console errors; rack + dock + wire log present.
2. MIDI HUB: chain head + expected ports all listed.
3. XR18 rack panel: OSC LIVE with console name.
4. 🔄 DIN loop test → INTACT (once the cabling is fixed).
5. Logic: IAC ✓ + note 60 heard.
6. One Ditto command + one Stadium snapshot, confirmed on the devices.
7. `./performer.sh status` clean · cache N/N · queue drained.
