// check_song.js <mpl-core.js> <song _MPL.json>... — every row must parse with the real MPL parser, every part must be as
// long as its section, and the song row must be as long as the recording's beat map.
const fs = require('fs'), path = require('path');
const core = require(path.resolve(process.argv[2]));
let bad = 0, files = 0, rowsN = 0;
for (const f of process.argv.slice(3)) {
  let b; try { b = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log('UNREADABLE', f); bad++; continue; }
  if (b.version !== 2) continue;
  files++;
  const slots = b.slots, byName = new Map(slots.map((s, i) => [s.name.toLowerCase(), i]));
  const get = (key) => { const i = byName.get(String(key).toLowerCase()); return i == null ? null : { src: slots[i].src, id: i }; };
  const errs = [];
  const beatsOf = (i) => {                       // length of a row in beats: its notes and rests, launches take no time
    const toks = core.mplParse(slots[i].src, get, new Set([i]));
    let beats = 0, n = 0, launches = [];
    for (const t of toks) {
      if (t.launch != null) { launches.push(String(t.launch).toLowerCase()); continue; }
      if (t.note == null && !t.notes && !t.rest) continue;
      beats += t.dur || 1; n++;
    }
    return { beats, n, launches };
  };
  const len = {};
  slots.forEach((s, i) => {
    rowsN++;
    if (s.src.length > 4096) errs.push(s.name + ': ' + s.src.length + ' characters');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(s.name)) errs.push('bad name ' + s.name);
    try { len[s.name] = beatsOf(i); if (len[s.name].n > core.MPL_MAX_NOTES) errs.push(s.name + ': ' + len[s.name].n + ' notes'); }
    catch (e) { errs.push(s.name + ': ' + e.message); }
  });
  if (byName.size !== slots.length) errs.push('two rows share a name');
  for (const s of slots) {
    const L = len[s.name]; if (!L) continue;
    if (s.beats != null && Math.abs(L.beats - s.beats) > 1e-6) errs.push(s.name + ' is ' + L.beats + ' beats, should be ' + s.beats);
    if (s.role === 'phrase') {
      for (const p of L.launches) { const q = slots[byName.get(p)]; if (!q) errs.push(s.name + ' starts a missing part ' + p); else if (len[q.name] && Math.abs(len[q.name].beats - s.beats) > 1e-6) errs.push(q.name + ' is ' + len[q.name].beats + ' beats, its phrase is ' + s.beats); }
    }
    if (s.role === 'song' && Math.abs(L.beats - b.analysis.beats) > 1e-6) errs.push('the song row is ' + L.beats + ' beats, the recording ' + b.analysis.beats);
  }
  if (errs.length) { bad++; console.log(path.basename(f) + ':'); errs.slice(0, 8).forEach(e => console.log('   ' + e)); }
}
console.log('song files', files, '· rows', rowsN, '· files with problems', bad);
