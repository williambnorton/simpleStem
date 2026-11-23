#!/usr/bin/env python3
"""songscribe: a song's six stems -> one MPL song you can read top-down (Bill 2026-11-17):

    Fool_in_the_Rain=@intro,@verse,@chorus,@verse,@chorus,@bridge,@verse,2@chorus;
    verse=2@verseA,@verseB;
    verseA=@verseADrums&,@verseABass&,@verseAGuitar&,4Rw;
    verseADrums=m10,4e(|C,F#|,F#,|D,F#|,F#);
    verseABass=m13,2s-(Eq,R,R,Ge,A,...);

  the song     = its sections in order; a section that comes back is called again by the same name
  a section    = its phrases in order (4 bars each); a phrase that comes back is called again too
  a phrase     = its parts started together (@part&), then rests for the phrase's length
  a part       = one stem as MPL on that stem's channel: m10 drums, m11 voice, m13 bass,
                 m14 guitar, m15 piano, m16 other

Drums are measured by drumscribe (hits on the beat grid, graded A-F against the drum stem). Bass and
voice are followed as one note at a time; guitar, piano and other as one chord per beat. Those are
rough sketches and are not graded. Pure numpy + ffmpeg.
"""
import os, re
import numpy as np
import drumscribe as ds
import drumlabel

SR = ds.SR
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
# stem file, part suffix, MIDI channel
PARTS = [('drums', 'Drums', 10), ('bass', 'Bass', 13), ('vocals', 'Voice', 11), ('guitar', 'Guitar', 14), ('piano', 'Piano', 15), ('other', 'Other', 16)]
MONO = {'bass': (38.0, 330.0, 26, 62), 'vocals': (75.0, 1000.0, 43, 86)}     # f0 search range (Hz), note range (MIDI)
CHORD_OCT = {'guitar': 0, 'piano': 1, 'other': 1}                               # octaves above MPL's default octave
# The bass is written this many octaves ABOVE where it was recorded (Bill 2026-11-18: the bass of the first ten songs was too low
# once played by a synth). MPL's C is MIDI 36, the bass drum, and a bass part sits at C to C+ (36-48): a bass guitar's open E is
# MIDI 28, one octave below that, so +1 puts it at E (40). SONGSCRIBE_BASS_UP=2 raises it again.
BASS_UP = int(os.environ.get('SONGSCRIBE_BASS_UP', '1'))
KIND_NAME = {'Intro': 'intro', 'Verse': 'verse', 'Chorus': 'chorus', 'Pre-Chorus': 'prechorus', 'Bridge': 'bridge', 'Solo': 'solo',
             'Interlude': 'interlude', 'Break': 'break', 'Outro': 'outro'}
MAX_ROWS = 180
MAX_SECTIONS = 15            # a song is at most this many sections back to back
REST, HOLD = -1, -2


