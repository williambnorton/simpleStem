/* mpl-drums.js — the song's drum MPL played from the Performer (Bill 2026-11-17).

   Three ways in, one engine:
     · the MPL DRUMS pill   — the MPL on its own: all six stems go silent.
     · the MPL button on the Drum fader — the MPL is the drum track: only the drum stem goes
       silent, the other five keep playing, and the Drum fader, M and S act on the MPL.
     · the D button on the Vocals, Bass, Guitar, Piano and Other faders — the drum sequence is
       also sent to that strip's MIDI channel, each drum played as a note of the song's key,
       with that strip's program. The strip's own stem keeps playing.
     · the MPL button next to M and S on the Vocals, Bass, Guitar, Piano and Other faders, shown
       only when the song's MPL has a part on that strip's channel (2026-11-18) — that stem goes
       silent and the part plays in its place as MIDI, like the Drum fader's MPL button. (Shown on
       every strip when the song has an MPL, dim where that strip has no part.)
     · Hold any of these MPL buttons down, or Option-click one, and the stem keeps playing too: stem
       and MPL are heard together ("MPL+"). The next click goes back to the stem alone.
   Either way the stems stay loaded, because they are the song's clock. That is what makes every
   transport control work unchanged — play, pause, stop, beginning, the timeline, next section,
   loop, the section looper and the speed dial all move that clock, and the notes follow it.

   The MPL is row 0 of STEMS/<song>/<song>_MPL.json: the whole song's drums in one string, or (files
   re-processed from 2026-11-17) the song as calls — sections, their phrases, each phrase's parts
   started together — from which the drum parts are gathered. Its beats are
   placed on the recording's own beat times (analysis.beat_t) so it stays in step with the other
   stems; a file without them falls back to the song's one measured tempo.

   Needs app.js (isPlaying, audioElements, stripNodes, mixerState, currentSong …) and mpl-core.js (mplParse). */

