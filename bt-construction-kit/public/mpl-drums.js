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
/* MPL FADERS (Bill 2026-11-23). A strip that plays its MPL in place of its stem is an MPL strip: its fader is
   the note intensity of that channel (80% = the notes as written) and has its own value, mplVol, so the
   stem's level is still where it was when the strip goes back to its stem. M and S are shared. */
const MPL_VOL_KEY = 'performer.mplVol.v1';
const mplVol = { drums: 0.8, vocals: 0.8, bass: 0.8, guitar: 0.8, piano: 0.8, other: 0.8 };
try { const sv = JSON.parse(localStorage.getItem(MPL_VOL_KEY) || 'null'); if (sv) for (const k of Object.keys(mplVol)) if (typeof sv[k] === 'number') mplVol[k] = Math.max(0, Math.min(1, sv[k])); } catch (e) {}
/* INPUT ROUTING waiting for its bar: { mode: 'mpl' | 'stem', T: song time of the downbeat, strips: the strips an MPL switch brings in, all: every strip it puts on MPL,
   sched / hold: in the last half second the stems' switch is set on the audio clock for these strips, folder } */
let mplGate = null;
const mplFaderOn = (chan) => mplStripMode(chan) === 'replace' || !!(mplGate && mplGate.mode === 'mpl' && mplGate.strips.has(chan));
/* the DRUM KIT row in MPL mode: which piece a drum note belongs to, and how hard that piece plays
   (kit-drums.js: its MPL fader, and M and S among the pieces) */
const mplKitPiece = (n) => n === 35 || n === 36 ? 'kick' : n === 37 || n === 38 || n === 40 ? 'snare' : n === 42 || n === 44 || n === 46 ? 'hihat'
  : n === 41 || n === 43 || n === 45 || n === 47 || n === 48 || n === 50 ? 'toms' : n === 49 || n === 51 || n === 52 || n === 53 || n === 55 || n === 57 || n === 59 ? 'cymbals' : 'percussion';
const MPL_KIT_IDS = ['kick', 'snare', 'toms', 'hihat', 'cymbals', 'percussion'];
function mplKitGainP(p) {
  if (typeof kit === 'undefined' || !kit || !kit.mplVol) return 1;
  if (kit.mute[p] || (MPL_KIT_IDS.some(k => kit.solo[k]) && !kit.solo[p])) return 0;
  const own = mplFaderOn('drums') || mplKitMpl[p] === 'replace';        // an MPL fader of its own, else the piece's audio fader
  return Math.max(0, +(own ? kit.mplVol[p] : kit.vol[p]) || 0) / 0.8;
}

/* SONG | EXACT (Bill 2026-11-23). Every stem has two MPL versions:
     song  — its part in the song MPL: sections and loops, editable (what the strips' MPL buttons have played so far)
     exact — its own transcription, <stem>_MPL.json: every note where it was found in that stem, no loops,
             scored against the stem (the logic13 block of the song MPL: accuracy %). The kit pieces have only this one.
   mplSrc says which one a strip plays; the Drums strip's "exact" is the six kit pieces' transcriptions together.
   mplKitMpl: a kit piece playing its transcription in place of ('replace') or beside ('both') its audio. */
const mplSrc = { drums: 'song', vocals: 'song', bass: 'song', guitar: 'song', piano: 'song', other: 'song' };
const mplKitMpl = {};
let mplExact = { folder: null, stems: {} };                  // stem → { state: 'loading' | 'ready' | 'none', part: { ch, events, notes, pc } }
const mplL13 = () => (mplDrums && mplDrums.bank && mplDrums.bank.logic13) || null;
/* the measured accuracy (%) of a stem's transcription against its audio; 'drums' = the six pieces pooled; null = not measured */
function mplAcc(stem) {
  const l = mplL13(); if (!l) return null;
  const a = stem === 'drums' ? l.drums : (l.stems || {})[stem];
  return a && a.accuracy != null ? +a.accuracy : null;
}
const mplExactHas = (stem) => stem === 'drums' ? MPL_KIT_IDS.some(p => mplAcc(p) != null) : mplAcc(stem) != null;
const mplSrcOf = (strip) => mplSrc[strip] === 'exact' && mplExactHas(strip) ? 'exact' : 'song';
/* the % shown for what a strip's MPL button plays: the transcription's score, or (drums only) the song MPL's drum grade */
function mplPctOf(strip) {
  return mplSrcOf(strip) === 'exact' ? mplAcc(strip) : mplSongPct(strip);
}
/* the song MPL's own part against its stem: the drum grade (hits), and for the five pitched parts the
   score songpartscore.py wrote into the file (pitch classes beat by beat, the measure of the transcriptions) */
