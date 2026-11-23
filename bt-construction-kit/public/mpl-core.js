/* mpl-core.js — the MPL language itself: the parser and what its marks mean.
   Shared by the MIDI console (midi-console.html) and the Performer (app.js), so the two
   can never read a string differently. No page, no DOM: it also loads in Node.
   Moved out of midi-console.html on 2026-11-17; the code is unchanged. */
const MPL_MAX_NOTES = 4096;   // the most notes + rests one string may expand to (was 2048)
const MPL_DYN_UP = { 1: 0.4, 2: 0.75, 3: 1 }, MPL_DYN_DOWN = { '-1': 0.8, '-2': 0.55, '-3': 0.25 };
function mplDynVel(v, dyn) {
  if (!dyn || v < 1) return v;
  const r = dyn > 0 ? v + (127 - v) * MPL_DYN_UP[dyn] : v * MPL_DYN_DOWN[dyn];
  return Math.max(1, Math.min(127, Math.round(r)));
}
const MPL_SEMIS = { 'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11 };
const MPL_DEFAULTS = { octave: 2, dur: 'q' };   // octave 2: bare C = MIDI 36, the bass drum (Bill 2026-11-14); editable in the defaults row
function mplParse(src, getSlot, _seen) {
  let i = 0; const s = String(src || '');
  /* Group default duration (Bill 2026-11-14): a duration letter on a
     group's head sets the length of every note, chord, rest and comma
     pause inside that has none of its own — 4e(E,F,G) = 4(Ee,Fe,Ge).
     Groups nest; a note's own letter wins; called slots keep their own
     defaults. Outside any such group the Defaults row's ⌂ q applies. */
  const DUR_BEATS = { e: 0.5, s: 0.25, w: 4, q: 1, h: 2 };
  /* A dot after a duration makes it 1.5 times as long (Bill 2026-11-19): Ce. is a dotted
     eighth = 0.75 beat; a dot alone (C.) dots the current default; e.(…) dots a group's
     default. One dot only, and never when another dot follows (C..3( is a range, C...3( a loop). */
  const durB = (x) => x.endsWith('.') ? durB(x.slice(0, -1)) * 1.5 : DUR_BEATS[x];
  const beats = (d) => !d ? durB(curDur()) : d[0] === '.' ? durB(curDur()) * 1.5 : durB(d);
  const durStack = [];
  const curDur = () => durStack.length ? durStack[durStack.length - 1] : MPL_DEFAULTS.dur;
  /* group head at the cursor: [dur][octave shift]( */
  const groupAt = () => /^([ehqsw]\.?)?(\+{1,3}|-{1,3})?\(/.exec(s.slice(i));
  function groupParse(g) {
    i += g[0].length;
    if (g[1]) durStack.push(g[1]);
    let inner;
    try { inner = seq(true); } finally { if (g[1]) durStack.pop(); }
    return g[2] ? mplOctShift(inner, g[2]) : inner;
  }
  /* @N — the call: inline slot N's MPL at this point. A repeat count
     works (2@2 plays slot 2 twice). getSlot supplies slot sources; the
     seen-set breaks circular calls (@2 inside slot 2, or 1→2→1). */
  const seen = _seen || new Set();
  function callSlot(key) {
    if (!getSlot) throw new Error('@' + key + ' — slot calls only work from the MPL BANK');
    const got = getSlot(key);
    if (!got) throw new Error('@' + key + ' — no slot numbered or named "' + key + '"');
    if (seen.has(got.id)) throw new Error('@' + key + ' is a circular call');
    if (!String(got.src || '').trim()) throw new Error('@' + key + ' — that slot is empty');
    /* each inlined token remembers its home: the callee slot id + its
       span in the CALLEE's source, so the play view can underline the
       called slot's text while the call runs. */
    return mplParse(got.src, getSlot, new Set([...seen, got.id]))
      .filter(t => !t.loopMark)
      .map(t => ({ ...t, cslot: got.id, cs: t.s, ce: t.e, cpath: [got.id, ...(t.cpath || [])] }));
  }
  /* call target: a single digit or a shorthand NAME (the slot's name
     field, case-insensitive) — @1 ≡ @verse ≡ @Verse. */
  function callTarget() {
    const m = /^(\d|[A-Za-z][A-Za-z0-9_]{0,47})/.exec(s.slice(i));
    if (!m) throw new Error('@ needs a slot key 0-9 / A-Z or a slot name');
    i += m[1].length;
    return m[1];
  }
  /* One note/chord or rest token at the cursor — shared by the main loop
     and the bare repeat-count form (2Ae = two eighth-note As). */
  /* stack (Bill 2026-11-15): |C,F#| = the notes between the bars sound
     together on one step (kick + hat). Inside: notes, each with optional
     ^ or v. After the closing bar: an optional length letter and feel
     marks, for the whole stack. A | glued to a note opens a stack; the
     straight-feel mark stays a | on its own (",|,") or after a note. */
  function stackToken() {
    if (s[i] !== '|' || !/[A-G]/.test(s[i + 1] || '')) return null;
    const p0 = i; i++;
    const notes = [], dyns = [];
    for (;;) {
      while (/\s/.test(s[i] || '')) i++;
      const m = /^([A-G])(#|b)?(\d?)([+\-]*)([\^v]*)/.exec(s.slice(i));
      if (!m) throw new Error('inside |…| write notes with commas between them, e.g. |C,F#| (char ' + (i + 1) + ')');
      i += m[0].length;
      const name = m[1] + (m[2] || '');
      let v = 12 * ((m[3] === '' ? MPL_DEFAULTS.octave : +m[3]) + 1) + MPL_SEMIS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
      for (const c of m[4]) v += (c === '+') ? 12 : -12;
      if (v < 0 || v > 127) throw new Error(name + ' shifted out of MIDI range 0-127');
      const up = (m[5].match(/\^/g) || []).length, dn = (m[5].match(/v/g) || []).length;
      if (up && dn) throw new Error(name + ': use ^ or v on a note, not both');
      if (up > 3 || dn > 3) throw new Error(name + ': at most 3 ^ or 3 v');
      if (!notes.includes(v)) { notes.push(v); dyns.push(up || -dn); }
      while (/\s/.test(s[i] || '')) i++;
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '|') { i++; break; }
      throw new Error('stack |' + name + '… needs a closing | — inside it a note takes only ^ or v; the length goes after the closing bar, e.g. |C,F#|e (char ' + (i + 1) + ')');
    }
    const t = /^([ehqsw]?(?:\.(?!\.))?)((?:[\/\\|])*)/.exec(s.slice(i));
    i += t[0].length;
    const o = { notes, root: notes[0], dyns, stack: true, dur: beats(t[1]), s: p0, e: i };
    if (t[2]) {
      let f = 0;
      if (!t[2].includes('|')) { for (const c of t[2]) f += (c === '/') ? -1 : 1; f = Math.max(-4, Math.min(4, f)); }
      o.feel = f;
    }
    return o;
  }
  function noteToken() {
    const st = stackToken();
    if (st) return st;
    const noteS = i;
    /* Case matters (Bill 2026-11-11): CAPITAL A-G are notes; lowercase
       letters modify them — b = flat (Bb2, Ebe), e/q/s/w = duration. */
    const m = /^([A-G])(#|b)?(\d?)([+\-]*)(m!|!)?([ehqsw]?(?:\.(?!\.))?)((?:[\/\\|^v])*)/.exec(s.slice(i));
    if (!m || !m[1]) return null;
    i += m[0].length;
    const name = m[1] + (m[2] || '');
    const oct = m[3] === '' ? MPL_DEFAULTS.octave : +m[3];
    let root = 12 * (oct + 1) + MPL_SEMIS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    for (const c of m[4]) root += (c === '+') ? 12 : -12;
    const dur = beats(m[6]);
    /* feel suffix: each / leans ahead 1 tick (1/24 beat), each \\ lays
       back 1 tick, | = dead straight. Per-note override of the sticky
       feel; capped at ±4 ticks. */
    let feel = null;
    const fm = m[7].replace(/[\^v]/g, '');
    if (fm) {
      if (fm.includes('|')) feel = 0;
      else {
        feel = 0;
        for (const c of fm) feel += (c === '/') ? -1 : 1;
        feel = Math.max(-4, Math.min(4, feel));
      }
    }
    /* dynamics (Bill 2026-11-14): ^ ^^ ^^^ louder (a little, a lot, max),
       v vv vvv softer (a little, a lot, max) — this note only. */
    const up = (m[7].match(/\^/g) || []).length, dn = (m[7].match(/v/g) || []).length;
    if (up && dn) throw new Error(name + ': use ^ or v on a note, not both');
    if (up > 3 || dn > 3) throw new Error(name + ': at most 3 ^ or 3 v');
    const dyn = up || -dn;
    const tok = (o) => { if (feel != null) o.feel = feel; if (dyn) o.dyn = dyn; return o; };
    if (m[5]) {
      const iv = (m[5] === 'm!') ? [0, 3, 7] : [0, 4, 7];
      const notes = iv.map(x => root + x);
      if (notes.some(v => v < 0 || v > 127)) throw new Error(name + ' chord out of MIDI range 0-127');
      return tok({ notes, root, dur, s: noteS, e: i });
    }
    if (root < 0 || root > 127) throw new Error(name + ' shifted out of MIDI range 0-127');
    return tok({ note: root, dur, s: noteS, e: i });
  }
  function restToken() {
    const m = /^[Rr-]([ehqsw]?(?:\.(?!\.))?)/.exec(s.slice(i));
    if (!m) return null;
    const rp = i;
    i += m[0].length;
    return { rest: true, dur: beats(m[1]), s: rp, e: i };
  }

  function seq(inGroup) {
    const out = [];
    /* Consecutive commas are pauses: an empty slot between commas is one
       quarter rest — A,,,D plays A, two beats of silence, then D. */
    let danglingComma = false;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ',') { i++; if (danglingComma) out.push({ rest: true, dur: durStack.length ? beats('') : 1, s: i - 1, e: i }); danglingComma = true; continue; }
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === ')') { if (inGroup) { i++; return out; } throw new Error('unexpected ")" at char ' + (i + 1)); }
      danglingComma = false;
      /* tempo (Bill 2026-11-15): 88T sets the bank tempo to 88 bpm from
         here on. There is one tempo for the whole bank, so it becomes the
         new default: every row that is playing follows it. Zero time. */
      const tm = /^(\d{1,3})T(?![A-Za-z0-9_])/.exec(s.slice(i));
      if (tm) {
        if (+tm[1] < 30 || +tm[1] > 300) throw new Error('tempo ' + tm[1] + 'T is out of range: 30T to 300T');
        out.push({ tempo: +tm[1], s: i, e: i + tm[0].length });
        i += tm[0].length;
        continue;
      }
      /* octave group (2026-11-11): 1-3 + or - glued to "(" shift every note
         inside by that many octaves: -(C,E,G) = C3,E3,G3 · ++(A) = A6.
         A rest before a group needs a comma: -,(C,E). */
      if (/^[ehqsw]?\.?(\+{4,}|-{4,})\(/.test(s.slice(i))) throw new Error('octave group: at most 3 + or - before "(" (char ' + (i + 1) + ')');
      const g0 = groupAt();
      if (g0) { out.push(...groupParse(g0)); continue; }
      if (/\d/.test(ch)) {
        const numS = i;
        let n = ''; while (i < s.length && /\d/.test(s[i])) n += s[i++];
        const numE = i;
        while (i < s.length && /\s/.test(s[i])) i++;
        const reps = Math.min(99, Math.max(1, +n));
        if (s[i] === '@') {
          i++;
          const key = callTarget();
          if (s[i] === '&') {
            i++;
            out.push({ launch: key, count: reps, s: numS, e: i });
            continue;
          }
          const inner = callSlot(key).map(t => ({ ...t, s: numS, e: i }));
          for (let k = 0; k < reps; k++) {
            out.push({ loopMark: { s: numS, e: numE, remaining: reps - k } });
            out.push(...inner.map(t => ({ ...t })));
          }
          out.push({ loopMark: { s: numS, e: numE, restore: true } });
          continue;
        }
        if (/^[ehqsw]?\.?(\+{4,}|-{4,})\(/.test(s.slice(i))) throw new Error('octave group: at most 3 + or - before "(" (char ' + (i + 1) + ')');
        const g2 = groupAt();
        if (g2) {
          const inner = groupParse(g2);
          for (let k = 0; k < reps; k++) {
            out.push({ loopMark: { s: numS, e: numE, remaining: reps - k } });
            out.push(...inner.map(t => ({ ...t })));
          }
          out.push({ loopMark: { s: numS, e: numE, restore: true } });
          continue;
        }
        /* bare repeat: count + single note/chord/rest — 2Ae = two
           eighth-note As, 3R = three rests (Bill 2026-07-29). */
        const single = noteToken() || restToken();
        if (single) {
          for (let k = 0; k < reps; k++) {
            out.push({ loopMark: { s: numS, e: numE, remaining: reps - k } });
            out.push({ ...single });
          }
          out.push({ loopMark: { s: numS, e: numE, restore: true } });
          continue;
        }
        throw new Error('expected "(", "@", or a note after repeat count ' + n);
      }
      /* standalone feel mode: | straight · / ahead · \\ behind — sticky
         for all following notes until changed (per-note suffix wins). */
      if ((ch === '/' || ch === '\\' || ch === '|') && !(ch === '|' && /[A-G]/.test(s[i + 1] || ''))) {
        const p0 = i;
        let v = 0, bar = false;
        while (i < s.length && (s[i] === '/' || s[i] === '\\' || s[i] === '|')) {
          if (s[i] === '|') bar = true;
          else v += (s[i] === '/') ? -1 : 1;
          i++;
        }
        out.push({ feelSet: bar ? 0 : Math.max(-4, Math.min(4, v)), s: p0, e: i });
        continue;
      }
      if (ch === '#') {
        const p0 = i;
        let n2 = 0;
        while (i < s.length && s[i] === '#') { n2++; i++; }
        out.push({ excl: n2, s: p0, e: i });
        continue;
      }
      /* sample (Bill 2026-11-20): *name plays the audio clip of that name from the SAMPLES folder. Zero time, like
         p# or m#: the clip rings for its own length and the sequence carries straight on — A,B,*airhorn,C,D. */
      if (ch === '*') {
        const m = /^\*([A-Za-z0-9_]{1,64})/.exec(s.slice(i));
        if (!m) throw new Error('* needs a sample name — letters, digits or _ (char ' + (i + 1) + ')');
        out.push({ sample: m[1], s: i, e: i + m[0].length });
        i += m[0].length;
        continue;
      }
      if (ch === '@') {
        const p0 = i;
        i++;
        const key = callTarget();
        if (s[i] === '&') {
          i++;
          out.push({ launch: key, count: 1, s: p0, e: i });
          continue;
        }
        out.push(...callSlot(key).map(t => ({ ...t, s: p0, e: i })));
        continue;
      }
      if (ch === 'm' || ch === 'M') {
        const p0 = i;
        i++; let n = ''; while (i < s.length && /\d/.test(s[i])) n += s[i++];
        if (!n) throw new Error('m needs a channel 1-16 (char ' + (i + 1) + ')');
        const c = +n; if (c < 1 || c > 16) throw new Error('channel ' + c + ' out of range 1-16');
        out.push({ ch: c, s: p0, e: i });
        continue;
      }
      /* control change: c<num>=<val> — MPL gained this so the corpus can
         express everything the wire says (Stadium snapshots CC69=2, etc.)
         and so sequences can drive real CCs. Zero time, like p#/m#. */
      if (ch === 'c' && /^c\d+=/.test(s.slice(i))) {   // lowercase only: C7 is a note
        const p0 = i;
        i++;
        let n = ''; while (i < s.length && /\d/.test(s[i])) n += s[i++];
        i++;   // '='
        let v = ''; while (i < s.length && /\d/.test(s[i])) v += s[i++];
        if (!v) throw new Error('c' + n + '= needs a value 0-127 (char ' + (i + 1) + ')');
        const cc = +n, val = +v;
        if (cc > 127 || val > 127) throw new Error('CC ' + cc + '=' + val + ' out of range 0-127');
        out.push({ cc, val, s: p0, e: i });
        continue;
      }
      if (ch === 'p' || ch === 'P') {
        const p0 = i;
        i++; let n = ''; while (i < s.length && /\d/.test(s[i])) n += s[i++];
        if (!n) throw new Error('p needs a program 0-127 (char ' + (i + 1) + ')');
        const p = +n; if (p > 127) throw new Error('program ' + p + ' out of range 0-127');
        out.push({ pc: p, s: p0, e: i });
        continue;
      }
      if (s.startsWith('...', i) || ch === '\u2026') {
        i += (ch === '\u2026') ? 1 : 3;
        /* token...N(body) — the incrementing loop: the token immediately
           before the ... is re-emitted at the top of every iteration with
           its value advanced by 1 each time. p1...3(A,B,C) plays the body
           under programs 1, 2, 3; m1...4(C) walks channels 1-4; C...5(-)
           climbs semitones. Bare ... (no N( after) stays the trajectory
           filler between notes. */
        const eS = i - 3;
        const look = /^\s*(\d+)\s*\(/.exec(s.slice(i));
        if (look) {
          const numS = i + look[0].search(/\d/);
          const numE = numS + look[1].length;
          i += look[0].length;
          const inner = seq(true);
          const reps = Math.min(99, Math.max(1, +look[1]));
          const base = out.pop();
          if (!base || (base.note == null && !base.notes && base.pc == null && base.ch == null)) {
            throw new Error('"...N(" needs a note, p#, or m# immediately before it');
          }
          for (let k = 0; k < reps; k++) {
            out.push({ loopMark: { s: numS, e: numE, remaining: reps - k } });
            if (base.note != null) {
              const v = base.note + k;
              if (v < 0 || v > 127) throw new Error('"..." walked a note out of MIDI range');
              out.push({ note: v, dur: base.dur, s: base.s, e: base.e });
            } else if (base.notes) {
              const vs = base.notes.map(v => v + k);
              if (vs.some(v => v < 0 || v > 127)) throw new Error('"..." walked a chord out of MIDI range');
              out.push({ notes: vs, root: (base.root || 0) + k, dur: base.dur, s: base.s, e: base.e });
            } else if (base.pc != null) {
              out.push({ pc: Math.min(127, base.pc + k), s: base.s, e: base.e });
            } else {
              out.push({ ch: Math.min(16, base.ch + k), s: base.s, e: base.e });
            }
            out.push(...inner.map(t => ({ ...t })));
          }
          out.push({ loopMark: { s: numS, e: numE, restore: true } });
          continue;
        }
        out.push({ ellipsis: true, s: eS, e: i });
        continue;
      }
      /* value range: token..N(body) — the two-dot RANGE (checked after the
         three-dot forms so ... always wins). p1..3(E,D) plays the body
         under programs 1,2,3 — inclusive, descending allowed (p5..3).
         Precedence: the ..3( binds as a range end, never as a 3() loop. */
      if (ch === '.' && s[i + 1] === '.' && s[i + 2] !== '.') {
        i += 2;
        const look = /^\s*(\d+)\s*\(/.exec(s.slice(i));
        if (!look) throw new Error('".." needs an end value and "(" — e.g. p1..3(E,D)');
        const numS = i + look[0].search(/\d/);
        const numE = numS + look[1].length;
        i += look[0].length;
        const inner = seq(true);
        const base = out.pop();
        if (!base || (base.note == null && base.pc == null && base.ch == null)) {
          throw new Error('".." range needs a note, p#, or m# immediately before it');
        }
        const from = (base.note != null) ? base.note : (base.pc != null ? base.pc : base.ch);
        const end = +look[1];
        const step = end >= from ? 1 : -1;
        const total = Math.abs(end - from) + 1;
        if (base.pc != null && (end < 0 || end > 127)) throw new Error('".." program range ends at ' + end + ' — programs are 0-127 (p0..127 is all of them)');
        if (total > 999) throw new Error('".." range too long (' + total + ' steps, max 999)');
        let k = 0;
        for (let v = from; step > 0 ? v <= end : v >= end; v += step, k++) {
          out.push({ loopMark: { s: numS, e: numE, remaining: total - k } });
          if (base.note != null) {
            if (v < 0 || v > 127) throw new Error('".." walked a note out of MIDI range');
            out.push({ note: v, dur: base.dur, s: base.s, e: base.e });
          } else if (base.pc != null) {
            out.push({ pc: Math.max(0, Math.min(127, v)), s: base.s, e: base.e });
          } else {
            out.push({ ch: Math.max(1, Math.min(16, v)), s: base.s, e: base.e });
          }
          out.push(...inner.map(t => ({ ...t })));
        }
        out.push({ loopMark: { s: numS, e: numE, restore: true } });
        continue;
      }
      /* note := letter #? octave-digit? (+|-)* (m! | !)? (w|h|q|e|s)?
         C! = C major chord, Cm! = C minor (root, third, fifth). Duration
         letters: w=whole h=half q=quarter(default) e=eighth s=sixteenth; a . after the letter dots it (Ce. = 1.5 eighths).
         "Cm" without "!" is NOT a chord — the m starts a channel command. */
      const nt = noteToken();
      if (nt) { out.push(nt); continue; }
      const rt = restToken();
      if (rt) { out.push(rt); continue; }
      if (/[a-g]/.test(ch)) throw new Error('lowercase "' + ch + '" at char ' + (i + 1) + ' is not a note — notes are capital A-G (lowercase b = flat, e = eighth): write ' + ch.toUpperCase());
      throw new Error('unexpected "' + ch + '" at char ' + (i + 1));
    }
    if (inGroup) throw new Error('missing ")"');
    return out;
  }
  return mplResolveEllipses(seq(false));
}
/* Octave group helper: shift every note/chord in toks by marks ("+", "--"…)
   — & launches start other slots and are not shifted. */
function mplOctShift(toks, marks) {
  const d = (marks[0] === '+' ? 12 : -12) * marks.length;
  const ok = (v) => { if (v < 0 || v > 127) throw new Error(marks + '( shifts a note out of MIDI range 0-127'); return v; };
  return toks.map(t => t.note != null ? { ...t, note: ok(t.note + d) }
    : t.notes ? { ...t, notes: t.notes.map(v => ok(v + d)), root: t.root != null ? t.root + d : t.root } : t);
}
/* "..." — continue the trajectory: the two notes before it set the step,
   and generated notes walk that step until (not including) the next
   written note. 2(E,F,...,E+) climbs the chromatic scale to E an octave
   up, twice. Generated notes inherit the previous note's duration. */
function mplResolveEllipses(toks) {
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!t.ellipsis) { out.push(t); continue; }
    const prior = [];
    for (let j = out.length - 1; j >= 0 && prior.length < 2; j--) if (out[j].note != null) prior.push(out[j]);
    let next = null;
    for (let j = k + 1; j < toks.length; j++) if (toks[j].note != null) { next = toks[j]; break; }
    if (!prior.length) throw new Error('"..." needs at least one note before it');
    if (!next) throw new Error('"..." needs a target note after it');
    if (prior.length === 1) {
      /* One prior note: walk the natural (white-key) scale toward the
         target — m2,C...E plays C,D,E; C...C+ walks the C major scale. */
      const from = prior[0].note, target = next.note;
      if (from === target) throw new Error('"..." target equals the note before it');
      const dir = target > from ? 1 : -1;
      const WHITE = [0, 2, 4, 5, 7, 9, 11];
      for (let v = from + dir; dir > 0 ? v < target : v > target; v += dir) {
        if (v < 0 || v > 127) break;
        if (WHITE.includes(((v % 12) + 12) % 12)) out.push({ note: v, dur: prior[0].dur, s: t.s, e: t.e });
      }
    } else {
      /* Two priors: their interval is the step — E,F,... climbs half
         steps; C,E,... climbs major thirds. */
      const step = prior[0].note - prior[1].note;
      if (!step) throw new Error('"..." step is zero — the two notes before it are identical');
      if ((step > 0) !== (next.note > prior[0].note)) throw new Error('"..." target is not in the direction of travel');
      for (let v = prior[0].note + step; step > 0 ? v < next.note : v > next.note; v += step) {
        out.push({ note: v, dur: prior[0].dur, s: t.s, e: t.e });
      }
    }
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MPL_MAX_NOTES, MPL_SEMIS, MPL_DEFAULTS, MPL_DYN_UP, MPL_DYN_DOWN, mplParse, mplOctShift, mplResolveEllipses, mplDynVel };
}