let mplDrumsActive = false;     // the pill: MPL alone, the six stems silent
let mplDrumsStrip = false;      // the Drum fader's MPL button: MPL in place of the drum stem
let mplDrumsStripBoth = false;  // … or, held / Option-clicked, MPL together with the drum stem
const mplSends = {};            // the D buttons: strip → true while the drum sequence goes to its channel
const mplParts = {};            // the MPL buttons beside M and S: strip → 'replace' (part in place of its stem) or 'both' (part and stem)
/* 'off' | 'replace' | 'both' for a strip's MPL button */
const mplStripMode = (strip) => strip === 'drums' ? (mplDrumsStrip ? (mplDrumsStripBoth ? 'both' : 'replace') : 'off') : (mplParts[strip] || 'off');
const MPL_CH_STRIP = { 10: 'drums', 11: 'vocals', 13: 'bass', 14: 'guitar', 15: 'piano', 16: 'other' };
const MPL_STRIP_LABEL = { drums: 'Drums', vocals: 'Vocals', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other' };
let mplDrums = null;            // { folder, name, grade, bpm, t0, beatT, stems, events: [{ t, len, ch, notes: [[note, vel]] }], … }
const mplDrumsF = { tag: '', pos0: 0, perf0: 0, rate: 1, a: 0, L: 0, st: {}, seq: 0, sent: 0, err: '', lastFolder: null, loading: false, retryAt: 0,
                    live: new Set(), gen: {}, maps: {} };
const MPL_DRUMS_LEAD_MS = 320;  // notes are posted this far ahead with their play time
const MPL_DRUMS_CH = 10;

/* The five other strips. ch = the strip's amp as a MIDI channel; prog = the program used when the
   song file names none; base = the octave the key's root sits in; the rest says which note of the
   key each kind of drum plays there: [tone, octaves up], tone 0 = root, 1 = third, 2 = fifth,
   3 = sixth (major) or seventh (minor). Each strip gets a different spread, so several strips
   together make a chord and not a unison. */
const MPL_SEND = {
  vocals: { ch: 11, label: 'Vocals', prog: 53, base: 60, kick: [1, 0], snare: [2, 0], hat: [0, 1], tomL: [0, 0], tomM: [3, 0], tomH: [1, 1], cym: [2, 0] },
  bass:   { ch: 13, label: 'Bass',   prog: 33, base: 24, kick: [0, 0], snare: [2, 0], hat: [0, 1], tomL: [1, 0], tomM: [2, 0], tomH: [0, 1], cym: [0, 0] },
  guitar: { ch: 14, label: 'Guitar', prog: 29, base: 48, kick: [0, 0], snare: [1, 0], hat: [2, 0], tomL: [3, 0], tomM: [0, 1], tomH: [1, 1], cym: [2, 1] },
  piano:  { ch: 15, label: 'Piano',  prog: 0,  base: 48, kick: [0, 0], snare: [2, 0], hat: [1, 1], tomL: [3, 0], tomM: [0, 1], tomH: [2, 1], cym: [0, 1] },
  other:  { ch: 16, label: 'Other',  prog: 48, base: 60, kick: [2, 0], snare: [0, 1], hat: [3, 0], tomL: [1, 0], tomM: [2, 0], tomH: [0, 1], cym: [1, 1] },
};
const MPL_KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function mplDrumKind(n) {
  if (n === 35 || n === 36) return 'kick';
  if (n >= 37 && n <= 40) return 'snare';
  if (n === 42 || n === 44 || n === 46) return 'hat';
  if (n === 41 || n === 43) return 'tomL';
  if (n === 45 || n === 47) return 'tomM';
  if (n === 48 || n === 50) return 'tomH';
  return 'cym';
}
/* the song's key, from its metadata ("A major", "F# minor"); with none, the console's current key, else C */
function mplSongKey() {
  const m = /^\s*([A-G])\s*([#♯b♭]?)\s*(m(?!aj)|min)?/i.exec((currentSong && currentSong.key) || '');
  if (m) {
    const pc = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[m[1].toUpperCase()] + (/[#♯]/.test(m[2]) ? 1 : m[2] ? -1 : 0);
    return { pc: (pc + 12) % 12, minor: !!m[3], from: 'song' };
  }
  try { const k = JSON.parse(localStorage.getItem('console.mplNoteMap.v2') || '{}').key; if (k >= 0 && k <= 11) return { pc: k | 0, minor: false, from: 'console' }; } catch (e) {}
  return { pc: 0, minor: false, from: 'none' };
}
const mplKeyName = (k) => MPL_KEY_NAMES[k.pc] + (k.minor ? ' minor' : ' major');
/* a strip's note map: drum → the note it plays on that strip. Chosen from the key; a line in the
   console's NOTE MAP that points a drum at this strip's channel is used instead (its step of the key). */
function mplSendMap(chan) {
  const S = MPL_SEND[chan], key = mplSongKey(), tones = key.minor ? [0, 3, 7, 10] : [0, 4, 7, 9];
  let manual = {};
  try { manual = JSON.parse(localStorage.getItem('console.mplNoteMap.v2') || '{}').map || {}; } catch (e) {}
  const cache = {};
  return (n) => {
    if (cache[n] != null) return cache[n];
    const e = manual[n];
    let v;
    if (e && +e.ch === S.ch) v = 36 + key.pc + (+e.s || 0) + 12 * (+e.o || 0);
    else { const [tone, oct] = S[mplDrumKind(n)]; v = S.base + key.pc + tones[tone] + 12 * oct; }
    while (v > 127) v -= 12;
    while (v < 0) v += 12;
    return (cache[n] = v);
  };
}
function mplSendProgram(chan) {
  const st = mplDrums && mplDrums.stems && mplDrums.stems[chan];
  return st && st.program >= 0 && st.program <= 127 ? { p: st.program | 0, name: st.program_name || '' } : { p: MPL_SEND[chan].prog, name: '' };
}

/* the MPL string → timed hits. Tempo marks are skipped: the recording's beats place the notes,
   and the transport's speed dial scales them. */
function mplDrumsBuild(folder, bank) {
  const slots = (bank && bank.slots) || [];
  const row = slots.find(s => String(s.key) === String(bank.main != null ? bank.main : '0')) || slots[0];
  if (!row || !String(row.src || '').trim()) throw new Error('the MPL file has no drum row');
  const an = bank.analysis || {};
  const bpm = +an.bpm || +bank.bpm || 120, t0 = +an.first_bar_t || 0, spb = 60 / bpm;
  const bt = Array.isArray(an.beat_t) && an.beat_t.length > 1 ? an.beat_t.map(Number) : null;
  const timeOf = (b) => {                                  // MPL beat → seconds into the recording
    if (!bt) return t0 + b * spb;
    const n = bt.length - 1;
    if (b <= 0) return bt[0] + b * (bt[1] - bt[0]);
    if (b >= n) return bt[n] + (b - n) * (bt[n] - bt[n - 1]);
    const i = Math.floor(b);
    return bt[i] + (b - i) * (bt[i + 1] - bt[i]);
  };
  const byName = new Map();
  slots.forEach((s, i) => { if (s && s.name) byName.set(String(s.name).toLowerCase(), i); });
  const get = (key) => {                                    // @name, or @digit for a keyed row
    const k = String(key).trim().toLowerCase();
    const i = byName.has(k) ? byName.get(k) : (/^\d$/.test(k) ? slots.findIndex(s => s && String(s.key) === k) : -1);
    return i >= 0 && slots[i] ? { src: String(slots[i].src || ''), id: i } : null;
  };
  const byCh = {}, pcs = {};                                // channel → its timed notes / the first program it names
  /* one row from beat0: its own notes, the rows it calls (the parser writes those in line) and the
     rows it starts alongside (@part&), which take none of its time. The notes of every strip's
     channel are kept: the drum channel is the drum track, the others are the strips' own parts. */
  const walk = (src, id, beat0, depth) => {
    const toks = mplParse(src, get, new Set([id]));
    let ch = MPL_DRUMS_CH, beat = beat0, sticky = 0;
    for (const t of toks) {
      if (t.launch != null) {
        const g = depth < 8 ? get(t.launch) : null;
        if (g) { let b = beat; for (let k = 0; k < (t.count || 1); k++) b += walk(g.src, g.id, b, depth + 1); }
        continue;
      }
      if (t.ch) { ch = t.ch; continue; }
      if (t.feelSet != null) { sticky = t.feelSet; continue; }
      if (t.pc != null) { if (pcs[ch] == null) pcs[ch] = t.pc; continue; }
      if (t.note == null && !t.notes && !t.rest) continue;
      if (!t.rest && MPL_CH_STRIP[ch]) {
        const f = t.feel != null ? t.feel : sticky, at = timeOf(beat + f / 24);
        const notes = (t.notes || [t.note]).map((n, k) => [n, mplDynVel(100, t.dyns ? t.dyns[k] : t.dyn)]);
        (byCh[ch] || (byCh[ch] = [])).push({ t: at, len: timeOf(beat + f / 24 + (t.dur || 1)) - at, ch, notes });
      }
      beat += t.dur || 1;
    }
    return beat - beat0;
  };
  const beat = walk(String(row.src), slots.indexOf(row), 0, 0);
  const parts = {};                                          // strip → { ch, events, pc, notes }
  for (const ch of Object.keys(byCh)) {
    const ev = byCh[ch].sort((a, b) => a.t - b.t);
    parts[MPL_CH_STRIP[ch]] = { ch: +ch, events: ev, pc: pcs[ch] != null ? pcs[ch] : null, notes: ev.reduce((a, e) => a + e.notes.length, 0) };
  }
  if (!Object.keys(parts).length) throw new Error('the MPL file has no notes');
  const events = parts.drums ? parts.drums.events : [];
  const g = bank.grade || row.grade || {};
  return { folder, name: row.name || '', grade: g.pct != null ? g.letter + ' ' + g.pct + '%' : '', bpm, t0, beatT: bt, pc: pcs[MPL_DRUMS_CH] != null ? pcs[MPL_DRUMS_CH] : null,
           events, parts, stems: bank.stems || null, beats: beat, bpb: +an.beats_per_bar || 4, notes: parts.drums ? parts.drums.notes : 0 };
}
function mplIdxIn(ev, t) {                                  // the first note of a list at or after song time t
  let lo = 0, hi = ev.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function mplDrumsPost(body) {
  return fetch('/api/midi/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).catch(e => ({ error: e.message }));
}
/* every listener has its own tag, so one of them can be silenced without touching the others */
const mplDrumsTagOf = (id) => mplDrumsF.tag + '.' + id + '.' + (mplDrumsF.gen[id] || 0);
function mplDrumsCancelOne(id) {
  if (!mplDrumsF.live.has(id)) return;
  fetch('/api/midi/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: mplDrumsTagOf(id), flush: true }) }).catch(() => {});
  mplDrumsF.live.delete(id);
  mplDrumsF.gen[id] = (mplDrumsF.gen[id] || 0) + 1;
}
function mplDrumsCancel() {
  if (!mplDrumsF.tag) return;
  for (const id of [...mplDrumsF.live]) mplDrumsCancelOne(id);
  mplDrumsF.tag = '';
}
function mplDrumsMaster() {
  for (const ch of CHANNELS) { const ae = audioElements[ch]; if (ae && audioHasSrc(ae)) return ae; }
  return null;
}
/* the pill: keep all six stems silent while they keep time (the looper's own mute uses the same node) */
function mplDrumsMute(on) {
  for (const ch of Object.keys(audioElements)) {
    const n = stripNodes && stripNodes[ch];
    if (!n || !n.mediaMute) continue;
    const want = on ? 0 : (Object.keys(loopBufferSources || {}).length ? 0 : 1);
    if (n.mediaMute.gain.value !== want) { try { n.mediaMute.gain.value = want; } catch (e) {} }
  }
}
/* the Drum fader's button: the drum stem — media element and looper buffer alike — is silenced
   ahead of the fader, so the click track, which joins the strip at the fader, still sounds */
function mplDrumsStemMute(on, chan) {
  const n = stripNodes && stripNodes[chan || 'drums'];
  if (!n || !n.preFader) return;
  const want = on ? 0 : 1;
  if (n.preFader.gain.value !== want) { try { n.preFader.gain.value = want; } catch (e) {} }
}
/* the strips must be carrying the six stems — not a backing track, the drum machine, a song
   source or a jam, which all play through the strips */
function mplDrumsStripOk() {
  return !!currentSong && currentSong.type === 'stems' && !drumMachineActive && !backingTrackActive && !jamMode;
}
const mplSendsOn = () => Object.keys(MPL_SEND).filter(c => mplSends[c]);
const mplPartsOn = () => Object.keys(mplParts).filter(c => mplParts[c]);
/* How hard the notes play. The drum track and a strip's own MPL part: that strip's fader, M and S —
   80% (where the fader rests) plays the velocities as written; muted, or another strip soloed, is
   silence. A D send: its strip's fader only, because M and S there belong to the stem that is still playing. */
function mplDrumsLevel(chan, own) {
  const ms = mixerState;
  if (!ms || !(currentMasterVolume > 0)) return 0;
  if (own == null ? chan === 'drums' : own) {              // the drum track, or a strip's own MPL part: M and S act on it
    if (ms.muted[chan]) return 0;
    if (Object.values(ms.soloed).some(Boolean) && !ms.soloed[chan]) return 0;
  }
  return Math.max(0, +ms.volumes[chan] || 0) / 0.8;
}
/* where the song is and how fast it runs. The section looper plays from buffers on the audio
   clock and the stems' own playheads only trail it, so there the looper's clock is the one to read. */
function mplDrumsClock() {
  const ae = mplDrumsMaster();
  if (!isPlaying || !ae) return null;
  if (!mplDrumsActive && audioCtx && sectionLooperRange && Object.keys(loopBufferSources || {}).length) {
    const a = sectionLooperRange.startT, L = sectionLooperRange.endT - a, rate = loopPlaybackRate || 1;
    if (L > 0) {
      const p = (loopInitialOffset + (audioCtx.currentTime - loopStartedAtCtxT) * rate) % L;
      return { pos: a + (p + L) % L, rate, a, L };
    }
  }
  if (ae.paused || ae.ended) return null;
  return { pos: ae.currentTime || 0, rate: ae.playbackRate || 1, a: 0, L: 0 };
}

/* the follower: every 25 ms, post the hits that fall inside the next third of a second of song time */
function mplDrumsTick() {
  if (!mplDrumsStripOk()) {
    if (mplDrumsStrip) mplDrumsStripOff();
    for (const c of mplPartsOn()) mplPartOff(c);
    if (!mplDrumsActive) for (const c of mplSendsOn()) mplSendOff(c);
  }
  const sends = mplSendsOn(), pl = mplPartsOn();
  if ((!mplDrumsActive && !mplDrumsStrip && !sends.length && !pl.length) || !mplDrums) { if (mplDrumsF.tag) mplDrumsCancel(); return; }
  if (mplDrumsActive) mplDrumsMute(true);
  if (mplDrumsStrip && !mplDrumsStripBoth) mplDrumsStemMute(true);
  for (const c of pl) if (mplParts[c] !== 'both') mplDrumsStemMute(true, c);
  const F = mplDrumsF, c = mplDrumsClock();
  // who hears what now, and how hard: the drum sequence (drum track, D sends) and each strip's own part
  const targets = [];
  if (mplDrumsActive || mplDrumsStrip) targets.push({ id: 'drums', level: mplDrumsLevel('drums') });
  for (const s of sends) targets.push({ id: s, level: mplDrumsLevel(s) });
  for (const s of pl) if (mplDrums.parts[s]) targets.push({ id: s, level: mplDrumsLevel(s, true), part: mplDrums.parts[s] });
  const live = targets.filter(t => t.level > 0);
  if (!c || !live.length) { if (F.tag) mplDrumsCancel(); return; }
  const now = performance.now();
  let expect = F.pos0 + (now - F.perf0) * F.rate / 1000;
  if (F.L > 0) expect = F.a + (((expect - F.a) % F.L) + F.L) % F.L;
  let off = Math.abs(c.pos - expect);
  if (c.L > 0) off = Math.min(off, Math.abs(c.L - off));
  if (!F.tag || c.rate !== F.rate || c.a !== F.a || c.L !== F.L || off > 0.07) {   // started, sought, looped or changed speed
    mplDrumsCancel();
    F.tag = 'mpld' + (++F.seq); F.pos0 = c.pos; F.perf0 = now; F.rate = c.rate; F.a = c.a; F.L = c.L;
    F.st = {};                                              // every list is read again from the playhead
    F.maps = {};
  }
  for (const id of [...F.live]) if (!live.some(t => t.id === id)) mplDrumsCancelOne(id);   // muted or switched off: its waiting notes go too
  for (const t of live) {                                   // a listener that joins sets its sound first
    if (F.live.has(t.id)) continue;
    F.live.add(t.id);
    if (t.part) mplDrumsPost({ port: 'IAC', type: 'pc', channel: t.part.ch, program: t.part.pc != null ? t.part.pc : mplSendProgram(t.id).p });
    else if (t.id === 'drums') { if (mplDrums.pc != null) mplDrumsPost({ port: 'IAC', type: 'pc', channel: MPL_DRUMS_CH, program: mplDrums.pc }); }
    else { F.maps[t.id] = mplSendMap(t.id); mplDrumsPost({ port: 'IAC', type: 'pc', channel: MPL_SEND[t.id].ch, program: mplSendProgram(t.id).p }); }
  }
  const lead = document.hidden ? 1500 : MPL_DRUMS_LEAD_MS;
  const horizon = F.pos0 + (now - F.perf0 + lead) * F.rate / 1000;      // song time, counted straight through the looper's wraps
  // the lists to read: the drum sequence (for the drum track and the D sends) and one part per strip
  const streams = [];
  const dl = live.filter(t => !t.part);
  if (dl.length) streams.push({ key: 'drums', ev: mplDrums.events, targets: dl });
  for (const t of live) if (t.part) streams.push({ key: 'p.' + t.id, ev: t.part.events, targets: [t] });
  const end = F.L > 0 ? F.a + F.L : Infinity;
  for (const S of streams) {
    const ev = S.ev;
    let st = F.st[S.key];
    if (!st) {                                              // a list that joins starts at where the playhead is now
      const raw = F.pos0 + (now - F.perf0) * F.rate / 1000, w = F.L > 0 ? Math.max(0, Math.floor((raw - F.a) / F.L)) : 0;
      st = F.st[S.key] = { idx: mplIdxIn(ev, raw - w * F.L - 0.05), wraps: w };   // a note the playhead has only just passed still sounds
    }
    for (;;) {
      if (F.L > 0 && (st.idx >= ev.length || ev[st.idx].t >= end)) {         // the looped section ends: on to its first note again
        if (end + st.wraps * F.L > horizon) break;
        st.wraps++; st.idx = mplIdxIn(ev, F.a);
        continue;
      }
      if (st.idx >= ev.length) break;
      const e = ev[st.idx], u = e.t + st.wraps * F.L;
      if (u > horizon) break;
      st.idx++;
      const atPerf = F.perf0 + (u - F.pos0) / F.rate * 1000;
      if (atPerf < now - 60) continue;
      const at = Date.now() + Math.max(0, atPerf - performance.now());
      for (const t of S.targets) {
        const map = t.part || t.id === 'drums' ? null : F.maps[t.id];
        const channel = map ? MPL_SEND[t.id].ch : e.ch, tag = mplDrumsTagOf(t.id);
        const offAt = at + (map || t.part ? Math.max(60, e.len / F.rate * 850) : 90);   // a drum is a tap; a synth holds the note for its step
        const done = new Set();
        for (const [n, vel] of e.notes) {
          const note = map ? map(n) : n;
          if (done.has(note)) continue;                     // two drums on one note of the key: play it once
          done.add(note);
          const velocity = Math.max(1, Math.min(127, Math.round(vel * t.level)));
          mplDrumsPost({ port: 'IAC', type: 'note_on', channel, note, velocity, at, tag })
            .then(r => { if (r && !r.error) { F.sent++; F.err = ''; } else F.err = (r && r.error) || 'no reply from the MIDI sidecar'; });
          mplDrumsPost({ port: 'IAC', type: 'note_off', channel, note, velocity: 0, at: offAt, tag });
        }
      }
    }
  }
}
setInterval(() => { try { mplDrumsTick(); } catch (e) { console.warn('[mpl-drums] tick', e); } }, 25);

function mplDrumsWhere() {
  const c = mplDrumsClock(), ae = mplDrumsMaster(), pos = c ? c.pos : ae ? (ae.currentTime || 0) : 0;
  const bt = mplDrums.beatT;
  let beat;
  if (bt) {
    if (pos < bt[0]) return 'before the first bar';
    let lo = 0, hi = bt.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bt[mid] <= pos) lo = mid; else hi = mid - 1; }
    beat = lo;
  } else {
    if (pos < mplDrums.t0) return 'before the first bar';
    beat = Math.floor((pos - mplDrums.t0) * mplDrums.bpm / 60);
  }
  return 'bar ' + (Math.floor(beat / mplDrums.bpb) + 1) + ' · beat ' + (beat % mplDrums.bpb + 1);
}
function mplDrumsBannerPaint() {
  const b = document.getElementById('mpl-drums-banner');
  if (!b) return;
  const sends = mplSendsOn(), pl = mplPartsOn(), on = mplDrumsActive || mplDrumsStrip || sends.length > 0 || pl.length > 0;
  b.classList.toggle('show', on);
  if (!on || !mplDrums) return;
  const what = (mplDrums.name || 'the drum MPL') + (mplDrums.grade ? ' (grade ' + mplDrums.grade + ')' : '');
  const parts = [];
  if (mplDrumsStrip) parts.push((mplDrumsStripBoth ? 'MPL+ — the drum stem and ' + what + ' play together' : 'MPL is the drum track — ' + what + ' plays in place of the drum stem') +
    (mplDrumsLevel('drums') <= 0 ? ' (the MPL is SILENT: the Drum fader is muted, down, or another strip is soloed)' : ''));
  else if (mplDrumsActive) parts.push('MPL Drums is the playback source — the six stems are silent, the transport plays ' + what + (mplDrumsLevel('drums') <= 0 ? ' (SILENT: the Drum fader is muted, down, or another strip is soloed)' : ''));
  if (sends.length) parts.push((parts.length ? 'its hits also play' : 'The drum sequence (' + what + ') plays') + ' as notes of ' + mplKeyName(mplSongKey()) + ' on ' +
    sends.map(s => MPL_SEND[s].label + ' m' + MPL_SEND[s].ch).join(', '));
  if (pl.length) {
    const rep = pl.filter(c => mplParts[c] !== 'both'), both = pl.filter(c => mplParts[c] === 'both'), nm = (a) => a.map(c => MPL_STRIP_LABEL[c] + ' m' + mplDrums.parts[c].ch).join(', ');
    const bits = [];
    if (rep.length) bits.push(nm(rep) + ' in place of the ' + (rep.length > 1 ? 'stems' : 'stem'));
    if (both.length) bits.push(nm(both) + ' along with the ' + (both.length > 1 ? 'stems' : 'stem'));
    parts.push('MPL ' + (parts.length ? 'also plays' : 'plays') + ' ' + bits.join(' · ') + (pl.some(c => mplDrumsLevel(c, true) <= 0) ? ' (a part is SILENT: its fader is muted, down, or another strip is soloed)' : ''));
  }
  parts.push(mplDrumsWhere(), mplDrumsF.sent + ' notes sent');
  if (mplDrumsStrip) parts.push(mplDrumsStripBoth ? 'click MPL+ to turn the MPL off' : 'press MPL again for the drum stem'); else if (mplDrumsActive) parts.push('click the 6 STEMS pill to return');
  else if (pl.length && !sends.length) parts.push(pl.every(c => mplParts[c] === 'both') ? 'click MPL to turn it off' : 'press MPL again for the stem');
  const txt = document.getElementById('mpl-drums-banner-text');
  if (txt) txt.textContent = mplDrumsF.err ? 'MPL Drums — notes are NOT going out: ' + mplDrumsF.err : parts.join(' · ');
  b.classList.toggle('mpl-bad', !!mplDrumsF.err);
}
function mplDrumsPillPaint() {
  const song = !!mplDrums && !!currentSong && mplDrums.folder === currentSong.folderName;
  const can = song && mplDrums.events.length > 0;            // the drum features need drum notes
  const how = can ? mplDrums.name + (mplDrums.grade ? ', grade ' + mplDrums.grade : '') + ', ' + mplDrums.notes + ' hits, ' +
                    (mplDrums.beatT ? 'placed on the recording\'s own beats' : 'at the song\'s one measured tempo — this file has no beat times yet') : '';
  const none = mplDrumsF.loading ? 'Looking for this song\'s drum MPL…' : 'No drum MPL for this song yet (STEMS/<song>/<song>_MPL.json).';
  const pill = document.getElementById('active-meta-mpl');
  if (pill) {
    const v = document.getElementById('active-mpl-value');
    pill.classList.toggle('disabled', !can && !mplDrumsActive);
    if (v) v.textContent = mplDrumsActive ? 'ON' : can ? (mplDrums.grade ? mplDrums.grade.split(' ')[0] : 'MPL') : '--';
    pill.title = can
      ? 'MPL DRUMS: play this song\'s drum MPL (' + how + ') as MIDI on the drum channel, with the six stems silent. ' +
        'Play, stop, the timeline, sections, loop and speed all work on it. Click again (or 6 STEMS) to go back to the stems.'
      : none;
  }
  const btn = document.getElementById('mpl-drums-strip');
  if (btn) {
    btn.classList.toggle('active', mplDrumsStrip);
    btn.classList.toggle('both', mplDrumsStrip && mplDrumsStripBoth);
    btn.textContent = mplDrumsStrip && mplDrumsStripBoth ? 'MPL+' : 'MPL';
    btn.classList.toggle('none', !can);                      // shown only when the song's MPL has drums
    btn.classList.toggle('disabled', !mplDrumsStrip && !(can && mplDrumsStripOk()));
    btn.title = !can ? none
      : !mplDrumsStripOk() ? 'The MPL can stand in for the drum stem only while the six stems are the source.'
      : 'MPL: make this song\'s drum MPL (' + how + ') the drum track. The drum stem goes silent and the MPL plays in its place as MIDI on ' +
        'channel 10, in step with the other stems. Play, stop, the timeline, sections, loop, the looper and speed all drive it; ' +
        'this fader, M and S set how hard it plays (80% = as written). Press again to bring the drum stem back. ' +
        'Hold the button down (or Option-click) to hear the drum stem AND the MPL together; the next click turns the MPL off.';
    if (mplDrumsStrip && mplDrumsStripBoth) btn.title = 'MPL+: the drum stem and this song\'s drum MPL both play (MIDI on channel 10). Click to turn the MPL off and keep the stem.';
  }
  const key = mplSongKey();
  for (const b of document.querySelectorAll('.mpl-send-btn')) {
    const chan = b.dataset.mplSend, S = MPL_SEND[chan];
    if (!S) continue;
    b.classList.toggle('active', !!mplSends[chan]);
    b.classList.toggle('disabled', !mplSends[chan] && !(can && (mplDrumsStripOk() || mplDrumsActive)));
    if (!can) { b.title = 'D: send the drum sequence to ' + S.label + ' as notes. ' + none; continue; }
    const map = mplSendMap(chan), pr = mplSendProgram(chan);
    const nm = (v) => MPL_KEY_NAMES[v % 12] + (Math.floor(v / 12) - 1);
    b.title = 'D: send this song\'s drum sequence to ' + S.label + ' — the same hits as MIDI on m' + S.ch + ', program ' + pr.p + (pr.name ? ' ' + pr.name : '') +
      ', each drum played as a note of ' + mplKeyName(key) + (key.from === 'song' ? '' : key.from === 'console' ? ' (the console\'s key: the song has none)' : ' (the song has no key)') +
      ': bass drum ' + nm(map(36)) + ', snare ' + nm(map(38)) + ', hi-hat ' + nm(map(42)) + ', toms ' + nm(map(41)) + ' ' + nm(map(47)) + ' ' + nm(map(50)) + ', crash ' + nm(map(49)) +
      '. A NOTE MAP line in the MIDI console that points a drum at m' + S.ch + ' is used in place of the automatic note. The ' + S.label +
      ' stem keeps playing; this fader sets how hard the notes play (80% = as written). Press again to stop.';
  }
  // the MPL button beside M and S on the other strips: shown only when the song's MPL has a part on that strip's channel
  for (const b of document.querySelectorAll('.mpl-part-btn')) {
    const strip = b.dataset.mplPart, P = song && mplDrums.parts[strip], L = MPL_STRIP_LABEL[strip];
    b.classList.toggle('none', !song && !mplParts[strip]);
    b.classList.toggle('active', !!mplParts[strip]);
    b.classList.toggle('both', mplParts[strip] === 'both');
    b.textContent = mplParts[strip] === 'both' ? 'MPL+' : 'MPL';
    b.classList.toggle('disabled', !mplParts[strip] && (!P || !mplDrumsStripOk()));
    if (!P) { b.title = 'This song\'s MPL has no ' + L + ' part — the ' + L + ' stem had nothing the analysis could follow, or the file has not been re-processed yet.'; continue; }
    const pc = P.pc != null ? { p: P.pc, name: '' } : mplSendProgram(strip);
    b.title = mplParts[strip] === 'both' ? 'MPL+: the ' + L + ' stem and this song\'s ' + L + ' MPL part both play (MIDI on channel ' + P.ch + '). Click to turn the MPL off and keep the stem.'
      : !mplDrumsStripOk() && !mplParts[strip] ? 'The ' + L + ' MPL can stand in for the stem only while the six stems are the source.'
      : 'MPL: play this song\'s ' + L + ' MPL part (' + P.notes + ' notes, followed from the ' + L + ' stem — a sketch, not a transcription) in place of the ' + L +
        ' stem. The stem goes silent and the part plays as MIDI on channel ' + P.ch + ', program ' + pc.p + (pc.name ? ' ' + pc.name : '') +
        ', in step with the other stems. Play, stop, the timeline, sections, loop, the looper and speed all drive it; this fader, M and S set how hard it plays (80% = as written). Press again to bring the stem back. ' +
        'Hold the button down (or Option-click) to hear the ' + L + ' stem AND the MPL part together; the next click turns the MPL off.';
  }
}

/* which song is up: fetch its MPL file, drop the MPL when the song changes. A file Drive has not
   handed over yet (503) or a server hiccup is asked for again every few seconds. */
async function mplDrumsFetch(folder) {
  mplDrumsF.loading = true; mplDrumsF.retryAt = 0; mplDrumsPillPaint();
  try {
    const r = await fetch('/api/song/' + encodeURIComponent(folder) + '/mpl', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.bank && mplDrumsF.lastFolder === folder) mplDrums = mplDrumsBuild(folder, j.bank);
    } else if (r.status !== 404) mplDrumsF.retryAt = Date.now() + 4000;
  } catch (e) {
    console.warn('[mpl-drums] ' + folder + ': ' + e.message);
    if (!/MPL file|drum row/.test(e.message)) mplDrumsF.retryAt = Date.now() + 4000;
  }
  mplDrumsF.loading = false;
}
async function mplDrumsWatch() {
  const folder = currentSong && currentSong.type === 'stems' ? currentSong.folderName : null;
  if (folder !== mplDrumsF.lastFolder) {
    mplDrumsF.lastFolder = folder;
    if (mplDrumsActive) disengageMplDrums();
    if (mplDrumsStrip) mplDrumsStripOff();
    for (const c of mplSendsOn()) mplSendOff(c);
    for (const c of mplPartsOn()) mplPartOff(c);
    mplDrums = null;
    if (folder) await mplDrumsFetch(folder);
  } else if (folder && !mplDrums && !mplDrumsF.loading && mplDrumsF.retryAt && Date.now() > mplDrumsF.retryAt) {
    await mplDrumsFetch(folder);
  }
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
setInterval(() => { mplDrumsWatch().catch(() => {}); }, 500);

function engageMplDrums() {
  if (mplDrumsActive) return;
  if (!mplDrums || !mplDrums.events.length || !currentSong || mplDrums.folder !== currentSong.folderName) { try { showToast('No drum MPL for this song yet'); } catch (e) {} return; }
  try { initAudioCtx(); } catch (e) {}
  // one source at a time
  if (mplDrumsStrip) mplDrumsStripOff();
  try { if (jamMode && jamMode.kind === 'source') leaveSongSource(); } catch (e) {}
  try { if (drumMachineActive) disengageDrumMachine(); } catch (e) {}
  try { if (backingTrackActive) disengageBackingTrack(); } catch (e) {}
  try { stopLooperIfActive(); } catch (e) {}
  mplDrumsF.sent = 0; mplDrumsF.err = '';
  mplDrumsActive = true;
  mplDrumsMute(true);
  // the stems must be loaded: they are the clock
  try { if (currentSong && !Object.values(audioElements).some(audioHasSrc)) loadSong(currentSong, { silentRestore: true }); } catch (e) {}
  try { updateModePills(); updateTransportIcon(); } catch (e) {}
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
function disengageMplDrums() {
  if (!mplDrumsActive) return;
  mplDrumsActive = false;
  mplDrumsCancel();
  mplDrumsMute(false);
  try { updateModePills(); updateTransportIcon(); } catch (e) {}
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
function toggleMplDrums() { if (mplDrumsActive) disengageMplDrums(); else engageMplDrums(); }

/* the Drum fader's MPL button */
function mplDrumsStripOn(both) {
  if (mplDrumsStrip) { mplDrumsStripBoth = !!both; mplDrumsStemMute(!both); mplDrumsPillPaint(); mplDrumsBannerPaint(); return; }   // replace ⇄ both
  if (!mplDrums || !mplDrums.events.length || !currentSong || mplDrums.folder !== currentSong.folderName) { try { showToast('No drum MPL for this song yet'); } catch (e) {} return; }
  if (mplDrumsActive) disengageMplDrums();                  // the pill and the button are two uses of one MPL
  if (!mplDrumsStripOk()) { try { showToast('The MPL can stand in for the drum stem only while the six stems are the source — click the 6 STEMS pill first'); } catch (e) {} return; }
  try { initAudioCtx(); } catch (e) {}
  if (!mplSendsOn().length) { mplDrumsF.sent = 0; mplDrumsF.err = ''; }
  mplDrumsStrip = true; mplDrumsStripBoth = !!both;
  mplDrumsStemMute(!both);                                  // the drum stem goes silent — unless the MPL is to be heard with it
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
function mplDrumsStripOff() {
  if (!mplDrumsStrip) return;
  mplDrumsStrip = false; mplDrumsStripBoth = false;
  mplDrumsCancelOne('drums');
  mplDrumsStemMute(false);                                  // the drum stem is back
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
/* a click: stem → MPL in its place → stem; held or Option-clicked: MPL together with the stem, and the next click goes back to the stem */
function toggleMplDrumsStrip(both) {
  const m = mplStripMode('drums');
  if (m === 'both' || (m === 'replace' && !both)) mplDrumsStripOff(); else mplDrumsStripOn(both);
}

/* the D button on the other five faders */
function mplSendOn(chan) {
  if (mplSends[chan] || !MPL_SEND[chan]) return;
  if (!mplDrums || !mplDrums.events.length || !currentSong || mplDrums.folder !== currentSong.folderName) { try { showToast('No drum MPL for this song yet'); } catch (e) {} return; }
  if (!mplDrumsStripOk() && !mplDrumsActive) { try { showToast('The drum sequence follows the six stems — click the 6 STEMS pill first'); } catch (e) {} return; }
  try { initAudioCtx(); } catch (e) {}
  if (mplParts[chan]) mplPartOff(chan);                     // one thing at a time on a channel: D and this strip's own MPL part
  if (!mplDrumsActive && !mplDrumsStrip && !mplSendsOn().length && !mplPartsOn().length) { mplDrumsF.sent = 0; mplDrumsF.err = ''; }
  mplSends[chan] = true;
  const S = MPL_SEND[chan], pr = mplSendProgram(chan);
  try { showToast('Drum sequence → ' + S.label + ': m' + S.ch + ', program ' + pr.p + (pr.name ? ' ' + pr.name : '') + ', notes of ' + mplKeyName(mplSongKey())); } catch (e) {}
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
function mplSendOff(chan) {
  if (!mplSends[chan]) return;
  mplSends[chan] = false;
  mplDrumsCancelOne(chan);
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}

/* the MPL button beside M and S on the other five faders */
function mplPartOn(chan, both) {
  if (!MPL_STRIP_LABEL[chan] || chan === 'drums') return;
  if (mplParts[chan]) { mplParts[chan] = both ? 'both' : 'replace'; mplDrumsStemMute(!both, chan); mplDrumsPillPaint(); mplDrumsBannerPaint(); return; }   // replace ⇄ both
  const P = mplDrums && currentSong && mplDrums.folder === currentSong.folderName && mplDrums.parts[chan];
  if (!P) { try { showToast('No MPL part for the ' + MPL_STRIP_LABEL[chan] + ' in this song'); } catch (e) {} return; }
  if (!mplDrumsStripOk()) { try { showToast('The MPL can stand in for a stem only while the six stems are the source — click the 6 STEMS pill first'); } catch (e) {} return; }
  try { initAudioCtx(); } catch (e) {}
  if (mplSends[chan]) mplSendOff(chan);                     // one thing at a time on a channel
  if (!mplDrumsActive && !mplDrumsStrip && !mplSendsOn().length && !mplPartsOn().length) { mplDrumsF.sent = 0; mplDrumsF.err = ''; }
  mplParts[chan] = both ? 'both' : 'replace';
  mplDrumsStemMute(!both, chan);                            // the stem goes silent (it keeps time) — unless the part is to be heard with it
  try { showToast(MPL_STRIP_LABEL[chan] + ' MPL: m' + P.ch + ', ' + P.notes + ' notes ' + (both ? 'along with the stem' : 'in place of the stem')); } catch (e) {}
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
function mplPartToggle(chan, both) {
  const m = mplStripMode(chan);
  if (m === 'both' || (m === 'replace' && !both)) mplPartOff(chan); else mplPartOn(chan, both);
}
function mplPartOff(chan) {
  if (!mplParts[chan]) return;
  mplParts[chan] = false;
  mplDrumsCancelOne(chan);
  mplDrumsStemMute(false, chan);                            // the stem is back
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}

/* HOLD: press an MPL button and keep it down (0.45 s) and the MPL joins the stem — "MPL+" — and stays
   that way after the button is let go. The click that ends the hold is swallowed; a button already
   in MPL+ is not held (its next click turns the MPL off). */
const MPL_HOLD_MS = 450;
let mplHold = null;
function mplHoldFired(e) {
  const h = mplHold;
  if (!h || !h.fired) return false;
  mplHold = null;
  return true;
}
document.addEventListener('pointerdown', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.mpl-part-btn, #mpl-drums-strip') : null;
  if (mplHold) { clearTimeout(mplHold.timer); mplHold = null; }
  if (!b || b.classList.contains('none') || b.classList.contains('disabled')) return;
  const strip = b.id === 'mpl-drums-strip' ? 'drums' : b.dataset.mplPart;
  if (mplStripMode(strip) === 'both') return;
  const h = mplHold = { strip, fired: false, timer: 0 };
  h.timer = setTimeout(() => {
    h.fired = true;
    if (strip === 'drums') mplDrumsStripOn(true); else mplPartOn(strip, true);
  }, MPL_HOLD_MS);
}, true);
const mplHoldRelease = () => { if (mplHold) { clearTimeout(mplHold.timer); const h = mplHold; if (!h.fired) mplHold = null; else setTimeout(() => { if (mplHold === h) mplHold = null; }, 400); } };
document.addEventListener('pointerup', mplHoldRelease, true);
document.addEventListener('pointercancel', mplHoldRelease, true);

// the pill, the fader buttons and the Drum fader's click button: bound by delegation, like the other source pills
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  const send = t.closest('.mpl-send-btn'), part = t.closest('.mpl-part-btn');
  if (t.closest('#active-meta-mpl')) { e.preventDefault(); e.stopPropagation(); toggleMplDrums(); }
  else if (t.closest('#mpl-drums-strip')) { e.preventDefault(); e.stopPropagation(); if (mplHoldFired(e)) return; toggleMplDrumsStrip(e.altKey); }
  else if (part) { e.preventDefault(); e.stopPropagation(); if (mplHoldFired(e)) return; mplPartToggle(part.dataset.mplPart, e.altKey); }
  else if (send) { e.preventDefault(); e.stopPropagation(); const c = send.dataset.mplSend; if (mplSends[c]) mplSendOff(c); else mplSendOn(c); }
  else if (t.closest('#drums-click-btn')) { e.preventDefault(); e.stopPropagation(); const b = document.getElementById('btn-click-toggle'); if (b) b.click(); }
});