function mplSongPct(strip) {
  const b = mplDrums && mplDrums.bank;
  if (!b) return null;
  if (strip === 'drums') return b.grade && b.grade.pct != null ? +b.grade.pct : null;
  const a = b.song_accuracy && b.song_accuracy.stems && b.song_accuracy.stems[strip];
  return a && a.accuracy != null ? +a.accuracy : null;
}
function mplExactBuild(stem, tbank) {
  const keep = mplLive; mplLive = mplLiveNew();               // the panel's switches belong to the song MPL's rows, not to these
  try {
    const b = mplDrumsBuild(mplDrums.folder, Object.assign({}, tbank, { analysis: mplDrums.bank.analysis, grade: null }));
    const part = b.parts[MPL_KIT_IDS.includes(stem) ? 'drums' : stem] || Object.values(b.parts)[0];
    const off = (+tbank.offset_ms || 0) / 1000;              // the stem's hits sit this far from the grid (stemscribe.py)
    if (part && off) for (const e of part.events) e.t += off;
    return part || null;
  } finally { mplLive = keep; }
}
function mplExactLoad(stem) {
  if (!mplDrums) return null;
  const folder = mplDrums.folder;
  if (mplExact.folder !== folder) mplExact = { folder, stems: {} };
  const have = mplExact.stems[stem];
  if (have) return have;
  const rec = mplExact.stems[stem] = { state: 'loading', part: null };
  if (mplAcc(stem) == null) { rec.state = 'none'; return rec; }   // Logic found nothing there: an exact part with no notes
  fetch('/api/song/' + encodeURIComponent(folder) + '/mpl/' + stem, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
    if (!mplDrums || mplDrums.folder !== folder || mplExact.stems[stem] !== rec) return;
    try { rec.part = j && j.bank ? mplExactBuild(stem, j.bank) : null; } catch (e) { console.warn('[mpl-drums] ' + stem + ' transcription: ' + e.message); rec.part = null; }
    rec.state = rec.part ? 'ready' : 'none';
    try { mplDrumsPillPaint(); } catch (e) {}
  }).catch(() => { if (mplExact.stems[stem] === rec) delete mplExact.stems[stem]; });   // asked again on the next tick
  return rec;
}
/* is this kit piece playing its own transcription now (so the song MPL's drum row leaves that piece alone) */
const mplKitExactOn = (p) => !!mplKitMpl[p] || (mplStripMode('drums') !== 'off' && mplSrcOf('drums') === 'exact');
const mplKitPieceMode = (p) => mplKitMpl[p] || 'off';
/* the lists a stream key reads (see mplDrumsTick): drums, p.<strip>, x.<strip> (exact), k.<piece> (exact), o.<strip> (loops on top) */
function mplStreamEv(key) {
  if (!mplDrums) return null;
  if (key === 'drums') return mplDrums.events;
  const k = key.slice(0, 2), id = key.slice(2);
  if (k === 'p.') return (mplDrums.parts[id] || {}).events || null;
  if (k === 'o.') return (mplDrums.overlays[id] || {}).events || null;
  if (k === 'x.' || k === 'k.') { const r = mplExact.folder === mplDrums.folder && mplExact.stems[id]; return (r && r.part && r.part.events) || null; }
  return null;
}
/* after a change of source: nothing of these listeners is left waiting, and their lists go on from the playhead */
function mplStreamsRestart(ids, keys) {
  const F = mplDrumsF;
  for (const id of ids) mplDrumsCancelOne(id);
  const pos = F.tag && !(F.L > 0) ? F.pos0 + (performance.now() - F.perf0) * F.rate / 1000 : null;
  for (const key of keys) { const ev = mplStreamEv(key); if (ev && pos != null) F.st[key] = { idx: mplIdxIn(ev, pos + 0.005), wraps: 0 }; else delete F.st[key]; }
}
function mplSrcSet(strip, src) {
  if (!mplSrc[strip] || (src !== 'song' && src !== 'exact')) return;
  if (src === 'exact' && !mplExactHas(strip)) { try { showToast('No exact transcription of the ' + MPL_STRIP_LABEL[strip] + ' for this song'); } catch (e) {} return; }
  if (mplSrc[strip] === src) return;
  mplSrc[strip] = src;
  if (src === 'exact') for (const st of (strip === 'drums' ? MPL_KIT_IDS : [strip])) mplExactLoad(st);
  if (strip === 'drums') mplStreamsRestart(['drums'].concat(MPL_KIT_IDS.map(p => 'k.' + p)), ['drums'].concat(MPL_KIT_IDS.map(p => 'k.' + p)));
  else mplStreamsRestart([strip], ['p.' + strip, 'x.' + strip]);
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}
/* a kit piece's MPL button: its transcription in place of its audio ('replace'), beside it ('both'), or 'off' */
function mplKitPieceSet(p, mode) {
  if (!MPL_KIT_IDS.includes(p)) return;
  if (mode !== 'off') {
    if (mplAcc(p) == null) { try { showToast('No transcription of this piece for this song' + (mplL13() ? ': Logic found nothing in it' : '')); } catch (e) {} return; }
    if (!mplDrumsStripOk()) { try { showToast('The MPL can stand in for a kit piece only while the six stems are the source'); } catch (e) {} return; }
    try { initAudioCtx(); } catch (e) {}
    mplExactLoad(p);
    if (typeof kit !== 'undefined' && !kit.on && mode === 'replace') { kit.on = true; try { showToast('KIT switched on, so this piece can be swapped on its own'); } catch (e) {} }
  }
  const was = mplKitExactOn(p);
  if (mode === 'off') delete mplKitMpl[p]; else mplKitMpl[p] = mode;
  if (was !== mplKitExactOn(p)) mplStreamsRestart(['drums', 'k.' + p], ['drums', 'k.' + p]);
  try { kitApplyFaders(); kitSave(); kitPaint(); } catch (e) {}
  mplDrumsPillPaint(); mplDrumsBannerPaint();
}

/* SPEAKERS in MPL mode (Bill 2026-11-23). The sound of an MPL strip is made in Logic, so the ring of amp buttons
   cannot move audio: each lit button is instead a Logic track the strip's notes are sent to — V m11, B m13,
   G m14, P m15, O m16, and D m10 for the drums — and they play with that track's instrument. A strip's own
   track is lit to begin with. On the Drums strip the other five buttons are the D sends (the drum sequence as
   notes of the key on that track). Kit pieces keep their own list (kit.mplRoute). L and R have no track. */
const MPL_AMP_CH = { V: 11, D: 10, B: 13, G: 14, P: 15, O: 16 };
const MPL_AMP_STRIP = { V: 'vocals', D: 'drums', B: 'bass', G: 'guitar', P: 'piano', O: 'other' };
const MPL_HOME = { vocals: 'V', drums: 'D', bass: 'B', guitar: 'G', piano: 'P', other: 'O' };
const mplRoute = {};
const mplRouteOf = (strip) => mplRoute[strip] || (mplRoute[strip] = new Set([MPL_HOME[strip]]));
/* where one drum note of piece p goes: [channel, note] for each lit button of that piece */
function mplKitDests(p, n, pieceRoutes) {
  const letters = pieceRoutes && typeof kit !== 'undefined' && kit && kit.mplRoute && kit.mplRoute[p] ? kit.mplRoute[p] : ['D'];
  const out = [];
  for (const l of letters) {
    if (l === 'D') { if (!pieceRoutes || mplRouteOf('drums').has('D')) out.push([MPL_DRUMS_CH, n]); continue; }
    const st = MPL_AMP_STRIP[l];
    if (!st || !MPL_SEND[st]) continue;
    const map = mplDrumsF.maps['r.' + st] || (mplDrumsF.maps['r.' + st] = mplSendMap(st));
    out.push([MPL_SEND[st].ch, map(n)]);
  }
  return out;
}
/* the blue LEDs: a strip's (or kit piece's) LED is lit for a moment each time one of its notes sounds */
const mplLed = {};
function mplLedHit(key, atPerf) { const q = mplLed[key] || (mplLed[key] = []); if (q.length < 64) q.push(atPerf); }
/* What the MPL Player panel (mpl-player.js) has switched, by slot index. Cleared with the song.
     off  — rows dropped out of the song (everything such a row calls or starts is silent too)
     ov   — rows looping on top of it: { id, b0, b1 } in MPL beats; b1 = Infinity until told to stop
     mute — M: the row's notes, and those of everything it calls or starts, are silent wherever they play
     solo — S: only the soloed rows and what is under them is heard
     vol  — row → 0..100, the row's level and that of everything under it (75 = as written)
     rev  — rows that play backwards: last note first, and the parts they start reversed too */
