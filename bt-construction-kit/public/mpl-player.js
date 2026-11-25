/* mpl-player.js — the MPL Player panel in the Performer (Bill 2026-11-23).

   A small panel, bottom left, shown while the loaded song has an MPL file. It is the MIDI console's
   bank in miniature, for the song that is playing: every row of the song's MPL (the song, its
   sections, their phrases, the parts) has a button and, for the first 36, its key 0-9 / A-Z.

   Pressing a row's button (or its key, while "Keys" is lit) starts or stops that piece, a cycle at a time:
     · a piece the song is playing drops out from its next cycle; pressed again it comes back at its next cycle.
       Everything a dropped row calls or starts is silent with it.
     · a part the song is playing while its strip still plays the stem: the MPL takes over that strip.
     · a piece the song is not playing loops on top, in time with the song, from the next bar; pressed
       again it stops at the end of its cycle. Loops layer, and sound with the stems at the strip's level.
   Each row also carries the MIDI console's row buttons:
     ⬇ ⬆   the row's own notes an octave down / up (drum notes and the rows it calls are left alone)
     −\ +\  every note of the row 1/24 beat earlier / later
     🤖     ask the AI to change the row        🗑  clear it to rests of the same length (↶ puts it back)
     ➜     copy it, with the rows it calls, to the Favorites bank of the MIDI console
     level  the row's level and that of everything under it (75 = as written; double-click = 75)
     ◀ ▶   play it backwards / forwards: the lit one stops it, the other turns it round at its next cycle
     M S    mute / solo the row and everything it calls or starts, at once
   "Reset" stops every loop, brings every row back and clears M, S, backwards and the levels.

   "Edit" opens the row editor for the selected row (click a row's name, or pick a strip to follow the
   row that strip is playing): the row's MPL text, for drums a sixteen-step grid, and Ask AI. A change
   is checked as it is made and takes over at the row's next cycle (at once when the song is stopped
   or the row has no further cycle). Undo, Revert row, Save: nothing is written until Save, which sends
   the changed rows to PUT /api/song/:base/mpl; the file as it was is kept in <song>_MPL.orig.json.
   A row is shared by every place that calls it, so a change is heard everywhere that row is used.

   Needs mpl-core.js (mplParse) and mpl-drums.js (mplDrums, mplLive, mplDrumsBuild, mplDrumsRebuild,
   mplDrumsClock, mplDrumsF, the strip toggles).

   The same controls for one sequence — octave, direction, text, Ask AI — also sit on each fader strip
   while that strip plays its MPL in place of its stem (see "MPL controls on the faders" below). */
