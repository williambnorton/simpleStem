#!/usr/bin/env python3
"""midi_sidecar — small HTTP daemon that proxies MIDI messages to attached
devices (Helix, XR18, Logic via IAC, ...). The portal hits us on localhost:5555.

Why a sidecar? The browser's Web MIDI API is unreliable for live use: the tab
must stay focused, SysEx needs prompts, and a page reload kills any open
ports. A small persistent Python process is bulletproof, supports SysEx, and
keeps the wire open even when the portal restarts.

Endpoints
---------
GET  /health                → { ok, ports: [...] }
GET  /ports                 → { outputs: [...] }
POST /send                  → fire one message
POST /clock                 → 24-ppqn MIDI clock control
    body: { action: "start" | "bpm" | "stop", bpm: 30-300, port: optional
            substring filter; default = broadcast to every output }
    body: { port: "helix",  # substring match against output port names
            type: "pc" | "cc" | "note_on" | "note_off",
            channel: 1..16,
            ... type-specific fields }

Type-specific fields
--------------------
pc:       { program: 0..127 }
cc:       { controller: 0..127, value: 0..127 }
note_on:  { note: 0..127, velocity: 0..127 }
note_off: { note: 0..127, velocity: 0..127 }

Install
-------
pip3 install mido python-rtmidi
(or whichever Python the demucs venv uses on the Performer machine)
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import mido
except ImportError:
    print("ERROR: mido + python-rtmidi required.", file=sys.stderr)
    print("On macOS with Homebrew Python (PEP 668), inject into the demucs", file=sys.stderr)
    print("pipx venv instead of system pip:", file=sys.stderr)
    print("    pipx inject demucs mido python-rtmidi", file=sys.stderr)
    print("Or, if you prefer a dedicated venv:", file=sys.stderr)
    print("    python3 -m venv ~/.simpleStem-midi-venv", file=sys.stderr)
    print("    ~/.simpleStem-midi-venv/bin/pip install mido python-rtmidi", file=sys.stderr)
    sys.exit(1)

PORT = 5555

# ── XR18 OSC client (UDP :10024) ────────────────────────────────────────
# The XR18's parameter tree is readable/writable over OSC on UDP 10024
# (X AIR series; replies return to the sender's addr/port). Sending a
# path with NO arguments queries it; sending with an argument sets it.
# /xinfo broadcast discovers the console. Sources: Behringer X AIR OSC
# docs, behringer.world/wiki x-air_osc, xair-api-python.
import os
import socket
import struct

XAIR_PORT = 10024
_xr_cache = {"addr": None, "at": 0.0}


def _osc_str(txt):
    b = txt.encode("utf-8") + b"\0"
    return b + b"\0" * ((4 - len(b) % 4) % 4)


def osc_encode(addr, args=()):
    tags, payload = ",", b""
    for a in args:
        if isinstance(a, bool):
            a = int(a)
        if isinstance(a, int):
            tags += "i"; payload += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"; payload += struct.pack(">f", a)
        else:
            tags += "s"; payload += _osc_str(str(a))
    return _osc_str(addr) + _osc_str(tags) + payload


def _read_str(data, i):
    end = data.index(b"\0", i)
    txt = data[i:end].decode("utf-8", "replace")
    i = end + 1
    i += (4 - i % 4) % 4
    return txt, i


def osc_decode(data):
    addr, i = _read_str(data, 0)
    args = []
    if i < len(data) and data[i:i + 1] == b",":
        tags, i = _read_str(data, i)
        for t in tags[1:]:
            if t == "i":
                args.append(struct.unpack(">i", data[i:i + 4])[0]); i += 4
            elif t == "f":
                args.append(round(struct.unpack(">f", data[i:i + 4])[0], 5)); i += 4
            elif t == "s":
                v, i = _read_str(data, i); args.append(v)
            elif t == "b":
                n = struct.unpack(">i", data[i:i + 4])[0]
                i += 4 + n + (4 - n % 4) % 4
                args.append("<blob %d bytes>" % n)
    return addr, args


XR18_IP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xr18_ip.txt")


def xr_configured_ip():
    env = os.environ.get("XR18_IP")
    if env:
        return env.strip()
    try:
        with open(XR18_IP_FILE, "r", encoding="utf-8") as f:
            ip = f.read().strip()
            return ip or None
    except Exception:
        return None


def xr_discover(timeout=1.5):
    """Find the XR18: pinned IP first (xr18_ip.txt / XR18_IP), then
    broadcast fallback — including the link-local broadcast, because
    Bill's board lives at a 169.254.x.x APIPA address on direct
    Ethernet and self-assigned addresses CAN drift after reboot. First
    /xinfo reply wins and is cached 5 min, so a drifted pin heals
    itself without editing the file."""
    now = time.time()
    if _xr_cache["addr"] and now - _xr_cache["at"] < 300:
        return _xr_cache["addr"]
    env_ip = xr_configured_ip()
    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sk.settimeout(timeout)
    try:
        msg = osc_encode("/xinfo")
        sk.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        targets = []
        if env_ip:
            targets.append(env_ip)
        targets += ["255.255.255.255", "169.254.255.255"]
        for t in targets:
            try:
                sk.sendto(msg, (t, XAIR_PORT))
            except Exception:
                pass
        _data, addr = sk.recvfrom(4096)
        _xr_cache["addr"] = addr
        _xr_cache["at"] = now
        return addr
    except Exception:
        _xr_cache["addr"] = None
        return None
    finally:
        sk.close()


def xr_exchange(path, args=(), timeout=1.5, expect_reply=True, log=False):
    addr = xr_discover()
    if not addr:
        return None
    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sk.settimeout(timeout)
    try:
        sk.sendto(osc_encode(path, args), addr)
        if log:
            _record_osc("tx", path, list(args))
        if not expect_reply:
            return {"sent": True}
        deadline = time.time() + timeout
        while time.time() < deadline:
            data, _ = sk.recvfrom(4096)
            raddr, rargs = osc_decode(data)
            if raddr == path or path == "/xinfo":
                if log:
                    _record_osc("rx", raddr, rargs)
                return {"path": raddr, "args": rargs}
        return None
    except Exception:
        return None
    finally:
        sk.close()


def fader_to_db(f):
    if f is None:
        return None
    if f >= 0.5:
        db = f * 40.0 - 30.0
    elif f >= 0.25:
        db = f * 80.0 - 50.0
    elif f >= 0.0625:
        db = f * 160.0 - 70.0
    elif f > 0.0:
        db = f * 480.0 - 90.0
    else:
        return "-inf"
    return round(db, 1)


def db_to_fader(db):
    db = float(db)
    if db >= -10.0:
        f = (db + 30.0) / 40.0
    elif db >= -30.0:
        f = (db + 50.0) / 80.0
    elif db >= -60.0:
        f = (db + 70.0) / 160.0
    else:
        f = (db + 90.0) / 480.0
    return max(0.0, min(1.0, f))

# --- Amp programs: what the six monitor wedges are carrying -----------------
# Bill 2026-07-30. Signal flow first, because the obvious mental model is wrong:
# the XR18 has NO Main L/R -> bus send. Main L/R is a sink, not a source; a bus
# mix is built from CHANNEL sends. So "Main Left into aux 1" really means "raise
# ch 1's send into bus 1". See CONTRACTS EX-7.
#
# A "program" is a COMPLETE state of the send matrix: all eight sources
# (Main L/R on ch 1-2, the six stems on USB returns ch 11-16) against all six
# wedge buses. Complete rather than incremental, because programs have to be
# mutually exclusive -- switching from split-by-stem to lr-odd-even must not
# leave stem sends hanging in the wedges. Every program is therefore the same
# 48 writes with different values, which also makes each one idempotent and
# self-healing: UDP loss is silent and unreported, so re-sending the full
# matrix is how a dropped datagram gets corrected.
#
# This lives in the sidecar, not in the UI surfaces, because it owns the OSC
# socket and the dB curve (so writes can be verified against their readback)
# and one implementation cannot drift from itself. Safety class: loud.
AMP_ON_DB = -10.0     # db_to_fader(-10) == 0.5 exactly
AMP_OFF_DB = -90.0    # db_to_fader(-90) == 0.0 exactly -> reads back "-inf"
AMP_BUSES = 6
AMP_MAIN_CH = ("01", "02")                                    # Main L, Main R
AMP_STEM_CH = ("11", "12", "13", "14", "15", "16")            # USB returns
AMP_STEM_NAMES = ("vocals", "drums", "bass", "guitar", "piano", "other")
AMP_SOURCES = AMP_MAIN_CH + AMP_STEM_CH
_amps_lock = threading.Lock()

# rotatable: the program takes a `step`, so a rotation can walk it.
AMP_PROGRAMS = {
    "reset": {
        "label": "RESET",
        "desc": "every wedge send closed — the amps carry nothing; Main L/R still feeds FOH",
        "rotatable": False,
    },
    "lr-odd-even": {
        "label": "All on · L/R to odd/even",
        "desc": "Main Left into aux 1/3/5, Main Right into aux 2/4/6 — the whole band hears the track",
        "rotatable": False,
    },
    "split-by-stem": {
        "label": "Split by stem",
        "desc": "one stem per wedge: vocals→1, drums→2, bass→3, guitar→4, piano→5, other→6",
        "rotatable": True,
    },
}


def amp_matrix(program, step=0):
    """{(source_ch, bus): db} for all 8 sources x 6 buses — a complete state."""
    if program not in AMP_PROGRAMS:
        raise ValueError("unknown amp program %r (have: %s)"
                         % (program, ", ".join(sorted(AMP_PROGRAMS))))
    m = {(src, bus): AMP_OFF_DB
         for src in AMP_SOURCES for bus in range(1, AMP_BUSES + 1)}
    if program == "reset":
        pass
    elif program == "lr-odd-even":
        # Odd buses carry Main L, even buses carry Main R.
        for bus in range(1, AMP_BUSES + 1):
            m[(AMP_MAIN_CH[0] if bus % 2 else AMP_MAIN_CH[1], bus)] = AMP_ON_DB
    elif program == "split-by-stem":
        # Stem i lands in bus ((i + step) mod 6) + 1. step>0 walks the stems
        # toward higher-numbered wedges ("right" around the ring); rotate-left
        # is the caller passing a decreasing step.
        for i, src in enumerate(AMP_STEM_CH):
            m[(src, ((i + int(step)) % AMP_BUSES) + 1)] = AMP_ON_DB
    return m


def amp_plan(program, step=0):
    """[(osc_path, db)] — 48 writes, the ON sends FIRST.

    Ordering matters during a rotation: raising a stem's new wedge before
    closing its old one means the stem is never momentarily nowhere.
    """
    m = amp_matrix(program, step)
    items = sorted(m.items(), key=lambda kv: (kv[1] != AMP_ON_DB, kv[0]))
    return [("/ch/%s/mix/%02d/level" % (src, bus), db) for (src, bus), db in items]


def xr_send_many(plan):
    """Blast a plan down ONE socket, no readbacks. Returns writes sent, or None.

    The fast path, for rotation ticks only. A verified write costs two round
    trips, so the 48 writes of one program step would be 96 exchanges -- far
    too slow for a 1 Hz rotation, and `amps` verification would serialize
    behind its own timeouts. Deliberately does NOT touch the wire log: at one
    step per second the log would drown (docs/14 keeps the 60 s deep-probe
    quiet for the same reason). Entry and exit ARE verified; the ticks between
    are trusted, and each tick re-sends the whole matrix so a dropped
    datagram self-corrects on the next one.
    """
    addr = xr_discover()
    if not addr:
        return None
    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for path, db in plan:
            sk.sendto(osc_encode(path, [db_to_fader(db)]), addr)
        return len(plan)
    except Exception:
        return None
    finally:
        sk.close()


def amp_apply(program, step=0, verify=True):
    """Put the wedges into `program`. Verified unless this is a rotation tick.

    Verified mode reads every write back and compares it to the fader float it
    should have produced. That check is not paranoia: POST /xr18/set reports ok
    as soon as the datagram leaves, and xr_discover() caches the mixer address
    for 300 s, so a power-cycled board still accepts sendto and answers
    nothing. Unverified "successes" would light the desk up over six wedges
    that never moved -- and the reverse, RESET reported clean while the wedges
    stay hot, is the dangerous direction. See CONTRACTS EX-8.
    """
    try:
        plan = amp_plan(program, step)
    except ValueError as e:
        return {"ok": False, "error": str(e), "applied": 0, "partial": False}

    if not verify:
        n = xr_send_many(plan)
        if n is None:
            return {"ok": False, "error": "XR18 unreachable", "applied": 0,
                    "partial": False, "verified": False}
        return {"ok": True, "program": program, "step": int(step),
                "applied": n, "partial": False, "verified": False}

    # Only the first six writes go to the wire log. Three log records per item
    # (write tx, read tx, read rx) x 48 items would be 144 entries into a
    # 150-slot ring buffer — one program would erase the entire MIDI/OSC
    # history the console and docs/15 depend on. Because amp_plan() puts the ON
    # sends first, those six ARE the live ones for any program that has six;
    # for RESET they are simply evidence the walk ran.
    # Readback timeout is tight (0.5 s): on the wired/link-local path a reply is
    # ~1 ms, so a slow reply means something is wrong, and the sidecar's HTTP
    # server is single-threaded — a long walk blocks every other request,
    # including MIDI /send.
    for i, (path, db) in enumerate(plan):
        want = db_to_fader(db)
        chatty = (i < 6)
        if xr_exchange(path, [want], expect_reply=False, log=chatty) is None:
            return {"ok": False, "error": "XR18 unreachable", "applied": i,
                    "partial": i > 0, "at": path, "verified": True}
        back = xr_exchange(path, timeout=0.5, log=chatty)
        got = (back or {}).get("args")
        got = got[0] if got else None
        # partial=True even at i == 0 on these two: unlike the unreachable
        # branch above, the datagram DID leave, so this send may well have
        # moved even though we can't confirm it. Callers must treat the amp
        # state as unknown, not as unchanged.
        if got is None:
            return {"ok": False, "applied": i, "partial": True, "at": path,
                    "verified": True,
                    "error": "no readback from %s — board is not answering "
                             "(powered off, or off this network)" % path}
        if abs(float(got) - want) > 0.001:
            return {"ok": False, "applied": i, "partial": True, "at": path,
                    "verified": True,
                    "error": "%s read back %s, expected %s" % (path, got, want)}
    return {"ok": True, "program": program, "step": int(step),
            "applied": len(plan), "partial": False, "verified": True}


def amp_state():
    """Read the 48 sends and say which program the BOARD is actually in.

    The UI caches the program name, but a snapshot recall, an X-AIR-Edit edit
    or a power cycle moves these sends behind the app's back, so the cache is
    only ever a cache. This is the reconciliation path. See CONTRACTS EX-9.
    """
    reads = {}
    for src in AMP_SOURCES:
        for bus in range(1, AMP_BUSES + 1):
            path = "/ch/%s/mix/%02d/level" % (src, bus)
            back = xr_exchange(path, timeout=0.6)
            args = (back or {}).get("args")
            if not args:
                return {"ok": False, "error": "XR18 unreachable", "program": "unknown"}
            reads[(src, bus)] = float(args[0])

    def matches(program, step=0):
        return all(abs(reads[k] - db_to_fader(v)) <= 0.001
                   for k, v in amp_matrix(program, step).items())

    for pid, meta in AMP_PROGRAMS.items():
        steps = range(AMP_BUSES) if meta["rotatable"] else (0,)
        for st in steps:
            if matches(pid, st):
                return {"ok": True, "program": pid, "step": st,
                        "label": meta["label"],
                        "sends": {"/ch/%s/mix/%02d/level" % k: fader_to_db(v)
                                  for k, v in reads.items()}}
    return {"ok": True, "program": "custom", "step": None,
            "label": "custom — not one of the known programs",
            "sends": {"/ch/%s/mix/%02d/level" % k: fader_to_db(v)
                      for k, v in reads.items()}}


def amp_preflight():
    """Catch the console settings that silently defeat a program.

    Two link settings make a write to one channel or bus also write its
    partner, which an amp program cannot see because amp_apply reads back the
    very path it wrote -- it passes verification while producing the wrong
    result. See CONTRACTS EX-10.

      * /config/buslink/N-M ON  -> buses N,M are one stereo pair, so "Main L in
        aux 1, Main R in aux 2" stops being two independent sends.
      * /config/chlink/1-2 ON together with /config/linkcfg/fdrmute ON (the
        pref is literally "Fader, Mute, Sends") -> writing ch 1's send also
        writes ch 2's, so the deliberate opposite-side OFF write is clobbered
        by its own partner.
    """
    checks, warnings = {}, []
    for pair in ("1-2", "3-4", "5-6"):
        back = xr_exchange("/config/buslink/%s" % pair, timeout=0.8)
        args = (back or {}).get("args")
        if args is None:
            return {"ok": False, "error": "XR18 unreachable"}
        checks["buslink/%s" % pair] = int(args[0]) if args else 0
    fdr = xr_exchange("/config/linkcfg/fdrmute", timeout=0.8)
    checks["linkcfg/fdrmute"] = int((fdr or {}).get("args", [0])[0] or 0)
    chl = xr_exchange("/config/chlink/1-2", timeout=0.8)
    checks["chlink/1-2"] = int((chl or {}).get("args", [0])[0] or 0)

    for pair in ("1-2", "3-4", "5-6"):
        if checks["buslink/%s" % pair]:
            warnings.append("buses %s are STEREO-LINKED — those two wedges cannot "
                            "carry independent signals; unlink them in X-AIR-Edit "
                            "(Setup > Config > Bus links)" % pair)
    if checks["chlink/1-2"] and checks["linkcfg/fdrmute"]:
        warnings.append("ch 1-2 are stereo-linked AND the link pref includes Sends — "
                        "writing Main L's send also writes Main R's, so the L/R "
                        "spread will silently collapse. Unlink ch 1-2, or turn off "
                        "'Sends' in the link preferences.")
    return {"ok": True, "clear": not warnings, "checks": checks, "warnings": warnings}


# Lazy-open outputs so we don't grab every device at startup.# Lazy-open outputs so we don't grab every device at startup. Cached by the
# canonical port name (what mido reports) so multiple substring queries that
# resolve to the same port share one handle.
_outputs = {}


def find_port(needle):
    """Substring + case-insensitive match against available output ports.
    Returns the canonical name, or None if no match.
    """
    needle = (needle or "").lower().strip()
    if not needle:
        return None
    for name in mido.get_output_names():
        if needle in name.lower():
            return name
    return None


def chain_port():
    """The head of Bill's physical MIDI daisy chain (2026-07-15 wiring:
    Mac MIDI OUT -> XR18 IN, XR18 OUT/Thru -> Ditto X4 IN, Ditto THRU ->
    Helix Stadium, Helix -> back to Mac IN). Every chained device hears
    the SAME stream and answers by MIDI CHANNEL, so messages for devices
    with no port of their own route out the chain head. Override with
    MIDI_CHAIN_PORT=<substring>; default tries XR18, then the first
    non-virtual (non-IAC) output."""
    env = os.environ.get("MIDI_CHAIN_PORT")
    if env:
        return find_port(env)
    name = find_port("xr18")
    if name:
        return name
    virtual = ("iac", "network", "bluetooth", "ump", "session", "virtual")
    for n in mido.get_output_names():
        low = n.lower()
        if not any(v in low for v in virtual):
            return n
    return None


def chain_in_port():
    """The chain's RETURN port (Helix -> back to the Mac's MIDI IN).
    Override with MIDI_CHAIN_IN; else first non-virtual input."""
    env = os.environ.get("MIDI_CHAIN_IN")
    virtual = ("iac", "network", "bluetooth", "ump", "session", "virtual")
    try:
        names = mido.get_input_names()
    except Exception:
        return None
    if env:
        for n in names:
            if env.lower() in n.lower():
                return n
        return None
    for n in names:
        low = n.lower()
        if not any(v in low for v in virtual):
            return n
    return None


def get_output(needle, allow_chain=True):
    name = find_port(needle)
    routed = "direct"
    low = (needle or "").lower()
    if not name and ("iac" in low or "logic" in low):
        # Logic-bound messages must NEVER fall back to the DIN chain —
        # notes meant for the DAW would hit the Ditto/Stadium. Try
        # Logic's own virtual input instead (exists whenever Logic
        # runs, even with the IAC bus disabled).
        name = find_port("logic pro virtual in")
        routed = "logic-virtual"
        if not name:
            return None, None
    if not name and allow_chain:
        name = chain_port()
        routed = "chain"
    if not name:
        return None, None
    if name not in _outputs:
        _outputs[name] = mido.open_output(name)
    return _outputs[name], routed


class MidiClock:
    """24-ppqn MIDI clock generator. One background thread, absolute-time
    scheduled (perf_counter) so tempo doesn't drift with sleep jitter.
    Broadcasts to every output port (or a substring-filtered subset) so
    loopers/pedals follow the portal's playback tempo. Driven by POST /clock
    with {action: start|bpm|stop, bpm?, port?}.
    """

    def __init__(self):
        self._thread = None
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._interval = 60.0 / (120.0 * 24.0)
        self.bpm = 0.0
        self.running = False
        self.port_filter = None

    def _targets(self):
        try:
            names = mido.get_output_names()
        except Exception:
            names = []
        if self.port_filter:
            needle = self.port_filter.lower()
            names = [n for n in names if needle in n.lower()]
        outs = []
        for n in names:
            try:
                if n not in _outputs:
                    _outputs[n] = mido.open_output(n)
                outs.append(_outputs[n])
            except Exception:
                pass
        return outs

    def start(self, bpm, port_filter=None):
        self.stop(send_stop=False)
        with self._lock:
            self.bpm = float(bpm)
            self._interval = 60.0 / (self.bpm * 24.0)
        self.port_filter = port_filter or None
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.running = True
        self._thread.start()

    def set_bpm(self, bpm):
        with self._lock:
            self.bpm = float(bpm)
            self._interval = 60.0 / (self.bpm * 24.0)

    def stop(self, send_stop=True):
        if self._thread and self._thread.is_alive():
            self._stop_evt.set()
            self._thread.join(timeout=1.0)
        self._thread = None
        self.running = False
        if send_stop:
            for out in self._targets():
                try:
                    out.send(mido.Message("stop"))
                except Exception:
                    pass

    def _run(self):
        outs = self._targets()
        for out in outs:
            try:
                out.send(mido.Message("start"))
            except Exception:
                pass
        next_t = time.perf_counter()
        ticks = 0
        while not self._stop_evt.is_set():
            for out in outs:
                try:
                    out.send(mido.Message("clock"))
                except Exception:
                    pass
            with self._lock:
                iv = self._interval
            next_t += iv
            ticks += 1
            if ticks % 240 == 0:
                outs = self._targets()
            delay = next_t - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                next_t = time.perf_counter()


_clock = MidiClock()


# ── RX monitor (Bill 2026-07-17): the only way to READ state over MIDI
# is to listen. A background thread opens every MIDI input (hardware +
# IAC), keeps a ring buffer of recent messages (clock/active-sense
# filtered out), and derives last-known device state: XR18 fader/mute/
# pan CC maps (ch 1/2/3), Stadium program + snapshot (PC / CC69).
from collections import deque

_chain_cache = {"result": None, "at": 0.0}
_rx = {"events": deque(maxlen=150), "listening": [],
       "derived": {"xr18": {"faders": {}, "mutes": {}, "pans": {}},
                   "stadium": {"program": None, "snapshot": None},
                   "last_rx_at": None}}


def _record_rx(port, msg):
    if msg.type in ("clock", "active_sensing", "start", "stop", "continue"):
        return
    ev = {"t": round(time.time(), 3), "port": port, "type": msg.type,
          "dir": "rx", "proto": "midi"}
    for attr in ("channel", "control", "value", "program", "note", "velocity"):
        if hasattr(msg, attr):
            ev[attr] = getattr(msg, attr)
    if "channel" in ev:
        ev["channel"] += 1
    _rx["events"].append(ev)
    _rx["derived"]["last_rx_at"] = ev["t"]
    ch = ev.get("channel")
    if msg.type == "control_change":
        if ch == 1 and msg.control <= 35:
            _rx["derived"]["xr18"]["faders"][str(msg.control)] = msg.value
        elif ch == 2 and msg.control <= 39:
            _rx["derived"]["xr18"]["mutes"][str(msg.control)] = msg.value
        elif ch == 3 and msg.control <= 35:
            _rx["derived"]["xr18"]["pans"][str(msg.control)] = msg.value
        if msg.control == 69:
            _rx["derived"]["stadium"]["snapshot"] = msg.value + 1 if msg.value <= 7 else None
    elif msg.type == "program_change":
        _rx["derived"]["stadium"]["program"] = msg.program


def _record_tx(port, msg):
    """Log an OUTBOUND MIDI message into the same wire log the RX
    monitor uses, so the console shows the full conversation."""
    ev = {"t": round(time.time(), 3), "port": port, "type": msg.type,
          "dir": "tx", "proto": "midi"}
    for attr in ("channel", "control", "value", "program", "note", "velocity"):
        if hasattr(msg, attr):
            ev[attr] = getattr(msg, attr)
    if "channel" in ev:
        ev["channel"] += 1
    _rx["events"].append(ev)


def _record_osc(direction, path, args):
    _rx["events"].append({"t": round(time.time(), 3), "port": "XR18 UDP:10024",
                          "type": "osc", "dir": direction, "proto": "osc",
                          "path": path, "args": args})


def _rx_loop():
    """Listens on every MIDI input. Hardened 2026-07-19: a port that
    DISAPPEARS (unplug) gets closed and forgotten so it re-opens fresh
    when it returns — a stale CoreMIDI handle stays silent forever while
    fresh opens (like the loop test's) still work, which made the
    monitor look deaf. Failed opens are retried every ~10 s."""
    opened = {}
    tick = 0
    while True:
        try:
            tick += 1
            current = set(mido.get_input_names())
            for n in list(opened.keys()):
                if n not in current:
                    try:
                        if opened[n]:
                            opened[n].close()
                    except Exception:
                        pass
                    del opened[n]
            if tick % 300 == 0:
                for n in [k for k, v in opened.items() if v is None]:
                    del opened[n]
            for n in current:
                if n not in opened:
                    try:
                        opened[n] = mido.open_input(n)
                    except Exception:
                        opened[n] = None
            _rx["listening"] = [n for n, p in opened.items() if p]
            for n, inp in opened.items():
                if not inp:
                    continue
                for msg in inp.iter_pending():
                    _record_rx(n, msg)
        except Exception:
            pass
        time.sleep(0.03)


def build_msg(body):
    msg_type = (body.get("type") or "").lower()
    # MIDI channels are 1-16 to humans, 0-15 on the wire.
    ch = int(body.get("channel", 1)) - 1
    if not (0 <= ch <= 15):
        raise ValueError(f"channel must be 1-16, got {body.get('channel')}")
    if msg_type == "pc":
        program = int(body.get("program", 0))
        if not (0 <= program <= 127):
            raise ValueError(f"program must be 0-127, got {program}")
        return mido.Message("program_change", channel=ch, program=program)
    if msg_type == "cc":
        controller = int(body.get("controller", 0))
        value = int(body.get("value", 0))
        for nm, v in (("controller", controller), ("value", value)):
            if not (0 <= v <= 127):
                raise ValueError(f"{nm} must be 0-127, got {v}")
        return mido.Message("control_change", channel=ch, control=controller, value=value)
    if msg_type in ("note_on", "note_off"):
        note = int(body.get("note", 60))
        velocity = int(body.get("velocity", 100))
        for nm, v in (("note", note), ("velocity", velocity)):
            if not (0 <= v <= 127):
                raise ValueError(f"{nm} must be 0-127, got {v}")
        return mido.Message(msg_type, channel=ch, note=note, velocity=velocity)
    raise ValueError(f"unsupported message type: {msg_type!r}")


class Handler(BaseHTTPRequestHandler):
    # Silence default access log; we already see request errors in responses.
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        # CORS so the portal (different origin :3000) can call us directly
        # if the user wants to bypass the proxy. Same-origin proxy is the
        # default path though.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        if self.path == "/health":
            try:
                chain = chain_port()
            except Exception:
                chain = None
            return self._json(200, {"ok": True, "ports": mido.get_output_names(),
                                    "inputs": mido.get_input_names(),
                                    "chain_port": chain,
                                    "xr18_ip": xr_configured_ip(),
                                    "clock": {"running": _clock.running, "bpm": _clock.bpm}})
        if self.path == "/ports":
            return self._json(200, {"outputs": mido.get_output_names(),
                                    "inputs": mido.get_input_names()})
        if self.path == "/monitor":
            return self._json(200, {"ok": True,
                                    "listening": _rx["listening"],
                                    "events": list(_rx["events"])[-50:],
                                    "derived": _rx["derived"]})
        if self.path.startswith("/chain/test"):
            fresh = "fresh" in self.path
            if not fresh and _chain_cache["result"] and time.time() - _chain_cache["at"] < 30:
                return self._json(200, {**_chain_cache["result"], "cached": True})
            return self._chain_test()
        if self.path == "/xr18/info":
            return self._xr18_info()
        if self.path == "/xr18/amp-programs":
            return self._json(200, {"ok": True, "programs": [
                dict(id=pid, **meta) for pid, meta in AMP_PROGRAMS.items()],
                "on_db": AMP_ON_DB, "buses": AMP_BUSES,
                "stems": list(AMP_STEM_NAMES)})
        if self.path == "/xr18/amp-program":
            st = amp_state()
            return self._json(200 if st.get("ok") else 503, st)
        if self.path == "/xr18/preflight":
            pf = amp_preflight()
            return self._json(200 if pf.get("ok") else 503, pf)
        if self.path.startswith("/xr18/query?"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            osc_path = (q.get("path") or [""])[0]
            if not osc_path.startswith("/"):
                return self._json(400, {"error": "path must start with /"})
            r = xr_exchange(osc_path, log=True)
            if r is None:
                return self._json(503, {"ok": False, "error": "XR18 unreachable"})
            return self._json(200, {"ok": True, **r})
        self._json(404, {"error": "not found"})

    def _chain_test(self):
        """Results cache 30 s (desk + console both auto-test every minute;
        without the cache the wire log drowns in markers)."""
        """Loopback test of the physical DIN chain: send a marker CC on
        channel 16 (no device in the rig listens there) out the chain
        head and listen for its echo on the chain return input. Echo
        received = every Thru in XR18 -> Ditto -> Helix -> Mac passes."""
        import random
        out, _routed = get_output(None)
        if not out:
            return self._json(503, {"ok": False, "error": "no chain output port"})
        virtual = ("iac", "network", "bluetooth", "ump", "session", "virtual")
        in_names = [n for n in mido.get_input_names()
                    if not any(v in n.lower() for v in virtual)]
        env = os.environ.get("MIDI_CHAIN_IN")
        if env:
            narrowed = [n for n in in_names if env.lower() in n.lower()]
            in_names = narrowed or in_names
        if not in_names:
            return self._json(200, {"ok": True, "loop": "untestable",
                                    "hint": "no hardware MIDI input for the return leg"})
        nonce = random.randint(1, 126)
        marker = mido.Message("control_change", channel=15, control=119, value=nonce)
        inps = []
        for n in in_names:
            try:
                inps.append((n, mido.open_input(n)))
            except Exception:
                pass
        if not inps:
            return self._json(500, {"ok": False, "error": "could not open any return input"})
        try:
            for _n, inp in inps:
                for _m in inp.iter_pending():
                    pass
            t0 = time.time()
            out.send(marker)
            _record_tx(out.name, marker)
            while time.time() - t0 < 2.0:
                for n, inp in inps:
                    for msg in inp.iter_pending():
                        if (msg.type == "control_change" and msg.channel == 15
                                and msg.control == 119 and msg.value == nonce):
                            _chain_cache["result"] = {"ok": True, "loop": "intact",
                                                      "roundtrip_ms": int((time.time() - t0) * 1000),
                                                      "out": out.name, "heard_on": n,
                                                      "listened_on": [x[0] for x in inps]}
                            _chain_cache["at"] = time.time()
                            return self._json(200, _chain_cache["result"])
                time.sleep(0.01)
            _chain_cache["result"] = {"ok": True, "loop": "broken",
                                      "out": out.name,
                                      "listened_on": [x[0] for x in inps],
                                      "hint": "no echo on ANY hardware input — isolate the break: "
                                              "cable XR18 DIN OUT straight into the return input "
                                              "and retest, then re-insert Ditto, then Helix"}
            _chain_cache["at"] = time.time()
            return self._json(200, _chain_cache["result"])
        finally:
            for _n, inp in inps:
                try:
                    inp.close()
                except Exception:
                    pass

    def _xr18_info(self):
        info = xr_exchange("/xinfo", timeout=2.0)
        if info is None:
            return self._json(503, {"ok": False, "error": "XR18 not found on the network (OSC :10024)"})
        a = info.get("args") or []
        out = {"ok": True,
               "network": {"ip": a[0] if len(a) > 0 else None,
                           "name": a[1] if len(a) > 1 else None,
                           "model": a[2] if len(a) > 2 else None,
                           "firmware": a[3] if len(a) > 3 else None}}
        snap = xr_exchange("/-snap/index")
        out["snapshot_index"] = (snap or {}).get("args", [None])[0]
        sname = xr_exchange("/-snap/name")
        out["snapshot_name"] = (sname or {}).get("args", [None])[0]
        lrf = xr_exchange("/lr/mix/fader")
        f = (lrf or {}).get("args", [None])[0]
        out["main_lr"] = {"fader": f, "fader_db": fader_to_db(f)}
        lron = xr_exchange("/lr/mix/on")
        on = (lron or {}).get("args", [None])[0]
        out["main_lr"]["muted"] = (on == 0) if on is not None else None
        buses = []
        for b in range(1, 7):
            nm = xr_exchange("/bus/%d/config/name" % b, timeout=0.8)
            fv = xr_exchange("/bus/%d/mix/fader" % b, timeout=0.8)
            bf = (fv or {}).get("args", [None])[0]
            buses.append({"bus": b,
                          "name": ((nm or {}).get("args", [""]) or [""])[0],
                          "fader": bf, "fader_db": fader_to_db(bf)})
        out["aux_buses"] = buses
        return self._json(200, out)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw) if raw else {}
        except Exception as e:
            return self._json(400, {"error": f"bad json: {e}"})
        if self.path == "/send":
            return self._handle_send(body)
        if self.path == "/clock":
            return self._handle_clock(body)
        if self.path == "/xr18/ip":
            import re as _re
            ip = str(body.get("ip") or "").strip()
            if ip and not _re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip):
                return self._json(400, {"error": "not an IPv4 address"})
            try:
                if ip:
                    with open(XR18_IP_FILE, "w", encoding="utf-8") as f:
                        f.write(ip + "\n")
                elif os.path.exists(XR18_IP_FILE):
                    os.remove(XR18_IP_FILE)
            except Exception as e:
                return self._json(500, {"error": str(e)})
            _xr_cache["addr"] = None
            _xr_cache["at"] = 0.0
            probe = xr_exchange("/xinfo", timeout=2.0)
            return self._json(200, {"ok": True, "ip": ip or None,
                                    "probe": probe.get("args") if probe else None,
                                    "reachable": probe is not None})
        if self.path == "/xr18/amp-program":
            program = str(body.get("program") or "")
            try:
                step = int(body.get("step") or 0)
            except (TypeError, ValueError):
                return self._json(400, {"ok": False, "error": "step must be an integer"})
            # Rotation ticks opt out of readback verification; everything else
            # is verified. See xr_send_many() for why.
            verify = not bool(body.get("fast"))
            # Belt and braces. The HTTP server is single-threaded today, so
            # requests already serialize and this lock is never contended --
            # but two interleaved walks over the same 48 paths would leave a
            # board state that depends on packet ordering, so the guard stays
            # correct if the server ever grows threads.
            if not _amps_lock.acquire(blocking=False):
                return self._json(409, {"ok": False, "error": "an amp change is already running"})
            try:
                r = amp_apply(program, step, verify=verify)
            finally:
                _amps_lock.release()
            if not r.get("ok") and "unknown amp program" in (r.get("error") or ""):
                return self._json(400, r)
            return self._json(200 if r.get("ok") else 503, r)
        if self.path == "/xr18/set":
            osc_path = str(body.get("path") or "")
            if not osc_path.startswith("/"):
                return self._json(400, {"error": "path must start with /"})
            value = body.get("value")
            if body.get("db") is not None:
                value = db_to_fader(body["db"])
            args = [] if value is None else [value]
            r = xr_exchange(osc_path, args, expect_reply=False, log=True)
            if r is None:
                return self._json(503, {"ok": False, "error": "XR18 unreachable"})
            back = xr_exchange(osc_path, log=True)
            return self._json(200, {"ok": True, "set": osc_path, "value": value,
                                    "readback": (back or {}).get("args")})
        self._json(404, {"error": "not found"})

    def _handle_clock(self, body):
        action = (body.get("action") or "").lower()
        try:
            if action == "start":
                bpm = float(body.get("bpm", 120))
                if not (30.0 <= bpm <= 300.0):
                    raise ValueError(f"bpm must be 30-300, got {bpm}")
                _clock.start(bpm, body.get("port"))
                return self._json(200, {"ok": True, "running": True, "bpm": _clock.bpm})
            if action == "bpm":
                bpm = float(body.get("bpm", 120))
                if not (30.0 <= bpm <= 300.0):
                    raise ValueError(f"bpm must be 30-300, got {bpm}")
                _clock.set_bpm(bpm)
                return self._json(200, {"ok": True, "running": _clock.running, "bpm": _clock.bpm})
            if action == "stop":
                _clock.stop()
                return self._json(200, {"ok": True, "running": False})
            raise ValueError(f"unsupported clock action: {action!r}")
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": f"clock failed: {e}"})

    def _handle_send(self, body):
        out, routed = get_output(body.get("port"))
        if not out:
            return self._json(404, {
                "error": f'no MIDI output matching "{body.get("port")}" and no chain port',
                "available": mido.get_output_names(),
            })
        try:
            msg = build_msg(body)
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        try:
            out.send(msg)
            _record_tx(out.name, msg)
        except Exception as e:
            return self._json(500, {"error": f"send failed: {e}"})
        return self._json(200, {"ok": True, "sent_to": out.name, "routed": routed, "msg": str(msg)})


def main():
    print(f"midi_sidecar listening on http://127.0.0.1:{PORT}")
    try:
        outs = mido.get_output_names()
    except Exception as e:
        outs = []
        print(f"WARN: could not enumerate MIDI ports: {e}", file=sys.stderr)
    print(f"available MIDI outputs: {outs}")
    threading.Thread(target=_rx_loop, daemon=True, name="rx-monitor").start()
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nmidi_sidecar shutting down")