const mplLiveNew = () => ({ off: new Set(), ov: [], mute: new Set(), solo: new Set(), vol: new Map(), rev: new Set() });
let mplLive = mplLiveNew();
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
  // SKEW (Bill 2026-11-27): a number of milliseconds at the top of the song's MPL file. The whole MPL — every
  // part, every row — plays that much later against the recording (negative: earlier). It moves the beat
  // grid the notes are placed on, so cycles, bars and the MPL Player panel move with it.
  const skew = (+bank.SKEW || 0) / 1000;
  const bpm = +an.bpm || +bank.bpm || 120, t0 = (+an.first_bar_t || 0) + skew, spb = 60 / bpm;
  const bt = Array.isArray(an.beat_t) && an.beat_t.length > 1 ? an.beat_t.map(x => +x + skew) : null;
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
  const ovCh = {}, ovPcs = {};                              // the same for the rows looping on top (mplLive.ov)
  const spans = [];                                         // every pass of every row: { id, b0, b1, t0, t1, ov } (for the MPL Player panel)
  const off = mplLive.off, mute = mplLive.mute, solo = mplLive.solo, vol = mplLive.vol, rev = mplLive.rev, lens = new Map();
  const lenOf = (id) => {                                   // the beats a row takes when it is called
    if (lens.has(id)) return lens.get(id);
    let n = 0;
    try { for (const t of mplParse(String((slots[id] || {}).src || ''), get, new Set([id]))) if (t.launch == null && (t.note != null || t.notes || t.rest)) n += t.dur || 1; } catch (e) {}
    lens.set(id, n);
    return n;
  };
  const gainOf = (id) => (vol.has(id) ? Math.max(0, Math.min(100, +vol.get(id) || 0)) : 75) / 75;
  /* one row from beat0: its own notes, the rows it calls (the parser writes those in line, each
     token carrying the path of rows it came through) and the rows it starts alongside (@part&),
     which take none of its time. The notes of every strip's channel are kept: the drum channel is
     the drum track, the others are the strips' own parts.
     ctx — what the rows above hand down: quiet (one of them was dropped out), path (their slot
     indexes, this row's last), mir (the stretches { s, L } of those that play backwards), gain. */
  const walk = (src, id, beat0, depth, ctx, out, opc) => {
    const toks = mplParse(src, get, new Set([id]));
    const song = out === byCh;
    let ch = MPL_DRUMS_CH, beat = beat0, sticky = 0;
    const cur = [];                                         // the called rows the cursor is inside: { id, start, pass, L }
    for (const t of toks) {
      if (t.ch) { ch = t.ch; continue; }
      if (t.feelSet != null) { sticky = t.feelSet; continue; }
      if (t.pc != null) { if (opc[ch] == null) opc[ch] = t.pc; continue; }
      if (t.launch == null && t.note == null && !t.notes && !t.rest) continue;
      const path = t.cpath || [];
      let quiet = ctx.quiet, gain = ctx.gain, mir = ctx.mir;
      for (let d = 0; d < path.length; d++) {
        const L = lenOf(path[d]);
        if (!cur[d] || cur[d].id !== path[d]) { cur.length = d; cur[d] = { id: path[d], start: beat, pass: -1, L }; }
        const k = L > 0 ? Math.floor((beat - cur[d].start) / L + 1e-9) : 0;
        if (k !== cur[d].pass) {
          cur[d].pass = k; cur.length = d + 1;
          if (song) spans.push({ id: path[d], b0: cur[d].start + k * L, b1: cur[d].start + (k + 1) * L });
        }
        if (song && off.has(path[d])) quiet = true;
        gain *= gainOf(path[d]);
        if (rev.has(path[d]) && L > 0) mir = mir.concat([{ s: cur[d].start + k * L, L }]);
      }
      cur.length = path.length;
      if (t.launch != null) {
        const g = depth < 8 ? get(t.launch) : null;
        if (g) {
          let b = beat;
          for (let k = 0; k < (t.count || 1); k++) {
            const gl = lenOf(g.id);
            const len = walk(g.src, g.id, b, depth + 1, { quiet: quiet || (song && off.has(g.id)), path: ctx.path.concat(path, [g.id]),
                                                          mir: rev.has(g.id) && gl > 0 ? mir.concat([{ s: b, L: gl }]) : mir, gain: gain * gainOf(g.id) }, out, opc);
            if (song) spans.push({ id: g.id, b0: b, b1: b + len });
            b += len;
          }
        }
        continue;
      }
      if (!t.rest && MPL_CH_STRIP[ch]) {
        const list = out[ch] || (out[ch] = []);             // a silenced strip still has its (empty) part
        const full = ctx.path.concat(path);
        if (!quiet && gain > 0 && !full.some(x => mute.has(x)) && (!solo.size || full.some(x => solo.has(x)))) {
          const dur = t.dur || 1;
          let b = beat;
          for (let k = mir.length - 1; k >= 0; k--) b = mir[k].s + mir[k].L - (b - mir[k].s) - dur;   // backwards rows: innermost first
          const f = t.feel != null ? t.feel : sticky, at = timeOf(b + f / 24);
          const notes = (t.notes || [t.note]).map((n, k) => [n, Math.min(127, mplDynVel(100, t.dyns ? t.dyns[k] : t.dyn) * gain)]);
          list.push({ t: at, len: timeOf(b + f / 24 + dur) - at, ch, notes });
        }
      }
      beat += t.dur || 1;
    }
    return beat - beat0;
  };
  const main = slots.indexOf(row);
  const top = (id, b) => ({ quiet: false, path: [id], mir: rev.has(id) && lenOf(id) > 0 ? [{ s: b, L: lenOf(id) }] : [], gain: gainOf(id) });
  const beat = walk(String(row.src), main, 0, 0, Object.assign(top(main, 0), { quiet: off.has(main) }), byCh, pcs);
  spans.push({ id: main, b0: 0, b1: beat });
  for (const o of mplLive.ov) {                             // the loops on top: pass after pass from b0 until b1 or the end of the song
    const sl = slots[o.id];
    if (!sl || !String(sl.src || '').trim()) continue;
    let b = o.b0, guard = 0;
    const end = Math.min(o.b1, beat);
    while (b < end - 1e-6 && guard++ < 4000) {
      const len = walk(String(sl.src), o.id, b, 1, top(o.id, b), ovCh, ovPcs);
      if (!(len > 0)) break;
      spans.push({ id: o.id, b0: b, b1: b + len, ov: true });
      b += len;
    }
  }
  for (const sp of spans) { sp.t0 = timeOf(sp.b0); sp.t1 = timeOf(sp.b1); }
  const partsOf = (map, pc) => {                            // strip → { ch, events, pc, notes }
    const o = {};
    for (const ch of Object.keys(map)) {
      const ev = map[ch].sort((a, b) => a.t - b.t);
      o[MPL_CH_STRIP[ch]] = { ch: +ch, events: ev, pc: pc[ch] != null ? pc[ch] : null, notes: ev.reduce((a, e) => a + e.notes.length, 0) };
    }
    return o;
  };
  const parts = partsOf(byCh, pcs), overlays = partsOf(ovCh, ovPcs);
  if (!Object.keys(parts).length) throw new Error('the MPL file has no notes');
  const events = parts.drums ? parts.drums.events : [];
  const g = bank.grade || row.grade || {};
  return { folder, name: row.name || '', grade: g.pct != null ? g.letter + ' ' + g.pct + '%' : '', bpm, t0, beatT: bt, pc: pcs[MPL_DRUMS_CH] != null ? pcs[MPL_DRUMS_CH] : null,
           events, parts, overlays, stems: bank.stems || null, beats: beat, bpb: +an.beats_per_bar || 4, notes: parts.drums ? parts.drums.notes : 0,
           spans: spans.sort((a, b) => a.t0 - b.t0), bank };
}
/* The MPL Player panel changed the song (mpl-player.js): a row's text, a row dropped out or
   brought back, a loop started or stopped. Build the song again. `soft`: the notes already on
   their way (the next third of a second) are left alone and every list goes on from there, so
   nothing is cut off or played twice; without it (or while the section looper runs) the waiting
   notes are cancelled and every list is read again from the playhead. Throws, and changes
   nothing, when the song does not build. */