(function () {
  'use strict';
  const STRIPS = ['drums', 'vocals', 'bass', 'guitar', 'piano', 'other'];
  const STRIP_CH = { drums: 10, vocals: 11, bass: 13, guitar: 14, piano: 15, other: 16 };
  const LABEL = { drums: 'Drums', vocals: 'Vocals', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other' };
  const DRUM_NAMES = { 35: 'Kick 2', 36: 'Kick', 37: 'Side stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Floor tom lo', 42: 'Closed hat',
    43: 'Floor tom hi', 44: 'Pedal hat', 45: 'Low tom', 46: 'Open hat', 47: 'Mid tom', 48: 'Hi-mid tom', 49: 'Crash', 50: 'High tom', 51: 'Ride',
    53: 'Ride bell', 54: 'Tambourine', 55: 'Splash', 56: 'Cowbell' };
  const GRID_DEFAULT = [49, 46, 42, 38, 36];                        // rows always offered: crash, open hat, closed hat, snare, kick
  const GRID_ORDER = [49, 55, 51, 53, 46, 44, 42, 54, 56, 50, 48, 47, 45, 43, 41, 39, 37, 40, 38, 35, 36];
  const SEMI = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /* ── the parts that need no page (also run by the node test) ───────────────────────────── */

  /* MIDI note → MPL: a bare letter is octave 2 (C = 36), + and - move it an octave */
  function noteName(n) {
    const sh = Math.floor(n / 12) - 3, name = SEMI[((n % 12) + 12) % 12];
    return Math.abs(sh) <= 3 ? name + (sh > 0 ? '+' : '-').repeat(Math.abs(sh)) : name + (Math.floor(n / 12) - 1);
  }
  /* a row as timed notes, the way mplDrumsBuild walks it: { events: [{ b, notes, dyns }], beats, launches }
     (dyns: per note, 1..3 louder ^, -1..-3 softer v, 0 plain) */
  function rowEvents(parse, src, get, id) {
    const toks = parse(src, get, new Set([id]));
    const events = []; let beat = 0, sticky = 0, launches = false;
    for (const t of toks) {
      if (t.launch != null) { launches = true; continue; }
      if (t.ch || t.pc != null) continue;
      if (t.feelSet != null) { sticky = t.feelSet; continue; }
      if (t.note == null && !t.notes && !t.rest) continue;
      if (!t.rest) events.push({ b: beat + (t.feel != null ? t.feel : sticky) / 24, notes: t.notes ? t.notes.slice() : [t.note],
                                 dyns: t.notes ? (t.dyns ? t.dyns.slice() : t.notes.map(() => t.dyn || 0)) : [t.dyn || 0] });
      beat += t.dur || 1;
    }
    return { events, beats: beat, launches };
  }
  /* timed notes → sixteenth steps: { steps, cells: Map(note → Map(step → dyn)), exact } — exact is
     false when something would be lost by writing the row from the grid (notes off the sixteenth grid) */
  function gridOf(ev) {
    const steps = Math.round(ev.beats * 4), cells = new Map();
    let exact = Math.abs(ev.beats * 4 - steps) < 1e-6 && !ev.launches;
    for (const e of ev.events) {
      const st = Math.round(e.b * 4);
      if (Math.abs(e.b * 4 - st) > 1e-6) exact = false;
      if (st < 0 || st >= steps) { exact = false; continue; }
      e.notes.forEach((n, k) => { if (!cells.has(n)) cells.set(n, new Map()); cells.get(n).set(st, e.dyns[k] || 0); });
    }
    return { steps, cells, exact };
  }
  /* the loop lengths (in steps) the grid may show: whole bars that divide the row and repeat through it */
  function unitsOf(g) {
    const out = [];
    for (let u = 16; u < g.steps; u *= 2) {
      if (g.steps % u) continue;
      let periodic = true;
      for (const map of g.cells.values()) { for (const [st, dy] of map) if (map.get((st + u) % g.steps) !== dy) { periodic = false; break; } if (!periodic) break; }
      if (periodic) out.push(u);
    }
    out.push(g.steps);
    return out;
  }
  /* the tokens in front of a row that take no time: channel, program, controllers */
  function prefixOf(src) {
    const m = /^\s*((?:(?:m\d{1,2}|p\d{1,3}|c\d{1,3}=\d{1,3})\s*,\s*)*)/.exec(String(src || ''));
    return m ? m[1].replace(/\s+/g, '') : '';
  }
  /* the grid → one MPL row: the loop written once in sixteenths and repeated */
  function gridToSrc(prefix, g, unit) {
    const u = Math.max(1, Math.min(unit || g.steps, g.steps)), reps = Math.round(g.steps / u), toks = [];
    for (let st = 0; st < u; st++) {
      const ns = [...g.cells.keys()].filter(n => g.cells.get(n).has(st)).sort((a, b) => a - b)
        .map(n => { const dy = g.cells.get(n).get(st); return noteName(n) + (dy > 0 ? '^'.repeat(dy) : dy < 0 ? 'v'.repeat(-dy) : ''); });
      toks.push(!ns.length ? 'R' : ns.length === 1 ? ns[0] : '|' + ns.join(',') + '|');
    }
    return (prefix || 'm10,') + (reps > 1 ? reps : '') + 's(' + toks.join(',') + ')';
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { noteName, rowEvents, gridOf, unitsOf, prefixOf, gridToSrc }; }
  if (typeof document === 'undefined') return;

  /* ── the panel ─────────────────────────────────────────────────────────────────────────── */
  const S = { open: false, edit: false, keys: false, strip: 'drums', follow: false, id: null, undo: [], dirty: new Map(),
              pendSrc: new Map(),      // row → { src, at }: text that takes over at song time `at`
              pendState: new Map(),    // row → { off, at }: drops out / comes back at song time `at`
              pendDir: new Map(),      // row → { rev, at }: turns round at song time `at`
              stash: new Map(),        // row → its text before 🗑
              unit: 0, folder: null, built: null, idx: null, len: new Map(), rows: [], rowsFor: null,
              err: '', warn: '', note: '', typedAt: 0, aiBusy: false, grid: null, cols: [], lastCol: -1 };
  try { S.open = localStorage.getItem('performer.mplPlayer.open') === '1'; } catch (e) {}
  let el = null, typeTimer = null;
  const song = () => (typeof mplDrums !== 'undefined' && mplDrums && mplDrums.bank && typeof currentSong !== 'undefined' && currentSong
                      && currentSong.type === 'stems' && mplDrums.folder === currentSong.folderName) ? mplDrums : null;
  const toast = (m) => { try { showToast(m, 5000); } catch (e) {} };
  const slotCh = (s) => +s.channel || +((/^\s*m(\d{1,2})\b/.exec(String(s.src || '')) || [])[1] || 0) || null;
  const stripOf = (s) => (s && (s.role === 'part' || !s.role)) ? (STRIPS.find(x => STRIP_CH[x] === slotCh(s)) || null) : null;
  const heard = (strip) => (strip === 'drums' && mplDrumsActive) || mplStripMode(strip) !== 'off';
  const curSrc = (m, id) => S.pendSrc.has(id) ? S.pendSrc.get(id).src : String(m.bank.slots[id].src || '');
  function getter(bank) {
    const slots = bank.slots || [], byName = new Map();
    slots.forEach((s, i) => { if (s && s.name) byName.set(String(s.name).toLowerCase(), i); });
    return (key) => {
      const k = String(key).trim().toLowerCase();
      const i = byName.has(k) ? byName.get(k) : (/^\d$/.test(k) ? slots.findIndex(s => s && String(s.key) === k) : -1);
      return i >= 0 && slots[i] ? { src: String(slots[i].src || ''), id: i } : null;
    };
  }
  const posNow = () => { const c = mplDrumsClock(), ae = mplDrumsMaster(); return c ? c.pos : ae ? (ae.currentTime || 0) : 0; };
  /* the same, but never before the first bar: a song waiting at 0:00 is "in" its first rows */
  const posIn = (m) => Math.max(posNow(), timeAt(m, 0));
  /* how far ahead of the playhead a change has to lie to be sure no note of it is already on its way */
  const margin = (rate) => ((document.hidden ? 1500 : 320) + 130) / 1000 * (rate || 1);
  function beatAt(m, pos) {                                  // song time → MPL beat
    const bt = m.beatT;
    if (!bt) return (pos - m.t0) * m.bpm / 60;
    if (pos <= bt[0]) return (pos - bt[0]) / Math.max(1e-6, bt[1] - bt[0]);
    let lo = 0, hi = bt.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bt[mid] <= pos) lo = mid; else hi = mid - 1; }
    const nx = lo + 1 < bt.length ? bt[lo + 1] : bt[lo] + (bt[lo] - bt[lo - 1]);
    return lo + (pos - bt[lo]) / Math.max(1e-6, nx - bt[lo]);
  }
  function timeAt(m, b) {                                    // MPL beat → song time (as mplDrumsBuild places it)
    const bt = m.beatT;
    if (!bt) return m.t0 + b * 60 / m.bpm;
    const n = bt.length - 1;
    if (b <= 0) return bt[0] + b * (bt[1] - bt[0]);
    if (b >= n) return bt[n] + (b - n) * (bt[n] - bt[n - 1]);
    const i = Math.floor(b);
    return bt[i] + (b - i) * (bt[i + 1] - bt[i]);
  }
  /* the passes of every row, by row and (for parts) by strip — kept until the song is built again */
  function index(m) {
    if (S.built === m && S.idx) return S.idx;
    const byId = new Map(), byStrip = {};
    for (const sp of m.spans || []) {
      if (!byId.has(sp.id)) byId.set(sp.id, { song: [], ov: [] });
      byId.get(sp.id)[sp.ov ? 'ov' : 'song'].push(sp);
      if (!sp.ov) { const strip = stripOf(m.bank.slots[sp.id]); if (strip) (byStrip[strip] || (byStrip[strip] = [])).push(sp); }
    }
    S.built = m; S.idx = { byId, byStrip }; S.len = new Map();
    return S.idx;
  }
  const passes = (m, id) => index(m).byId.get(id) || { song: [], ov: [] };
  const passAt = (list, pos) => list.find(sp => sp.t0 <= pos + 0.02 && pos < sp.t1 + 0.02) || null;
  function rowLen(m, id) {
    if (!S.len.has(id)) { let n = 0; try { n = rowEvents(mplParse, curSrc(m, id), getter(m.bank), id).beats; } catch (e) {} S.len.set(id, n); }
    return S.len.get(id);
  }
  /* song time at which this row next starts a cycle that is still wholly ahead, or null */
  function nextCycle(m, id, pos, rate) {
    const p = passes(m, id), lim = pos + margin(rate);
    let t = null;
    for (const sp of p.song.concat(p.ov)) if (sp.t0 > lim && (t == null || sp.t0 < t)) t = sp.t0;
    return t;
  }
  function spanNow(m, strip) {
    const list = index(m).byStrip[strip] || [], pos = posNow();
    let cur = list[0] || null;
    for (const sp of list) { if (sp.t0 <= pos + 0.02) cur = sp; else break; }
    return cur;
  }
  function sectionNow(m) {
    const secs = m.bank.sections || [], pos = posNow();
    let k = -1;
    secs.forEach((s, i) => { if (+s.t0 <= pos + 0.02) k = i; });
    return k < 0 ? '' : (secs[k].kind || secs[k].row || 'Section') + ' (' + (k + 1) + ' of ' + secs.length + ')';
  }
  function rebuild(m) {                                      // after a switch: build again, keeping what is already sounding
    const beat = beatAt(m, posNow());
    mplLive.ov = mplLive.ov.filter(o => o.b1 === Infinity || o.b1 > beat - 1e-6);   // loops that have ended are forgotten
    try { mplDrumsRebuild(m.bank, true); return true; } catch (e) { S.note = 'Could not switch: ' + ((e && e.message) || e); return false; }
  }

  /* ── start / stop a piece ──────────────────────────────────────────────────────────────── */
  function press(id) {
    const m = song(); if (!m || !m.bank.slots[id]) return;
    const slot = m.bank.slots[id], c = mplDrumsClock(), pos = posNow(), rate = c ? c.rate : 1;
    // a loop of this row is running, or waiting for its bar: stop it at the end of its cycle
    const ov = mplLive.ov.find(o => o.id === id && o.b1 === Infinity);
    if (ov) {
      const len = rowLen(m, id), ahead = beatAt(m, pos + (c ? margin(rate) : 0));
      if (!c || ahead <= ov.b0 || !(len > 0)) mplLive.ov.splice(mplLive.ov.indexOf(ov), 1);
      else ov.b1 = ov.b0 + Math.ceil((ahead - ov.b0) / len - 1e-6) * len;
      rebuild(m); return;
    }
    if (S.pendState.has(id)) { S.pendState.delete(id); return; }               // changed your mind before the cycle came round
    const flip = (off) => {
      const at = c ? nextCycle(m, id, pos, rate) : null;
      if (c) S.pendState.set(id, { off, at: at != null ? at : timeAt(m, Math.ceil(beatAt(m, pos + margin(rate)) / m.bpb) * m.bpb) });   // no cycle left: the next bar
      else { if (off) mplLive.off.add(id); else mplLive.off.delete(id); rebuild(m); }
    };
    if (mplLive.off.has(id)) { flip(false); return; }                           // dropped out: back at its next cycle
    if (passAt(passes(m, id).song, posIn(m))) {                                 // the song is playing it
      const strip = stripOf(slot);
      if (strip && !heard(strip)) { try { if (strip === 'drums') mplDrumsStripOn(false); else mplPartOn(strip, false); } catch (e) {} return; }   // the stem was playing: the MPL takes over
      if (!strip && !STRIPS.some(heard)) { toast('No strip is playing its MPL yet — press a part here, or an MPL button on a fader.'); return; }
      flip(true); return;
    }
    // not in the song now: loop it on top from the next bar
    if (!(rowLen(m, id) > 0)) { toast(slot.name + ' has no length to loop.'); return; }
    const from = beatAt(m, pos + (c ? margin(rate) : 0));
    mplLive.ov.push({ id, b0: Math.max(0, Math.ceil(from / m.bpb - 1e-6) * m.bpb), b1: Infinity });
    if (!rebuild(m)) mplLive.ov.pop();
  }
  function resetAll() {
    const m = song(); if (!m) return;
    mplLive.off.clear(); mplLive.ov.length = 0; mplLive.mute.clear(); mplLive.solo.clear(); mplLive.rev.clear(); mplLive.vol.clear();
    S.pendState.clear(); S.pendDir.clear(); S.rowsFor = null;
    rebuild(m); S.note = 'Every loop stopped; every row is back in the song, forwards, unmuted, at its written level.';
  }
  const nextBarT = (m, pos, rate) => timeAt(m, Math.ceil(beatAt(m, pos + margin(rate)) / m.bpb) * m.bpb);
  /* is this row sounding: 'loop' (on top), 'song' (the song is playing it and it is heard), 'stem' (in the song, its strip plays the stem), '' */
  function running(m, id) {
    if (mplLive.ov.some(o => o.id === id && o.b1 === Infinity)) return 'loop';
    if (mplLive.off.has(id) || !passAt(passes(m, id).song, posIn(m))) return '';
    const strip = stripOf(m.bank.slots[id]);
    return (strip ? heard(strip) : STRIPS.some(heard)) ? 'song' : 'stem';
  }
  /* ◀ ▶ : the lit one stops the row, the other turns it round at its next cycle; a row that is not sounding starts that way round */
  function direction(id, wantRev) {
    const m = song(); if (!m || !m.bank.slots[id]) return;
    const run = running(m, id), pd = S.pendDir.get(id);
    if (run === 'loop' || run === 'song') {
      if (pd) { if (pd.rev !== wantRev) S.pendDir.delete(id); return; }           // already waiting to turn; the other button takes it back
      if (mplLive.rev.has(id) === wantRev) { press(id); return; }
      const c = mplDrumsClock();
      if (c) { const at = nextCycle(m, id, c.pos, c.rate); S.pendDir.set(id, { rev: wantRev, at: at != null ? at : nextBarT(m, c.pos, c.rate) }); }
      else { if (wantRev) mplLive.rev.add(id); else mplLive.rev.delete(id); rebuild(m); }
      return;
    }
    S.pendDir.delete(id);
    if (mplLive.rev.has(id) !== wantRev) { if (wantRev) mplLive.rev.add(id); else mplLive.rev.delete(id); rebuild(m); }
    press(id);
  }
  function toggleIn(set, id) {                               // M and S: at once
    const m = song(); if (!m) return;
    if (set.has(id)) set.delete(id); else set.add(id);
    rebuild(m);
  }
  let volTimer = null;
  function setVol(id, v) {
    v = Math.max(0, Math.min(100, Math.round(+v) || 0));
    if (v === 75) mplLive.vol.delete(id); else mplLive.vol.set(id, v);
    clearTimeout(volTimer);
    volTimer = setTimeout(() => { const m = song(); if (m) rebuild(m); }, 120);
  }
  const NOTE_SPEC_RE = /^([A-G](?:#|b)?)(\d?)([+\-]*)((?:m!|!)?[ehqsw]?\.?[\/\\|^v]*)$/;
  const said = (id, text) => { S.note = text + (S.pendSrc.has(id) ? ' From its next cycle.' : ''); if (S.id === id) show(id); };
  /* ⬆ ⬇ : the row's own notes an octave up or down; drum notes and the rows it calls are left alone */
  function octave(id, dir) {
    const m = song(); if (!m) return;
    const src = curSrc(m, id), name = m.bank.slots[id].name;
    let toks;
    try { toks = mplParse(src, getter(m.bank), new Set([id])); } catch (e) { S.note = name + ': ' + e.message + ' — fix it first.'; return; }
    let ch = slotCh(m.bank.slots[id]) || 11, drums = 0, called = 0;
    const spans = new Map();
    for (const t of toks) {
      if (t.ch) { ch = t.ch; continue; }
      if (t.note == null && !t.notes) continue;
      if (t.cslot != null) { called++; continue; }
      if (ch === 10) { drums++; continue; }
      if (t.s != null) spans.set(t.s, t.e);
    }
    if (!spans.size) { S.note = drums ? name + ' is drums — not shifted: moving drum notes changes the instrument.' : name + ' has no notes of its own to shift' + (called ? ' — shift the rows it calls.' : '.'); return; }
    const shift = (nm, digit, marks) => {                    // one pitch, or null at the limit
      if (digit !== '') { const d = +digit + dir; return d < 0 || d > 9 ? null : nm + d + marks; }
      const net = [...marks].reduce((n, c) => n + (c === '+' ? 1 : -1), 0) + dir;
      return Math.abs(net) > 5 ? null : nm + (net > 0 ? '+'.repeat(net) : '-'.repeat(-net));
    };
    let out = src, n = 0, bad = 0;
    for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) {
      const txt = src.slice(a, b);
      let nw = null;
      if (txt[0] === '|') {                                  // a stack: every note between the bars
        const close = txt.indexOf('|', 1);
        if (close > 0) {
          let ok = true;
          const inner = txt.slice(1, close).replace(/([A-G](?:#|b)?)(\d?)([+\-]*)/g, (all, nm, dg, mk) => { const x = shift(nm, dg, mk); if (x == null) { ok = false; return all; } return x; });
          if (ok) nw = '|' + inner + txt.slice(close);
        }
      } else {
        const mm = NOTE_SPEC_RE.exec(txt);
        if (mm) { const x = shift(mm[1], mm[2], mm[3]); if (x != null) nw = x + mm[4]; }
      }
      if (nw == null) { bad++; continue; }
      out = out.slice(0, a) + nw + out.slice(b); n++;
    }
    if (bad || !n) { S.note = name + ' not shifted — ' + (bad ? bad + ' note(s) are already at the limit.' : 'nothing to shift.'); return; }
    if (apply(id, out, {})) said(id, (dir > 0 ? '⬆ ' : '⬇ ') + name + (dir > 0 ? ' up' : ' down') + ' an octave: ' + n + ' note' + (n === 1 ? '' : 's') + (called ? ' · the rows it calls are left alone' : '') + '.');
    else S.note = name + ' not shifted — ' + S.err;
  }
  /* −\ +\ : every note of the row 1/24 beat earlier or later (limit //// and \\\\) */
  function feel(id, dir) {
    const m = song(); if (!m) return;
    const src = curSrc(m, id), name = m.bank.slots[id].name;
    let toks;
    try { toks = mplParse(src, getter(m.bank), new Set([id])); } catch (e) { S.note = name + ': ' + e.message + ' — fix it first.'; return; }
    const spans = new Map(); let called = 0;
    for (const t of toks) { if (t.note == null && !t.notes) continue; if (t.cslot != null) { called++; continue; } if (t.s != null) spans.set(t.s, t.e); }
    if (!spans.size) { S.note = name + ' has no notes of its own to move' + (called ? ' — use the buttons on the rows it calls.' : '.'); return; }
    let out = src, n = 0, atLimit = 0;
    for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) {
      const txt = src.slice(a, b);
      const mm = txt[0] === '|' ? /^(\|[^|]*\|[ehqsw]?\.?)([\/\\|]*)$/.exec(txt) : /^([A-G](?:#|b)?\d?[+\-]*(?:m!|!)?[ehqsw]?\.?)((?:[\/\\|^v])*)$/.exec(txt);
      if (!mm) continue;
      const dyn = mm[2].replace(/[\/\\|]/g, '');
      const net = mm[2].includes('|') ? 0 : (mm[2].match(/\\/g) || []).length - (mm[2].match(/\//g) || []).length;
      const nw = Math.max(-4, Math.min(4, net + dir));
      if (nw === net) { atLimit++; continue; }
      out = out.slice(0, a) + mm[1] + (nw > 0 ? '\\'.repeat(nw) : '/'.repeat(-nw)) + dyn + out.slice(b); n++;
    }
    if (!n) { S.note = name + ': every note is already at the limit.'; return; }
    if (apply(id, out, {})) said(id, name + ': ' + n + ' note' + (n === 1 ? '' : 's') + ' 1/24 beat ' + (dir > 0 ? 'later' : 'earlier') + (atLimit ? ' · ' + atLimit + ' already at the limit' : '') + '.');
    else S.note = name + ' not changed — ' + S.err;
  }
  const restsFor = (L) => {                                  // silence of L beats
    const out = [];
    const w = Math.floor(L / 4 + 1e-9); let rem = L - 4 * w;
    if (w) out.push((w > 1 ? w : '') + 'Rw');
    const q = Math.floor(rem + 1e-9); rem -= q;
    if (q) out.push((q > 1 ? q : '') + 'R');
    const e = Math.floor(rem / 0.5 + 1e-9); rem -= e * 0.5;
    if (e) out.push('Re');
    const x = Math.round(rem / 0.25);
    if (x > 0) out.push((x > 1 ? x : '') + 'Rs');
    return out.join(',');
  };
  /* 🗑 : the row becomes rests of the same length, so the song still lines up; pressed again (↶) its text comes back */
  function trash(id) {
    const m = song(); if (!m) return;
    const name = m.bank.slots[id].name, cur = curSrc(m, id);
    if (S.stash.has(id)) {
      const old = S.stash.get(id); S.stash.delete(id);
      if (apply(id, old, {})) said(id, '↶ ' + name + ' is back.'); else S.note = name + ' not restored — ' + S.err;
      return;
    }
    const L = beatsOf(m, id, cur);
    if (!(L > 0)) { S.note = name + ' has no length to clear.'; return; }
    if (apply(id, prefixOf(cur) + restsFor(L), {})) { S.stash.set(id, cur); said(id, '🗑 ' + name + ' cleared to rests of the same length · ↶ puts it back.'); }
    else S.note = name + ' not cleared — ' + S.err;
  }
  /* ➜ : copy the row, with the rows it calls, to the MIDI console's Favorites bank */
  const CALL_RE = /@(\d|[A-Za-z][A-Za-z0-9_]{0,47})/g, FAV_FILE = 'favorites.mpl-bank.json';
  async function copyFav(id) {
    const m = song(); if (!m) return;
    const get = getter(m.bank), slots = m.bank.slots;
    const rows = [], post = [], seen = new Set();
    const walk = (k) => {
      if (seen.has(k)) return;
      seen.add(k); rows.push(k);
      for (const mm of curSrc(m, k).matchAll(CALL_RE)) { const g = get(mm[1]); if (g && g.id !== k && String(slots[g.id].src || '').trim()) walk(g.id); }
      post.push(k);
    };
    walk(id);
    let bank;
    try { bank = await fetch('/mpl-banks/' + FAV_FILE, { cache: 'no-store' }).then(x => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); }); }
    catch (e) { S.note = 'Could not read the Favorites bank: ' + e.message; paint(); return; }
    if (!Array.isArray(bank.slots)) bank.slots = [];
    const there = (n) => bank.slots.find(x => String(x.name || '').trim().toLowerCase() === n.toLowerCase());
    const newName = new Map(), reuse = new Set();
    for (const k of rows) newName.set(k, String(slots[k].name || '').trim() || ('seq' + k));
    const rewrite = (k) => curSrc(m, k).replace(CALL_RE, (all, ref) => { const g = get(ref); return g && g.id !== k && newName.get(g.id) ? '@' + newName.get(g.id) : all; });
    for (const k of post) {                                  // called rows first, so a renamed row is called by its new name
      const base = newName.get(k), text = rewrite(k);
      let n = base, c = 1;
      for (;;) {
        const x = there(n), mine = [...newName].some(([q, v]) => q !== k && v && v.toLowerCase() === n.toLowerCase());
        if (x && x.src === text && !mine) { reuse.add(k); break; }              // already there, the same sequence
        if (!x && !mine) break;
        n = base.slice(0, 44) + '_' + (++c);
      }
      newName.set(k, n);
    }
    const add = rows.filter(k => !reuse.has(k));
    if (!add.length) { S.note = '⭐ ' + slots[id].name + ' is already in Favorites — nothing new to copy.'; paint(); return; }
    for (const k of add) bank.slots.push({ name: newName.get(k), src: rewrite(k), velocity: 100 });
    if (!bank.format) bank.format = 'simplestem-mpl-bank';
    if (!bank.bpm) bank.bpm = Math.round(m.bpm) || 120;
    try {
      const x = await fetch('/api/mpl/banks/' + encodeURIComponent(FAV_FILE), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bank) });
      const j = await x.json().catch(() => ({ ok: false, error: 'HTTP ' + x.status }));
      if (!j.ok) throw new Error(j.error || 'HTTP ' + x.status);
      S.note = '⭐ copied ' + slots[id].name + (add.length > 1 ? ' and ' + (add.length - 1) + ' row' + (add.length > 2 ? 's' : '') + ' it calls' : '') + ' to Favorites (MIDI console)'
        + (reuse.size ? ' · ' + reuse.size + ' already there' : '') + '.';
    } catch (e) { S.note = 'Not copied — Favorites was not written: ' + ((e && e.message) || e); }
    paint();
  }
  /* ≡ : the selected row's text with each sequence group on its own line, or joined again; it plays the same */
  function splitText(src) {
    const flat = src.replace(/\s*\n\s*/g, ''), items = [];
    let depth = 0, inStack = false, cur = '';
    for (let k = 0; k < flat.length; k++) {
      const c = flat[k];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '|') { if (inStack) inStack = false; else if (/[A-G]/.test(flat[k + 1] || '') && (k === 0 || /[,(\d]/.test(flat[k - 1]))) inStack = true; }
      if (c === ',' && depth === 0 && !inStack) { items.push(cur); cur = ''; } else cur += c;
    }
    items.push(cur);
    const lines = []; let run = [];
    for (const it of items) { if (it.includes('(')) { if (run.length) { lines.push(run.join(',')); run = []; } lines.push(it); } else run.push(it); }
    if (run.length) lines.push(run.join(','));
    return lines.join(',\n');
  }
  function splitRow() {
    const m = song(); if (!m || S.id == null) return;
    const id = S.id, src = curSrc(m, id), name = m.bank.slots[id].name, isSplit = /\n/.test(src);
    const out = isSplit ? src.replace(/\s*\n\s*/g, '') : splitText(src);
    if (out === src) { S.note = name + ' has no sequence groups to split — it is one line already.'; return; }
    const sig = (t) => { try { return JSON.stringify(mplParse(t, getter(m.bank), new Set([id])).map(x => [x.note, x.notes, x.rest, x.dur, x.feel, x.dyn, x.ch, x.pc, x.launch])); } catch (e) { return 'ERR ' + e.message; } };
    if (sig(out) !== sig(src)) { S.note = name + ' not ' + (isSplit ? 'joined' : 'split') + ' — it would not play the same.'; return; }
    if (apply(id, out, {})) said(id, isSplit ? '≡ ' + name + ' joined back into one line.' : '≡ ' + name + ' split into ' + out.split('\n').length + ' lines, one sequence group each.');
  }
  /* the switches that were waiting for a cycle to come round */
  function pump() {
    const m = song(); if (!m || (!S.pendSrc.size && !S.pendState.size && !S.pendDir.size)) return;
    const c = mplDrumsClock(), F = mplDrumsF;
    const reach = (!c || c.L > 0) ? Infinity : (F.tag && F.hz != null ? F.hz : c.pos + 0.32 * c.rate) + 0.06 * c.rate;
    const keep = new Map(); let changed = false;
    for (const [id, p] of S.pendState) if (p.at <= reach) { if (p.off) mplLive.off.add(id); else mplLive.off.delete(id); S.pendState.delete(id); changed = true; }
    for (const [id, p] of S.pendDir) if (p.at <= reach) { if (p.rev) mplLive.rev.add(id); else mplLive.rev.delete(id); S.pendDir.delete(id); changed = true; }
    for (const [id, p] of S.pendSrc) if (p.at <= reach) { keep.set(id, m.bank.slots[id].src); m.bank.slots[id].src = p.src; S.pendSrc.delete(id); changed = true; }
    if (keep.size) S.note = [...keep.keys()].map(id => m.bank.slots[id].name).join(', ') + ': the new text is playing.';
    if (!changed) return;
    if (!rebuild(m)) { for (const [id, src] of keep) m.bank.slots[id].src = src; return; }
    if (keep.has(S.id)) drawGrid();
  }
  setInterval(() => { try { pump(); } catch (e) { console.warn('[mpl-player] pump', e); } }, 25);

  window.addEventListener('keydown', (e) => {                // armed: 0-9 and A-Z are the rows' keys
    const m = song();
    if (!S.keys || !m || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    const k = e.key && e.key.length === 1 ? e.key.toUpperCase() : '';
    if (!/^[0-9A-Z]$/.test(k)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const i = m.bank.slots.findIndex(s => s && String(s.key == null ? '' : s.key).toUpperCase() === k);
    if (i >= 0) { press(i); paint(); }
  }, true);

  /* ── the page ──────────────────────────────────────────────────────────────────────────── */
  const mk = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };
  const btnCss = 'padding:4px 9px;border-radius:5px;border:1px solid #4b3b6b;background:#221a33;color:#e6defa;cursor:pointer;font:12px system-ui,sans-serif';
  function build() {
    el = { box: mk('div', 'position:fixed;left:12px;bottom:12px;z-index:9000;width:min(790px,calc(100vw - 24px));max-height:78vh;display:none;flex-direction:column;' +
                         'background:#15131c;color:#e6e6e6;border:1px solid #c084fc;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.55);font:13px/1.35 system-ui,sans-serif') };
    el.box.id = 'mpl-player-panel';
    el.head = mk('div', 'padding:7px 10px;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    el.head.title = 'MPL Player: start and stop the pieces of this song\'s MPL, and change them, while it plays. Click to fold or unfold.';
    el.head.addEventListener('click', () => { S.open = !S.open; try { localStorage.setItem('performer.mplPlayer.open', S.open ? '1' : '0'); } catch (e) {} paint(true); });
    el.body = mk('div', 'padding:0 10px 10px;overflow:auto;border-top:1px solid #2c2540;display:flex;flex-direction:column;gap:7px');
    // the bar: Keys, Reset, Edit, Save
    el.bar = mk('div', 'display:flex;gap:6px;align-items:center;padding-top:8px');
    el.keys = mk('button', btnCss); el.keys.type = 'button';
    el.keys.title = 'Lit: the keys 0-9 and A-Z start and stop the rows that carry them, and the Performer\'s own number and letter shortcuts are paused (Space still plays and pauses).';
    el.keys.addEventListener('click', () => { S.keys = !S.keys; el.keys.blur(); paint(); });
    el.reset = mk('button', btnCss, 'Reset'); el.reset.type = 'button';
    el.reset.title = 'Stop every loop, bring every dropped row back, and clear M, S, backwards and the levels.';
    el.reset.addEventListener('click', () => { resetAll(); paint(); });
    el.hint = mk('span', 'flex:1;color:#b9b2cc;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'Press a row: start / stop that piece, a cycle at a time.');
    el.editBtn = mk('button', btnCss); el.editBtn.type = 'button';
    el.editBtn.title = 'Show or hide the editor for the selected row (text, drum grid, Ask AI).';
    el.editBtn.addEventListener('click', () => { S.edit = !S.edit; if (S.edit && S.id == null) { S.follow = true; } paint(true); });
    el.save = mk('button', btnCss + ';border-color:#c084fc;font-weight:600', 'Save'); el.save.type = 'button';
    el.save.title = 'Write the changed rows to the song\'s MPL file. The file as it was is kept as <song>_MPL.orig.json.';
    el.save.addEventListener('click', save);
    el.bar.append(el.keys, el.reset, el.hint, el.editBtn, el.save);
    // the rows
    el.rows = mk('div', 'max-height:206px;overflow:auto;border:1px solid #2c2540;border-radius:6px;padding:3px');
    // the editor
    el.editor = mk('div', 'display:flex;flex-direction:column;gap:7px');
    el.strips = mk('div', 'display:flex;gap:5px;flex-wrap:wrap;align-items:center');
    el.stripBtn = {};
    for (const st of STRIPS) {
      const b = mk('button', btnCss, LABEL[st]); b.type = 'button';
      b.addEventListener('click', () => { S.strip = st; S.follow = true; S.id = null; paint(true); });
      el.stripBtn[st] = b; el.strips.appendChild(b);
    }
    el.hear = mk('button', btnCss + ';margin-left:auto'); el.hear.type = 'button';
    el.hear.title = 'What this strip plays: its stem, the MPL in its place, or both. Click to switch; Option-click for both.';
    el.hear.addEventListener('click', (e) => { try { if (S.strip === 'drums') toggleMplDrumsStrip(e.altKey); else mplPartToggle(S.strip, e.altKey); } catch (x) {} paint(); });
    el.strips.appendChild(el.hear);
    el.now = mk('div', 'display:flex;gap:8px;align-items:center;color:#b9b2cc;font-size:12px');
    el.nowText = mk('span', 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    el.follow = mk('button', btnCss); el.follow.type = 'button';
    el.follow.title = 'Following: the editor shows the row the chosen strip is playing now. Pinned: it stays on the row you picked.';
    el.follow.addEventListener('click', () => { S.follow = !S.follow; paint(true); });
    el.now.append(el.nowText, el.follow);
    el.text = mk('textarea', 'width:100%;box-sizing:border-box;min-height:54px;resize:vertical;background:#0d0b13;color:#f2ecff;border:1px solid #4b3b6b;border-radius:5px;' +
                             'padding:6px 8px;font:12px/1.4 ui-monospace,Menlo,monospace');
    el.text.spellcheck = false;
    el.text.addEventListener('input', () => {
      S.follow = false; S.typedAt = Date.now();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { apply(S.id, el.text.value, { typing: true }); paint(); }, 220);
    });
    el.msg = mk('div', 'font-size:12px;min-height:16px');
    el.gridBar = mk('div', 'display:flex;gap:8px;align-items:center;font-size:12px;color:#b9b2cc');
    el.unit = mk('select', 'background:#221a33;color:#e6defa;border:1px solid #4b3b6b;border-radius:5px;padding:2px 4px;font:12px system-ui,sans-serif');
    el.unit.addEventListener('change', () => { S.unit = +el.unit.value || 0; drawGrid(); });
    el.gridNote = mk('span', 'flex:1');
    el.gridBar.append(mk('span', '', 'Loop'), el.unit, el.gridNote);
    el.grid = mk('div', 'overflow-x:auto;padding-bottom:4px');
    el.ai = mk('div', 'display:flex;gap:6px;align-items:center');
    el.aiText = mk('input', 'flex:1;background:#0d0b13;color:#f2ecff;border:1px solid #4b3b6b;border-radius:5px;padding:5px 8px;font:12px system-ui,sans-serif');
    el.aiText.placeholder = 'Ask the AI to change this row: "busier hi-hat", "walking bass", "add a fill in bar 4"';
    el.aiText.addEventListener('keydown', (e) => { if (e.key === 'Enter') askAi(); });
    el.aiBtn = mk('button', btnCss, 'Ask AI'); el.aiBtn.type = 'button';
    el.aiBtn.addEventListener('click', askAi);
    el.ai.append(el.aiText, el.aiBtn);
    el.acts = mk('div', 'display:flex;gap:6px;align-items:center');
    el.undo = mk('button', btnCss, 'Undo'); el.undo.type = 'button'; el.undo.addEventListener('click', undo);
    el.revert = mk('button', btnCss, 'Revert row'); el.revert.type = 'button';
    el.revert.title = 'Put this row back as it is in the song file.';
    el.revert.addEventListener('click', () => { if (S.dirty.has(S.id)) { apply(S.id, S.dirty.get(S.id), {}); show(S.id); paint(); } });
    el.split = mk('button', btnCss, '≡'); el.split.type = 'button';
    el.split.title = 'Split this row\'s text so each sequence group sits on its own line; press again to join it. Only the layout changes: it plays the same.';
    el.split.addEventListener('click', () => { splitRow(); paint(); });
    el.acts.append(el.undo, el.revert, el.split);
    el.editor.append(el.strips, el.now, el.text, el.msg, el.gridBar, el.grid, el.ai, el.acts);
    el.note = mk('div', 'font-size:12px;color:#b9b2cc;min-height:16px');
    el.body.append(el.bar, el.rows, el.editor, el.note);
    el.box.append(el.head, el.body);
    for (const ev of ['keydown', 'keyup', 'keypress']) el.box.addEventListener(ev, (e) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) e.stopPropagation(); });   // typing here is not a Performer shortcut
    el.box.addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('button') : null; if (b) b.blur(); });   // Space stays the Performer's play / pause
    document.body.appendChild(el.box);
  }
  /* one line per row of the song: key, name, the console's row buttons, what it is doing */
  const rbCss = 'flex:0 0 22px;height:20px;padding:0;border-radius:4px;border:1px solid #3a3350;background:#1d1930;color:#cfc6e6;cursor:pointer;font:11px system-ui,sans-serif;line-height:18px';
  function buildRows(m) {
    el.rows.textContent = ''; S.rows = [];
    const DEPTH = { song: 0, section: 1, phrase: 2, part: 3 };
    (m.bank.slots || []).forEach((s, i) => {
      if (!s || !String(s.src || '').trim()) { S.rows[i] = null; return; }
      const line = mk('div', 'display:flex;align-items:center;gap:3px;padding:2px 3px;border-radius:4px');
      const rb = (txt, title, fn) => { const b = mk('button', rbCss, txt); b.type = 'button'; b.title = title; b.addEventListener('click', () => { fn(); paint(); }); return b; };
      const nm = s.name || ('row ' + (i + 1)), strip = stripOf(s);
      const key = mk('button', 'flex:0 0 26px;height:20px;border-radius:4px;border:1px solid #4b3b6b;background:#1d1930;color:#e6defa;cursor:pointer;font:600 11px ui-monospace,Menlo,monospace;padding:0;margin-right:4px',
                     s.key != null && String(s.key) !== '' ? String(s.key) : '▸');
      key.type = 'button';
      key.addEventListener('click', () => { press(i); paint(); });
      const name = mk('span', 'flex:1;min-width:90px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:' + (DEPTH[s.role] != null ? DEPTH[s.role] : 3) * 10 + 'px', nm);
      name.title = (strip ? LABEL[strip] + ' part' : (s.role || 'row')) + (s.note ? ' · ' + s.note : '') + '\nClick the name to edit this row.';
      name.addEventListener('click', () => { S.follow = false; S.edit = true; if (strip) S.strip = strip; show(i); paint(true); });
      const tools = [
        rb('⬇', 'Shift ' + nm + ' DOWN an octave. Drum notes and the rows it calls are left alone. A playing row changes at its next cycle.', () => octave(i, -1)),
        rb('⬆', 'Shift ' + nm + ' UP an octave. Drum notes and the rows it calls are left alone. A playing row changes at its next cycle.', () => octave(i, 1)),
        rb('−\\', 'Every note of ' + nm + ' lands 1/24 beat earlier (limit ////). The rows it calls are left alone.', () => feel(i, -1)),
        rb('+\\', 'Every note of ' + nm + ' lands 1/24 beat later (limit \\\\\\\\). The rows it calls are left alone.', () => feel(i, 1)),
        rb('🤖', 'Ask the AI to change ' + nm + ': opens the editor on this row with the request box ready.', () => { S.follow = false; S.edit = true; if (strip) S.strip = strip; show(i); paint(true); setTimeout(() => { try { el.aiText.focus(); } catch (e) {} }, 0); }),
      ];
      const tr = rb('🗑', '', () => trash(i));
      const fav = rb('➜', 'Copy ' + nm + ', with the rows it calls, to the Favorites bank of the MIDI console. It stays here too.', () => { copyFav(i); });
      const vol = mk('input', 'flex:0 0 54px;width:54px;height:14px;margin:0 3px;accent-color:#c084fc');
      vol.type = 'range'; vol.min = 0; vol.max = 100; vol.step = 1; vol.value = mplLive.vol.has(i) ? mplLive.vol.get(i) : 75;
      vol.title = 'Level of ' + nm + ' and of everything it plays: 75 = as written, 100 = a third louder, 0 = silent. Double-click = 75.';
      vol.addEventListener('input', () => { setVol(i, vol.value); vol.title = vol.title.replace(/ Now \d+\.$/, '') + ' Now ' + vol.value + '.'; });
      vol.addEventListener('dblclick', () => { vol.value = 75; setVol(i, 75); });
      const back = rb('◀', '', () => direction(i, true)), fwd = rb('▶', '', () => direction(i, false));
      const mu = rb('M', 'MUTE ' + nm + ': its notes, and the notes of everything it calls or starts, are silent wherever they play. It keeps its place, so it comes back in time.', () => toggleIn(mplLive.mute, i));
      const so = rb('S', 'SOLO ' + nm + ': only this row and what it calls or starts is heard (with any other soloed rows).', () => toggleIn(mplLive.solo, i));
      mu.style.fontWeight = so.style.fontWeight = '700';
      const st = mk('span', 'flex:0 0 66px;font-size:11px;text-align:right;white-space:nowrap;overflow:hidden');
      line.append(key, name, ...tools, tr, fav, vol, back, fwd, mu, so, st);
      el.rows.appendChild(line);
      S.rows[i] = { line, key, name, st, tr, back, fwd, mu, so, nm, last: '' };
    });
    S.rowsFor = m.bank;
  }
  const LOOK = {   // state → [key background, key border, key text colour, words, words colour]
    loop:     ['#f1c40f', '#f1c40f', '#15131c', 'looping', '#f1c40f'],
    loopwait: ['#1d1930', '#f1c40f', '#f1c40f', 'next bar', '#f1c40f'],
    loopend:  ['#6b5a12', '#f1c40f', '#15131c', 'last cycle', '#f1c40f'],
    offwait:  ['#c084fc', '#ff7b7b', '#15131c', 'out next', '#ff7b7b'],
    onwait:   ['#1d1930', '#c084fc', '#c084fc', 'back next', '#c084fc'],
    off:      ['#1d1930', '#ff7b7b', '#ff7b7b', 'out', '#ff7b7b'],
    stem:     ['#1d1930', '#c084fc', '#e6defa', 'stem', '#8f86a8'],
    on:       ['#c084fc', '#c084fc', '#15131c', 'playing', '#c084fc'],
    idle:     ['#1d1930', '#4b3b6b', '#8f86a8', '', '#8f86a8'],
  };
  const lit = (b, on, bg) => { b.style.background = on ? bg : '#1d1930'; b.style.color = on ? '#15131c' : '#cfc6e6'; b.style.borderColor = on ? bg : '#3a3350'; };
  function paintRows(m) {
    if (S.rowsFor !== m.bank) buildRows(m);
    const pos = posNow(), beat = beatAt(m, pos), any = STRIPS.some(heard);
    S.rows.forEach((r, i) => {
      if (!r) return;
      const s = m.bank.slots[i], p = passes(m, i), strip = stripOf(s);
      const ov = mplLive.ov.find(o => o.id === i && (o.b1 === Infinity || o.b1 > beat + 1e-6));
      const pend = S.pendState.get(i), pd = S.pendDir.get(i), rev = mplLive.rev.has(i);
      const state = ov ? (ov.b1 !== Infinity ? 'loopend' : beat < ov.b0 ? 'loopwait' : 'loop')
        : pend ? (pend.off ? 'offwait' : 'onwait')
        : mplLive.off.has(i) ? 'off'
        : passAt(p.song, posIn(m)) ? ((strip ? heard(strip) : any) ? 'on' : 'stem')
        : 'idle';
      const sounding = state === 'loop' || state === 'loopend' || state === 'on' || state === 'offwait';
      const muted = mplLive.mute.has(i), solo = mplLive.solo.has(i), stashed = S.stash.has(i);
      const sel = i === S.id && S.edit;
      const sig = [state, sel, S.pendSrc.has(i), S.dirty.has(i), rev, pd ? pd.rev : '', muted, solo, stashed].join('|');
      if (sig === r.last) return;
      r.last = sig;
      const L = LOOK[state];
      r.key.style.background = L[0]; r.key.style.borderColor = L[1]; r.key.style.color = L[2];
      r.st.textContent = S.pendSrc.has(i) ? 'new text next' : pd ? (pd.rev ? '◀ next' : '▶ next') : L[3];
      r.st.style.color = L[4];
      r.st.title = { loop: 'Looping on top of the song.', loopwait: 'Loops on top from the next bar.', loopend: 'Stops at the end of this cycle.', offwait: 'Drops out from its next cycle.',
                     onwait: 'Comes back at its next cycle.', off: 'Dropped out of the song.', stem: 'In the song now; the stem is playing, not the MPL.', on: 'The song is playing it.', idle: '' }[state]
        + (S.pendSrc.has(i) ? ' Its new text takes over at its next cycle.' : '') + (pd ? ' Turns round at its next cycle.' : '');
      r.name.style.color = state === 'off' || muted ? '#8f86a8' : state === 'idle' ? '#b9b2cc' : '#f2ecff';
      r.name.style.textDecoration = state === 'off' ? 'line-through' : 'none';
      r.name.textContent = r.nm + (S.dirty.has(i) ? ' ●' : '');
      r.line.style.background = sel ? '#2a2140' : 'transparent';
      r.key.title = state === 'loop' || state === 'loopwait' ? 'Stop this loop at the end of its cycle.'
        : state === 'off' || state === 'offwait' ? 'Bring this piece back.'
        : state === 'on' ? 'Drop this piece out from its next cycle.'
        : state === 'stem' ? (strip ? 'The ' + LABEL[strip] + ' strip is playing its stem: press to let the MPL take over.' : 'In the song now; no strip is playing its MPL.')
        : 'Loop this piece on top of the song from the next bar.';
      lit(r.fwd, sounding && !rev, '#c084fc'); lit(r.back, sounding && rev, '#c084fc');
      if (pd) (pd.rev ? r.back : r.fwd).style.borderColor = '#f1c40f';
      r.fwd.title = sounding && !rev ? 'Playing forwards. Press to stop ' + r.nm + ' at the end of its cycle.' : sounding ? 'Turn ' + r.nm + ' forwards at its next cycle.' : 'Start ' + r.nm + ' forwards.';
      r.back.title = sounding && rev ? 'Playing BACKWARDS. Press to stop ' + r.nm + ' at the end of its cycle.' : sounding ? 'Turn ' + r.nm + ' BACKWARDS at its next cycle: last note first, the parts it starts reversed too.' : 'Start ' + r.nm + ' BACKWARDS.';
      lit(r.mu, muted, '#ff7b7b'); lit(r.so, solo, '#f1c40f');
      r.tr.textContent = stashed ? '↶' : '🗑';
      r.tr.title = stashed ? 'Put the text of ' + r.nm + ' back.' : 'Clear ' + r.nm + ' to rests of the same length (the song still lines up). Click again (↶) to put it back.';
    });
  }

  /* ── changing a row ────────────────────────────────────────────────────────────────────── */
  const beatsOf = (m, id, src) => { try { return rowEvents(mplParse, src, getter(m.bank), id).beats; } catch (e) { return null; } };
  function check(m, id, src) {                               // null when the song builds with this text, else why not
    const slot = m.bank.slots[id], keep = slot.src;
    slot.src = src;
    try { mplDrumsBuild(m.folder, m.bank); return null; } catch (e) { return String((e && e.message) || e); } finally { slot.src = keep; }
  }
  /* a row's new text: checked now, taking over at the row's next cycle; false (nothing changed) when it does not build */
  function apply(id, src, opts) {
    const m = song(); if (!m || id == null) return false;
    const slot = m.bank.slots[id], before = curSrc(m, id);
    src = String(src);
    if (src === before) { S.err = ''; return true; }
    if (!src.trim()) { S.err = 'The row is empty — write rests (e.g. 4Rw) for silence.'; return false; }
    const bad = check(m, id, src);
    if (bad) { S.err = bad; return false; }
    S.err = '';
    const last = S.undo[S.undo.length - 1];
    if (!opts.noUndo && !(opts.typing && last && last.id === id && last.typing && Date.now() - last.at < 1500)) {
      S.undo.push({ id, src: before, typing: !!opts.typing, at: Date.now() });
      if (S.undo.length > 100) S.undo.shift();
    } else if (last && opts.typing) last.at = Date.now();
    if (!S.dirty.has(id)) S.dirty.set(id, String(slot.src || ''));
    const c = mplDrumsClock(), at = c ? nextCycle(m, id, c.pos, c.rate) : null;
    if (c && at != null) { S.pendSrc.set(id, { src, at }); S.note = slot.name + ': the new text takes over at its next cycle.'; }
    else {
      S.pendSrc.delete(id);
      const keep = slot.src; slot.src = src;
      if (!rebuild(m)) { slot.src = keep; S.err = S.note; S.note = ''; return false; }
    }
    if (S.dirty.get(id) === src) S.dirty.delete(id);
    S.len.delete(id);
    const a = beatsOf(m, id, S.dirty.has(id) ? S.dirty.get(id) : src), b = beatsOf(m, id, src);
    S.warn = (a != null && b != null && Math.abs(a - b) > 1e-6) ? 'This row is now ' + (+b.toFixed(2)) + ' beats; in the file it is ' + (+a.toFixed(2)) + '. It will drift against the other parts.' : '';
    if (id === S.id) drawGrid();
    return true;
  }
  function undo() {
    const u = S.undo.pop(); if (!u) return;
    apply(u.id, u.src, { noUndo: true });
    S.follow = false; show(u.id); paint();
  }
  function show(id) {
    const m = song(); if (!m) return;
    S.id = id; S.err = ''; S.warn = '';
    if (el) el.text.value = id != null ? curSrc(m, id) : '';
    S.unit = 0;
    drawGrid();
  }

  function drawGrid() {
    const m = song();
    S.grid = null; S.cols = []; S.lastCol = -1;
    const on = !!m && S.edit && S.id != null && stripOf(m.bank.slots[S.id]) === 'drums';
    el.gridBar.style.display = el.grid.style.display = on ? '' : 'none';
    if (!on) return;
    let ev;
    try { ev = rowEvents(mplParse, curSrc(m, S.id), getter(m.bank), S.id); } catch (e) { el.grid.textContent = ''; el.gridNote.textContent = 'The row does not parse yet.'; return; }
    const g = gridOf(ev), units = unitsOf(g);
    if (!g.steps) { el.grid.textContent = ''; el.gridNote.textContent = 'The row has no length.'; return; }
    if (!units.includes(S.unit)) S.unit = units[0];
    S.grid = g;
    el.unit.textContent = '';
    for (const u of units) {
      const o = document.createElement('option'); o.value = u;
      o.textContent = (u % 16 ? (u / 4) + ' beats' : (u / 16) + (u === 16 ? ' bar' : ' bars')) + (u === g.steps && units.length > 1 ? ' (whole row)' : '');
      if (u === S.unit) o.selected = true;
      el.unit.appendChild(o);
    }
    el.gridNote.textContent = g.exact ? 'Click a step to add or remove a hit. Brighter = louder (^), dimmer = softer (v).' : 'This row has timing marks or notes off the sixteenth grid: a click here rewrites it as straight sixteenths.';
    el.gridNote.style.color = g.exact ? '#b9b2cc' : '#f1c40f';
    const notes = GRID_ORDER.filter(n => GRID_DEFAULT.includes(n) || g.cells.has(n)).concat([...g.cells.keys()].filter(n => !GRID_ORDER.includes(n)).sort((a, b) => b - a));
    const tbl = mk('div', 'display:grid;grid-template-columns:86px repeat(' + S.unit + ',14px);gap:1px;width:max-content;font-size:11px');
    S.cols = Array.from({ length: S.unit }, () => []);
    for (const n of notes) {
      const lab = mk('div', 'color:#b9b2cc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px', DRUM_NAMES[n] || noteName(n));
      lab.title = noteName(n) + ' (MIDI ' + n + ')';
      tbl.appendChild(lab);
      for (let st = 0; st < S.unit; st++) {
        const c = document.createElement('div'), hit = g.cells.has(n) && g.cells.get(n).has(st), dy = hit ? g.cells.get(n).get(st) : 0;
        c.style.cssText = 'height:16px;border-radius:2px;cursor:pointer;background:' + (hit ? (dy > 0 ? '#f0e2ff' : dy < 0 ? '#7c5aa6' : '#c084fc') : st % 16 === 0 ? '#3a3350' : st % 4 === 0 ? '#2b2540' : '#1d1930');
        c.dataset.n = n; c.dataset.st = st;
        S.cols[st].push(c);
        tbl.appendChild(c);
      }
    }
    tbl.addEventListener('click', (e) => {
      const c = e.target; if (!c.dataset || c.dataset.st == null) return;
      const n = +c.dataset.n, st = +c.dataset.st, gg = S.grid;
      if (!gg.cells.has(n)) gg.cells.set(n, new Map());
      const add = !gg.cells.get(n).has(st);
      /* the loop is written once and repeated: keep the steps of the loop that is shown */
      for (const [k, s2] of gg.cells) { const f = new Map(); for (const [x, dy] of s2) if (x < S.unit) f.set(x, dy); gg.cells.set(k, f); }
      const f = gg.cells.get(n); if (add) f.set(st, 0); else f.delete(st);
      const src = gridToSrc(prefixOf(curSrc(song(), S.id)), { steps: gg.steps, cells: gg.cells }, S.unit);
      S.follow = false;
      if (apply(S.id, src, {})) el.text.value = src;
      paint();
    });
    el.grid.textContent = ''; el.grid.appendChild(tbl);
  }

  /* ask the AI to change one row; the answer is used only if it builds and keeps the row's length. Returns what to tell the user. */
  async function aiRow(id, hint) {
    const m = song(); if (!m || id == null || !m.bank.slots[id]) return '';
    const slot = m.bank.slots[id], cur = curSrc(m, id), beats = beatsOf(m, id, cur), strip = stripOf(slot);
    try {
      const withRows = (m.bank.slots || []).filter((s, i) => i !== id && s && s.role === 'part' && slot.phrase && s.phrase === slot.phrase).map(s => ({ name: s.name, src: s.src }));
      const r = await fetch('/api/mpl/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'row', strip: strip || '', name: slot.name, current: cur, hint, beats: beats || 16, key: m.bank.key || '', bpm: m.bpm,
                               with: withRows, bank: [{ name: slot.name, src: cur }], slot: 0 }) });
      const j = await r.json().catch(() => ({}));
      const got = j && j.ok && j.result && (j.result.slots || []).find(x => x && typeof x.src === 'string' && x.src.trim());
      const now = song();
      if (!got) return 'AI: ' + ((j && j.error) || 'no row came back.');
      if (!now || now.folder !== m.folder) return 'The song changed while the AI was working; its row was not used.';
      const nb = beatsOf(now, id, got.src);
      if (beats != null && nb != null && Math.abs(nb - beats) > 1e-6) return 'The AI\'s row is ' + (+nb.toFixed(2)) + ' beats, not ' + (+beats.toFixed(2)) + ', so it was not used: ' + got.src.slice(0, 160);
      if (apply(id, got.src, {})) { if (S.id === id) show(id); return 'AI: ' + (j.result.reply || 'done.') + (S.pendSrc.has(id) ? ' It takes over at the row\'s next cycle.' : '') + ' (Undo puts the row back.)'; }
      const why = S.err; S.err = '';
      return 'The AI\'s row was not used (' + why + '): ' + got.src.slice(0, 160);
    } catch (e) { return 'AI: ' + ((e && e.message) || e); }
  }
  async function askAi() {
    const m = song(); const hint = el.aiText.value.trim();
    if (!m || S.id == null || !hint || S.aiBusy) return;
    S.aiBusy = true; S.note = 'Asking the AI… (this can take up to a minute; the song keeps playing)'; S.follow = false; paint();
    S.note = await aiRow(S.id, hint);
    S.aiBusy = false; paint();
  }

  /* ── MPL controls on the faders (Bill 2026-11-23) ─────────────────────────────────────────
     A strip that plays its MPL in place of its stem (INPUT ROUTING: MPL, or its own MPL button) carries
     the controls of the sequence it is playing now, under its M and S:
       ⬇ ⬆   that sequence's notes an octave down / up
       ◀ ▶   backwards / forwards: the lit one drops the sequence out at its next cycle (pressed again it
              comes back), the other turns it round at its next cycle
       text   the sequence's MPL, to edit while it plays: a text that builds takes over at its next cycle
       🤖     say what you want in the track; the AI rewrites the sequence (same length, or it is not used)
     The block follows the song from sequence to sequence; while you type in it, it stays on the one you
     are changing. Nothing is written to the song file until Save in the MPL Player panel.
     Above them: Song | Exact — play the strip's part of the song MPL (these controls), or the stem's exact
     transcription with its score against the audio (nothing to edit there). */
  const SC = {};
  function scRun(c, fn) {                                    // a panel action for this strip's sequence; the panel editor keeps its own messages
    const keep = { err: S.err, warn: S.warn, note: S.note };
    try { return fn(); }
    finally {
      c.err = S.err; c.note = S.err ? '' : (S.note !== keep.note ? S.note : S.warn);
      if (S.id === c.id) { if (!S.err) show(c.id); } else { S.err = keep.err; S.warn = keep.warn; }
    }
  }
  function scBuild(strip) {
    const host = document.querySelector('.channel-strip.' + strip + '-strip');
    if (!host) return null;
    const c = { id: null, folder: null, timer: 0, typedAt: 0, err: '', note: '', busy: false };
    c.box = mk('div', 'display:none;flex-direction:column;gap:3px;margin:2px 3px 0;padding:4px;border:1px solid #c084fc;border-radius:6px;background:#15131c;color:#e6defa;' +
                      'font:11px/1.3 system-ui,sans-serif;text-align:left;min-width:0');
    c.box.className = 'mpl-strip-ctl';
    /* Song | Exact: which of the stem's two MPL versions the strip plays (mpl-drums.js, mplSrc), each with its score */
    const segCss = 'flex:1 1 0;height:20px;padding:0 3px;border-radius:4px;border:1px solid #3a3350;background:#1d1930;color:#cfc6e6;cursor:pointer;font:600 10.5px system-ui,sans-serif;white-space:nowrap;overflow:hidden';
    c.src = mk('div', 'display:flex;gap:3px');
    c.song = mk('button', segCss, 'Song'); c.song.type = 'button';
    c.exact = mk('button', segCss, 'Exact'); c.exact.type = 'button';
    c.song.addEventListener('click', () => { mplSrcSet(strip, 'song'); c.song.blur(); scPaint(strip); });
    c.exact.addEventListener('click', () => { mplSrcSet(strip, 'exact'); c.exact.blur(); scPaint(strip); });
    c.src.append(c.song, c.exact);
    c.info = mk('div', 'display:none;color:#b9b2cc;font-size:10.5px;line-height:1.35');
    c.head = mk('div', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    c.name = mk('span', 'font-weight:700'); c.st = mk('span', 'color:#f1c40f;margin-left:5px');
    c.head.append(c.name, c.st);
    const row = c.row = mk('div', 'display:flex;gap:3px');
    const b = (txt, fn) => { const x = mk('button', rbCss + ';flex:1 1 0;height:22px', txt); x.type = 'button'; x.addEventListener('click', () => { if (c.id != null) scRun(c, () => fn(c.id)); x.blur(); scPaint(strip); paint(); }); return x; };
    c.down = b('⬇', (id) => octave(id, -1)); c.up = b('⬆', (id) => octave(id, 1));
    c.back = b('◀', (id) => direction(id, true)); c.fwd = b('▶', (id) => direction(id, false));
    row.append(c.down, c.up, c.back, c.fwd);
    c.text = mk('textarea', 'width:100%;box-sizing:border-box;height:150px;resize:vertical;background:#0d0b13;color:#f2ecff;border:1px solid #4b3b6b;border-radius:4px;padding:5px 6px;' +
                            'font:13px/1.4 ui-monospace,Menlo,monospace');
    c.text.spellcheck = false;
    c.text.addEventListener('input', () => {
      c.typedAt = Date.now(); clearTimeout(c.timer);
      const id = c.id;
      c.timer = setTimeout(() => { if (id == null || id !== c.id) return; scRun(c, () => apply(id, c.text.value, { typing: true })); scPaint(strip); paint(); }, 220);
    });
    const ai = c.aiRow = mk('div', 'display:flex;gap:3px');
    c.ai = mk('input', 'flex:1;min-width:0;background:#0d0b13;color:#f2ecff;border:1px solid #4b3b6b;border-radius:4px;padding:3px 4px;font:11px system-ui,sans-serif');
    c.ai.placeholder = 'what do you want here?';
    c.ai.title = 'Say what you want in this track ("busier", "walking bass", "half time", "add a fill in bar 4") and press Enter: the AI rewrites the sequence this strip is playing. Used only if it builds and keeps its length.';
    c.aiBtn = mk('button', rbCss + ';flex:0 0 24px;height:22px', '🤖'); c.aiBtn.type = 'button';
    const go = async () => {
      const hint = c.ai.value.trim(), id = c.id;
      if (!hint || id == null || S.aiBusy) return;
      S.aiBusy = true; c.busy = true; c.err = ''; c.note = 'Asking the AI… (up to a minute; the song keeps playing)'; scPaint(strip);
      const said = await aiRow(id, hint);
      S.aiBusy = false; c.busy = false; c.note = said; if (/^AI: /.test(said) && !/^AI: (no row|HTTP|Failed)/.test(said)) c.ai.value = '';
      scPaint(strip); paint();
    };
    c.ai.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    c.aiBtn.addEventListener('click', () => { go(); c.aiBtn.blur(); });
    ai.append(c.ai, c.aiBtn);
    c.msg = mk('div', 'font-size:10.5px;min-height:13px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical');
    c.box.append(c.src, c.info, c.head, row, c.text, ai, c.msg);
    for (const ev of ['keydown', 'keyup', 'keypress']) c.box.addEventListener(ev, (e) => { if (/^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) e.stopPropagation(); });   // typing here is not a Performer shortcut
    host.appendChild(c.box);
    return c;
  }
  function scPaint(strip) {
    const m = song(); let c = SC[strip];
    if (!m || mplStripMode(strip) === 'off') { if (c && c.box.style.display !== 'none') c.box.style.display = 'none'; return; }   // shown while the strip plays its MPL, in place of the stem or with it
    if (!c) { c = SC[strip] = scBuild(strip); if (!c) return; }
    if (c.box.style.display !== 'flex') c.box.style.display = 'flex';
    if (c.folder !== m.folder) { c.folder = m.folder; c.id = null; c.err = ''; c.note = ''; }
    // Song | Exact, each with its score against the stem's audio
    const exact = mplSrcOf(strip) === 'exact', hasX = mplExactHas(strip), accX = mplAcc(strip), g = mplSongPct(strip);
    const sl = 'Song' + (g != null ? ' ' + Math.round(g) + '%' : ''), xl = 'Exact' + (accX != null ? ' ' + Math.round(accX) + '%' : '');
    if (c.song.textContent !== sl) c.song.textContent = sl;
    if (c.exact.textContent !== xl) c.exact.textContent = xl;
    lit(c.song, !exact, '#c084fc'); lit(c.exact, exact, '#3b9dff');
    c.exact.disabled = !hasX; c.exact.style.opacity = hasX ? '1' : '.4';
    c.song.title = 'Song: this strip plays its part of the song MPL — sections and loops, which you can change below.' + (g == null ? ' This part has no score yet.' : strip === 'drums' ? ' Its drum part matches ' + Math.round(g) + '% of the hits in the drum stem.' : ' Beat by beat, ' + Math.round(g) + '% of the notes it plays are the notes heard in the ' + LABEL[strip] + ' stem.');
    c.exact.title = hasX ? 'Exact: this strip plays the ' + LABEL[strip] + ' transcription — every note where it was found in the stem, no loops' + (accX != null ? ', ' + Math.round(accX) + '% accurate against the stem\'s audio' : '') + '. Use it to hear how close the MPL is to the original; it cannot be edited here.' + (strip === 'drums' ? ' For the drums it is the six kit pieces\' transcriptions together.' : '')
      : 'This song has no exact transcription of the ' + LABEL[strip] + '.';
    for (const x of [c.head, c.row, c.text, c.aiRow, c.msg]) { const d = exact ? 'none' : (x === c.row || x === c.aiRow ? 'flex' : ''); if (x.style.display !== d) x.style.display = d; }
    if (c.info.style.display !== (exact ? '' : 'none')) c.info.style.display = exact ? '' : 'none';
    if (exact) {
      const rec = strip === 'drums' ? null : (typeof mplExact !== 'undefined' && mplExact.stems[strip]) || null;
      const t = strip === 'drums' ? 'The six kit pieces\' transcriptions, every hit where it was found. Use the DRUM KIT row to swap single pieces.'
        : (rec && rec.state === 'loading' ? 'Loading the transcription…' : 'Every note where it was found in ' + strip + '.m4a, for the whole song. Hold the MPL button to hear it with the stem.');
      if (c.info.textContent !== t) c.info.textContent = t;
      return;
    }
    const ae = document.activeElement, editing = ae === c.text || ae === c.ai || c.busy || Date.now() - c.typedAt < 1500;
    const sp = spanNow(m, strip), now = sp ? sp.id : null;
    if (!editing && now !== c.id) { c.id = now; c.err = ''; c.note = ''; }
    if (c.id != null && !m.bank.slots[c.id]) c.id = null;
    const id = c.id, slot = id != null ? m.bank.slots[id] : null, src = slot ? curSrc(m, id) : '';
    if (ae !== c.text && !c.err && c.text.value !== src) c.text.value = src;
    const pend = slot && S.pendState.get(id), pd = slot && S.pendDir.get(id), rev = !!slot && mplLive.rev.has(id), off = !!slot && mplLive.off.has(id);
    const inSong = !!slot && !!passAt(passes(m, id).song, posIn(m)), sounding = inSong && !off;
    const st = !slot ? '' : S.pendSrc.has(id) ? 'new text next cycle' : pd ? (pd.rev ? '◀ next cycle' : '▶ next cycle') : pend ? (pend.off ? 'out next cycle' : 'back next cycle')
      : off ? 'out' : !inSong ? 'not playing now' : now !== id ? 'editing — the song has moved on' : '';
    const nm = slot ? (slot.name || 'row ' + (id + 1)) + (S.dirty.has(id) ? ' ●' : '') : 'no ' + LABEL[strip] + ' sequence here';
    if (c.name.textContent !== nm) c.name.textContent = nm;
    if (c.st.textContent !== st) c.st.textContent = st;
    c.head.title = slot ? LABEL[strip] + ' is playing its MPL: these controls act on the sequence ' + slot.name + (slot.uses ? ' (used ' + slot.uses + '× in the song — a change is heard everywhere it is used)' : '') + '.' + (S.dirty.has(id) ? ' ● changed, not saved: Save is in the MPL Player panel.' : '') : '';
    for (const x of [c.down, c.up, c.back, c.fwd, c.aiBtn]) { x.disabled = !slot; x.style.opacity = slot ? '1' : '.4'; }
    c.text.disabled = c.ai.disabled = !slot;
    lit(c.fwd, sounding && !rev, '#c084fc'); lit(c.back, sounding && rev, '#c084fc');
    if (pd) (pd.rev ? c.back : c.fwd).style.borderColor = '#f1c40f';
    const sn = slot ? slot.name : 'the sequence';
    c.down.title = 'Shift the notes of ' + sn + ' DOWN an octave (from its next cycle).'; c.up.title = 'Shift the notes of ' + sn + ' UP an octave (from its next cycle).';
    c.fwd.title = sounding && !rev ? 'Playing forwards. Press to drop ' + sn + ' out from its next cycle.' : off ? 'Bring ' + sn + ' back, forwards, at its next cycle.' : 'Turn ' + sn + ' forwards at its next cycle.';
    c.back.title = sounding && rev ? 'Playing BACKWARDS. Press to drop ' + sn + ' out from its next cycle.' : off ? 'Bring ' + sn + ' back, BACKWARDS, at its next cycle.' : 'Turn ' + sn + ' BACKWARDS at its next cycle: last note first.';
    c.text.title = 'The MPL of ' + sn + '. Edit it while it plays: a text that builds takes over at its next cycle; one that does not is shown in red and not used.';
    c.text.style.borderColor = c.err ? '#ff7b7b' : '#4b3b6b';
    const msg = c.err ? 'Not used: ' + c.err : c.note;
    if (c.msg.textContent !== msg) c.msg.textContent = msg;
    c.msg.style.color = c.err ? '#ff7b7b' : '#b9b2cc'; c.msg.title = msg;
  }
  setInterval(() => { for (const st of STRIPS) { try { scPaint(st); } catch (e) { console.warn('[mpl-player] strip', st, e); } } }, 150);

  async function save() {
    const m = song(); if (!m || !S.dirty.size) return;
    if (S.pendSrc.size) {                                    // what waits for its cycle is written too, so it takes over now
      for (const [id, p] of S.pendSrc) m.bank.slots[id].src = p.src;
      S.pendSrc.clear(); rebuild(m);
    }
    const rows = [...S.dirty.keys()].map(i => ({ name: m.bank.slots[i].name, src: m.bank.slots[i].src }));
    el.save.disabled = true; S.note = 'Saving…'; paint();
    try {
      const r = await fetch('/api/song/' + encodeURIComponent(m.folder) + '/mpl', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { S.dirty.clear(); S.note = 'Saved ' + rows.length + (rows.length === 1 ? ' row' : ' rows') + '. The file as it was before your first save is kept as ' + (j.original || 'the .orig.json file') + '.'; }
      else S.note = 'Not saved: ' + ((j && j.error) || ('the server answered ' + r.status));
    } catch (e) { S.note = 'Not saved: ' + ((e && e.message) || e); }
    paint();
  }

  function paint(force) {
    const m = song();
    if (!m) { if (el) el.box.style.display = 'none'; return; }
    if (!el) build();
    if (S.folder !== m.folder) {                             // another song: the edits of the last one went with its file copy
      if (S.dirty.size) toast('MPL Player: ' + S.dirty.size + ' changed row(s) of the last song were not saved.');
      S.folder = m.folder; S.dirty.clear(); S.undo = []; S.pendSrc.clear(); S.pendState.clear(); S.pendDir.clear(); S.stash.clear(); S.id = null; S.note = ''; S.err = ''; S.warn = '';
      force = true;
    }
    el.box.style.display = 'flex';
    el.body.style.display = S.open ? 'flex' : 'none';
    const idx = index(m), loops = mplLive.ov.filter(o => o.b1 === Infinity).length, outs = mplLive.off.size;
    el.head.textContent = (S.open ? '▾ ' : '▸ ') + 'MPL Player · ' + (m.name || 'song') + (S.keys ? '  ⌨ keys on' : '') + (loops ? '  ↻ ' + loops + ' looping' : '') + (outs ? '  ✕ ' + outs + ' out' : '') + (mplLive.mute.size ? '  M ' + mplLive.mute.size : '') + (mplLive.solo.size ? '  S ' + mplLive.solo.size : '')
      + (S.dirty.size ? '  ● ' + S.dirty.size + ' unsaved' : '');
    if (!S.open) return;
    el.keys.textContent = S.keys ? '⌨ Keys on' : '⌨ Keys';
    el.keys.style.background = S.keys ? '#c084fc' : '#221a33'; el.keys.style.color = S.keys ? '#15131c' : '#e6defa';
    el.reset.style.opacity = (loops || outs || S.pendState.size || S.pendDir.size || mplLive.mute.size || mplLive.solo.size || mplLive.rev.size || mplLive.vol.size) ? '1' : '.45';
    el.editBtn.textContent = S.edit ? 'Edit ▾' : 'Edit ▸';
    el.save.disabled = !S.dirty.size; el.save.style.opacity = S.dirty.size ? '1' : '.45';
    el.save.textContent = S.dirty.size ? 'Save ' + S.dirty.size + (S.dirty.size === 1 ? ' row' : ' rows') : 'Saved';
    el.note.textContent = S.note;
    paintRows(m);
    el.editor.style.display = S.edit ? 'flex' : 'none';
    if (!S.edit) return;
    if (!idx.byStrip[S.strip] && S.id == null) S.strip = STRIPS.find(s => idx.byStrip[s]) || 'drums';
    const typing = Date.now() - S.typedAt < 1200;
    if (S.follow && !typing) { const sp = spanNow(m, S.strip); const id = sp ? sp.id : null; if (id !== S.id || force) show(id); }
    else if (force) { if (S.id != null) show(S.id); else drawGrid(); }
    const slot = S.id != null ? m.bank.slots[S.id] : null;
    for (const st of STRIPS) {
      const b = el.stripBtn[st], has = !!idx.byStrip[st];
      b.style.opacity = has ? '1' : '.4'; b.disabled = !has;
      b.style.background = st === S.strip ? '#c084fc' : '#221a33'; b.style.color = st === S.strip ? '#15131c' : '#e6defa';
      b.title = has ? 'Follow the ' + LABEL[st] + ' row that is playing.' : 'This song\'s MPL has no ' + LABEL[st] + ' part.';
    }
    const mode = mplStripMode(S.strip), pill = S.strip === 'drums' && mplDrumsActive;
    el.hear.textContent = LABEL[S.strip] + ': ' + (pill ? 'MPL drums alone' : mode === 'replace' ? 'MPL' : mode === 'both' ? 'MPL + stem' : 'stem');
    el.hear.style.borderColor = (pill || mode !== 'off') ? '#c084fc' : '#4b3b6b';
    const where = (() => { try { return mplDrumsWhere(); } catch (e) { return ''; } })();
    const sp = slot ? passAt(passes(m, S.id).song.concat(passes(m, S.id).ov), posNow()) : null;
    el.nowText.textContent = [sectionNow(m), where, slot ? ('row ' + slot.name + (slot.uses ? ' · used ' + slot.uses + '×' : '') + (sp ? '' : ' · not playing now')) : 'no row'].filter(Boolean).join(' · ');
    el.follow.textContent = S.follow ? 'Following' : 'Pinned — follow';
    el.follow.style.borderColor = S.follow ? '#c084fc' : '#4b3b6b';
    el.text.disabled = !slot;
    el.msg.textContent = S.err ? 'Not used yet: ' + S.err : S.warn;
    el.msg.style.color = S.err ? '#ff7b7b' : '#f1c40f';
    el.text.style.borderColor = S.err ? '#ff7b7b' : '#4b3b6b';
    el.aiBtn.disabled = S.aiBusy || !slot; el.aiBtn.textContent = S.aiBusy ? 'Asking…' : 'Ask AI';
    el.undo.disabled = !S.undo.length; el.undo.style.opacity = S.undo.length ? '1' : '.45';
    const dirtyRow = S.dirty.has(S.id);
    el.revert.disabled = !dirtyRow; el.revert.style.opacity = dirtyRow ? '1' : '.45';
    // the step that is sounding
    let col = -1;
    if (S.grid && sp && S.cols.length && !S.pendSrc.has(S.id)) { const b = beatAt(m, posNow()) - sp.b0; if (b >= 0) col = Math.floor(b * 4 + 1e-6) % S.cols.length; }
    if (col !== S.lastCol) {
      if (S.lastCol >= 0 && S.cols[S.lastCol]) for (const c of S.cols[S.lastCol]) c.style.outline = '';
      if (col >= 0) for (const c of S.cols[col]) c.style.outline = '1px solid #fff';
      S.lastCol = col;
    }
  }
  setInterval(() => { try { paint(); } catch (e) { console.warn('[mpl-player]', e); } }, 100);
})();
