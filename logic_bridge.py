#!/usr/bin/env python3
"""logic_bridge — HTTP daemon on :5556 that emulates a Mackie Control
surface so Claude and the portal can READ Logic Pro's mixer (track names,
meters, fader positions) and WRITE fader moves. Runs on the Performer.

Why MCU emulation instead of plain CC assignments: the Mackie Control
protocol is bidirectional. Logic streams per-strip meter levels (channel
pressure), scribble-strip text (sysex), and fader echoes (pitchbend) to
any registered control surface, which is exactly the "listen" half of
mixing. CC assignments are write-only and blind.

One-time Logic setup (by hand, once):
  Logic Pro > Settings > Control Surfaces > Setup > New > Install...
  > Mackie Designs / Mackie Control > Add.
  Set BOTH the Input Port and the Output Port to "LogicBridge Virtual".
Logic then treats the bridge as a 9-fader surface showing tracks 1-8
plus master. Keep the vocal tracks inside the first 8 tracks (or use
POST /bank) so the balance verb can see them.

Endpoints
---------
GET  /health   → { ok, ports, logic_seen, meters_streaming, ... }
GET  /tracks   → the 8 visible strips + master: name, fader dB, meter
POST /fader    → { track: 1-8 | name: "bill", delta_db: -3 | set_db: 0 }
POST /bank     → { action: bank_left|bank_right|channel_left|channel_right }
POST /balance  → { names: ["bill","matt","dan"], window_sec: 10,
                   max_db: 6, apply: true }
    Samples each named track's meter for window_sec (they must be
    singing), converts to dB, computes the median as the target, and
    trims each fader by the clamped difference. apply:false = dry run.

Offline behavior: everything here is localhost MIDI + HTTP. No Drive,
no internet. With Logic not running, endpoints answer instantly with
logic_seen:false instead of hanging.

Install: same interpreter as midi_sidecar (mido + python-rtmidi).
"""

import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import mido
except ImportError:
    print("ERROR: mido + python-rtmidi required (same install as midi_sidecar).", file=sys.stderr)
    sys.exit(1)

PORT = 5556
# "virtual" in the name is load-bearing: midi_sidecar's chain heuristics
# skip ports containing it, so the bridge can never be mistaken for the
# head of the physical DIN chain.
PORT_NAME = "LogicBridge Virtual"

# ── MCU fader taper: 14-bit position <-> dB, piecewise linear over the
# printed fader scale of a real Mackie Control (100mm, +6 at top, 0 at
# ~75% travel). Good to ~1 dB, which is enough for trims; balance
# verifies against meters, not against this curve.
FADER_ANCHORS = [(0, -72.0), (1024, -60.0), (2048, -50.0), (3072, -40.0),
                 (4608, -30.0), (6144, -20.0), (8192, -10.0), (10240, -5.0),
                 (12288, 0.0), (16383, 6.0)]


def pos_to_db(pos):
    pos = max(0, min(16383, int(pos)))
    for (p0, d0), (p1, d1) in zip(FADER_ANCHORS, FADER_ANCHORS[1:]):
        if pos <= p1:
            return round(d0 + (d1 - d0) * (pos - p0) / (p1 - p0), 1)
    return 6.0


def db_to_pos(db):
    db = max(-72.0, min(6.0, float(db)))
    for (p0, d0), (p1, d1) in zip(FADER_ANCHORS, FADER_ANCHORS[1:]):
        if db <= d1:
            return int(round(p0 + (p1 - p0) * (db - d0) / (d1 - d0)))
    return 16383


# ── MCU meter: channel pressure value = (strip << 4) | level. Levels
# 1-12 light the LED ladder; the thresholds below are the standard MCU
# segment map. 0xE marks overload, 0xF clears it.
METER_DB = {1: -60.0, 2: -48.0, 3: -42.0, 4: -36.0, 5: -30.0, 6: -24.0,
            7: -18.0, 8: -12.0, 9: -9.0, 10: -6.0, 11: -3.0, 12: 0.0}

STRIPS = 8


class Strip:
    def __init__(self, idx):
        self.idx = idx
        self.name = ""
        self.value = ""
        self.fader_pos = None
        self.meters = deque(maxlen=600)   # (t, level_idx)
        self.overload = False


