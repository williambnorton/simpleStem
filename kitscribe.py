#!/usr/bin/env python3
"""kitscribe: a song's Logic Pro 13 kit-piece stems -> one MPL row per drum piece per phrase.

Reads STEMS/<song>/{kick,snare,hihat,toms,cymbals,percussion}.m4a (or logic13/ under it, the older layout) and the song's
<folder>_MPL.json (songscribe.py), keeps that file's beat grid, sections, phrases and non-drum
rows, and replaces each phrase's one drum row with a row per kit piece, measured from that
piece's own stem. Pure numpy + ffmpeg, like drumscribe.py.

  python3 kitscribe.py <STEMS/song folder> --out <bank.json> [--mpl <_MPL.json>] [--offset-ms N]
Prints one JSON line: the per-piece hit counts and grades.
"""
import argparse, json, os, re, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drumscribe as ds

KIT_DIR = 'logic13'
#          piece         row suffix  band (Hz)       drumscribe voice columns
PIECES = [('kick',       'Kick',     (35, 250),      ['K']),
          ('snare',      'Snare',    (150, 9000),    ['S']),
          ('hihat',      'Hat',      (2500, 11000),  ['H']),
          ('toms',       'Toms',     (55, 1500),     ['T1', 'T2', 'T3']),
          ('cymbals',    'Cym',      (2500, 11000),  ['X']),
          ('percussion', 'Perc',     (250, 11000),   ['H'])]      # written through the hat column, then renamed
FLOOR_DB, NEAR_DB, PRESENT_DB, BLEED_DB = -45.0, 18.0, -36.0, 12.0


def piece_onsets(path, lo, hi):
    """[(frame, level dB, low-band peak Hz, centroid Hz)] for every hit in one kit-piece stem."""
    x = ds.load(path)
    if len(x) < ds.NFFT * 4: return []
    mag = ds.stft_mag(x)
    env = ds.onset_env(ds.band(mag, lo, hi))
    pos = env[env > 0]
    if not len(pos): return []
    pk = ds.peaks(env / (np.percentile(pos, 98) + 1e-9), 0.15, 3)
    cs = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    n = mag.shape[0]
    a = np.arange(n) * ds.HOP
    rms = np.sqrt((cs[a + ds.NFFT] - cs[a]) / ds.NFFT)
    f = np.arange(mag.shape[1]) * ds.SR / ds.NFFT
    lowb = (f >= 50) & (f < 400)
    out = []
    for p in pk:
        b = min(n, p + 4)
        lev = 20 * np.log10(rms[p:b].max() + 1e-9)
        sp = mag[p:b].mean(axis=0)
        out.append((int(p), float(lev), float(f[lowb][np.argmax(sp[lowb])]), float((sp * f).sum() / (sp.sum() + 1e-9))))
    if not out: return []
    lv = sorted((o[1] for o in out), reverse=True)
    ref = lv[min(2, len(lv) - 1)]                         # the third-loudest hit: a few real hits set the level, not the residue
    if ref < PRESENT_DB: return []
    return [o for o in out if o[1] >= max(FLOOR_DB, ref - NEAR_DB)]


def drop_bleed(on):
    """A hit that lands with a much louder hit in another piece's stem is that piece leaking through."""
    allp = sorted((p, lev, k) for k, v in on.items() for (p, lev, _f, _c) in v)
    fr = np.array([a[0] for a in allp]); lv = np.array([a[1] for a in allp]); who = [a[2] for a in allp]
    out = {}
    for k, v in on.items():
        keep = []
        for o in v:
            i0, i1 = np.searchsorted(fr, o[0] - 2), np.searchsorted(fr, o[0] + 3)
            if any(who[i] != k and lv[i] >= o[1] + BLEED_DB for i in range(i0, i1)): continue
            keep.append(o)
        out[k] = keep
    return out


def f1(p, a):
    tp = int((p & a).sum()); fp = int((p & ~a).sum()); fn = int((~p & a).sum())
    if tp + fp + fn == 0: return None
    pct = round(100 * 2 * tp / (2 * tp + fp + fn))
    return {'pct': pct, 'hits': int(a.sum()), 'matched': tp, 'extra': fp, 'missed': fn,
            'letter': 'A' if pct >= 90 else 'B' if pct >= 80 else 'C' if pct >= 70 else 'D' if pct >= 60 else 'F'}


