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

---

# Field diagnosis — the daisy chain (2026-07-17)

Interrogated the Performer Mac's MIDI Studio (Audio MIDI Setup):

- **Active MIDI entities**: `NUX B-8` (hardware interface, 1 in / 1 out
  — THE HEAD OF THE CHAIN) and `IAC Driver`. Network/Bluetooth/UMP are
  virtual.
- **Offline (pale)**: `HELIX` (its own USB not connected) and a generic
  `USB MIDI Interface` (unplugged).
- **No port is named XR18 / Ditto / Helix.** The physical wiring is a
  serial chain: Mac (NUX B-8 OUT) → XR18 MIDI IN → XR18 OUT/Thru →
  Ditto X4 IN → Ditto THRU → Helix Stadium → return → NUX B-8 IN.

Consequences + fixes shipped:

1. **Port-name routing could never work** — the sidecar 404'd on
   "helix"/"ditto"/"XR18" because only "NUX B-8" exists. Fix:
   `chain_port()` fallback — unmatched device sends route out the chain
   head (env `MIDI_CHAIN_PORT` override; auto-detect prefers "xr18",
   else the first non-virtual port, skipping IAC/Network/Bluetooth/UMP).
   `/health` now reports `chain_port`; the desk shows "CHAINED via
   NUX B-8 ✓" instead of a false red ✗.
2. **Desk boot crash** (`Cannot access 'midiState' before
   initialization`) — boot-time `renderDock()` ran before the `let`
   declarations; state now declared at the top of the script.
3. **Channel plan for ONE shared wire** (every device hears everything):
   XR18 = ch 1/2/3 (fixed) · Ditto X4 = ch 4 (fixed) · Helix Stadium =
   ch 1 by default, WHICH COLLIDES with the XR18 fader map (and XR18
   fader CCs 0-31 on ch 1 trip Stadium global functions like CC10 song
   cue). **Recommended: set Stadium Global Settings > MIDI > Global
   MIDI Channel = 5** (Bypass/Ctrl = 6), then right-click the desk
   Stadium → "Desk MIDI channel…" → 5. Note the portal's timeline
   automation editor also defaults new events to ch 4 — on this chain
   ch 4 is the DITTO; pick the channel deliberately per event.
4. **Board-side switches that must be ON** for the chain to pass:
   XR18 Setup > MIDI > DIN/USB Rx (or the XR18 ignores input) and MIDI
   OUT-as-Thru so messages continue to the Ditto; Ditto DIP switches
   set for MIDI CC + Thru; Stadium MIDI > MIDI Thru if the return to
   the Mac should carry messages onward.

---

# The MIDI Console (2026-07-17)

`/midi-console.html` — the control room for everything MIDI. Top: a
live TOPOLOGY diagram (MacBook → XR18 → Ditto → Helix → return, plus
the IAC branch to Logic), nodes colored by the shared verdict rules,
the return edge annotated with the loop-test round trip. Below, one
panel per device:

- **XR18** — snapshot recall (PC ch 1), Main LR fader slider (CC31
  ch 1), main mute/unmute (CC31 ch 2), OSC console readout, and the
  RX-derived fader/mute state (populates once the board's **USB Tx**
  is enabled and it starts transmitting its moves).
- **Ditto X4** — both loopers + all-stop/all-clear/FX (ch 4).
- **Logic Pro** — transport key commands, plus **Note On** (channel/
  note/velocity, auto note-off after 250 ms) and **Program Change**
  senders over the IAC bus. In Logic: a record-armed Software
  Instrument track receives them; External MIDI tracks pointed at the
  chain port let LOGIC drive the XR18/Ditto/Helix.
- **Clock + chain** — 24-ppqn clock start/stop/bpm, DIN loop test.
- **RX MONITOR** — the sidecar now runs a background listener on EVERY
  MIDI input (`/monitor`): ring buffer of recent messages (clock
  filtered) and derived last-known state (XR18 fader/mute/pan CC maps,
  Stadium program + snapshot). This is "all state available via MIDI"
  — MIDI is write-only unless devices transmit, so the monitor is the
  read path. Enable XR18 USB Tx and Stadium Send MIDI PC/Snapshot CC
  to fill it.

Sends from the console use `port:'chain'` (explicit chain routing) or
'XR18'/'IAC' where a real port exists. Reached from the desk: rack
footer link, or click the MIDI SIDECAR dock panel.

---

# Pass-thru mode verdict (2026-07-17, Bill's final config)

Bill enabled **USB-DIN Pass Thru** — confirmed correct AND
consequential: in this mode the XR18 becomes a pure USB↔DIN MIDI
interface (USB→DIN OUT to the chain, DIN IN→USB back) and **the mixer
itself ignores all MIDI** (the greyed checkboxes are inactive, per the
X AIR manual's "Using MIDI without affecting XR18"). Division of labor
from here on:

- **XR18 control = OSC only** (:10024 — laptop must be on the XR18's
  network). Snapshot recall switched from MIDI PC to OSC `/-snap/load`
  in both the desk and the console; Main LR fader/mute were already
  OSC-capable and the console's CC-based versions were replaced.
- **Chain devices (Ditto ch 4, Stadium ch 5) = MIDI** out the XR18's
  USB port → DIN OUT.
- **Return leg** can now come home through the XR18's own DIN IN
  (DIN IN → USB is part of pass-thru) — the NUX B-8 becomes optional.
  `MIDI_CHAIN_IN` env pins the return port if both are present.

## Turning OSC on (2026-07-18)

OSC has no enable switch — the XR18 always listens on UDP :10024. "Not
found" = no IP path between laptop and mixer. Three ways to create one
(X-AIR-Edit Setup > Connection tabs):

1. **Access Point** — the XR18 broadcasts its own Wi-Fi; join it from
   the Mac. Gig-proof (no internet needed), but the laptop loses
   internet while joined.
2. **WLAN client** — the XR18 joins the home/band router; laptop stays
   on the same Wi-Fi. Best at home (internet + OSC together).
3. **LAN** — Ethernet from the XR18's port to the router (or direct).
   Most reliable for gigs.

Then pin the mixer's IP (shown in X-AIR-Edit once connected) via the
console's "mixer IP → set + probe" (persists in `xr18_ip.txt` next to
the sidecar; `POST /xr18/ip` validates, saves, clears the discovery
cache, and probes /xinfo immediately). Pinning beats broadcast
discovery, which macOS multi-interface routing and the application
firewall both love to eat. If probes still fail with a correct IP:
System Settings > Network > Firewall — allow incoming for the python
running the sidecar.