class Bridge:
    def __init__(self):
        self.strips = [Strip(i) for i in range(STRIPS)]
        self.master_pos = None
        self.lcd = [" "] * 112            # 2 rows x 56 chars
        self.last_logic_at = None
        self.last_meter_at = None
        self.last_lcd_at = None
        self.log = deque(maxlen=100)
        self._write_lock = threading.Lock()
        self.inp = None
        self.out = None

    # ── ports ────────────────────────────────────────────────────────
    def open_ports(self):
        self.inp = mido.open_input(PORT_NAME, virtual=True, callback=self._on_msg)
        self.out = mido.open_output(PORT_NAME, virtual=True)
        print("logic_bridge: virtual MIDI ports '%s' open" % PORT_NAME)

    # ── inbound from Logic (host → surface) ──────────────────────────
    def _on_msg(self, msg):
        now = time.time()
        self.last_logic_at = now
        if msg.type == "aftertouch":
            strip = (msg.value >> 4) & 0x7
            lvl = msg.value & 0xF
            if lvl == 0xE:
                self.strips[strip].overload = True
            elif lvl == 0xF:
                self.strips[strip].overload = False
            else:
                self.strips[strip].meters.append((now, min(lvl, 12)))
            self.last_meter_at = now
        elif msg.type == "pitchwheel":
            pos = msg.pitch + 8192
            if msg.channel < STRIPS:
                self.strips[msg.channel].fader_pos = pos
            elif msg.channel == STRIPS:
                self.master_pos = pos
        elif msg.type == "sysex":
            self._on_sysex(msg.data)

    def _on_sysex(self, data):
        # Mackie header 00 00 66, device id, command, payload...
        if len(data) < 5 or tuple(data[:3]) != (0x00, 0x00, 0x66):
            return
        cmd = data[4]
        if cmd == 0x12 and len(data) > 6:   # LCD text: offset + chars
            off = data[5]
            for i, ch in enumerate(data[6:]):
                p = off + i
                if 0 <= p < 112:
                    self.lcd[p] = chr(ch) if 32 <= ch < 127 else " "
            row = "".join(self.lcd[:56])
            row2 = "".join(self.lcd[56:])
            for s in self.strips:
                s.name = row[s.idx * 7:(s.idx + 1) * 7].strip()
                s.value = row2[s.idx * 7:(s.idx + 1) * 7].strip()
            self.last_lcd_at = time.time()
        else:
            self.log.append({"t": round(time.time(), 2), "rx_sysex_cmd": cmd})

    # ── outbound to Logic (surface → host) ───────────────────────────
    def _send(self, msg):
        with self._write_lock:
            self.out.send(msg)

    def set_fader_pos(self, strip, pos):
        pos = max(0, min(16383, int(pos)))
        touch = 0x68 + strip
        self._send(mido.Message("note_on", channel=0, note=touch, velocity=127))
        self._send(mido.Message("pitchwheel", channel=strip, pitch=pos - 8192))
        self._send(mido.Message("note_on", channel=0, note=touch, velocity=0))
        self.strips[strip].fader_pos = pos
        self.log.append({"t": round(time.time(), 2), "fader": strip + 1,
                         "pos": pos, "db": pos_to_db(pos)})

    def bank(self, action):
        notes = {"bank_left": 0x2E, "bank_right": 0x2F,
                 "channel_left": 0x30, "channel_right": 0x31}
        n = notes.get(action)
        if n is None:
            raise ValueError("action must be one of %s" % ", ".join(sorted(notes)))
        self._send(mido.Message("note_on", channel=0, note=n, velocity=127))
        self._send(mido.Message("note_on", channel=0, note=n, velocity=0))
        self.log.append({"t": round(time.time(), 2), "bank": action})

    # ── queries ──────────────────────────────────────────────────────
    def resolve(self, body):
        """Find a strip by 1-based number or by (sub)name match."""
        if body.get("track") is not None:
            t = int(body["track"])
            if not (1 <= t <= STRIPS):
                raise ValueError("track must be 1-%d" % STRIPS)
            return self.strips[t - 1]
        needle = str(body.get("name") or "").strip().lower()
        if not needle:
            raise ValueError("need track (1-%d) or name" % STRIPS)
        hits = [s for s in self.strips
                if s.name and (needle in s.name.lower()
                               or s.name.lower() in needle)]
        if not hits:
            raise ValueError("no visible track matches %r (visible: %s)"
                             % (needle, [s.name for s in self.strips if s.name]))
        if len(hits) > 1:
            raise ValueError("%r is ambiguous: %s" % (needle, [s.name for s in hits]))
        return hits[0]

    def strip_json(self, s, now=None):
        now = now or time.time()
        recent = [l for (t, l) in s.meters if now - t <= 3.0]
        level = max(recent) if recent else 0
        return {"strip": s.idx + 1, "name": s.name, "value": s.value,
                "fader_pos": s.fader_pos,
                "fader_db": pos_to_db(s.fader_pos) if s.fader_pos is not None else None,
                "meter_level": level,
                "meter_db": METER_DB.get(level),
                "overload": s.overload,
                "meter_samples_3s": len(recent)}

    def measured_db(self, s, since):
        """Active singing level over a window: mean dB of the top half of
        the nonzero meter samples, so gaps between phrases don't drag
        the number down. None if there wasn't enough signal."""
        lvls = sorted(l for (t, l) in s.meters if t >= since and l > 0)
        if len(lvls) < 8:
            return None
        top = lvls[len(lvls) // 2:]
        return round(sum(METER_DB[l] for l in top) / len(top), 1)


bridge = Bridge()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        now = time.time()
        if self.path == "/health":
            return self._json(200, {
                "ok": True, "port_name": PORT_NAME,
                "logic_seen": bridge.last_logic_at is not None,
                "logic_age_sec": round(now - bridge.last_logic_at, 1) if bridge.last_logic_at else None,
                "meters_streaming": bool(bridge.last_meter_at and now - bridge.last_meter_at < 3.0),
                "lcd_age_sec": round(now - bridge.last_lcd_at, 1) if bridge.last_lcd_at else None,
                "log": list(bridge.log)[-15:]})
        if self.path == "/tracks":
            return self._json(200, {
                "ok": True,
                "logic_seen": bridge.last_logic_at is not None,
                "meters_streaming": bool(bridge.last_meter_at and now - bridge.last_meter_at < 3.0),
                "strips": [bridge.strip_json(s, now) for s in bridge.strips],
                "master": {"fader_pos": bridge.master_pos,
                           "fader_db": pos_to_db(bridge.master_pos) if bridge.master_pos is not None else None}})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw) if raw else {}
        except Exception as e:
            return self._json(400, {"error": "bad json: %s" % e})
        try:
            if self.path == "/fader":
                return self._fader(body)
            if self.path == "/bank":
                bridge.bank(str(body.get("action") or ""))
                time.sleep(0.4)   # let Logic repaint the scribble strips
                return self._json(200, {"ok": True,
                                        "visible": [s.name for s in bridge.strips]})
            if self.path == "/balance":
                return self._balance(body)
        except ValueError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})
        self._json(404, {"error": "not found"})

    def _fader(self, body):
        s = bridge.resolve(body)
        before = s.fader_pos
        if body.get("set_db") is not None:
            pos = db_to_pos(body["set_db"])
        elif body.get("delta_db") is not None:
            if before is None:
                raise ValueError("no known fader position for %r yet: Logic has "
                                 "not echoed it. Use set_db once, or nudge the "
                                 "on-screen fader so Logic reports it." % s.name)
            pos = db_to_pos(pos_to_db(before) + float(body["delta_db"]))
        else:
            raise ValueError("need set_db or delta_db")
        bridge.set_fader_pos(s.idx, pos)
        return self._json(200, {"ok": True, "track": s.idx + 1, "name": s.name,
                                "before_db": pos_to_db(before) if before is not None else None,
                                "after_db": pos_to_db(pos)})

    def _balance(self, body):
        names = body.get("names") or []
        if len(names) < 2:
            raise ValueError("need at least two names to balance")
        strips = [bridge.resolve({"name": n}) for n in names]
        window = min(30.0, max(3.0, float(body.get("window_sec", 10))))
        max_db = min(12.0, max(1.0, float(body.get("max_db", 6))))
        apply = body.get("apply", True)
        if not (bridge.last_meter_at and time.time() - bridge.last_meter_at < 3.0):
            raise ValueError("no meter data streaming from Logic: is Logic "
                             "running, the surface added, and audio playing?")
        t0 = time.time()
        time.sleep(window)
        measured = {s.idx: bridge.measured_db(s, t0) for s in strips}
        missing = [s.name for s in strips if measured[s.idx] is None]
        if missing:
            raise ValueError("not enough signal during the %.0fs window on: %s "
                             "(they need to be singing while balance runs)"
                             % (window, ", ".join(missing)))
        vals = sorted(measured.values())
        target = vals[len(vals) // 2]
        report = []
        for s in strips:
            delta = round(max(-max_db, min(max_db, target - measured[s.idx])), 1)
            applied = False
            if apply and abs(delta) >= 0.5 and s.fader_pos is not None:
                bridge.set_fader_pos(s.idx, db_to_pos(pos_to_db(s.fader_pos) + delta))
                applied = True
            report.append({"track": s.idx + 1, "name": s.name,
                           "measured_db": measured[s.idx], "delta_db": delta,
                           "applied": applied,
                           "fader_db": pos_to_db(s.fader_pos) if s.fader_pos is not None else None})
        return self._json(200, {"ok": True, "target_db": target,
                                "window_sec": window, "applied": bool(apply),
                                "tracks": report})


def main():
    bridge.open_ports()
    print("logic_bridge listening on http://127.0.0.1:%d" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nlogic_bridge shutting down")
