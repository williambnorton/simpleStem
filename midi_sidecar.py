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


def xr_discover(timeout=1.5):
    now = time.time()
    if _xr_cache["addr"] and now - _xr_cache["at"] < 300:
        return _xr_cache["addr"]
    env_ip = os.environ.get("XR18_IP")
    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sk.settimeout(timeout)
    try:
        msg = osc_encode("/xinfo")
        if env_ip:
            sk.sendto(msg, (env_ip, XAIR_PORT))
        else:
            sk.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sk.sendto(msg, ("255.255.255.255", XAIR_PORT))
        _data, addr = sk.recvfrom(4096)
        _xr_cache["addr"] = addr
        _xr_cache["at"] = now
        return addr
    except Exception:
        _xr_cache["addr"] = None
        return None
    finally:
        sk.close()


def xr_exchange(path, args=(), timeout=1.5, expect_reply=True):
    addr = xr_discover()
    if not addr:
        return None
    sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sk.settimeout(timeout)
    try:
        sk.sendto(osc_encode(path, args), addr)
        if not expect_reply:
            return {"sent": True}
        deadline = time.time() + timeout
        while time.time() < deadline:
            data, _ = sk.recvfrom(4096)
            raddr, rargs = osc_decode(data)
            if raddr == path or path == "/xinfo":
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

# Lazy-open outputs so we don't grab every device at startup. Cached by the
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
    virtual = ("iac", "network", "bluetooth", "ump", "session")
    for n in mido.get_output_names():
        low = n.lower()
        if not any(v in low for v in virtual):
            return n
    return None


def chain_in_port():
    """The chain's RETURN port (Helix -> back to the Mac's MIDI IN).
    Override with MIDI_CHAIN_IN; else first non-virtual input."""
    env = os.environ.get("MIDI_CHAIN_IN")
    virtual = ("iac", "network", "bluetooth", "ump", "session")
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
                                    "clock": {"running": _clock.running, "bpm": _clock.bpm}})
        if self.path == "/ports":
            return self._json(200, {"outputs": mido.get_output_names(),
                                    "inputs": mido.get_input_names()})
        if self.path == "/chain/test":
            return self._chain_test()
        if self.path == "/xr18/info":
            return self._xr18_info()
        if self.path.startswith("/xr18/query?"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            osc_path = (q.get("path") or [""])[0]
            if not osc_path.startswith("/"):
                return self._json(400, {"error": "path must start with /"})
            r = xr_exchange(osc_path)
            if r is None:
                return self._json(503, {"ok": False, "error": "XR18 unreachable"})
            return self._json(200, {"ok": True, **r})
        self._json(404, {"error": "not found"})

    def _chain_test(self):
        """Loopback test of the physical DIN chain: send a marker CC on
        channel 16 (no device in the rig listens there) out the chain
        head and listen for its echo on the chain return input. Echo
        received = every Thru in XR18 -> Ditto -> Helix -> Mac passes."""
        import random
        out, _routed = get_output(None)
        inp_name = chain_in_port()
        if not out:
            return self._json(503, {"ok": False, "error": "no chain output port"})
        if not inp_name:
            return self._json(200, {"ok": True, "loop": "untestable",
                                    "hint": "no hardware MIDI input for the return leg"})
        nonce = random.randint(1, 126)
        marker = mido.Message("control_change", channel=15, control=119, value=nonce)
        try:
            inp = mido.open_input(inp_name)
        except Exception as e:
            return self._json(500, {"ok": False, "error": f"open input failed: {e}"})
        try:
            for _m in inp.iter_pending():
                pass
            t0 = time.time()
            out.send(marker)
            while time.time() - t0 < 2.0:
                for msg in inp.iter_pending():
                    if (msg.type == "control_change" and msg.channel == 15
                            and msg.control == 119 and msg.value == nonce):
                        return self._json(200, {"ok": True, "loop": "intact",
                                                "roundtrip_ms": int((time.time() - t0) * 1000),
                                                "out": out.name, "inp": inp_name})
                time.sleep(0.01)
            return self._json(200, {"ok": True, "loop": "broken",
                                    "out": out.name, "inp": inp_name,
                                    "hint": "no echo — check XR18 MIDI thru, Ditto thru, "
                                            "Helix MIDI Thru, and the return cable"})
        finally:
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
        if self.path == "/xr18/set":
            osc_path = str(body.get("path") or "")
            if not osc_path.startswith("/"):
                return self._json(400, {"error": "path must start with /"})
            value = body.get("value")
            if body.get("db") is not None:
                value = db_to_fader(body["db"])
            args = [] if value is None else [value]
            r = xr_exchange(osc_path, args, expect_reply=False)
            if r is None:
                return self._json(503, {"ok": False, "error": "XR18 unreachable"})
            back = xr_exchange(osc_path)
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
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nmidi_sidecar shutting down")
