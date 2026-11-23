#!/usr/bin/env python3
"""drumscribe: drums.m4a -> beat grid -> kick/snare/hat/tom/crash hits ->
one MPL row per section + one whole-song MPL string, each graded against
the hits detected in the stem. Pure numpy + ffmpeg.

  python3 drumscribe.py <drums.m4a> <meta.json> [--debug]

meta.json: {folder,title,artist,bpm,duration_sec,sections:[t..]}
Prints one JSON object (the analysis + the rows) on stdout.
"""
import json, math, os, subprocess, sys
import numpy as np

SR, NFFT, HOP = 22050, 1024, 256
FPS = SR / HOP
VOICES = ['K', 'S', 'H', 'T1', 'T2', 'T3', 'X']          # kick snare hat floor/mid/high tom crash
NOTE = {'K': 'C', 'S': 'D', 'H': 'F#', 'T1': 'F', 'T2': 'B', 'T3': 'D+', 'X': 'C#+'}
ORDER = ['X', 'K', 'S', 'T1', 'T2', 'T3', 'H']            # order inside a stack


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def stft_mag(x):
    n = 1 + (len(x) - NFFT) // HOP
    win = np.hanning(NFFT).astype(np.float32)
    out = np.empty((n, NFFT // 2 + 1), dtype=np.float32)
    idx = np.arange(NFFT)
    for a in range(0, n, 3000):
        b = min(n, a + 3000)
        fr = x[np.arange(a, b)[:, None] * HOP + idx[None, :]]
        out[a:b] = np.abs(np.fft.rfft(fr * win, axis=1))
    return out


def band(mag, lo, hi):
    f = np.arange(mag.shape[1]) * SR / NFFT
    return mag[:, (f >= lo) & (f < hi)].sum(axis=1)


def onset_env(e):
    l = np.log1p(40.0 * e)
    d = np.maximum(0, l[2:] - l[:-2])
    return np.concatenate([[0, 0], d]).astype(np.float32)


def smooth(v, w):
    if w < 1: return v
    k = np.exp(-0.5 * (np.arange(-3 * w, 3 * w + 1) / w) ** 2); k /= k.sum()
    return np.convolve(v, k, mode='same')


def refine_tempo(env, bpm):
    """Autocorrelation peak within +-8% of bpm."""
    e = env - env.mean()
    best, bl = -1e9, None
    p0 = 60.0 / bpm * FPS
    for lag in np.arange(p0 * 0.92, p0 * 1.08, 0.05):
        s = 0.0
        for m in (1, 2, 4):
            L = lag * m; a = int(L); fr = L - a
            if a + 1 >= len(e): continue
            s += float(np.dot(e[:len(e) - a - 1], (1 - fr) * e[a:len(e) - 1] + fr * e[a + 1:])) / (len(e) - a)
        if s > best: best, bl = s, lag
    return 60.0 * FPS / bl


def track_beats(env, bpm, tight=100.0):
    p = 60.0 / bpm * FPS
    loc = smooth(env, max(1.0, p / 32.0)); loc = loc / (loc.std() + 1e-9)
    n = len(loc)
    lo, hi = int(round(2 * p)), int(round(p / 2))
    rng = np.arange(-lo, -hi + 1)
    cost = -tight * (np.log(-rng / p)) ** 2
    cum = np.zeros(n); back = np.full(n, -1, dtype=np.int64)
    first = True
    for t in range(n):
        a = t + rng[0]
        if a < 0:
            cum[t] = loc[t]; continue
        cand = cum[a:a + len(rng)] + cost
        j = int(np.argmax(cand))
        cum[t] = loc[t] + cand[j]
        if first and loc[t] < 0.01 * loc.max(): back[t] = -1
        else: back[t] = a + j; first = False
    tail = cum[int(n - 2 * p):]
    t = int(n - 2 * p) + int(np.argmax(tail))
    beats = [t]
    while back[beats[-1]] >= 0: beats.append(int(back[beats[-1]]))
    beats = np.array(beats[::-1], dtype=float)
    # extend to cover the whole file
    per = np.median(np.diff(beats)) if len(beats) > 2 else p
    pre = []
    t0 = beats[0] - per
    while t0 > 0: pre.append(t0); t0 -= per
    post = []
    t1 = beats[-1] + per
    while t1 < n - 1: post.append(t1); t1 += per
    return np.concatenate([pre[::-1], beats, post])


def at(env, frames, w):
    """max of env within +-w frames of each (float) frame position."""
    out = np.zeros(len(frames))
    n = len(env)
    for i, f in enumerate(frames):
        a, b = max(0, int(round(f - w))), min(n, int(round(f + w)) + 1)
        if b > a: out[i] = env[a:b].max()
    return out


def peaks(env, thr, sep):
    c = np.where((env[1:-1] > env[:-2]) & (env[1:-1] >= env[2:]) & (env[1:-1] > thr))[0] + 1
    keep = []
    for i in c[np.argsort(-env[c])]:
        if all(abs(i - k) >= sep for k in keep): keep.append(int(i))
    return np.array(sorted(keep), dtype=int)


BANDS = [(35, 90), (90, 150), (150, 300), (300, 1000), (1000, 3000), (3000, 7000), (7000, 11000)]


def onsets(mag):
    """Every drum onset in the file with its energy jump per band."""
    E = [band(mag, a, b) for a, b in BANDS]
    O = [onset_env(e) for e in E]
    Nn = [o / (np.percentile(o[o > 0], 98) + 1e-9) if (o > 0).any() else o for o in O]
    env = Nn[0] + 0.6 * Nn[1] + 0.8 * Nn[2] + 0.6 * Nn[3] + 0.6 * Nn[4] + 0.8 * Nn[5] + 0.6 * Nn[6]
    pk = set()
    for o in Nn + [env / 3]:
        for p in peaks(o, 0.12, 3): pk.add(int(p))
    pk = sorted(pk)
    merged = []
    for p in pk:
        if merged and p - merged[-1][-1] <= 2: merged[-1].append(p)
        else: merged.append([p])
    n = mag.shape[0]
    ev = []
    for grp in merged:
        p = max(grp, key=lambda q: env[q])
        a0, a1 = max(0, p - 5), max(1, p - 1)
        inc = np.array([max(0.0, float(e[p:min(n, p + 4)].mean() - e[a0:a1].mean())) for e in E])
        if inc.sum() <= 0: continue
        ev.append((p, inc))
    return ev, E, env


def classify(ev, E, mag):
    """Label each onset: K kick, S snare (g = ghost), T1/T2/T3 toms, H hat, X crash."""
    if not ev: return []
    inc = np.array([e[1] for e in ev]); tot = inc.sum(axis=1) + 1e-9
    sh = inc / tot[:, None]
    low = inc[:, 0] + inc[:, 1]; shL = sh[:, 0] + sh[:, 1]
    mid = inc[:, 2] + inc[:, 3] + inc[:, 4]                     # 150-3000
    body = inc[:, 2] + inc[:, 3]; crack = inc[:, 4] + inc[:, 5]  # 150-1000 / 1000-7000
    hi = inc[:, 5] + inc[:, 6]; shH = sh[:, 5] + sh[:, 6]
    top = inc[:, 6]
    def ref(v, mask, q=75):
        return float(np.percentile(v[mask], q)) if mask.sum() >= 6 else None
    kmask = (sh[:, 0] > 0.22) & (shL > 0.3)
    refK = ref(low, kmask, 92)                                   # the loud kicks set the level, not the bleed
    smask = (shL < 0.12) & ((sh[:, 2] + sh[:, 3] + sh[:, 4]) > 0.38) & (crack > 0.45 * body)
    if smask.sum() >= 6:                                        # the loud ones set the level
        lv = mid[smask]; smask2 = smask & (mid > 0.4 * np.percentile(lv, 90))
        refS = ref(mid, smask2) or ref(mid, smask)
    else: refS = None
    hmask = (shH > 0.62) & (shL < 0.08)
    refH = ref(hi, hmask, 80)
    nfr = mag.shape[0]
    freqs = np.arange(mag.shape[1]) * SR / NFFT
    lb = (freqs >= 45) & (freqs < 420)
    Ehi = E[6]
    out = []
    for i, (p, _) in enumerate(ev):
        lab = {}
        isK = refK is not None and low[i] > 0.30 * refK and sh[i, 0] > 0.10
        if refS is not None and crack[i] > 0.4 * body[i]:
            if mid[i] > (0.5 if isK else 0.33) * refS: lab['S'] = 1.0
            elif (not isK) and shL[i] < 0.12 and mid[i] > 0.09 * refS and (sh[i, 2] + sh[i, 3] + sh[i, 4]) > 0.35: lab['S'] = 0.3
        tomlike = (sh[i, 1] + sh[i, 2]) > 0.5 and sh[i, 0] < 0.18 and crack[i] < 0.4 * body[i] + 1e-9
        if tomlike and 'S' not in lab and refS is not None and (inc[i, 1] + inc[i, 2]) > 0.5 * refS:
            a = mag[min(nfr - 1, p + 1):min(nfr, p + 5), lb].mean(axis=0) ** 2
            c = float((a * freqs[lb]).sum() / (a.sum() + 1e-9))
            lab['T1' if c < 135 else 'T2' if c < 210 else 'T3'] = 1.0
            isK = False
        if isK: lab['K'] = 1.0
        # cymbals
        if refH is not None:
            a1, a2 = min(nfr - 1, p + int(0.25 * FPS)), min(nfr, p + int(0.6 * FPS))
            b1, b2 = max(0, p - int(0.3 * FPS)), max(1, p - 3)
            ring = float(Ehi[a1:a2].mean()) if a2 > a1 else 0.0
            before = float(Ehi[b1:b2].mean()) if b2 > b1 else 0.0
            pkv = float(Ehi[p:min(nfr, p + 4)].max())
            if top[i] > 0.6 * refH and ring > 0.45 * pkv and ring > 2.0 * before and pkv > 1.5 * refH:
                lab['X'] = 1.0
            elif shH[i] > 0.55 and hi[i] > 0.2 * refH and 'S' not in lab and 'K' not in lab:
                lab['H'] = 1.0
        if lab: out.append((p, lab, float(top[i])))
    return out, refH


def to_grid(lab, refH, beats, spb):
    steps = []
    for i in range(len(beats) - 1):
        for k in range(spb): steps.append(beats[i] + (beats[i + 1] - beats[i]) * k / spb)
    steps = np.array(steps); ns = len(steps)
    per = np.median(np.diff(beats)); tol = 0.5 * per / spb
    H = {v: np.zeros(ns, dtype=bool) for v in VOICES}
    ghost = np.zeros(ns, dtype=bool); full = np.zeros(ns, dtype=bool); topv = np.zeros(ns)
    offs = []
    for p, l, tp in lab:
        j = int(np.searchsorted(steps, p))
        c = min((k for k in (j - 1, j) if 0 <= k < ns), key=lambda k: abs(steps[k] - p), default=None)
        if c is None or abs(steps[c] - p) > tol: continue
        if 'K' in l or l.get('S', 0) == 1.0: offs.append(abs(steps[c] - p) / FPS)
        for v in l:
            H[v][c] = True
            if v == 'S':
                if l[v] == 1.0: full[c] = True
        topv[c] = max(topv[c], tp)
    ghost = H['S'] & ~full
    # a hat under a kick or snare can't be heard apart: fill it in when the hats either side are there
    masked = (H['K'] | full | H['T1'] | H['T2'] | H['T3']) & ~H['H'] & ~H['X']
    hh = H['H'].copy()
    for j in np.where(masked)[0]:
        for back, fwd in ((2, 2), (1, 1)) if spb == 4 else ((1, 2), (3, 3)):
            if j - back >= 0 and j + fwd < ns and H['H'][j - back] and H['H'][j + fwd]:
                if spb == 4 and back == 1 and not (j % 2 == 0): continue
                hh[j] = True; break
    H['H'] = hh & ~H['X']
    return H, ghost, steps, offs


def analyze(path, meta, debug=False, stem_dir=None):
    x = load(path)
    if len(x) < SR * 5: raise RuntimeError('audio too short')
    mag = stft_mag(x)
    ev, E, env = onsets(mag)
    lab, refH = classify(ev, E, mag)
    if len(lab) < 16: raise RuntimeError('almost no drum hits found in the stem')

    bpm0 = float(meta.get('bpm') or 120)
    while bpm0 > 200: bpm0 /= 2
    while bpm0 < 50: bpm0 *= 2
    bpm = refine_tempo(env, bpm0)
    beats = track_beats(env, bpm)

    # ---- tempo octave: the backbeat (snare) belongs on every other beat
    note = []
    for _ in range(2):
        H, ghost, steps, _o = to_grid(lab, refH, beats, 2)
        S = (H['S'] & ~ghost).astype(float)
        on, off = S[0::2], S[1::2]
        tot = S.sum() + 1e-9
        cur = 60 * FPS / np.median(np.diff(beats))
        r4 = [on[c::4].sum() / tot for c in range(4)]
        if max(r4) > 0.6 and cur / 2 >= 48:
            c = int(np.argmax(r4)); beats = beats[c % 2::2]; note.append('halved'); continue
        if cur * 2 <= 190 and (off.sum() / tot > 0.6 or (cur < 75 and on.sum() / max(1, len(on)) > 0.75)):
            mid = (beats[:-1] + beats[1:]) / 2
            beats = np.sort(np.concatenate([beats, mid])); note.append('doubled'); continue
        break
    per = np.median(np.diff(beats)); bpm = 60 * FPS / per

    # ---- straight or triplet subdivision
    d = np.diff(beats); b0 = beats[:-1]
    w = min(2.0, 0.07 * per)
    pos = lambda fr: at(env, b0 + fr * d, w).mean()
    e12, e14, e34, e13, e23 = pos(.5), pos(.25), pos(.75), pos(1 / 3), pos(2 / 3)
    straight = e12 + 0.5 * max(e14, e34)
    trip = e23 + 0.5 * e13
    spb = 3 if trip > 1.2 * straight else 4

    H, ghost, steps, offs = to_grid(lab, refH, beats, spb)
    ns = len(steps); nb_ = len(beats) - 1
    grid_fit = float((np.array(offs) < 0.030).mean()) if offs else 0.0

    # ---- meter 3 or 4, bar phase
    Kb = H['K'][0::spb].astype(float); Sb = (H['S'] & ~ghost)[0::spb].astype(float); Xb = H['X'][0::spb].astype(float)
    def ac(v, lag):
        a = v - v.mean()
        return float(np.dot(a[:-lag], a[lag:]) / (np.dot(a, a) + 1e-9))
    f = Kb - Sb
    m4 = ac(f, 2) + ac(f, 4); m3 = ac(f, 3) + ac(f, 6)
    bpb = 3 if (m3 > m4 + 0.25 and m3 > 0.3) else 4
    secs_t = sorted(set(float(t) for t in (meta.get('sections') or [])))
    dur = len(x) / SR
    secs_t = [t for t in secs_t if 0 < t < dur]

    def pscore(c, a, b):
        """How well bars starting on beats = c (mod bpb) fit the beats a..b: kick on 1 (and 3), snare on 2 and 4."""
        idx = np.arange(a, b)
        k = lambda r, v: float(v[idx[(idx - c) % bpb == r]].sum())
        if bpb == 4: return k(0, Kb) + 0.6 * k(2, Kb) + k(1, Sb) + k(3, Sb) - k(0, Sb) - k(2, Sb) + 1.5 * k(0, Xb)
        return k(0, Kb) - k(0, Sb) + 1.5 * k(0, Xb)
    cg = int(np.argmax([pscore(c, 0, nb_) for c in range(bpb)]))
    # each section may sit on its own bar phase (a dropped or added beat moves the bar line)
    marks = [0] + [int(np.argmin(np.abs(beats[:-1] - t * FPS))) for t in secs_t] + [nb_]
    marks = sorted(set(marks))
    starts = []; prev = cg
    for i in range(len(marks) - 1):
        a, b = marks[i], marks[i + 1]
        sc = [pscore(c, a, b) for c in range(bpb)]
        c = int(np.argmax(sc))
        if c != prev and not (sc[c] > sc[prev] + max(3.0, 0.3 * abs(sc[prev]))): c = prev
        prev = c
        cand = [j for j in range(max(0, a - bpb), min(nb_, a + bpb) + 1) if j % bpb == c]
        st = min(cand, key=lambda j: (abs(j - a), -j)) if cand else a
        if i == 0: st = c                                    # the song starts on its first full bar
        if not starts or st > starts[-1][0]: starts.append((st, c))
    bounds = [st for st, _ in starts] + [nb_]
    ranges = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1) if bounds[i + 1] - bounds[i] >= 1]
    while len(ranges) > 35:                                 # 36 rows: 35 sections + the whole-song row
        k = min(range(len(ranges) - 1), key=lambda i: ranges[i + 1][1] - ranges[i][0])
        ranges[k:k + 2] = [(ranges[k][0], ranges[k + 1][1])]
    spbar = spb * bpb
    V = np.stack([H[v] for v in VOICES], axis=-1)            # steps x voices
    MIDI = {'K': 36, 'S': 38, 'H': 42, 'T1': 41, 'T2': 47, 'T3': 50, 'X': 49}
    def expect(P):
        """[beat, notes...] for every step that sounds — what the MPL must parse to."""
        out = []
        for k in np.where(P.any(axis=1))[0]:
            out.append([round(k // spb + (k % spb) / spb, 4)] + sorted(MIDI[v] for vi, v in enumerate(VOICES) if P[k, vi]))
        return out

    def fit_all(plain):
        rows, parts, Pcat, Acat, nb_tot = [], [], [], [], 0
        for si_, (a, b) in enumerate(ranges):
            nbar = (b - a) // bpb; rem = (b - a) % bpb
            s0 = a * spb; s1 = s0 + nbar * spbar; s2 = b * spb
            A = V[s0:s1].reshape(nbar, spbar, len(VOICES)); G = ghost[s0:s1].reshape(nbar, spbar)
            if nbar: body, P, PG, info = fit_section(A, G, spb, bpb, plain)
            else: body, P, info = '', A, {'L': 0, 'literal': 0}
            Pt = V[s1:s2]
            if rem:                                          # beats left over before the next section's bar line
                t, d = bars_mpl(Pt[None], ghost[s1:s2][None], spb, bpb)
                body = (body + ',' if body else '') + ((d + '(' + t + ')') if d else t)
            Aall = np.concatenate([A.reshape(-1, len(VOICES)), Pt]); Pall = np.concatenate([P.reshape(-1, len(VOICES)), Pt])
            Pcat.append(Pall); Acat.append(Aall); nb_tot += nbar
            rows.append({'section': si_ + 1, 'bars': int(nbar), 'extra_beats': int(rem), 'beats': int(b - a),
                         't0': round(float(beats[a] / FPS), 1), 't1': round(float(beats[b] / FPS), 1),
                         'src': 'm10,' + body, 'grade': grade(Pall, Aall), 'pattern_bars': info['L'], 'literal': info['literal'],
                         'expect': expect(Pall)})
            parts.append(body)
        merged = []                                         # neighbours that are the same loop become one count
        for p in parts:
            m = _split_count(p)
            if m and merged and merged[-1][0] is not None and merged[-1][1] == m[1]: merged[-1][0] += m[0]
            elif m: merged.append([m[0], m[1]])
            else: merged.append([None, p])
        whole = 'm10,' + ','.join(counted(c, body) if c is not None else body for c, body in merged)
        Pw, Aw = np.concatenate(Pcat), np.concatenate(Acat)
        return rows, {'src': whole, 'grade': grade(Pw, Aw), 'bars': int(nb_tot), 'beats': int(ranges[-1][1] - ranges[0][0]),
                      'expect': expect(Pw), 'plain': plain, '_P': Pw, '_A': Aw}
    rows, whole = fit_all(False)
    if len(whole['src']) > 3900:                            # the bank keeps a row under 4000 characters
        whole = fit_all(True)[1]
    total_bars = whole['bars']
    res = {'bpm': round(bpm, 1), 'meta_bpm': meta.get('bpm'), 'tempo_note': note, 'beats_per_bar': bpb,
           'steps_per_beat': spb, 'bars': int(total_bars), 'beats': int(ranges[-1][1] - ranges[0][0]),
           'grid_fit': round(grid_fit, 3), 'first_bar_t': round(float(beats[ranges[0][0]] / FPS), 2),
           'duration': round(dur, 1), 'rows': rows, 'whole': whole,
           'section_source': 'sections' if meta.get('sections') else 'none'}
    b0, b1 = ranges[0][0], ranges[-1][1]
    res['_tl'] = {'P': whole.pop('_P'), 'A': whole.pop('_A'), 'G': ghost[b0 * spb:b1 * spb],
                  'beat_t': (beats[b0:b1 + 1] / FPS).tolist(), 'sections': [(a - b0, b - a) for a, b in ranges]}
    if stem_dir:                                            # name the sections from all six stems
        import drumlabel
        try:
            labs = drumlabel.label_sections(stem_dir, beats[b0:b1 + 1] / FPS, [(a - b0, b - a) for a, b in ranges], bpb, x)
            for row, lab in zip(rows, labs): row['label'] = lab
        except Exception as e:
            res['label_error'] = str(e)[:200]
    if debug:
        res['_V'] = V; res['_G'] = ghost; res['_ranges'] = ranges
    return res


def counted(n, body):
    """n times body. The console plays a count up to 99, so a longer run is written as several."""
    out = []
    while n > 0:
        k = min(n, 99); out.append((str(k) if k > 1 else '') + body); n -= k
    return ','.join(out)


def _split_count(body):
    """'8s(...)' -> (8, 's(...)') when the body is one counted group."""
    i = 0
    while i < len(body) and body[i].isdigit(): i += 1
    rest = body[i:]
    if not rest or rest[0] not in 'ewqs(' : return None
    j = rest.find('(')
    if j < 0 or j > 1: return None
    depth = 0
    for k, c in enumerate(rest):
        if c == '(': depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                if k != len(rest) - 1: return None
                return (int(body[:i]) if i else 1, rest)
    return None


def grade(P, A):
    def f1(p, a):
        tp = int((p & a).sum()); fp = int((p & ~a).sum()); fn = int((~p & a).sum())
        if tp + fp + fn == 0: return None, 0, 0, 0
        return 2 * tp / (2 * tp + fp + fn), tp, fp, fn
    # toms count as one voice
    def view(M):
        return np.stack([M[..., 0], M[..., 1], M[..., 2], M[..., 3] | M[..., 4] | M[..., 5], M[..., 6]], axis=-1)
    p, a = view(P), view(A)
    tot, tp, fp, fn = f1(p, a)
    out = {'pct': None if tot is None else round(100 * tot), 'hits': int(a.sum()), 'matched': tp, 'extra': fp, 'missed': fn}
    for i, nme in enumerate(['kick', 'snare', 'hat', 'tom', 'crash']):
        v = f1(p[..., i], a[..., i])[0]
        if v is not None: out[nme] = round(100 * v)
    pc = out['pct']
    out['letter'] = '-' if pc is None else 'A' if pc >= 90 else 'B' if pc >= 80 else 'C' if pc >= 70 else 'D' if pc >= 60 else 'F'
    return out


def fit_section(A, G, spb, bpb, plain=False):
    """Best short loop for the bars of one section. Returns (mpl body, P, PG, info)."""
    nb = A.shape[0]
    spbar = A.shape[1]
    def f1(p, a):
        tp = (p & a).sum(); d = 2 * tp + (p & ~a).sum() + (~p & a).sum()
        return 1.0 if d == 0 else 2 * tp / d
    if not A.any():
        P = np.zeros_like(A)
        return rest_bars(nb, bpb), P, np.zeros_like(G), {'L': 0, 'literal': 0}
    cands = [L for L in ((1,) if plain else (1, 2, 4)) if L * 2 <= nb] or [nb if nb <= 2 else 1]
    best = None
    for L in cands:
        pat = np.zeros((L, spbar, A.shape[2]), dtype=bool); pg = np.zeros((L, spbar), dtype=bool)
        for j in range(L):
            grp = A[j::L]
            pat[j] = grp.mean(axis=0) >= 0.5
            sn = grp[..., 1].sum(axis=0)
            pg[j] = (G[j::L].sum(axis=0) > 0.5 * np.maximum(sn, 1)) & pat[j][:, 1]
        P = np.concatenate([pat] * (nb // L + 1))[:nb]
        s = f1(P, A)
        if best is None or s > best[0] + 0.05: best = (s, L, pat, pg, P)
    s, L, pat, pg, P = best
    PG = np.concatenate([pg] * (nb // L + 1))[:nb]
    P = P.copy(); PG = PG.copy()
    lit = {}
    # a first bar (crash, pickup) or last bar (fill) that isn't the loop is written out
    for bi in ([0, nb - 1] if (nb >= 3 and not plain) else []):
        if A[bi].sum() >= 3 and f1(P[bi], A[bi]) < 0.6:
            lit[bi] = True; P[bi] = A[bi]; PG[bi] = G[bi]
    head = bar_mpl(A[0], G[0], spb, bpb, wrap=True) if 0 in lit else None
    tail = bar_mpl(A[nb - 1], G[nb - 1], spb, bpb, wrap=True) if (nb - 1) in lit else None
    inner_a = 1 if head else 0
    inner_n = nb - inner_a - (1 if tail else 0)
    # keep the loop phase: the loop restarts on the bar after a written-out first bar
    if head and L > 1:
        P[1:nb - (1 if tail else 0)] = np.concatenate([pat] * (nb // L + 1))[:inner_n]
        PG[1:nb - (1 if tail else 0)] = np.concatenate([pg] * (nb // L + 1))[:inner_n]
    segs = []
    if head: segs.append(head)
    full, remn = divmod(inner_n, L)
    loop_txt, dflt = bars_mpl(pat, pg, spb, bpb)
    if full:
        segs.append(counted(full, dflt + '(' + loop_txt + ')'))
    if remn:
        t, d = bars_mpl(pat[:remn], pg[:remn], spb, bpb)
        segs.append(d + '(' + t + ')')
    if tail: segs.append(tail)
    return ','.join(segs), P, PG, {'L': L, 'literal': len(lit)}


def rest_bars(n, bpb):
    one = 'Rw' if bpb == 4 else '3R'
    return counted(n, one if bpb == 4 else ('(' + one + ')'))


def step_tok(row, g):
    vs = [v for v in ORDER if row[VOICES.index(v)]]
    if not vs: return None
    names = [NOTE[v] + ('vv' if (v == 'S' and g) else '') for v in vs]
    return names[0] if len(names) == 1 else '|' + ','.join(names) + '|'


def bars_mpl(pat, pg, spb, bpb):
    """Bars -> (text, group length letter). One grid for the whole loop: quarters,
    eighths or sixteenths (straight), or the triplet spelling s, s\\, e\\\\ per beat."""
    nb = pat.shape[0]
    T = [[step_tok(pat[bi, k], pg[bi, k]) for k in range(pat.shape[1])] for bi in range(nb)]
    flat = [t for bar in T for t in bar]
    out = []
    if spb == 4:
        if not any(t for i, t in enumerate(flat) if i % 4): step, d = 4, ''
        elif not any(t for i, t in enumerate(flat) if i % 2): step, d = 2, 'e'
        else: step, d = 1, 's'
        out = [flat[i] or 'R' for i in range(0, len(flat), step)]
    else:
        d = ''
        for i in range(0, len(flat), 3):
            t = flat[i:i + 3]
            # length letter, then feel, then a lone note's dynamics (Dvv + e -> Devv)
            w = lambda tok, tail: (tok[:-2] + tail + 'vv') if (tok.endswith('vv') and not tok.startswith('|')) else tok + tail
            if not t[1] and not t[2]: out.append(t[0] or 'R')
            elif not t[1]: out += [w(t[0] or 'R', 'e'), w(t[2], 'e\\\\\\\\')]
            else: out += [w(t[0] or 'R', 's'), w(t[1], 's\\\\'), w(t[2], 'e\\\\\\\\') if t[2] else 'Re']
    rl = []; i = 0
    while i < len(out):
        j = i
        while j + 1 < len(out) and out[j + 1] == out[i]: j += 1
        n = j - i + 1
        if n >= 2 and '\\' not in out[i]: rl.append(str(n) + out[i])
        else: rl += out[i:j + 1]
        i = j + 1
    return ','.join(rl), d


def bar_mpl(a, g, spb, bpb, wrap):
    t, d = bars_mpl(a[None], g[None], spb, bpb)
    return (d + '(' + t + ')') if (d or wrap) else t


def show(V, G, a, b, spb, bpb):
    """Text picture of beats a..b (bar lines every bpb beats from a)."""
    lines = []
    spbar = spb * bpb
    for s0 in range(a * spb, b * spb, spbar):
        for v, ch in (('X', 'X'), ('H', 'h'), ('S', 'S'), ('T1', 't'), ('K', 'K')):
            vi = VOICES.index(v)
            row = V[s0:s0 + spbar, vi] | ((V[s0:s0 + spbar, 4] | V[s0:s0 + spbar, 5]) if v == 'T1' else False)
            if v in ('X', 'T1') and not row.any(): continue
            t = ''
            for k in range(len(row)):
                c = ch if row[k] else '.'
                if v == 'S' and row[k] and G[s0 + k]: c = 's'
                t += c + ('|' if (k + 1) % spb == 0 else '')
            lines.append('%4d %s %s' % (s0 // spb, v[0], t))
        lines.append('')
    return '\n'.join(lines)


def write_midi(path, r, title):
    """A Standard MIDI File for Logic: a tempo map that follows the recording's beats (drop the drum
    stem at 1 1 1 1 and it lines up), a marker per section, and two drum tracks on channel 10 —
    the hits detected in the stem, and what the MPL rows play."""
    import struct
    PPQ = 480
    tl = r['_tl']; spb, bpb = r['steps_per_beat'], r['beats_per_bar']
    bt = tl['beat_t']; T0 = bt[0]
    lead = next((n for n in (bpb, 2, 1) if T0 > 0 and n * 60.0 / T0 <= 900), 0)     # a short first bar up to the first beat
    def vlq(n):
        out = [n & 0x7F]; n >>= 7
        while n: out.append((n & 0x7F) | 0x80); n >>= 7
        return bytes(out[::-1])
    def track(events):
        events.sort(key=lambda e: (e[0], e[1]))
        data = b''; t = 0
        for tick, _, payload in events:
            data += vlq(tick - t) + payload; t = tick
        data += vlq(0) + b'\xff\x2f\x00'
        return b'MTrk' + struct.pack('>I', len(data)) + data
    meta = lambda kind, body: bytes([0xFF, kind]) + vlq(len(body)) + body
    tempo = lambda sec_per_beat: meta(0x51, struct.pack('>I', max(1, min(0xFFFFFF, int(round(sec_per_beat * 1e6)))))[1:])
    tsig = lambda n: meta(0x58, bytes([n, 2, 24, 8]))
    L = lead * PPQ
    cond = [(0, 0, meta(0x03, (title + ' - tempo map and sections').encode('ascii', 'replace')))]
    if lead: cond += [(0, 1, tsig(lead)), (0, 2, tempo(T0 / lead)), (L, 1, tsig(bpb))]
    else: cond.append((0, 1, tsig(bpb)))
    last = None
    for i in range(len(bt) - 1):
        d = bt[i + 1] - bt[i]
        if last is None or abs(d - last) > 0.0015 * last: cond.append((L + i * PPQ, 2, tempo(d))); last = d
    for k, ((a, n), row) in enumerate(zip(tl['sections'], r['rows'])):
        g = row['grade']
        lab = row.get('label')
        name = ' '.join(x for x in ('s%d' % (k + 1), (lab['label'] + ('?' if lab['confidence'] == 'low' else '')) if lab else '',
                                    (g['letter'] + ' ' + str(g['pct']) + '%') if g.get('pct') is not None else '') if x)
        cond.append((L + a * PPQ, 3, meta(0x06, name.encode('ascii', 'replace'))))
        rem = n % bpb
        if rem:                                              # the odd beats before the next section's bar line get their own short bar
            cond.append((L + (a + n - rem) * PPQ, 1, tsig(rem)))
            if a + n < len(bt) - 1: cond.append((L + (a + n) * PPQ, 1, tsig(bpb)))
    MIDI = {'K': 36, 'S': 38, 'H': 42, 'T1': 41, 'T2': 47, 'T3': 50, 'X': 49}
    def notes(M, name, ghost=None):
        ev = [(0, 0, meta(0x03, name.encode('utf-8')))]
        step = PPQ // spb
        for k in np.where(M.any(axis=1))[0]:
            for vi, v in enumerate(VOICES):
                if not M[k, vi]: continue
                vel = 45 if (v == 'S' and ghost is not None and ghost[k]) else 100
                ev.append((L + int(k) * step, 2, bytes([0x99, MIDI[v], vel])))
                ev.append((L + int(k) * step + step // 2, 1, bytes([0x89, MIDI[v], 0])))
        return ev
    tracks = [track(cond), track(notes(tl['A'], 'Detected in stem', tl['G'])), track(notes(tl['P'], 'MPL version'))]
    tmp = path + '.tmp'                                       # written beside it, then moved over: an old copy that Drive keeps only online cannot be opened for writing
    with open(tmp, 'wb') as f:
        f.write(b'MThd' + struct.pack('>IHHH', 6, 1, len(tracks), PPQ) + b''.join(tracks))
    os.replace(tmp, path)
    return {'lead_beats': lead, 'offset_s': 0.0 if lead else round(T0, 3)}


def clock(t):
    return '%d:%02d' % (int(t) // 60, int(t) % 60)


def row_name(title, suffix=''):
    import re
    t = re.sub(r'[^A-Za-z0-9]+', '_', title or '').strip('_') or 'song'
    return 'aid_' + t[:48 - 4 - len(suffix)].rstrip('_') + suffix


def grade_text(g):
    if g.get('pct') is None: return 'no drum hits in the stem here'
    parts = [n + ' ' + str(g[k]) for k, n in (('kick', 'kick'), ('snare', 'snare'), ('hat', 'hats'), ('tom', 'toms'), ('crash', 'crash')) if k in g]
    return 'grade %s %d%% (%s) · %d of %d hits matched, %d extra' % (g['letter'], g['pct'], ', '.join(parts), g['matched'], g['hits'], g['extra'])


# One slot per stem in every section (Bill 2026-11-15): the channel is the amp the stem plays through
# (m10 drums, m11 voice, m13 bass, m14 guitar, m15 keys, m16 other); the program is a General MIDI
# suggestion (0-127, as MPL's p#) to start from. Only drums are measured so far; the rest wait for their MPL.
STEM_DEFAULTS = {
    'vocals': {'channel': 11, 'program': 53, 'program_name': 'Voice Oohs'},
    'drums': {'channel': 10, 'program': 0, 'program_name': 'Standard kit'},
    'bass': {'channel': 13, 'program': 33, 'program_name': 'Electric Bass (finger)'},
    'guitar': {'channel': 14, 'program': 29, 'program_name': 'Overdriven Guitar'},
    'piano': {'channel': 15, 'program': 0, 'program_name': 'Acoustic Grand Piano'},
    'other': {'channel': 16, 'program': 48, 'program_name': 'String Ensemble 1'},
}
STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']


def add_stem_slots(bank):
    """Give the song and each of its sections a place for one MPL sequence per stem. Safe to run again:
    anything already filled in is kept."""
    top = bank.setdefault('stems', {})
    for s in STEM_ORDER:
        e = top.setdefault(s, {})
        for k, v in STEM_DEFAULTS[s].items(): e.setdefault(k, v)
        e.setdefault('suggested', True)                      # channel/program are starting points, not measured
    by_name = {x.get('name'): x for x in bank.get('slots', [])}
    for sec in bank.get('sections', []):
        st = sec.setdefault('stems', {})
        playing = sec.get('playing')
        for s in STEM_ORDER:
            e = st.setdefault(s, {})
            e.setdefault('channel', top[s]['channel']); e.setdefault('program', top[s]['program'])
            if playing is not None: e['playing'] = s in playing
            e.setdefault('src', None); e.setdefault('row', None); e.setdefault('status', 'empty')
        row = by_name.get(sec.get('row'))
        if row:                                              # the measured drum row for this section
            dr = st['drums']
            dr.update({'src': row['src'], 'row': row['name'], 'key': row.get('key'), 'status': 'measured'})
            if row.get('grade'): dr['grade'] = row['grade']
    bank['layout'] = ('"sections" is the song: each section has "stems", one entry per stem (vocals, drums, bass, guitar, piano, other) '
                      'with its MIDI channel, suggested program and MPL string ("src", null until written). "slots" is what the console '
                      'plays: up to 36 rows. A stem entry whose MPL is also a row names it in "row".')
    return bank


def beat_times(r):
    """analysis.beat_t: where each beat of row 0 falls in the recording, in seconds — beat_t[k] is the
    whole-song string's beat k (k = 0 is its first note), with one more entry for the end of the last
    beat. A player that follows these stays in step with the other stems; a steady 60/bpm does not."""
    return {'beat_t': [round(float(t), 3) for t in r['_tl']['beat_t']]}


def dump_bank(bank, path):
    """Write the bank as indented JSON, with the long beat list on one line."""
    import re
    txt = json.dumps(bank, indent=1, ensure_ascii=False)
    txt = re.sub(r'("beat_t": \[)([^\]]*)(\])', lambda m: m.group(1) + ' '.join(m.group(2).split()) + m.group(3), txt, count=1)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f: f.write(txt + '\n')
    os.replace(tmp, path)


def make_bank(meta, r, now):
    """The <folder>_MPL.json bank: row 0 = the whole song in one string, rows 1.. = one per section."""
    title, artist = meta.get('title') or meta.get('folder') or '', meta.get('artist') or ''
    keys = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    w = r['whole']
    feel = 'triplet (shuffle / 12-8) grid' if r['steps_per_beat'] == 3 else 'sixteenth-note grid'
    slots = [{'key': '0', 'name': row_name(title), 'src': w['src'], 'velocity': 100, 'grade': {k: v for k, v in w['grade'].items()},
              'note': 'Whole song in one string · %d bars of %d/4 at %s bpm · starts at %s in the recording · %s%s' % (
                  w['bars'], r['beats_per_bar'], ('%g' % r['bpm']), clock(r['first_bar_t']), grade_text(w['grade']),
                  ' · shortened to one-bar loops to fit a row' if w.get('plain') else '')}]
    n = len(r['rows'])
    sections = []
    for row in r['rows']:
        lab = row.get('label')
        slot = {'key': keys[row['section']], 'name': row_name(title, '_s%d' % row['section']), 'src': row['src'], 'velocity': 100,
                'grade': row['grade'], 'bars': row['bars'], 't0': row['t0'], 't1': row['t1'],
                'note': '%sSection %d of %d · %s-%s · %d bar%s%s · %s' % (
                    (lab['label'] + (' (a guess)' if lab['confidence'] == 'low' else '') + ' · ') if lab else '',
                    row['section'], n, clock(row['t0']), clock(row['t1']), row['bars'], '' if row['bars'] == 1 else 's',
                    (' + %d beat%s' % (row['extra_beats'], '' if row['extra_beats'] == 1 else 's')) if row['extra_beats'] else '',
                    grade_text(row['grade']))}
        sec = {'section': row['section'], 'key': slot['key'], 'row': slot['name'], 't0': row['t0'], 't1': row['t1'],
               'bars': row['bars'], 'extra_beats': row['extra_beats']}
        if lab:
            slot['label'] = lab['label']; slot['label_confidence'] = lab['confidence']
            sec.update(lab)
        slots.append(slot); sections.append(sec)
    return add_stem_slots({
        'format': 'simplestem-mpl-bank', 'version': 1,
        'name': (title + (' — ' + artist if artist else '') + ' · drums')[:80],
        'description': ('Drum sequences measured from this song\'s drum stem (drums.m4a) by drumscribe.py: beats tracked, then kick, snare, '
                        'hi-hat, tom and crash hits placed on a %s. Row 0 is the whole song in one string; rows 1-%d are its sections '
                        '(from %s), each written as its most common 1, 2 or 4 bar loop, with a first or last bar spelled out when it differs. '
                        'Each row\'s note carries its grade: how closely the row reproduces the hits detected in the stem (100%% = every '
                        'detected hit and no extras). The grade checks the short loop against the detection, not the detection against the '
                        'record: a hit the analysis misheard is not counted against it. Hats and ride are both written as closed hat (F#). '
                        'The "sections" list names each section (Intro, Verse, Chorus, Bridge, Solo, Break, Outro) from all six stems, with a '
                        'confidence and the reasons: where the singing is, which stems come in or drop out together, and which earlier section '
                        'its harmony repeats. Low-confidence names are guesses.'
                        ) % (feel, n, {'sections': 'the section marks saved for the song',
                                       'none': 'the whole song as one section'}[r['section_source']]),
        'created_by': {'kind': 'ai', 'name': 'Claude', 'via': 'drumscribe.py'},
        'prompt': 'For each song in the simpleStem library, create MPL strings for drums that match the pattern in the song.',
        'created_at': now, 'bpm': int(round(r['bpm'])), 'key': '', 'song': title, 'main': '0',
        'analysis': dict({k: r[k] for k in ('bpm', 'meta_bpm', 'tempo_note', 'beats_per_bar', 'steps_per_beat', 'bars', 'beats', 'grid_fit',
                                            'first_bar_t', 'duration', 'section_source')}, **beat_times(r)),
        'sections': sections,
        'slots': slots,
    })


if __name__ == '__main__':
    meta = json.load(open(sys.argv[2]))
    dbg = '--debug' in sys.argv
    r = analyze(sys.argv[1], meta, debug=dbg); r.pop('_tl', None)
    if dbg:
        V, G, rg = r.pop('_V'), r.pop('_G'), r.pop('_ranges')
        print(json.dumps({k: v for k, v in r.items() if k not in ('rows', 'whole')}))
        for row, (a, b) in zip(r['rows'], rg):
            print('--- section', row['section'], 'beats', a, b, 'bars', row['bars'], '+', row['extra_beats'], row['grade'], '\n   ', row['src'])
        print('WHOLE', r['whole']['grade'], len(r['whole']['src']), 'chars')
        k = int(sys.argv[sys.argv.index('--debug') + 1]) if len(sys.argv) > sys.argv.index('--debug') + 1 else 2
        a, b = rg[min(k, len(rg) - 1)]
        print(show(V, G, a, min(b, a + 6 * r['beats_per_bar']), r['steps_per_beat'], r['beats_per_bar']))
    else:
        print(json.dumps(r))
