#!/usr/bin/env python3
"""drumlabel: name a song's sections (Intro, Verse, Chorus, Bridge, Solo, Break, Outro) from its six stems.

What it looks at, per section:
  - which stems are sounding, and which come in or drop out together at the section's first beat
  - whether there is singing (the vocals stem)
  - how loud the section is against the rest of the song
  - whether its harmony, beat by beat, is mostly a repeat of an earlier section

Pure numpy + ffmpeg. Used by drumscribe.analyze(); every label carries a confidence and the reasons for it.
"""
import os, subprocess
import numpy as np

LSR = 11025
STEMS = ['vocals', 'bass', 'guitar', 'piano', 'other']


def load(path, sr=LSR):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def beat_rms(x, sr, bt):
    """RMS of x inside each beat (bt = beat times in seconds, n+1 edges)."""
    cs = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    e = np.clip((np.asarray(bt) * sr).astype(int), 0, len(x))
    n = np.maximum(1, e[1:] - e[:-1])
    return np.sqrt(np.maximum(0, cs[e[1:]] - cs[e[:-1]]) / n)


def beat_chroma(x, sr, bt, nfft=4096, hop=1024):
    """12 pitch-class energies per beat from the pitched stems."""
    if len(x) < nfft: return np.zeros((len(bt) - 1, 12))
    n = 1 + (len(x) - nfft) // hop
    win = np.hanning(nfft).astype(np.float32)
    f = np.arange(nfft // 2 + 1) * sr / nfft
    keep = (f >= 60) & (f <= 2100)
    pc = (np.round(12 * np.log2(np.maximum(f[keep], 1e-6) / 440.0) + 69).astype(int)) % 12
    M = np.zeros((12, keep.sum()), dtype=np.float32)
    M[pc, np.arange(keep.sum())] = 1.0
    ch = np.empty((n, 12), dtype=np.float32)
    idx = np.arange(nfft)
    for a in range(0, n, 1500):
        b = min(n, a + 1500)
        fr = x[np.arange(a, b)[:, None] * hop + idx[None, :]]
        mag = np.abs(np.fft.rfft(fr * win, axis=1))[:, keep]
        ch[a:b] = (mag ** 2) @ M.T
    ft = (np.arange(n) * hop + nfft / 2) / sr
    out = np.zeros((len(bt) - 1, 12))
    lo = np.searchsorted(ft, bt[:-1]); hi = np.searchsorted(ft, bt[1:])
    for i in range(len(bt) - 1):
        a, b = lo[i], max(hi[i], lo[i] + 1)
        if a < n: out[i] = ch[a:min(b, n)].mean(axis=0)
    out = np.sqrt(out)
    nrm = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.maximum(nrm, 1e-9)


def features(stem_dir, bt, drum_x=None, drum_sr=22050):
    """Per-beat loudness for each stem (dB under that stem's own loud level), singing flag, chroma."""
    nb = len(bt) - 1
    rms = {}; mix = None
    for s in STEMS:
        p = os.path.join(stem_dir, s + '.m4a')
        if not os.path.isfile(p): continue
        x = load(p)
        if len(x) < LSR: continue
        rms[s] = beat_rms(x, LSR, bt)
        if s != 'vocals':
            if mix is None: mix = x.copy()
            else:
                m = min(len(mix), len(x)); mix = mix[:m] + x[:m]
    if drum_x is not None: rms['drums'] = beat_rms(drum_x, drum_sr, bt)
    chroma = beat_chroma(mix, LSR, bt) if mix is not None else np.zeros((nb, 12))
    # a stem that is silence + separation residue for the whole song (e.g. "piano" in a guitar band) is not an instrument
    total = np.sqrt(sum(v ** 2 for v in rms.values())) if rms else np.zeros(nb)
    tot_ref = np.percentile(total, 90) + 1e-9
    act = {}; level = {}; real = {}
    for s, v in rms.items():
        ref = np.percentile(v, 95) + 1e-9
        real[s] = bool(ref > 0.06 * tot_ref)
        level[s] = 20 * np.log10(np.maximum(v, 1e-9) / ref)
        act[s] = (level[s] > -22) & real[s]
    return {'rms': rms, 'act': act, 'level': level, 'real': real, 'chroma': chroma, 'total': total}


def seq_sim(C, a, na, b, nb_, bpb, base):
    """How much section b's harmony repeats section a's, beat for beat (0 = unrelated, 1 = the same), trying
    bar shifts either way for a boundary that sits a bar early or late."""
    best = -1.0
    n = len(C)
    for sh in (-2, -1, 0, 1, 2):
        s = b + sh * bpb
        m = min(na, nb_, 64, n - max(a, s))
        if s < 0 or m < 2 * bpb: continue
        d = float(np.mean(np.sum(C[a:a + m] * C[s:s + m], axis=1)))
        best = max(best, d)
    return (best - base) / max(1e-6, 1 - base) if best >= 0 else 0.0


def label_sections(stem_dir, bt, secs, bpb, drum_x=None, debug=False):
    """secs: [(first beat, beats)] on the bt grid. Returns one dict per section."""
    F = features(stem_dir, np.asarray(bt), drum_x)
    nb = len(bt) - 1
    C = F['chroma']
    rng = np.random.default_rng(7)
    ii = rng.integers(0, nb, 4000); jj = rng.integers(0, nb, 4000)
    base = float(np.mean(np.sum(C[ii] * C[jj], axis=1))) if nb > 8 else 0.5
    tot_db = 20 * np.log10(np.maximum(F['total'], 1e-9))
    med = float(np.median(tot_db[F['total'] > 0.05 * np.percentile(F['total'], 90)])) if nb else 0.0
    has_vox = 'vocals' in F['act'] and F['real'].get('vocals', False)
    vox = F['act']['vocals'] if has_vox else np.zeros(nb, dtype=bool)
    S = []
    for k, (a, n) in enumerate(secs):
        sl = slice(a, a + n)
        d = {'i': k, 'a': a, 'n': n, 'voc': float(vox[sl].mean()) if n else 0.0,
             'loud': float(np.mean(tot_db[sl]) - med) if n else -60.0,
             'on': {s: float(v[sl].mean()) for s, v in F['act'].items()},
             'vlev': float(np.mean(np.maximum(F['level']['vocals'][sl], -40))) if (has_vox and n) else -40.0}
        # who comes in / drops out together on the first beat
        w = max(bpb, 4)
        ent, drp = [], []
        for s, v in F['act'].items():
            if not F['real'][s] or a < w: continue
            before = float(v[a - w:a].mean()); after = float(v[a:a + w].mean())
            if before <= 0.25 and after >= 0.75: ent.append(s)
            if before >= 0.75 and after <= 0.25: drp.append(s)
        d['enters'], d['drops'] = ent, drp
        S.append(d)
    ns = len(S)
    sim = np.zeros((ns, ns))
    for i in range(ns):
        for j in range(i + 1, ns):
            sim[i, j] = sim[j, i] = seq_sim(C, S[i]['a'], S[i]['n'], S[j]['a'], S[j]['n'], bpb, base)
    VOC = 0.30
    for d in S: d['sung'] = d['voc'] >= VOC
    # ---- families: a section joins the earlier section it repeats (same sung / not sung, similar harmony)
    TH = 0.45
    fam = [-1] * ns; nf = 0
    for j in range(ns):
        best, bi = TH, -1
        for i in range(j):
            if S[i]['sung'] != S[j]['sung']: continue
            if sim[i, j] > best: best, bi = sim[i, j], i
        if bi >= 0: fam[j] = fam[bi]; S[j]['repeats'] = bi; S[j]['repeat_sim'] = round(float(best), 2)
        else: fam[j] = nf; nf += 1
    members = {}
    for j, f in enumerate(fam): members.setdefault(f, []).append(j)

    sung = [d['i'] for d in S if d['sung']]
    kind = [None] * ns; why = [[] for _ in range(ns)]; conf = ['low'] * ns
    if not sung:
        # no singing found: name the parts by family only
        letters = {}
        for j in range(ns):
            letters.setdefault(fam[j], chr(ord('A') + len(letters)))
            kind[j] = 'Part ' + letters[fam[j]]
            why[j].append('no singing found in the vocals stem, so parts are lettered by which sections repeat each other')
            if len(members[fam[j]]) > 1: conf[j] = 'medium'
    else:
        fv, lv = sung[0], sung[-1]
        sfam = [f for f in members if S[members[f][0]]['sung']]
        rep = [f for f in sfam if len(members[f]) >= 2]
        mean_loud = lambda f: float(np.mean([S[j]['loud'] for j in members[f]]))
        mean_voc = lambda f: float(np.mean([S[j]['voc'] for j in members[f]]))
        chorus = verse = None
        if len(rep) >= 2:
            # the chorus is the repeated sung part that is louder / fuller and does not open the singing
            score = {f: mean_loud(f) + 4.0 * mean_voc(f) + (1.5 if members[f][0] != fv else 0.0) + 0.5 * (len(members[f]) - 2) for f in rep}
            chorus = max(rep, key=lambda f: score[f])
            rest = [f for f in rep if f != chorus]
            verse = min(rest, key=lambda f: members[f][0])
            margin = score[chorus] - max(score[f] for f in rest)
        elif len(rep) == 1:
            # one repeated sung part: the verse when the singing opens with it, otherwise the chorus
            f = rep[0]
            if members[f][0] == fv: verse = f
            else: chorus = f
            margin = 0.0
        # verse and chorus on the same chords (a three-chord song) land in one family: harmony can't split them
        one_harmony = len(rep) == 1 and verse is not None and len(members[verse]) >= 4 and len(members[verse]) >= 0.8 * len(sung)
        for j in range(ns):
            d = S[j]; f = fam[j]
            if j < fv:
                kind[j] = 'Intro'; conf[j] = 'high' if d['voc'] < 0.1 else 'medium'
                why[j].append('before the singing starts')
            elif j > lv:
                kind[j] = 'Outro'; conf[j] = 'high' if d['voc'] < 0.1 else 'medium'
                why[j].append('after the last sung section')
            elif not d['sung']:
                lead = {s: float(np.mean(F['level'][s][d['a']:d['a'] + d['n']])) - float(np.median(F['level'][s][F['act'][s]])) if F['act'][s].any() else -99
                        for s in ('guitar', 'piano', 'other') if F['real'].get(s)}
                top = max(lead, key=lead.get) if lead else None
                drums_on = d['on'].get('drums', 1.0)
                if d['loud'] < -6 or drums_on < 0.4:
                    kind[j] = 'Break'; why[j].append('no singing and the band drops back' + (' (drums mostly out)' if drums_on < 0.4 else ''))
                    conf[j] = 'medium'
                elif top and lead[top] > 0.5:
                    kind[j] = 'Solo'; why[j].append('no singing, ' + top + ' stem louder than its usual level'); conf[j] = 'medium'
                else:
                    kind[j] = 'Interlude'; why[j].append('no singing between sung sections'); conf[j] = 'medium'
                under = [i for i in range(ns) if S[i]['sung'] and sim[i, j] > TH]
                if under:
                    u = max(under, key=lambda i: sim[i, j]); d['over'] = u
            elif f == chorus:
                kind[j] = 'Chorus'; why[j].append('sung part that comes back %d times' % len(members[f]) + (', the louder and fuller of the repeated parts' if len(rep) >= 2 else ''))
                conf[j] = 'high' if (len(rep) >= 2 and margin > 2.5 and d.get('repeat_sim', 1.0) >= 0.7) else 'medium'
            elif f == verse:
                kind[j] = 'Verse'; why[j].append('sung part that comes back %d times' % len(members[f]) + (' and opens the singing' if members[f][0] == fv else ''))
                conf[j] = 'high' if (chorus is not None and margin > 2.5 and d.get('repeat_sim', 1.0) >= 0.7) else 'medium'
                if one_harmony:
                    conf[j] = 'low'; why[j].append('the whole sung part of the song runs over the same chords, so its verses and choruses could not be told apart')
            elif len(members[f]) >= 2:
                nxt = [fam[i + 1] if i + 1 < ns else None for i in members[f]]
                if chorus is not None and all(x == chorus for x in nxt):
                    kind[j] = 'Pre-Chorus'; why[j].append('repeated sung part that always leads into the chorus'); conf[j] = 'medium'
                else:
                    kind[j] = 'Verse'; why[j].append('another repeated sung part'); conf[j] = 'low'
            else:
                first_ch = members[chorus][0] if chorus is not None else None
                later = first_ch is not None and j > first_ch and sum(1 for i in members[chorus] if i < j) >= 1 and j >= ns * 0.45
                if later:
                    kind[j] = 'Bridge'; why[j].append('sung part heard only once, after the chorus has come round'); conf[j] = 'medium'
                elif chorus is not None and verse is None and j < first_ch:
                    kind[j] = 'Verse'; why[j].append('sung part before the first chorus'); conf[j] = 'medium'
                elif chorus is None and verse is not None:
                    louder = d['loud'] > mean_loud(verse) + 1.0
                    kind[j] = 'Chorus' if louder else 'Verse'
                    why[j].append('sung part heard once, ' + ('louder than the verses' if louder else 'at verse level')); conf[j] = 'low'
                else:
                    kind[j] = 'Verse'; why[j].append('sung part with no clear repeat'); conf[j] = 'low'
    # ---- reasons shared by every kind, numbering
    out = []
    # numbering goes by runs: neighbouring sections of one kind are one part of the song, split in two or more
    runs = []
    for j, kd in enumerate(kind):
        if runs and runs[-1][0] == kd: runs[-1][1].append(j)
        else: runs.append((kd, [j]))
    nruns = {}
    for kd, _ in runs: nruns[kd] = nruns.get(kd, 0) + 1
    seen = {}; label_of = {}
    for kd, js in runs:
        seen[kd] = seen.get(kd, 0) + 1
        base_l = kd + (' %d' % seen[kd] if nruns[kd] > 1 and not kd.startswith('Part') else '')
        for k, j in enumerate(js):
            label_of[j] = base_l + (' (part %d of %d)' % (k + 1, len(js)) if len(js) > 1 else '')
    for j, d in enumerate(S):
        kd = kind[j]; label = label_of[j]
        if 'repeats' in d: why[j].append('harmony repeats section %d (%d%% alike)' % (d['repeats'] + 1, round(100 * d['repeat_sim'])))
        if 'over' in d and 'repeats' not in d: why[j].append('played over the harmony of section %d' % (d['over'] + 1))
        if len(d['enters']) >= 2: why[j].append(', '.join(d['enters']) + ' come in together on its first beat')
        elif d['enters']: why[j].append(d['enters'][0] + ' comes in on its first beat')
        if len(d['drops']) >= 2: why[j].append(', '.join(d['drops']) + ' drop out together')
        elif d['drops']: why[j].append(d['drops'][0] + ' drops out')
        if has_vox: why[j].append('singing on %d%% of its beats' % round(100 * d['voc']))
        out.append({'label': label, 'kind': kd, 'confidence': conf[j], 'why': why[j],
                    'repeats': (d['repeats'] + 1) if 'repeats' in d else None,
                    'repeat_similarity': d.get('repeat_sim'), 'family': int(fam[j]) + 1,
                    'singing': round(d['voc'], 2), 'loudness_db': round(d['loud'], 1),
                    'enters': d['enters'], 'drops': d['drops'],
                    'playing': sorted(s for s, v in d['on'].items() if v >= 0.5)})
    if debug: return out, sim, S
    return out