# ───────────────────────── one note at a time: bass, voice
def f0_track(x, fmin, fmax, frame=2048, hop=512):
    """Pitch per frame from the autocorrelation: (Hz, how periodic 0-1, rms)."""
    n = 1 + (len(x) - frame) // hop
    if n < 1: return np.zeros(0), np.zeros(0), np.zeros(0)
    lo, hi = max(2, int(SR / fmax)), min(frame // 2, int(SR / fmin) + 1)
    f0 = np.zeros(n, dtype=np.float32); conf = np.zeros(n, dtype=np.float32); rms = np.zeros(n, dtype=np.float32)
    idx = np.arange(frame); win = np.hanning(frame).astype(np.float32)
    W = np.fft.rfft(win, 2 * frame); wac = np.fft.irfft(W.real ** 2 + W.imag ** 2)[:hi + 2]; wac = wac / wac[0]
    for a in range(0, n, 1200):
        b = min(n, a + 1200)
        fr = x[np.arange(a, b)[:, None] * hop + idx[None, :]]
        rms[a:b] = np.sqrt((fr ** 2).mean(axis=1))
        fr = fr - fr.mean(axis=1, keepdims=True)
        S = np.fft.rfft(fr * win, 2 * frame, axis=1)
        r = np.fft.irfft(S.real ** 2 + S.imag ** 2, axis=1)[:, :hi + 2]
        r = r / np.maximum(r[:, :1], 1e-12) / wac[None, :]
        seg = r[:, lo:hi + 1]
        mx = seg.max(axis=1)
        loc = np.zeros(seg.shape, dtype=bool)
        loc[:, 1:-1] = (seg[:, 1:-1] >= seg[:, :-2]) & (seg[:, 1:-1] >= seg[:, 2:])
        cand = loc & (seg >= (0.93 * mx)[:, None])          # the shortest period that is nearly as good as the best: not two periods
        first = np.where(cand.any(axis=1), cand.argmax(axis=1), seg.argmax(axis=1))
        rows = np.arange(b - a); k = first + lo
        y0, y1, y2 = r[rows, k - 1], r[rows, k], r[rows, k + 1]
        den = y0 - 2 * y1 + y2; den = np.where(np.abs(den) < 1e-9, -1e-9, den)
        lag = k + np.clip(0.5 * (y0 - y2) / den, -1, 1)
        f0[a:b] = SR / lag; conf[a:b] = np.clip(seg[rows, first], 0, 1)
    return f0, conf, rms


def mono_steps(x, step_t, fmin, fmax, lo_m, hi_m):
    """One state per grid step: a MIDI note where a note starts, HOLD while it rings on, REST."""
    ns = len(step_t) - 1
    S = np.full(ns, REST, dtype=int)
    f0, conf, rms = f0_track(x, fmin, fmax)
    if not len(f0): return S
    t = (np.arange(len(f0)) * 512 + 1024) / SR
    voiced = (conf > 0.55) & (rms > 0.08 * np.percentile(rms, 95)) & (rms > 0.003)
    midi = 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440.0)
    i0 = np.searchsorted(t, step_t[:-1]); i1 = np.searchsorted(t, step_t[1:])
    e0 = np.zeros(ns); e1 = np.zeros(ns); note = np.full(ns, REST, dtype=int)
    for k in range(ns):
        a, b = i0[k], max(i1[k], i0[k] + 1)
        if a >= len(t): break
        b = min(b, len(t)); v = voiced[a:b]
        e = rms[a:b]; third = max(1, (b - a) // 3)
        e0[k] = e[:third].mean(); e1[k] = e[-third:].mean()
        if v.mean() >= 0.5:
            m = int(round(float(np.median(midi[a:b][v]))))
            while m < lo_m: m += 12
            while m > hi_m: m -= 12
            note[k] = m
    for k in range(1, ns - 1):                               # one stray step between two equal neighbours
        if note[k - 1] == note[k + 1] != note[k] and note[k - 1] >= 0: note[k] = note[k - 1]
    for k in range(ns):
        if note[k] < 0: continue
        same = k > 0 and note[k - 1] == note[k]
        struck = e0[k] > 1.5 * e1[k - 1] if k > 0 else True   # louder than the step before ended: the note was played again
        S[k] = HOLD if (same and not struck) else note[k]
    return S


# ───────────────────────── one chord per beat: guitar, piano, other
def chord_beats(x, bt):
    """One state per beat: REST, or root * 2 + (1 if minor)."""
    nb = len(bt) - 1
    out = np.full(nb, REST, dtype=int)
    if len(x) < drumlabel.LSR: return out
    C = drumlabel.beat_chroma(x, drumlabel.LSR, bt); rms = drumlabel.beat_rms(x, drumlabel.LSR, bt)
    ref = np.percentile(rms, 95)
    if ref < 0.004: return out
    on = rms > 0.12 * ref
    for i in np.where(on)[0]:
        c = C[i]; best = None
        for root in range(12):
            base = c[root] + c[(root + 7) % 12]
            mj, mn = base + c[(root + 4) % 12], base + c[(root + 3) % 12]
            s, q = (mj, 0) if mj >= mn - 0.03 else (mn, 1)   # with no clear third (power chords) call it major
            if best is None or s > best[0]: best = (s, root * 2 + q)
        out[i] = best[1]
    sm = out.copy()                                           # a one-beat blip between two equal neighbours
    for i in range(1, nb - 1):
        if out[i - 1] == out[i + 1] != out[i]: sm[i] = out[i - 1]
    return sm


# ───────────────────────── states -> MPL
def loop_fit(S, nbar, spbar, agree=0.72):
    """The shortest 1, 2 or 4 bar loop (most common value at each step) that matches the bars well enough; else the bars as they are."""
    B = S[:nbar * spbar].reshape(nbar, spbar)
    for L in (1, 2, 4):
        if nbar < 2 * L: continue
        pat = np.zeros((L, spbar), dtype=int)
        for j in range(L):
            grp = B[j::L]
            for k in range(spbar):
                vals, cnt = np.unique(grp[:, k], return_counts=True); pat[j, k] = vals[cnt.argmax()]
        P = np.concatenate([pat] * (nbar // L + 1))[:nbar]
        if (P == B).mean() >= agree: return L, pat
    return nbar, B


def spell(m, octv):
    v = m - 12 * octv
    o = v // 12 - 3
    return NAMES[v % 12] + ('+' * o if o > 0 else '-' * -o)


def rle(toks):
    out = []; i = 0
    while i < len(toks):
        j = i
        while j + 1 < len(toks) and toks[j + 1] == toks[i]: j += 1
        n = j - i + 1
        if n >= 2 and '\\' not in toks[i]:
            while n > 0: k = min(n, 99); out.append((str(k) if k > 1 else '') + toks[i]); n -= k
        else: out += toks[i:j + 1]
        i = j + 1
    return out


def mono_mpl(flat, spb, octv):
    """Steps of one line -> a group: 's-(Eq,2R,Ge,A,...)'. Returns '' when nothing sounds."""
    flat = list(flat); n = len(flat)
    if not any(s >= 0 for s in flat): return ''
    marks = '+' * octv if octv > 0 else '-' * -octv
    if spb == 4:
        ev = []; i = 0
        while i < n:
            if flat[i] < 0: i += 1; continue
            j = i + 1
            while j < n and flat[j] == HOLD: j += 1
            ev.append((i, flat[i], j - i)); i = j
        g = next(g for g in (4, 2, 1) if all(s % g == 0 for s, _, _ in ev))     # quarters, eighths or sixteenths
        letter = {16: 'w', 4: 'q', 2: 'e', 1: 's'}
        toks = []; pos = 0
        for s, m, run in ev:
            toks += ['R'] * ((s - pos) // g)
            d = next(d for d in (16, 4, 2, 1) if d <= max(run, g) and d >= g)
            toks.append(spell(m, octv) + ('' if d == g else letter[d])); pos = s + d
            if pos > n: pos = n
        toks += ['R'] * ((n - pos) // g)
        return {4: '', 2: 'e', 1: 's'}[g] + marks + '(' + ','.join(rle(toks)) + ')'
    toks = []                                                # triplet grid: s, s\\, e\\\\ inside each beat
    for i in range(0, n, 3):
        t = [spell(s, octv) if s >= 0 else None for s in flat[i:i + 3]] + [None, None]
        if not t[1] and not t[2]: toks.append(t[0] or 'R')
        elif not t[1]: toks += [(t[0] or 'R') + 'e', t[2] + 'e\\\\\\\\']
        else: toks += [(t[0] or 'R') + 's', t[1] + 's\\\\', (t[2] + 'e\\\\\\\\') if t[2] else 'Re']
    return marks + '(' + ','.join(rle(toks)) + ')'


def chord_mpl(bars, bpb, octv):
    """Bars of beat states -> '+(A!w,2D!,R,E!)'. A bar that holds one chord is a whole note."""
    if not (bars >= 0).any(): return ''
    toks = []
    for bar in bars:
        nm = lambda c: NAMES[c // 2] + ('m!' if c % 2 else '!')
        if bpb == 4 and len(bar) == 4 and bar[0] >= 0 and (bar == bar[0]).all(): toks.append(nm(bar[0]) + 'w')
        else: toks += [nm(c) if c >= 0 else 'R' for c in bar]
    return ('+' * octv) + '(' + ','.join(rle(toks)) + ')'


def part_body(S, nbeats, per_beat, bpb, to_mpl):
    """One part of one section: looped bars, then any beats left over."""
    spbar = per_beat * bpb; nbar = nbeats // bpb
    segs = []
    if nbar:
        L, pat = loop_fit(S, nbar, spbar)
        full, remn = divmod(nbar, L)
        txt = to_mpl(pat)
        if txt: segs.append(ds.counted(full, txt))
        else: segs.append(ds.rest_bars(full * L, bpb))
        if remn:
            t = to_mpl(pat[:remn]); segs.append(t if t else ds.rest_bars(remn, bpb))
    tail = S[nbar * spbar:nbeats * per_beat]
    if len(tail):
        t = to_mpl(tail.reshape(1, -1)) if len(tail) % per_beat == 0 else ''
        segs.append(t if t else ds.counted(nbeats - nbar * bpb, 'R'))
    return ','.join(segs)


def length_rests(nbeats, bpb):
    if bpb == 4:
        bars, rem = divmod(nbeats, 4)
        return ','.join(x for x in (ds.counted(bars, 'Rw') if bars else '', ds.counted(rem, 'R') if rem else '') if x)
    return ds.counted(nbeats, 'R')


def used_defs(sdefs):
    """The phrases the sections actually play, each once, in order of first use."""
    out = {}
    for sd in sdefs:
        for d in sd['seq']: out.setdefault(id(d), d)
    return list(out.values())


def f1(p, a):
    tp = int((p & a).sum()); d = 2 * tp + int((p & ~a).sum()) + int((~p & a).sum())
    return 1.0 if d == 0 else 2 * tp / d


def safe_name(title):
    t = re.sub(r'[^A-Za-z0-9]+', '_', title or '').strip('_') or 'song'
    if not t[0].isalpha(): t = 'song_' + t
    return t[:40].rstrip('_')


# ───────────────────────── the song
def make_song(stem_dir, meta, now, tol=0.12):
    """Returns (bank, r): the <folder>_MPL.json contents and the drum analysis (for the .mid)."""
    drum_path = next(p for p in (os.path.join(stem_dir, 'logic', 'drums.m4a'), os.path.join(stem_dir, 'drums.m4a')) if os.path.isfile(p))
    r = ds.analyze(drum_path, meta, stem_dir=os.path.dirname(drum_path))
    spb, bpb = r['steps_per_beat'], r['beats_per_bar']
    tl = r['_tl']; bt = np.array(tl['beat_t']); P, A = tl['P'], tl['A']
    secs, rows = tl['sections'], r['rows']
    nbeats = len(bt) - 1
    step_t = np.append((bt[:-1, None] + (bt[1:, None] - bt[:-1, None]) * np.arange(spb)[None, :] / spb).reshape(-1), bt[-1])

    # every pitched stem once, for the whole song
    sdir = os.path.dirname(drum_path); lines = {}; chords = {}; octv = {}
    for stem, (fmin, fmax, lo_m, hi_m) in MONO.items():
        p = os.path.join(sdir, stem + '.m4a')
        if not os.path.isfile(p): continue
        S = mono_steps(ds.load(p), step_t, fmin, fmax, lo_m, hi_m)
        if (S >= 0).sum() < 8: continue
        if stem == 'bass': S = np.where(S >= 0, S + 12 * BASS_UP, S)       # notes only; REST and HOLD are negative and stay
        lines[stem] = S
        octv[stem] = int(np.clip(round((float(np.median(S[S >= 0])) - 42) / 12.0), -2, 3))
    for stem in CHORD_OCT:
        p = os.path.join(sdir, stem + '.m4a')
        if not os.path.isfile(p): continue
        C = chord_beats(drumlabel.load(p), bt)
        if (C >= 0).sum() >= 4: chords[stem] = C

    # harmony per beat (bass + guitar + piano + other) and where the voice is: two phrases are "the same" only if these agree too
    mix = None
    for stem in ('bass', 'guitar', 'piano', 'other'):
        p = os.path.join(sdir, stem + '.m4a')
        if not os.path.isfile(p): continue
        x = drumlabel.load(p)
        if mix is None: mix = x.copy()
        else: m = min(len(mix), len(x)); mix = mix[:m] + x[:m]
    chroma = drumlabel.beat_chroma(mix, drumlabel.LSR, bt) if mix is not None else np.zeros((nbeats, 12))
    sung = (lines['vocals'].reshape(nbeats, spb) != REST).mean(axis=1) if 'vocals' in lines else np.zeros(nbeats)
    G = tl['G']; nv = A.shape[1]; spbar = spb * bpb

    def drum_phrase(a, nb):
        """The drums of one phrase: (MPL body, the hits that body plays)."""
        Ac, Gc = A[a * spb:(a + nb) * spb], G[a * spb:(a + nb) * spb]
        nbar = nb // bpb
        if nbar:
            body, Pb, _pg, _info = ds.fit_section(Ac[:nbar * spbar].reshape(nbar, spbar, nv), Gc[:nbar * spbar].reshape(nbar, spbar), spb, bpb)
            Pc = Pb.reshape(-1, nv)
        else: body, Pc = '', Ac[:0]
        At = Ac[nbar * spbar:]
        if len(At):                                          # beats left over before the next bar line
            t, dd = ds.bars_mpl(At[None], Gc[nbar * spbar:][None], spb, bpb)
            body = (body + ',' if body else '') + ((dd + '(' + t + ')') if dd else t)
        return body, np.concatenate([Pc, At])

    # the song in phrases: neighbouring sections of one kind are one stretch, cut into 4-bar phrases from its first
    # beat (what is left over at its end is a phrase too), so the phrases of a stretch are all the same length
    kinds0 = [(row.get('label') or {}).get('kind') or 'Part' for row in rows]
    phrases = []; i = 0
    while i < len(secs):
        j = i
        while j + 1 < len(secs) and kinds0[j + 1] == kinds0[i]: j += 1
        a0 = secs[i][0]; total = sum(secs[n][1] for n in range(i, j + 1))
        nbar = total // bpb; k = 0
        while True:
            take = min(4, nbar - k); last = k + take >= nbar
            n = take * bpb + (total - nbar * bpb if last else 0)
            if n > 0:
                a = a0 + k * bpb
                sec = max(q for q in range(i, j + 1) if secs[q][0] <= a)
                phrases.append({'sec': sec, 'a': a, 'beats': int(n), 'kind': kinds0[i], 'row': rows[sec]})
            k += take
            if last: break
        i = j + 1
    for ph in phrases:
        ph['body'], ph['P'] = drum_phrase(ph['a'], ph['beats'])
        ph['A'] = A[ph['a'] * spb:(ph['a'] + ph['beats']) * spb]
        ph['C'] = chroma[ph['a']:ph['a'] + ph['beats']]
        ph['sung'] = bool(sung[ph['a']:ph['a'] + ph['beats']].mean() >= 0.2)

    def harmony(c1, c2):
        live = (np.abs(c1).sum(axis=1) > 0) | (np.abs(c2).sum(axis=1) > 0)
        return 1.0 if not live.any() else float((c1[live] * c2[live]).sum(axis=1).mean())

    def build(tol, drop):
        # a phrase that comes back is the same row: same length, the same drums fit it, same harmony, voice in both or neither
        defs = []; which = []
        for ph in phrases:
            own = f1(ph['P'], ph['A']); best = None
            for d in defs:
                if d['beats'] != ph['beats'] or d['sung'] != ph['sung']: continue
                s = f1(d['P'], ph['A'])
                if s >= own - tol and harmony(d['C'], ph['C']) >= 0.86 - tol and (best is None or s > best[0]): best = (s, d)
            if best: best[1]['members'].append(ph); which.append(best[1])
            else:
                d = {'kind': ph['kind'], 'beats': ph['beats'], 'P': ph['P'], 'C': ph['C'], 'sung': ph['sung'], 'a': ph['a'], 'row': ph['row'], 'body': ph['body'], 'members': [ph]}
                defs.append(d); which.append(d)
        # sections (Bill 2026-11-17: at most 15 back to back; more than that are variations of fewer sections).
        # Neighbouring stretches of one kind are one run; a run is tiled with blocks of that kind's length
        # (8 bars, doubled until the song has 15 blocks or fewer); blocks of one kind and one length are
        # one section, played everywhere as the block among them that fits them all best.
        kinds = [(row.get('label') or {}).get('kind') or 'Part' for row in rows]
        runs = []
        for pi, ph in enumerate(phrases):
            k = kinds[ph['sec']]
            if runs and runs[-1][0] == k: runs[-1][1].append(pi)
            else: runs.append((k, [pi]))

        def tile(unit):
            out = []
            for k, idx in runs:
                want = unit[k] * bpb; cur = []; n = 0; first = len(out)
                for pi in idx:
                    cur.append(pi); n += phrases[pi]['beats']
                    if n >= want: out.append((k, cur)); cur = []; n = 0
                if cur:
                    if len(out) > first and n < want / 2: out[-1] = (k, out[-1][1] + cur)      # a short tail stays with the block before it
                    else: out.append((k, cur))
            return out
        unit = {k: 8 for k in set(kinds)}
        blocks = tile(unit)
        while len(blocks) > MAX_SECTIONS:
            cnt = {}
            for k, _ in blocks: cnt[k] = cnt.get(k, 0) + 1
            # only a kind with two blocks inside one run is made longer: a longer block cannot merge anything else, and
            # doubling one that merges nothing would go on forever (2026-11-18: 19 long songs never finished)
            multi = {blocks[i][0] for i in range(len(blocks) - 1) if blocks[i][0] == blocks[i + 1][0]}
            if not multi: break
            k = max(multi, key=lambda q: cnt[q])
            unit[k] *= 2; blocks = tile(unit)
        blen = lambda blk: sum(phrases[pi]['beats'] for pi in blk[1])
        while len(blocks) > MAX_SECTIONS:                   # still too many kinds in a row: the shortest joins its shorter neighbour
            i = min(range(len(blocks)), key=lambda q: blen(blocks[q]))
            j = i - 1 if (i > 0 and (i == len(blocks) - 1 or blen(blocks[i - 1]) <= blen(blocks[i + 1]))) else i + 1
            a_, b_ = min(i, j), max(i, j)
            keep = blocks[j][0]
            blocks[a_:b_ + 1] = [(keep, blocks[a_][1] + blocks[b_][1])]
        groups = {}
        for bi, blk in enumerate(blocks): groups.setdefault((blk[0], blen(blk)), []).append(bi)
        sdefs = []; swhich = [None] * len(blocks); count = {}
        for (kind, nb), bis in sorted(groups.items(), key=lambda kv: kv[1][0]):
            Ab = {bi: np.concatenate([phrases[pi]['A'] for pi in blocks[bi][1]]) for bi in bis}
            Pb = {bi: np.concatenate([which[pi]['P'] for pi in blocks[bi][1]]) for bi in bis}
            best = max(bis, key=lambda c: sum(f1(Pb[c], Ab[m]) for m in bis))
            base = KIND_NAME.get(kind) or (re.sub(r'[^A-Za-z0-9]', '', kind.title()) or 'Part')
            base = base[0].lower() + base[1:]
            count[base] = count.get(base, 0) + 1
            first = phrases[blocks[bis[0]][1][0]]
            sd = {'kind': kind, 'seq': [which[pi] for pi in blocks[best][1]], 'name': base + (str(count[base]) if count[base] > 1 else ''), 'row': first['row'],
                  't0': float(bt[first['a']]), 'beats': int(nb), 'idx': bis, 'A': [Ab[m] for m in bis], 'a': [phrases[blocks[m][1][0]]['a'] for m in bis]}
            sdefs.append(sd)
            for bi in bis: swhich[bi] = sd
        used = {sd['name'].lower() for sd in sdefs}
        for sd in sdefs:                                     # a phrase is named after the section it first appears in: verseA, verseB ...
            k = 0
            for d in sd['seq']:
                if 'name' in d: continue
                nm = sd['name'] + (chr(65 + k) if k < 26 else 'Z%d' % k); k += 1
                while nm.lower() in used: nm += '_'
                used.add(nm.lower()); d['name'] = nm
        song = safe_name(meta.get('title') or meta.get('folder'))
        while song.lower() in used: song += '_song'
        for d in used_defs(sdefs):
            a, nb = d['a'], d['beats']; parts = []
            for stem, suffix, ch in PARTS:
                if stem in drop: continue
                if stem == 'drums': body = d['body']
                elif stem in lines:
                    S = lines[stem][a * spb:(a + nb) * spb]
                    if (S != REST).mean() < 0.12: continue
                    body = part_body(S, nb, spb, bpb, lambda pat, st=stem: mono_mpl(pat.reshape(-1), spb, octv[st]))
                elif stem in chords:
                    C = chords[stem][a:a + nb]
                    if (C >= 0).mean() < 0.3: continue
                    body = part_body(C, nb, 1, bpb, lambda pat, st=stem: chord_mpl(np.atleast_2d(pat), bpb, CHORD_OCT[st]))
                else: continue
                if not body or not re.search(r'[A-G]', body): continue
                parts.append({'name': d['name'] + suffix, 'src': 'm%d,%s' % (ch, body), 'stem': stem, 'channel': ch})
            d['parts'] = parts
        return defs, which, song, sdefs, swhich

    tol = float(os.environ.get('SONGSCRIBE_TOL', tol))
    drop = set(); defs, which, song, sdefs, swhich = build(tol, drop)
    for t2, dr in ((0.2, ()), (0.3, ()), (0.3, ('other',)), (0.3, ('other', 'piano')), (0.45, ('other', 'piano', 'guitar'))):
        if 1 + len(sdefs) + sum(1 + len(d['parts']) for d in used_defs(sdefs)) <= MAX_ROWS: break
        drop = set(dr); defs, which, song, sdefs, swhich = build(max(tol, t2), drop)

    # grades: the song as these rows play it, against the hits found in the drum stem
    for d in used_defs(sdefs): d['inst'] = []
    for sd in sdefs:
        Pseq = np.concatenate([d['P'] for d in sd['seq']])
        sd['grade'] = ds.grade(np.concatenate([Pseq] * len(sd['idx'])), np.concatenate(sd['A']))
        for Am in sd['A']:                                   # each place the section is played, phrase by phrase
            k = 0
            for d in sd['seq']: d['inst'].append(Am[k:k + len(d['P'])]); k += len(d['P'])
    for d in used_defs(sdefs):
        d['grade'] = ds.grade(np.concatenate([d['P']] * len(d['inst'])), np.concatenate(d['inst']))
    Pnew = np.concatenate([d['P'] for sd in swhich for d in sd['seq']]) if swhich else P
    g_song = ds.grade(Pnew, A)
    tl['P'] = Pnew

    def calls(seq):                                          # @a,@a,@b -> 2@a,@b
        out = []; i = 0
        while i < len(seq):
            j = i
            while j + 1 < len(seq) and seq[j + 1] is seq[i]: j += 1
            out.append(ds.counted(j - i + 1, '@' + seq[i]['name'])); i = j + 1
        return ','.join(out)
    bars_txt = lambda nb: '%d bar%s%s' % (nb // bpb, '' if nb // bpb == 1 else 's', (' + %d beat%s' % (nb % bpb, '' if nb % bpb == 1 else 's')) if nb % bpb else '')
    keys = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    title, artist = meta.get('title') or meta.get('folder') or '', meta.get('artist') or ''
    slots = [{'name': song, 'src': calls(swhich), 'velocity': 100, 'role': 'song', 'grade': g_song,
              'note': '%s%s · %d sections, %d of them different · %d bars of %d/4 at %g bpm · drums %s' % (
                  title, ' — ' + artist if artist else '', len(swhich), len(sdefs), r['bars'], bpb, r['bpm'], ds.grade_text(g_song))}]
    done = set()
    for sd in sdefs:
        lab = sd['row'].get('label') or {}; uses = len(sd['idx'])
        slots.append({'name': sd['name'], 'src': calls(sd['seq']), 'velocity': 100, 'role': 'section', 'kind': sd['kind'], 'beats': sd['beats'], 'uses': uses,
                      'grade': sd['grade'],
                      'note': '%s%s · %s · played %d time%s, first at %s · drums %s' % (
                          sd['kind'], ' (a guess)' if lab.get('confidence') == 'low' else '', bars_txt(sd['beats']), uses, '' if uses == 1 else 's',
                          ds.clock(sd['t0']), ds.grade_text(sd['grade']))})
        for d in sd['seq']:
            if id(d) in done: continue
            done.add(id(d)); uses = len(d['inst'])
            slots.append({'name': d['name'], 'src': ','.join(['@' + p['name'] + '&' for p in d['parts']] + [length_rests(d['beats'], bpb)]),
                          'velocity': 100, 'role': 'phrase', 'beats': int(d['beats']), 'uses': uses, 'grade': d['grade'],
                          'note': 'A phrase of %s · its parts start together · used %d time%s in the song · drums %s' % (
                              bars_txt(d['beats']), uses, '' if uses == 1 else 's', ds.grade_text(d['grade']))})
            for p in d['parts']:
                s = {'name': p['name'], 'src': p['src'], 'velocity': 100, 'role': 'part', 'stem': p['stem'], 'channel': p['channel'], 'phrase': d['name']}
                what = p['name'][len(d['name']):]
                if p['stem'] == 'drums': s['grade'] = d['grade']; s['note'] = 'Drums of %s, measured from the drum stem · %s' % (d['name'], ds.grade_text(d['grade']))
                elif p['stem'] in MONO: s['note'] = '%s of %s, followed one note at a time from the %s stem — a sketch, not graded' % (what, d['name'], p['stem'])
                else: s['note'] = '%s of %s, one chord per beat from the %s stem — a sketch, not graded' % (what, d['name'], p['stem'])
                slots.append(s)
    for i, s in enumerate(slots):
        if i < 36: s['key'] = keys[i]                        # the console's keyed rows; the rest take the next free rows
        s['auto_name'] = True                                 # the name was chosen by the analysis; renaming a row clears this
    sections = []; seen = {}
    for n, sd in enumerate(swhich):                           # the song in time order: which section row plays where
        k = seen.get(id(sd), 0); seen[id(sd)] = k + 1
        a = sd['a'][k]; lab = sd['row'].get('label') or {}
        sections.append({'section': n + 1, 'row': sd['name'], 'kind': sd['kind'], 'confidence': lab.get('confidence'), 'phrases': [d['name'] for d in sd['seq']],
                         't0': round(float(bt[a]), 1), 't1': round(float(bt[min(a + sd['beats'], nbeats)]), 1), 'bars': sd['beats'] // bpb, 'extra_beats': sd['beats'] % bpb,
                         'beats': sd['beats'], 'grade': ds.grade(np.concatenate([d['P'] for d in sd['seq']]), sd['A'][k])})
    feel = 'triplet (shuffle / 12-8) grid' if spb == 3 else 'sixteenth-note grid'
    bank = {
        'format': 'simplestem-mpl-bank', 'version': 2,
        'name': (title + (' — ' + artist if artist else ''))[:80],
        'description': ('This song as MPL, made from its six stems by songscribe.py. Read it top-down: the first row is the song — its sections in order, a section '
                        'that comes back called again by the same name; a section row is its phrases in order (4 bars each), shared between sections that play the '
                        'same thing. A song is at most 15 sections back to back: stretches of one kind are cut into equal lengths, and sections of one kind and '
                        'length are one row, played everywhere as the one among them that fits them all best, so their variations are folded together; a phrase row starts its parts together (@part&) and then rests for the '
                        'section\'s length; a part row is one stem on its channel (m10 drums, m11 voice, m13 bass, m14 guitar, m15 piano, m16 other). '
                        'Drums are measured: beats tracked in the drum stem, hits placed on a %s, each section written as its most common 1, 2 or 4 bar '
                        'loop. Bass and voice are followed one note at a time and guitar, piano and other as one chord per beat; those are sketches. '
                        'Grades (A 90%%+, B 80-90, C 70-80, D 60-70, F below) say how closely the drum rows reproduce the hits found in the drum stem: '
                        'the song\'s grade is the whole song as these rows play it, a section\'s grade covers every place it is used. A low grade can '
                        'still be a useful part. "text" is the same rows as name=MPL; lines.') % feel,
        'created_by': {'kind': 'ai', 'name': 'Claude', 'via': 'songscribe.py'},
        'prompt': 'Re-process the catalog: split each song into sections from its stems and write the MPL for it.',
        'created_at': now, 'bpm': int(round(r['bpm'])), 'key': meta.get('key') or '', 'song': title, 'artist': artist, 'main': '0',
        'grade': g_song,
        'text': ['%s=%s;' % (s['name'], s['src']) for s in slots],
        'analysis': dict({k: r[k] for k in ('bpm', 'meta_bpm', 'tempo_note', 'beats_per_bar', 'steps_per_beat', 'bars', 'beats', 'grid_fit',
                                            'first_bar_t', 'duration', 'section_source')}, **ds.beat_times(r)),
        'stems': {s: dict(ds.STEM_DEFAULTS[s], suggested=True) for s in ds.STEM_ORDER},
        'sections': sections,
        'slots': slots,
    }
    return bank, r
