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
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import mido
except ImportError:
    print("ERROR: mido + python-rtmidi required:", file=sys.stderr)
    print("  pip3 install mido python-rtmidi", file=sys.stderr)
    sys.exit(1)

PORT = 5555

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


def get_output(needle):
    name = find_port(needle)
    if not name:
        return None
    if name not in _outputs:
        _outputs[name] = mido.open_output(name)
    return _outputs[name]


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
            return self._json(200, {"ok": True, "ports": mido.get_output_names()})
        if self.path == "/ports":
            return self._json(200, {"outputs": mido.get_output_names()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw) if raw else {}
        except Exception as e:
            return self._json(400, {"error": f"bad json: {e}"})
        if self.path == "/send":
            return self._handle_send(body)
        self._json(404, {"error": "not found"})

    def _handle_send(self, body):
        out = get_output(body.get("port"))
        if not out:
            return self._json(404, {
                "error": f'no MIDI output matching "{body.get("port")}"',
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
        return self._json(200, {"ok": True, "sent_to": out.name, "msg": str(msg)})


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