function mplDrumsRebuild(bank, soft) {
  if (!mplDrums) return;
  const next = mplDrumsBuild(mplDrums.folder, bank), F = mplDrumsF;
  mplDrums = next;
  if (soft && F.tag && !(F.L > 0) && F.hz != null) {
    const evOf = (key) => key === 'drums' ? next.events : key.startsWith('p.') ? (next.parts[key.slice(2)] || {}).events
                        : key.startsWith('o.') ? (next.overlays[key.slice(2)] || {}).events : null;
    for (const key of Object.keys(F.st)) {
      if (key.startsWith('x.') || key.startsWith('k.')) continue;   // the transcriptions are not built from the song MPL: nothing changed for them
      const ev = evOf(key);
      if (ev) F.st[key] = { idx: mplIdxIn(ev, F.hz + 1e-7), wraps: 0 }; else delete F.st[key];
    }
  } else mplDrumsCancel();
  mplDrumsPillPaint(); mplDrumsBannerPaint();
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
  if (mplGate && mplGate.hold && mplGate.hold.has(chan || 'drums')) return;   // INPUT ROUTING has this strip's switch waiting on the audio clock
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
  const mine = (own == null ? chan === 'drums' : own) && mplFaderOn(chan);   // an MPL strip: its own MPL fader
  return Math.max(0, +(mine ? mplVol[chan] : ms.volumes[chan]) || 0) / 0.8;
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
    for (const p of Object.keys(mplKitMpl)) mplKitPieceSet(p, 'off');
  }
  const sends = mplSendsOn(), pl = mplPartsOn();
  const kp = mplDrums && mplDrumsStripOk() ? MPL_KIT_IDS.filter(p => mplKitExactOn(p) && (mplExactLoad(p) || {}).state === 'ready') : [];   // kit pieces playing their own transcription
  const ovs = mplDrums && mplDrums.overlays && mplDrumsStripOk() ? Object.keys(mplDrums.overlays) : [];   // rows looping on top (MPL Player panel)
  if ((!mplDrumsActive && !mplDrumsStrip && !sends.length && !pl.length && !ovs.length && !kp.length) || !mplDrums) { if (mplDrumsF.tag) mplDrumsCancel(); return; }
  if (mplDrumsActive) mplDrumsMute(true);
  if (mplDrumsStrip && !mplDrumsStripBoth) mplDrumsStemMute(true);
  for (const c of pl) if (mplParts[c] !== 'both') mplDrumsStemMute(true, c);
  const F = mplDrumsF, c = mplDrumsClock();
  // who hears what now, and how hard: the drum sequence (drum track, D sends) and each strip's own part
  const targets = [];
  if (mplDrumsActive || mplDrumsStrip) targets.push({ id: 'drums', level: mplDrumsLevel('drums') });
  for (const s of sends) targets.push({ id: s, level: mplDrumsLevel(s) });
  for (const s of pl) {
    const x = mplSrcOf(s) === 'exact', part = x ? (mplExactLoad(s) || {}).part : mplDrums.parts[s];   // its transcription, or its part of the song MPL
    if (part) targets.push({ id: s, level: mplDrumsLevel(s, true), part, x });
  }
  for (const p of kp) targets.push({ id: 'k.' + p, strip: 'drums', kit: p, level: mplDrumsLevel('drums'), part: mplExact.stems[p].part });
  for (const s of ovs) targets.push({ id: 'ov.' + s, strip: s, level: mplDrumsLevel(s, true), part: mplDrums.overlays[s], ov: true });   // heard with the stem, at the strip's level
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
    if (t.part) {
      const prog = t.part.pc != null ? t.part.pc : (t.strip || t.id) === 'drums' ? null : mplSendProgram(t.strip || t.id).p;
      if (prog != null) mplDrumsPost({ port: 'IAC', type: 'pc', channel: t.part.ch, program: prog });
    }
    else if (t.id === 'drums') { if (mplDrums.pc != null) mplDrumsPost({ port: 'IAC', type: 'pc', channel: MPL_DRUMS_CH, program: mplDrums.pc }); }
    else { F.maps[t.id] = mplSendMap(t.id); mplDrumsPost({ port: 'IAC', type: 'pc', channel: MPL_SEND[t.id].ch, program: mplSendProgram(t.id).p }); }
  }
  const lead = document.hidden ? 1500 : MPL_DRUMS_LEAD_MS;
  const horizon = F.pos0 + (now - F.perf0 + lead) * F.rate / 1000;      // song time, counted straight through the looper's wraps
  F.hz = horizon;                                           // how far the notes have been posted (mplDrumsRebuild goes on from here)
  // the lists to read: the drum sequence (for the drum track and the D sends) and one part per strip
  const streams = [];
  const dl = live.filter(t => !t.part);
  if (dl.length) streams.push({ key: 'drums', ev: mplDrums.events, targets: dl });
  for (const t of live) if (t.part) streams.push({ key: t.kit ? t.id : t.ov ? 'o.' + t.strip : (t.x ? 'x.' : 'p.') + t.id, ev: t.part.events, targets: [t] });
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
        if (mplGate && !t.ov && (t.part || t.id === 'drums') && (mplGate.mode === 'mpl' ? u < mplGate.T - 1e-4 && mplGate.strips.has(t.strip || t.id) : u >= mplGate.T - 1e-4)) continue;   // INPUT ROUTING waits for its bar: to MPL, nothing before the downbeat; to STEM, nothing from it on
        const map = t.part || t.id === 'drums' ? null : F.maps[t.id];                  // a D send: the drum sequence as notes of the key
        const tag = mplDrumsTagOf(t.id), drumTrack = !t.part && t.id === 'drums', strip = t.kit ? 'drums' : (t.strip || t.id);
        const tap = at + 90, held = at + Math.max(60, e.len / F.rate * 850);           // a drum is a tap; a synth holds the note for its step
        const ledAt = Math.max(atPerf, performance.now());
        const done = new Set();
        for (const [n, vel] of e.notes) {
          let level = t.level, dests, led = strip;
          if (map) dests = [[MPL_SEND[t.id].ch, map(n)]];
          else if (drumTrack || t.kit) {
            const p = t.kit || mplKitPiece(n);
            if (drumTrack && !mplDrumsActive && mplKitExactOn(p)) continue;             // that piece plays its own transcription
            const kitOn = !!t.kit || mplFaderOn('drums');                               // the kit faders, M, S and speakers act on each drum's notes
            if (kitOn) { const kg = mplKitGainP(p); if (kg <= 0) continue; level *= kg; }
            dests = mplKitDests(p, n, kitOn);
            mplLedHit(p, ledAt);
          } else if (t.ov || !mplFaderOn(strip)) dests = [[e.ch, n]];
          else dests = [...mplRouteOf(strip)].filter(l => l !== 'D').map(l => [l === MPL_HOME[strip] ? e.ch : MPL_AMP_CH[l], n]);   // the lit speakers: Logic tracks
          const velocity = Math.max(1, Math.min(127, Math.round(vel * level)));
          for (const [channel, note] of dests) {
            const k = channel * 128 + note;
            if (done.has(k)) continue;                       // two drums on one note of the key: play it once
            done.add(k);
            mplLedHit(led, ledAt);
            mplDrumsPost({ port: 'IAC', type: 'note_on', channel, note, velocity, at, tag })
              .then(r => { if (r && !r.error) { F.sent++; F.err = ''; } else F.err = (r && r.error) || 'no reply from the MIDI sidecar'; });
            mplDrumsPost({ port: 'IAC', type: 'note_off', channel, note, velocity: 0, at: channel === MPL_DRUMS_CH ? tap : held, tag });
          }
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
  try { mplInputPaint(); mplFaderPaint(); } catch (e) {}
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
    { const pc = can ? mplPctOf('drums') : null; btn.textContent = (mplDrumsStrip && mplDrumsStripBoth ? 'MPL+' : 'MPL') + (pc != null ? ' ' + Math.round(pc) + '%' : ''); }
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
    { const pc = P ? mplPctOf(strip) : null; b.textContent = (mplParts[strip] === 'both' ? 'MPL+' : 'MPL') + (pc != null ? ' ' + Math.round(pc) + '%' : ''); }
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
    mplLive = mplLiveNew();
    for (const p of Object.keys(mplKitMpl)) delete mplKitMpl[p];
    mplExact = { folder: null, stems: {} };
    try { kitApplyFaders(); } catch (e) {}
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

/* INPUT ROUTING — the MPL | STEM switch under OUTPUT ROUTING and INSTRUMENT ROUTING: every strip at once.
     MPL  — each strip whose MPL this song has plays it in place of its stem, exactly as its own MPL
            button does; a strip with no MPL part keeps its stem.
     STEM — every strip back on its stem.
   Neither is lit while the strips are mixed (some on MPL and some not, or an MPL+).
   While the song plays the switch waits for the next bar (mplInputRequest). */
function mplInputStrips() {
  if (!mplDrums || !currentSong || mplDrums.folder !== currentSong.folderName) return [];
  return Object.keys(MPL_STRIP_LABEL).filter(s => s === 'drums' ? mplDrums.events.length > 0 : !!mplDrums.parts[s]);
}
function mplInputMode() {
  const all = Object.keys(MPL_STRIP_LABEL);
  if (all.every(s => mplStripMode(s) === 'off')) return Object.keys(mplKitMpl).length ? 'mixed' : 'stem';
  const has = mplInputStrips();
  return has.length && all.every(s => mplStripMode(s) === (has.includes(s) ? 'replace' : 'off')) ? 'mpl' : 'mixed';
}
function mplInputSet(mode) {
  const say = (m) => { try { showToast(m, 10000); } catch (e) {} };
  if (mode === 'stem') {
    mplDrumsStripOff();
    for (const c of mplPartsOn()) mplPartOff(c);
    for (const p of Object.keys(mplKitMpl)) mplKitPieceSet(p, 'off');
    say('INPUT ROUTING: STEM — every strip plays its stem');
  } else {
    const has = mplInputStrips();
    if (!has.length) say('No MPL for this song yet');
    else if (!mplDrumsActive && !mplDrumsStripOk()) say('The MPL can stand in for the stems only while the six stems are the source — click the 6 STEMS pill first');
    else {
      for (const s of has) { if (s === 'drums') mplDrumsStripOn(false); else mplPartOn(s, false); }
      const on = has.filter(s => mplStripMode(s) === 'replace').map(s => MPL_STRIP_LABEL[s]);
      const kept = Object.keys(MPL_STRIP_LABEL).filter(s => !has.includes(s)).map(s => MPL_STRIP_LABEL[s]);
      say('INPUT ROUTING: MPL — ' + (on.join(', ') || 'nothing') + ' on MPL' + (kept.length ? ' · no MPL part, stem kept: ' + kept.join(', ') : ''));
    }
  }
  mplInputPaint();
}
function mplInputPaint() {
  const mode = mplInputMode(), can = mplInputStrips().length > 0 && (mplDrumsActive || mplDrumsStripOk());
  for (const r of document.querySelectorAll('input[name="input-routing"]')) {
    r.checked = r.value === mode;
    r.disabled = r.value === 'mpl' && mode === 'stem' && !can && !mplGate;
    const lab = r.closest('label');
    if (lab) lab.classList.toggle('armed', !!mplGate && mplGate.mode === r.value);
  }
}
/* A click on MPL or STEM. Stopped: at once. Playing: the switch waits for the next bar — the stems come
   back, or go silent, on its downbeat and the MPL notes start or stop there. A second click on the waiting
   choice switches at once; a click on the other one calls it off. With the section looper running: at once. */
let mplArmTimer = 0;
function mplNextBarT(pos, rate) {
  if (!mplDrums) return null;
  const bt = mplDrums.beatT, bpb = mplDrums.bpb || 4, from = pos + 0.2 * (rate || 1);
  if (bt) { for (let k = 0; k < bt.length; k += bpb) if (bt[k] > from) return bt[k]; return null; }
  if (!(mplDrums.bpm > 0)) return null;
  const bar = 60 / mplDrums.bpm * bpb;
  return mplDrums.t0 + Math.max(0, Math.ceil((from - mplDrums.t0) / bar)) * bar;
}
function mplInputDisarm() {
  clearTimeout(mplArmTimer); mplArmTimer = 0;
  const g = mplGate; mplGate = null;
  if (!g) return;
  if (g.mode === 'mpl' && g.pre) for (const s of g.strips) if (mplStripMode(s) === 'both') { if (s === 'drums') mplDrumsStripOff(); else mplPartOff(s); }
  if (g.mode === 'stem' && mplDrums) {                       // the notes held back from the downbeat on are due again
    const F = mplDrumsF;
    for (const k of Object.keys(F.st || {})) {
      if (k === 'drums' && mplSendsOn().length) continue;
      const ev = k.slice(0, 2) === 'o.' ? null : mplStreamEv(k);
      if (ev) F.st[k].idx = Math.min(F.st[k].idx, mplIdxIn(ev, g.T - 1e-4));
    }
  }
  if (g.hold) {                                              // take the switch off the audio clock again
    for (const s of g.hold) { const n = stripNodes && stripNodes[s]; if (n && n.preFader) { try { n.preFader.gain.cancelScheduledValues(0); n.preFader.gain.value = mplStripMode(s) === 'replace' ? 0 : 1; } catch (e) {} } }
    try { if (g.hold.has('drums') && typeof kitGateCancel === 'function') kitGateCancel(); } catch (e) {}
  }
}
function mplInputCommit() {
  clearTimeout(mplArmTimer); mplArmTimer = 0;
  const g = mplGate; if (!g) return;
  mplGate = null;
  mplInputSet(g.mode);
  mplInputPaint(); mplFaderPaint();
}
function mplInputWait() {
  clearTimeout(mplArmTimer); mplArmTimer = 0;
  const g = mplGate; if (!g) return;
  if (!mplDrums || !currentSong || mplDrums.folder !== currentSong.folderName || g.folder !== mplDrums.folder) { mplInputDisarm(); mplInputPaint(); return; }   // another song
  const c = mplDrumsClock();
  if (!c || c.L > 0) { mplInputCommit(); return; }           // stopped, or the looper took over: now
  const ms = (g.T - c.pos) / c.rate * 1000;
  if (ms <= 4) { mplInputCommit(); return; }
  if (!g.sched && ms <= 450) {
    /* the last half second. To MPL: the MPL joins beside the stems, its notes held back to the downbeat.
       Both ways: the stems go silent / come back exactly on the downbeat, set on the audio clock, and the
       kit pieces with the drum stem; the tick leaves those strips alone until the switch is made. */
    g.sched = true; g.schedPerf = performance.now() + ms;
    if (g.mode === 'mpl') { g.pre = true; for (const s of g.strips) { if (s === 'drums') mplDrumsStripOn(true); else mplPartOn(s, true); } }
    try {
      const when = audioCtx.currentTime + ms / 1000, v = g.mode === 'mpl' ? 0 : 1;
      const hold = new Set(g.mode === 'mpl' ? g.all : Object.keys(MPL_STRIP_LABEL).filter(s => mplStripMode(s) === 'replace'));
      for (const s of hold) { const n = stripNodes && stripNodes[s]; if (n && n.preFader) n.preFader.gain.setValueAtTime(v, when); }
      if (hold.has('drums') && typeof kitGateAt === 'function') kitGateAt(v === 1, when);
      g.hold = hold;
    } catch (e) {}
  } else if (g.sched && Math.abs(performance.now() + ms - g.schedPerf) > 60) { mplInputCommit(); return; }   // the song jumped: switch now
  mplArmTimer = setTimeout(mplInputWait, Math.max(1, Math.min(g.sched ? ms - 3 : ms - 440, 200)));
}
function mplInputRequest(mode) {
  if (mplGate && mplGate.mode === mode) { mplInputCommit(); return; }
  if (mplGate) mplInputDisarm();
  if (mplInputMode() === mode) { mplInputPaint(); return; }
  const c = mplDrumsClock(), T = c && !(c.L > 0) ? mplNextBarT(c.pos, c.rate) : null;
  const has = mplInputStrips();
  if (T == null || (mode === 'mpl' && (!has.length || (!mplDrumsActive && !mplDrumsStripOk())))) { mplInputSet(mode); return; }
  mplGate = { mode, T, strips: new Set(mode === 'mpl' ? has.filter(s => mplStripMode(s) === 'off') : []), all: has, pre: false, sched: false, hold: null, folder: mplDrums.folder };
  try { showToast('INPUT ROUTING: ' + (mode === 'mpl' ? 'MPL' : 'STEM') + ' from the next bar — click it again to switch now', 4000); } catch (e) {}
  mplInputWait();
  mplInputPaint();
}
document.addEventListener('click', (e) => {
  const r = e.target && e.target.matches && e.target.matches('input[name="input-routing"]') ? e.target : null;
  if (!r || r.disabled) return;
  mplInputRequest(r.value);
  mplInputPaint();
});

/* the faders of MPL strips: show and set mplVol, not the stem's level. The app's own fader handlers
   (stem level, saved mixer state, automation events) are kept out of it while a strip is an MPL strip. */
function mplFaderPaint() {
  for (const chan of Object.keys(MPL_STRIP_LABEL)) {
    const strip = document.querySelector('.channel-strip.' + chan + '-strip'), f = document.getElementById('fader-' + chan);
    if (!strip || !f) continue;
    const on = mplFaderOn(chan), was = strip.classList.contains('mpl-mode');
    const liveNow = mplStripMode(chan) !== 'off' || (chan === 'drums' && Object.keys(mplKitMpl).length > 0);   // the LED shows while this strip sends notes
    if (liveNow !== strip.classList.contains('mpl-live')) {
      strip.classList.toggle('mpl-live', liveNow);
      const hd = strip.querySelector('.channel-header');
      if (hd && !hd.querySelector('.mpl-led')) { const led = document.createElement('span'); led.className = 'mpl-led'; led.dataset.led = chan; led.title = 'Lights each time a note of this strip\'s MPL sounds.'; hd.appendChild(led); }
    }
    if (on || was) for (const b of strip.querySelectorAll('.pos-btn[data-ch]')) {          // the speakers: Logic tracks while this is an MPL strip
      const l = (/pos-([VDBGPOLR])\b/.exec(b.className) || [])[1], track = l && MPL_AMP_CH[l];
      const lit = on && !!track && (chan === 'drums' && l !== 'D' ? !!mplSends[MPL_AMP_STRIP[l]] : mplRouteOf(chan).has(l));
      b.classList.toggle('mpl-on', lit); b.classList.toggle('mpl-na', on && !track);
      if (on && !b.dataset.stemTitle) b.dataset.stemTitle = b.title || ' ';
      if (on) b.title = !track ? 'No Logic track here: in MPL mode the sound comes from Logic\'s tracks (V, D, B, G, P, O).'
        : chan === 'drums' && l !== 'D' ? 'Send the drum sequence to the ' + MPL_STRIP_LABEL[MPL_AMP_STRIP[l]] + ' track (MIDI ' + track + ') as notes of the song\'s key. Click again to stop.'
        : (lit ? 'Lit: ' : '') + MPL_STRIP_LABEL[chan] + '\'s notes ' + (lit ? 'go' : 'can also go') + ' to the ' + MPL_STRIP_LABEL[MPL_AMP_STRIP[l]] + ' track in Logic (MIDI ' + track + ') and play with that track\'s instrument. Click to ' + (lit ? 'remove' : 'add') + '.';
      else if (b.dataset.stemTitle) { b.title = b.dataset.stemTitle.trim(); delete b.dataset.stemTitle; }
    }
    if (on || was) {                                          // * and 🍭: lit for the Logic tracks while this is an MPL strip
      if (!on) mplSwirlStop(chan);
      const a = strip.querySelector('.pos-all'), sw = strip.querySelector('.pos-swirl');
      if (a) a.classList.toggle('mpl-on', on && chan !== 'drums' && mplAllOn(chan));
      if (sw) sw.classList.toggle('mpl-on', on && !!mplSwirl[chan]);
    }
    if (!on && !was) continue;
    if (on !== was) {
      strip.classList.toggle('mpl-mode', on);
      if (on) { f.dataset.stemTitle = f.title || ''; f.title = MPL_STRIP_LABEL[chan] + ' MPL intensity: how hard this strip\'s notes play (80% = as written). Its own value: the stem\'s level is untouched.'; }
      else f.title = f.dataset.stemTitle || '';
    }
    const want = on ? mplVol[chan] : (typeof mixerState !== 'undefined' && mixerState && mixerState.volumes ? +mixerState.volumes[chan] : NaN);
    if (!(want >= 0)) continue;
    if ((on !== was || document.activeElement !== f) && Math.abs(parseFloat(f.value) - want) > 0.004) f.value = want;
    const v = document.getElementById('val-' + chan), pct = Math.round(want * 100);
    if (v && v.textContent !== pct + '%') v.textContent = pct + '%';
    for (const b of strip.querySelectorAll('.fader-preset')) b.classList.toggle('active', +b.dataset.pct === pct);
  }
}
for (const type of ['input', 'change']) document.addEventListener(type, (e) => {
  const f = e.target, mm = f && f.id ? /^fader-([a-z]+)$/.exec(f.id) : null;
  if (!mm || !MPL_STRIP_LABEL[mm[1]] || !mplFaderOn(mm[1])) return;
  e.stopImmediatePropagation();                              // not the stem's level, not the saved mixer, not an automation event
  mplVol[mm[1]] = Math.max(0, Math.min(1, parseFloat(f.value) || 0));
  try { localStorage.setItem(MPL_VOL_KEY, JSON.stringify(mplVol)); } catch (x) {}
  mplFaderPaint();
}, true);
document.addEventListener('click', (e) => {                // a speaker button on an MPL strip: a Logic track, not an audio route
  const b = e.target && e.target.closest ? e.target.closest('.channel-strip.mpl-mode .pos-btn[data-ch]') : null;
  if (!b) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const strip = Object.keys(MPL_STRIP_LABEL).find(c => b.closest('.channel-strip').classList.contains(c + '-strip'));
  const l = (/pos-([VDBGPOLR])\b/.exec(b.className) || [])[1];
  if (!strip || !l || !MPL_AMP_CH[l]) { try { showToast('In MPL mode the sound comes from Logic: pick one of its tracks (V, D, B, G, P, O)'); } catch (x) {} return; }
  if (strip === 'drums' && l !== 'D') { const to = MPL_AMP_STRIP[l]; if (mplSends[to]) mplSendOff(to); else mplSendOn(to); }
  else if (strip !== 'drums' && l === 'D') return;
  else { const r = mplRouteOf(strip); if (r.has(l)) r.delete(l); else r.add(l); }
  mplFaderPaint();
}, true);
/* * and 🍭 on an MPL strip (Bill 2026-11-25): the same two tricks with Logic tracks in place of amps. * sends the
   strip's notes to all five pitched tracks (again: its own track only); 🍭 hands them from track to track, one a
   second. Not on the Drums strip, whose track buttons are the D sends. */
const MPL_RING = ['V', 'P', 'B', 'G', 'O'];
const mplSwirl = {};                                         // strip → { timer, i, prev }
const mplAllOn = (strip) => MPL_RING.every(l => mplRouteOf(strip).has(l));
function mplSwirlStop(strip) {
  const s = mplSwirl[strip]; if (!s) return;
  clearInterval(s.timer); delete mplSwirl[strip]; mplRoute[strip] = s.prev;
}
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.channel-strip.mpl-mode .pos-all, .channel-strip.mpl-mode .pos-swirl') : null;
  if (!b) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const strip = Object.keys(MPL_STRIP_LABEL).find(c => b.closest('.channel-strip').classList.contains(c + '-strip'));
  if (!strip || strip === 'drums') { try { showToast('On the Drums MPL strip, each track button sends the drum sequence to that track: use those.'); } catch (x) {} return; }
  const swirling = !!mplSwirl[strip];
  mplSwirlStop(strip);
  if (b.classList.contains('pos-all')) mplRoute[strip] = new Set(mplAllOn(strip) ? [MPL_HOME[strip]] : MPL_RING);
  else if (!swirling) {
    const s = mplSwirl[strip] = { prev: mplRouteOf(strip), i: MPL_RING.indexOf(MPL_HOME[strip]), timer: null };
    const step = () => { mplRoute[strip] = new Set([MPL_RING[s.i++ % MPL_RING.length]]); mplFaderPaint(); };
    step();
    s.timer = setInterval(step, 1000);
  }
  mplFaderPaint();
}, true);
(function mplLedLoop() {
  const paint = () => {
    requestAnimationFrame(paint);
    const now = performance.now();
    for (const el of document.querySelectorAll('.mpl-live .mpl-led, .kit-strip.mpl-piece .mpl-led')) {
      const q = mplLed[el.dataset.led];
      if (q) while (q.length && q[0] < now - 110) q.shift();
      const on = !!q && q.length > 0 && q[0] <= now;
      if (on !== el.classList.contains('on')) el.classList.toggle('on', on);
    }
  };
  requestAnimationFrame(paint);
})();
(function mplStripStyle() {
  const st = document.createElement('style');
  st.textContent = '.channel-strip.mpl-mode{border-color:#c084fc !important;box-shadow:inset 0 0 0 1px #c084fc}' +
    '.channel-strip.mpl-mode .vertical-slider{accent-color:#c084fc}' +
    '.channel-strip.mpl-mode .fader-value::before{content:"MPL ";font-weight:700;color:#8b3fd9}' +
    '.kit-panel.mpl-mode .kit-strip,.kit-strip.mpl-fader{border-color:#c084fc}' +
    '.kit-strip.mpl-fader .vertical-slider{accent-color:#c084fc}.kit-strip.mpl-fader .fader-value::before{content:"MPL ";font-weight:700;color:#8b3fd9}' +
    '.mpl-led{display:none;width:9px;height:9px;border-radius:50%;background:#16233f;border:1px solid #3b5ea8;margin-left:6px;flex:0 0 9px;transition:background .05s}' +
    '.mpl-live .mpl-led,.kit-strip.mpl-piece .mpl-led{display:inline-block}' +
    '.mpl-led.on{background:#3b9dff;border-color:#9fd0ff;box-shadow:0 0 8px 3px rgba(59,157,255,.85)}' +
    '.channel-strip.mpl-mode .pos-btn[data-ch],.channel-strip.mpl-mode .pos-all,.channel-strip.mpl-mode .pos-swirl{background:transparent !important;color:var(--text-muted) !important;border:1px dashed var(--border-color) !important;box-shadow:none !important}' +
    '.channel-strip.mpl-mode .pos-btn.mpl-on,.kit-strip.mpl-fader .kit-out.active,.kit-strip.mpl-fader .kit-all.active{background:#3b82f6 !important;color:#fff !important;border:1px solid #1d4ed8 !important}' +
    '.channel-strip.mpl-mode .pos-btn.mpl-na{opacity:.22 !important}' +
    '.mpl-strip-btn.kit-mpl{flex:1 1 34%;font-size:11px;padding:8px 0}' +
    '.mpl-strip-btn{white-space:nowrap}' +
    '.routing-fx .routing-radio.armed{outline:2px dashed #e67e22;outline-offset:1px;animation:mpl-armed .6s steps(2) infinite}' +
    '@keyframes mpl-armed{50%{outline-color:transparent}}';
  document.head.appendChild(st);
})();

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
  const b = e.target && e.target.closest ? e.target.closest('.mpl-part-btn, #mpl-drums-strip, .kit-mpl') : null;
  if (mplHold) { clearTimeout(mplHold.timer); mplHold = null; }
  if (!b || b.classList.contains('none') || b.classList.contains('disabled')) return;
  const piece = b.classList.contains('kit-mpl') ? (b.closest('.kit-strip') || { dataset: {} }).dataset.kit : null;
  const strip = piece ? 'kit:' + piece : b.id === 'mpl-drums-strip' ? 'drums' : b.dataset.mplPart;
  if (piece ? mplKitPieceMode(piece) === 'both' : mplStripMode(strip) === 'both') return;
  const h = mplHold = { strip, fired: false, timer: 0 };
  h.timer = setTimeout(() => {
    h.fired = true;
    if (piece) mplKitPieceSet(piece, 'both'); else if (strip === 'drums') mplDrumsStripOn(true); else mplPartOn(strip, true);
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