def grade_text(g):
    return '-' if not g else 'grade %s %d%% · %d of %d hits matched, %d extra' % (g['letter'], g['pct'], g['matched'], g['hits'], g['extra'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('song_dir'); ap.add_argument('--out', required=True)
    ap.add_argument('--mpl'); ap.add_argument('--offset-ms', type=int)
    a = ap.parse_args()
    song_dir = a.song_dir.rstrip('/'); base = os.path.basename(song_dir)
    src = json.load(open(a.mpl or os.path.join(song_dir, base + '_MPL.json')))
    an = src['analysis']; spb, bpb = an['steps_per_beat'], an['beats_per_bar']; spbar = spb * bpb
    bt = np.array(an['beat_t']) * ds.FPS; nbeats = len(bt) - 1; ns = nbeats * spb
    steps = (bt[:-1, None] + (bt[1:, None] - bt[:-1, None]) * np.arange(spb)[None, :] / spb).reshape(-1)
    tol = 0.5 * float(np.median(np.diff(bt))) / spb

    on = {}
    for key, _suf, (lo, hi), _cols in PIECES:
        p = os.path.join(song_dir, KIT_DIR, key + '.m4a')
        if not os.path.isfile(p): p = os.path.join(song_dir, key + '.m4a')     # flat layout: the pieces sit in the song folder
        on[key] = piece_onsets(p, lo, hi) if os.path.isfile(p) else []
    on = drop_bleed(on)

    def nearest(p):
        j = int(np.searchsorted(steps, p))
        c = min((k for k in (j - 1, j) if 0 <= k < ns), key=lambda k: abs(steps[k] - p), default=None)
        return c
    # one constant offset between these stems and the song's beat grid, from the kick and snare
    d = [o[0] - steps[nearest(o[0])] for k in ('kick', 'snare') for o in on[k] if nearest(o[0]) is not None]
    d = [v for v in d if abs(v) <= tol]
    shift = float(np.median(d)) if len(d) >= 8 else 0.0

    nv = len(ds.VOICES); A = {k: np.zeros((ns, nv), dtype=bool) for k, *_ in PIECES}; G = np.zeros(ns, dtype=bool)
    stats = {}
    for key, _suf, _band, cols in PIECES:
        ev = on[key]; placed = 0
        med = float(np.median([o[1] for o in ev])) if ev else 0.0
        for p, lev, lowf, _c in ev:
            c = nearest(p - shift)
            if c is None or abs(steps[c] - (p - shift)) > tol: continue
            col = cols[0] if len(cols) == 1 else cols[0 if lowf < 100 else 1 if lowf < 160 else 2]
            A[key][c, ds.VOICES.index(col)] = True; placed += 1
            if key == 'snare' and lev < med - 9: G[c] = True
        stats[key] = {'onsets': len(ev), 'on_grid': placed}
    cen = [o[3] for o in on['percussion']]
    pc = float(np.median(cen)) if cen else 0.0
    perc_note, perc_name = ('F#+', 'tambourine') if pc > 5000 else ('D#', 'hand clap') if pc > 1200 else ('E++', 'low conga')

    # where each phrase is played: the song is its sections back to back, a section its phrases back to back
    slot = {s['name']: s for s in src['slots'] if s.get('name')}
    starts = {}; cur = 0; worst = 0.0
    for sec in src['sections']:
        worst = max(worst, abs(float(an['beat_t'][min(cur, nbeats)]) - sec['t0']))
        for ph in sec['phrases']:
            starts.setdefault(ph, []).append(cur); cur += slot[ph]['beats']

    P = {k: np.zeros((ns, nv), dtype=bool) for k, *_ in PIECES}
    new_rows = {}                                   # phrase -> [(row name, piece, src, grade, note)]
    for ph, st in starts.items():
        nb = slot[ph]['beats']; st = [s for s in st if (s + nb) * spb <= ns]
        if not st: continue
        nbar = nb // bpb; rows = []
        Gc = np.mean([G[s * spb:(s + nb) * spb] for s in st], axis=0) >= 0.5
        for key, suf, _band, cols in PIECES:
            inst = np.stack([A[key][s * spb:(s + nb) * spb] for s in st])
            Ac = inst.mean(axis=0) >= 0.5
            if not Ac.any(): continue
            if nbar:
                body, Pb, _pg, _info = ds.fit_section(Ac[:nbar * spbar].reshape(nbar, spbar, nv), Gc[:nbar * spbar].reshape(nbar, spbar), spb, bpb)
                Pc = Pb.reshape(-1, nv)
            else: body, Pc = '', Ac[:0]
            At = Ac[nbar * spbar:]
            if len(At):
                t, dd = ds.bars_mpl(At[None], Gc[nbar * spbar:][None], spb, bpb)
                body = (body + ',' if body else '') + ((dd + '(' + t + ')') if dd else t)
            Pc = np.concatenate([Pc, At])
            if not Pc.any(): continue
            what = {'kick': 'kick', 'snare': 'snare', 'hihat': 'closed hi-hat', 'toms': 'toms (floor F, mid B, high D+)', 'cymbals': 'crash cymbal', 'percussion': perc_name}[key]
            if key == 'cymbals' and Pc.sum() > nb:   # busier than one a beat: that is a ride, not crashes
                body = body.replace('C#+', 'D#+'); what = 'ride cymbal'
            if key == 'percussion': body = body.replace('F#', perc_note)
            for s in st: P[key][s * spb:(s + nb) * spb] = Pc
            col = [ds.VOICES.index(c) for c in cols]
            g = f1(np.stack([Pc] * len(st))[..., col].any(axis=-1), inst[..., col].any(axis=-1))
            rows.append((ph + suf, key, 'm10,' + body, g,
                         '%s of %s, measured from the Logic 13 %s stem · %s' % (what[0].upper() + what[1:], ph, key, grade_text(g))))
        new_rows[ph] = rows

    piece_g = {}
    for key, _suf, _band, cols in PIECES:
        col = [ds.VOICES.index(c) for c in cols]
        g = f1(P[key][:, col].any(axis=1), A[key][:, col].any(axis=1))
        stats[key]['grade'] = g
        if g: piece_g[key] = g
    allP = np.stack([P[k].any(axis=1) for k, *_ in PIECES], axis=1); allA = np.stack([A[k].any(axis=1) for k, *_ in PIECES], axis=1)
    song_g = f1(allP, allA)

    slots = []
    for s in src['slots']:
        role = s.get('role')
        if role == 'part' and s.get('stem') == 'drums':
            for name, key, body, g, note in new_rows.get(s.get('phrase'), []):
                slots.append({'name': name, 'src': body, 'velocity': s.get('velocity', 100), 'role': 'part', 'stem': 'drums', 'piece': key,
                              'channel': 10, 'phrase': s.get('phrase'), 'grade': g, 'note': note, 'auto_name': True})
            continue
        t = dict(s); t.pop('key', None)
        if role == 'phrase':
            calls = ','.join('@%s&' % r[0] for r in new_rows.get(s['name'], []))
            t['src'] = re.sub(r'@%sDrums&,?' % re.escape(s['name']), (calls + ',') if calls else '', s['src'])
            t.pop('grade', None)
            t['note'] = 'A phrase of %d beats · its parts start together · used %d times · drums are one row per kit piece' % (s['beats'], len(starts.get(s['name'], [])))
        elif role == 'song':
            t['grade'] = song_g
            t['note'] = '%s · drums as kit pieces from the Logic 13 stems · %s' % (src.get('song', base), grade_text(song_g))
        elif role == 'section':
            t.pop('grade', None); t['note'] = re.sub(r' · drums grade.*$', '', s.get('note', ''))
        slots.append(t)
    keys = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for i, s in enumerate(slots): s['key'] = keys[i] if i < 36 else None

    bank = {k: v for k, v in src.items() if k not in ('slots', 'text', 'grade', 'offset_ms')}
    bank['name'] = '%s — %s · kit pieces' % (src.get('song', base), src.get('artist', ''))
    bank['description'] = ('This song as MPL with the drums split into kit pieces. The song, section and phrase rows and the voice, bass, guitar, '
        'piano and other rows are the ones in the song\'s own MPL file (songscribe.py); each phrase\'s single drum row is replaced by a row per piece '
        '— Kick (C), Snare (D), Hat (F#, closed), Toms (F, B, D+), Cym (C#+ crash, or D#+ ride where it plays more than once a beat) and Perc (%s, %s) — '
        'all on m10. Each piece is measured from its own Logic Pro 13 kit-piece stem (logic13/): hits found in that stem, placed on the song\'s '
        'sixteenth-note grid, and written as the phrase\'s most common 1, 2 or 4 bar loop. A piece with no hits in a phrase has no row there. '
        'Grades (A 90%%+, B 80-90, C 70-80, D 60-70, F below) say how closely a row reproduces the hits found in its stem everywhere the phrase is played. '
        '"text" is the same rows as name=MPL; lines.') % (perc_note, perc_name)
    bank['created_by'] = {'kind': 'ai', 'name': 'Claude', 'via': 'kitscribe.py'}
    bank['prompt'] = 'Add the MPL for each of the Logic 13 kit-piece tracks.'
    bank['created_at'] = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    off = a.offset_ms if a.offset_ms is not None else int(round(1000 * shift / ds.FPS))   # the hits sit this far after the grid
    if off: bank['offset_ms'] = off
    bank['grade'] = song_g
    bank['kit'] = {'stems': KIT_DIR, 'grid_shift_ms': round(1000 * shift / ds.FPS, 1), 'percussion_note': perc_note, 'pieces': stats}
    bank['slots'] = slots
    bank['text'] = ['%s=%s;' % (s['name'], s['src']) for s in slots]
    ds.dump_bank(bank, a.out)
    print(json.dumps({'song': base, 'rows': len(slots), 'kit_rows': sum(len(v) for v in new_rows.values()), 'shift_ms': bank['kit']['grid_shift_ms'],
                      'section_t_worst': round(worst, 2), 'pct': song_g and song_g['pct'], 'perc': perc_note,
                      'pieces': {k: [v['onsets'], v['on_grid'], v['grade'] and v['grade']['pct']] for k, v in stats.items()}}))


if __name__ == '__main__':
    main()
