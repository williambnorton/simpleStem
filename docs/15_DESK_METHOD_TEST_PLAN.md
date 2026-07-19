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
