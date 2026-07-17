# XR18 control — MIDI + OSC research and what simpleStem uses

Research date 2026-07-15. The XR18 exposes TWO control surfaces, and
simpleStem now uses both: **MIDI for writes that map cleanly to
messages** (snapshots, and the existing timeline automation), **OSC over
the network for reads and precise writes** (console identity, fader
values in dB, mute states, bus names).

## Surface 1 — MIDI (DIN ports or USB)

From the official Behringer *X AIR MIDI Implementation X18/XR18*
(30 June 2015):

| Channel | Message | Range | Controls |
|---|---|---|---|
| 1 | PC 1–64 | | Recall snapshots 1–64 (program byte 0–63 on the wire) |
| 1 | CC 0–15 | 0–127 | Input channel faders 1–16 |
| 1 | CC 16 | 0–127 | Aux line-in 17/18 fader |
| 1 | CC 17–20 | 0–127 | FX 1–4 return faders |
| 1 | CC 21–26 | 0–127 | **Aux sends / subgroups 1–6 — the six monitor wedges** |
| 1 | CC 27–30 | 0–127 | FX 1–4 send faders |
| 1 | CC 31 | 0–127 | **Main LR fader** |
| 1 | CC 32–35 | 0–127 | DCA 1–4 |
| 2 | (same CC map) | 0–127 | **Mutes** for all of the above; CC 36–39 = mute groups 1–4 |
| 3 | (same CC map) | 1–127 | Pan / balance; 64 = center |
| — | SysEx `F0 00 20 32 32 <ascii> F7` | ≤39 kB | **OSC strings tunneled over MIDI** |

Enable *DIN/USB Rx* on the console (Setup → MIDI) or none of this lands.

simpleStem path: the browser → `POST /api/midi/send` → `midi_sidecar.py`
(:5555) → mido → the "XR18" port. Snapshot recall from the desk uses
exactly this (PC ch 1). The song-timeline automation events already ride
the same wire.

## Surface 2 — OSC over UDP :10024

X AIR consoles answer OSC on UDP port 10024 (X32 uses 10023); replies
return to the sender's addr/port. Sending a parameter path with **no
arguments reads it**; with an argument **sets it**. Discovery: broadcast
`/xinfo` — the console answers with `[ip, name, model, firmware]`.

Paths simpleStem reads for the desk properties card:

- `/xinfo` — console identity (the connectivity proof)
- `/-snap/index`, `/-snap/name` — current snapshot
- `/lr/mix/fader` (float 0–1), `/lr/mix/on` (1 = open, 0 = muted)
- `/bus/1..6/config/name`, `/bus/1..6/mix/fader` — the wedge mixes

Other useful paths (same grammar, wired for later): `/ch/01..16/mix/
fader|on`, `/ch/NN/config/name`, `/ch/NN/mix/01..06/level` (per-wedge
sends), `/headamp/NN/gain|phantom`, `/xremote` (subscribe to change
events for 10 s), `/meters` (blob meter streams).

Fader float ↔ dB uses the standard X32/X AIR piecewise curve
(f ≥ 0.5 → 40f−30; ≥ 0.25 → 80f−50; ≥ 0.0625 → 160f−70; else 480f−90);
0.75 = 0 dB unity, 1.0 = +10 dB.

simpleStem path: `midi_sidecar.py` now carries a dependency-free OSC
client (hand-rolled encoder/decoder, UDP socket, `/xinfo` broadcast
discovery cached 5 min, `XR18_IP` env override). HTTP endpoints:
`GET /xr18/info` (deep probe), `GET /xr18/query?path=`,
`POST /xr18/set {path, value | db}` (write + readback). server.js
proxies these at `/api/xr18/info|query|set`.

## Desk methods shipped (right-click the XR18)

- 🔎 Probe MIDI (live properties) — the card: MIDI port verdicts both
  directions, then the OSC section: console name/model/fw/IP, current
  snapshot, Main LR dB + mute state, AUX 1–6 names + levels.
- 📸 Recall snapshot… — MIDI PC ch 1 (official recall path).
- 🎚 Set Main LR fader… — OSC `/lr/mix/fader` from a dB prompt, with
  readback confirmation.
- 🔇 / 🔊 Mute / Unmute Main LR — OSC `/lr/mix/on` 0/1.
- ⏱/⏹ MIDI clock start/stop (24 ppqn from the sidecar).
- 🎛 Open X-AIR-Edit.

Requires: laptop on the same network as the XR18 for OSC (the USB cable
carries audio + MIDI, NOT OSC), *DIN/USB Rx* enabled for MIDI control.

## Sources

- Behringer, *X AIR MIDI Implementation X18/XR18* (official chart)
- Behringer *X AIR OSC documentation* + `behringer.world` X AIR OSC wiki
- Patrick-Gilles Maillot's unofficial X32 OSC protocol (fader curve)
- `xair-api-python` (onyx-and-iris) — parameter tree confirmation

---

# Companion devices on the same MIDI wire (research 2026-07-15)

## Line 6 Helix Stadium (official manual, Rev D v1.3)

Global MIDI channel 1 (bypass/ctrl on channel 2). DIN + USB-C MIDI,
clock send/receive. Global CC map used by the desk:

- Preset recall: CC32 (setlist/bank) + PC 0-127; Stadium auto-transmits
  PC on preset change (Global Settings > MIDI > Send MIDI PC).
- Snapshots: CC69 val 0-7 (8 = next, 9 = previous).
- Looper: CC58 rec(64-127)/overdub(0-63) · CC59 play(64-127)/stop(0-63)
  · CC60 play once · CC52 clear · CC53 undo/redo · CC54 half-speed ·
  CC55 reverse · CC62 looper block on/off.
- Transport (Song view): CC63 playlist · CC10 song cue · CC46 marker ·
  CC47 return-to-zero · CC49 prev/next song · CC51 play/pause.
- Expression/knobs: CC1/CC2 EXP · CC36 toe switch · CC38-45 knobs 1-8 ·
  CC64 tap tempo · CC9 panel-button emulation.

## TC Electronic Ditto X4 (community-verified chart; needs the MIDI-CC
firmware update; DIN In/Thru only)

MIDI channel 4 (fixed). Receives MIDI clock — loop lengths lock to
tempo (pairs with the sidecar's 24-ppqn clock).

- Looper 1: CC3 rec/dub/play · CC9 stop · CC14 clear · CC15 level ·
  CC20 store · CC21 clear backtrack.
- Looper 2: CC22 rec/dub/play · CC23 stop · CC24 clear · CC25 level ·
  CC26 store · CC27 clear backtrack.
- Global: CC29 all stop · CC30 all clear · CC28 decay · CC31 FX on/off
  · CC85 serial/parallel · PC 1-7 FX select.

## Desk integration

Both devices are desk objects in the stage rig (instruments → Helix →
Ditto → XR18 analog chain; blue dashed MIDI control wires from the
MacBook). Right-click fires the real commands through
`POST /api/midi/send` (port substrings "helix" / "ditto"). Click opens
the instrumentation card (live port verdict + full CC map). The ambient
DEVICE DOCK along the bottom of the desk shows every physical device's
live properties without selecting anything.
