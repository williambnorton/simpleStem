#!/usr/bin/env node
/* songpartscore.js — the notes each strip of a song MPL plays, as the Performer builds them.
   Helper of songpartscore.py: reads one <song>_MPL.json path per line on stdin and prints one JSON line
   per file: { file, parts: { vocals|bass|guitar|piano|other: [[seconds, length, [midi notes]], …] } }.
   With --exact it also builds the per-stem transcriptions beside the file (<stem>_MPL.json) as "exact".
   The Performer's own parser and builder (public/mpl-core.js, public/mpl-drums.js) are loaded into a
   sandbox, so the notes are the ones the Performer would send. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const PUB = path.join(__dirname, 'bt-construction-kit', 'public');
const noop = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : noop), apply: () => noop, construct: () => noop, set: () => true });
const box = { console, document: noop, navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => Promise.reject(new Error('offline')),
  setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0, performance: { now: () => 0 }, addEventListener() {}, location: { search: '' } };
box.window = box; box.self = box; box.globalThis = box;
const ctx = vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(PUB, 'mpl-core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(PUB, 'mpl-drums.js'), 'utf8'), ctx, { filename: 'mpl' });
const STEMS = ['vocals', 'bass', 'guitar', 'piano', 'other'];
const build = (bank) => {
  ctx.__bank = bank;
  return JSON.parse(vm.runInContext(`(() => { const b = mplDrumsBuild('x', __bank), o = {};
    for (const s of ${JSON.stringify(STEMS)}) if (b.parts[s]) o[s] = b.parts[s].events.map(e => [+e.t.toFixed(4), +e.len.toFixed(4), e.notes.map(n => n[0])]);
    return JSON.stringify(o); })()`, ctx));
};
const exact = process.argv.includes('--exact');
for (const file of fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)) {
  const out = { file };
  try {
    const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.parts = build(bank);
    if (exact) {
      out.exact = {};
      for (const s of STEMS) {
        const p = path.join(path.dirname(file), s + '_MPL.json');
        if (!fs.existsSync(p)) continue;
        try { const t = JSON.parse(fs.readFileSync(p, 'utf8')); const b = build(Object.assign({}, t, { analysis: bank.analysis, grade: null })); out.exact[s] = b[s] || Object.values(b)[0] || []; } catch (e) {}
      }
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  console.log(JSON.stringify(out));
}
