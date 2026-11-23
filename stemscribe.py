#!/usr/bin/env python3
"""stemscribe: every Logic Pro 13 stem of a song -> its own whole-song MPL file, plus how closely that MPL follows the audio.

For STEMS/<song>/{kick,snare,hihat,toms,cymbals,percussion,vocals,bass,guitar,piano,other}.m4a it writes
<stem>_MPL.json beside them — a small MPL bank whose first row plays the whole stem, every note where it was found
(no loops), on the beat grid of the song's <folder>_MPL.json — and records the accuracy of each in that
<folder>_MPL.json under "logic13". Pure numpy + ffmpeg.

  python3 stemscribe.py <STEMS/song folder> [--mpl <_MPL.json to read>] [--also <second _MPL.json to update>] [--out <folder for the per-stem MPL files>]

Accuracy:
  drum pieces   the MPL's hits against the hits found in the stem, each matched within 30 ms (F1, as a percentage),
                and energy_covered: the share of the stem's energy that falls right after an MPL hit.
  vocals, bass  one note at a time; guitar, piano, other one chord per beat. Accuracy is the match, beat by beat,
                between the pitch classes the MPL plays and the pitch classes heard in the stem.
"""
import argparse, json, os, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drumscribe as ds
import drumlabel
import songscribe as ss
import kitscribe as ks

KIT = ks.KIT_DIR
CHUNK_BARS = 16
CHANNEL = {'vocals': 11, 'bass': 13, 'guitar': 14, 'piano': 15, 'other': 16}
MATCH_S = 0.030


def letter(p):
    return 'A' if p >= 90 else 'B' if p >= 80 else 'C' if p >= 70 else 'D' if p >= 60 else 'F'


def match(notes, ons, w):
    """How many of two sorted time lists pair up within w."""
    i = j = tp = 0
    while i < len(notes) and j < len(ons):
        d = notes[i] - ons[j]
        if abs(d) <= w: tp += 1; i += 1; j += 1
        elif d < 0: i += 1
        else: j += 1
    return tp


def bank(src, base, stem, what, channel, rows, acc, extra=None):
    slots = [{'key': '0', 'name': stem, 'src': ','.join('@' + n for n, _s, _b in rows), 'velocity': 100, 'role': 'song',
              'note': '%s of %s, whole song, every note where it was found in the Logic 13 stem · accuracy %s' % (what, src.get('song', base), ('%d%%' % acc['accuracy']) if acc.get('accuracy') is not None else '-')}]
    keys = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for i, (n, s, bars) in enumerate(rows):
        slots.append({'key': keys[i + 1] if i + 1 < 36 else None, 'name': n, 'src': s, 'velocity': 100, 'role': 'part', 'stem': stem, 'channel': channel, 'bars': bars})
    b = {'format': 'simplestem-mpl-bank', 'version': 2, 'name': '%s — %s · %s (Logic 13)' % (src.get('song', base), src.get('artist', ''), stem),
         'description': 'One stem as MPL: %s, written out for the whole song with every note where it was found in logic13/%s.m4a — no loops — in rows of %d bars; '
                        'the first row plays them in order. Made for comparing the MPL against the stem\'s audio. The beat grid is the one in %s_MPL.json.' % (what, stem, CHUNK_BARS, base),
         'created_by': {'kind': 'ai', 'name': 'Claude', 'via': 'stemscribe.py'}, 'prompt': 'Logic-stem the library and write the MPL for each stem.',
         'created_at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()), 'bpm': src.get('bpm'), 'key': src.get('key'), 'song': src.get('song'), 'artist': src.get('artist'),
         'main': '0', 'stem': stem, 'audio': '%s/%s.m4a' % (KIT, stem), 'accuracy': acc}
    if extra: b.update(extra)
    b['slots'] = slots
    b['text'] = ['%s=%s;' % (s['name'], s['src']) for s in slots]
    return b


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('song_dir'); ap.add_argument('--mpl'); ap.add_argument('--also'); ap.add_argument('--out')
    a = ap.parse_args()
    song_dir = a.song_dir.rstrip('/'); base = os.path.basename(song_dir); kit = os.path.join(song_dir, KIT)
    # Flat layout (Bill 2026-11-23): stems, kit pieces and per-stem MPL all sit in the song folder. logic13/ is used only while it exists.
    if not os.path.isdir(kit): kit = song_dir
    pre = KIT + '/' if kit != song_dir else ''          # where those files are, relative to the song folder
    outdir = a.out or kit                               # --out: write the per-stem MPL files somewhere else
    main_mpl = os.path.join(song_dir, base + '_MPL.json')
    src = json.load(open(a.mpl or main_mpl))
    an = src['analysis']; spb, bpb = an['steps_per_beat'], an['beats_per_bar']; spbar = spb * bpb
    bt_s = np.array(an['beat_t']); bt = bt_s * ds.FPS; nbeats = len(bt) - 1; ns = nbeats * spb
    steps = (bt[:-1, None] + (bt[1:, None] - bt[:-1, None]) * np.arange(spb)[None, :] / spb).reshape(-1)
    step_t = np.append(steps / ds.FPS, bt_s[-1])
    tol = 0.5 * float(np.median(np.diff(bt))) / spb
    nbar = -(-nbeats // bpb); NS = nbar * spbar
    chunks = [(b0, min(nbar, b0 + CHUNK_BARS)) for b0 in range(0, nbar, CHUNK_BARS)]
    def six(stem):
        p = os.path.join(kit, stem + '.m4a')
        return (p, pre + stem + '.m4a') if os.path.isfile(p) else (os.path.join(song_dir, stem + '.m4a'), stem + '.m4a')
    out = {}; files = {}

    # ── the six drum pieces
    on = {}
    for key, _suf, (lo, hi), _cols in ks.PIECES:
        p = os.path.join(kit, key + '.m4a')
        on[key] = ks.piece_onsets(p, lo, hi) if os.path.isfile(p) else []
    on = ks.drop_bleed(on)
    def nearest(p):
        j = int(np.searchsorted(steps, p))
        return min((k for k in (j - 1, j) if 0 <= k < ns), key=lambda k: abs(steps[k] - p), default=None)
    d = [o[0] - steps[nearest(o[0])] for k in ('kick', 'snare') for o in on[k] if nearest(o[0]) is not None]
    d = [v for v in d if abs(v) <= tol]
    shift = float(np.median(d)) if len(d) >= 8 else 0.0
    shift_ms = round(1000 * shift / ds.FPS, 1)
    nv = len(ds.VOICES); TP = FP = FN = 0
    cen = [o[3] for o in on['percussion']]; pc = float(np.median(cen)) if cen else 0.0
    perc_note, perc_name = ('F#+', 'tambourine') if pc > 5000 else ('D#', 'hand clap') if pc > 1200 else ('E++', 'low conga')
    for key, _suf, _band, cols in ks.PIECES:
        ev = on[key]
        if not os.path.isfile(os.path.join(kit, key + '.m4a')): continue
        A = np.zeros((NS, nv), dtype=bool); G = np.zeros(NS, dtype=bool)
        med = float(np.median([o[1] for o in ev])) if ev else 0.0
        for p, lev, lowf, _c in ev:
            c = nearest(p - shift)
            if c is None or abs(steps[c] - (p - shift)) > tol: continue
            col = cols[0] if len(cols) == 1 else cols[0 if lowf < 100 else 1 if lowf < 160 else 2]
            A[c, ds.VOICES.index(col)] = True
            if key == 'snare' and lev < med - 9: G[c] = True
        hit = np.where(A[:ns].any(axis=1))[0]
        if not len(hit):
            out[key] = {'accuracy': None, 'empty': True, 'hits': len(ev), 'notes': 0}; continue
        notes_f = steps[hit]; ons_f = np.array(sorted(o[0] - shift for o in ev))
        tp = match(notes_f, ons_f, MATCH_S * ds.FPS); fp = len(notes_f) - tp; fn = len(ons_f) - tp
        TP += tp; FP += fp; FN += fn
        pct = round(100 * 2 * tp / (2 * tp + fp + fn))
        x = ds.load(os.path.join(kit, key + '.m4a')); e = x.astype(np.float64) ** 2; mask = np.zeros(len(x), dtype=bool)
        for f in notes_f + shift:
            t = f / ds.FPS; mask[max(0, int((t - 0.015) * ds.SR)):int((t + 0.15) * ds.SR)] = True
        acc = {'accuracy': pct, 'letter': letter(pct), 'measure': 'hits within 30 ms', 'hits': len(ons_f), 'notes': len(notes_f), 'matched': tp, 'extra': fp, 'missed': fn,
               'energy_covered': round(100 * float(e[mask].sum() / (e.sum() + 1e-12)))}
        what = {'kick': 'Kick (C)', 'snare': 'Snare (D)', 'hihat': 'Hi-hat (F#, closed)', 'toms': 'Toms (F, B, D+)', 'cymbals': 'Cymbals (C#+ crash, D#+ ride)', 'percussion': 'Percussion (%s, %s)' % (perc_note, perc_name)}[key]
        rows = []
        for i, (b0, b1) in enumerate(chunks):
            Ac = A[b0 * spbar:b1 * spbar].reshape(b1 - b0, spbar, nv); Gc = G[b0 * spbar:b1 * spbar].reshape(b1 - b0, spbar)
            if Ac.any():
                t, dd = ds.bars_mpl(Ac, Gc, spb, bpb); body = dd + '(' + t + ')'
                if key == 'cymbals' and Ac.sum() > (b1 - b0) * bpb: body = body.replace('C#+', 'D#+')
                if key == 'percussion': body = body.replace('F#', perc_note)
            else: body = ds.rest_bars(b1 - b0, bpb)
            rows.append(('%s_%02d' % (key, i + 1), 'm10,' + body, [b0 + 1, b1]))
        out[key] = dict(acc, mpl=pre + key + '_MPL.json', audio=pre + key + '.m4a')
        ex = {'offset_ms': int(round(shift_ms))} if int(round(shift_ms)) else None
        files[key] = bank(src, base, key, what, 10, rows, acc, ex)
    drums = None
    if TP + FP + FN:
        p = round(100 * 2 * TP / (2 * TP + FP + FN)); drums = {'accuracy': p, 'letter': letter(p), 'matched': TP, 'extra': FP, 'missed': FN}

    # ── the pitched stems
    def chroma_score(stem, M):
        """M: (nbeats, 12) what the MPL plays in each beat. Against what is heard in each beat."""
        x = drumlabel.load(six(stem)[0])
        if len(x) < drumlabel.LSR: return None
        C = drumlabel.beat_chroma(x, drumlabel.LSR, bt_s); rms = drumlabel.beat_rms(x, drumlabel.LSR, bt_s)
        ref = np.percentile(rms, 95)
        heard = (rms > 0.12 * ref) if ref >= 0.004 else np.zeros(nbeats, dtype=bool)
        played = M.sum(axis=1) > 0
        act = heard | played
        if not act.any(): return None
        num = (C * M).sum(axis=1); den = np.linalg.norm(C, axis=1) * np.linalg.norm(M, axis=1)
        s = np.where(heard & played & (den > 0), num / np.maximum(den, 1e-9), 0.0)
        return round(100 * float(s[act].mean())), int(heard.sum()), int(played.sum())
    for stem in ('vocals', 'bass', 'guitar', 'piano', 'other'):
        p, rel = six(stem)
        if not os.path.isfile(p): continue
        M = np.zeros((nbeats, 12)); rows = []; notes = 0
        if stem in ss.MONO:
            fmin, fmax, lo_m, hi_m = ss.MONO[stem]
            S = ss.mono_steps(ds.load(p), step_t, fmin, fmax, lo_m, hi_m)
            if (S >= 0).sum() >= 8:
                if stem == 'bass': S = np.where(S >= 0, S + 12 * ss.BASS_UP, S)
                octv = int(np.clip(round((float(np.median(S[S >= 0])) - 42) / 12.0), -2, 3)); cur = -1
                for k in range(ns):
                    if S[k] >= 0: cur = S[k]; notes += 1
                    elif S[k] == ss.REST: cur = -1
                    if cur >= 0: M[k // spb, cur % 12] += 1
                Sp = np.concatenate([S, np.full(NS - ns, ss.REST, dtype=int)])
                for i, (b0, b1) in enumerate(chunks):
                    t = ss.mono_mpl(Sp[b0 * spbar:b1 * spbar], spb, octv)
                    rows.append(('%s_%02d' % (stem, i + 1), 'm%d,%s' % (CHANNEL[stem], t if t else ds.rest_bars(b1 - b0, bpb)), [b0 + 1, b1]))
            what = 'One note at a time'
        else:
            Cb = ss.chord_beats(drumlabel.load(p), bt_s)
            if (Cb >= 0).sum() >= 4:
                for k in np.where(Cb >= 0)[0]:
                    r = Cb[k] // 2; notes += 1
                    for iv in (0, 3 if Cb[k] % 2 else 4, 7): M[k, (r + iv) % 12] += 1
                Cp = np.concatenate([Cb, np.full(nbar * bpb - nbeats, ss.REST, dtype=int)])
                for i, (b0, b1) in enumerate(chunks):
                    t = ss.chord_mpl(Cp[b0 * bpb:b1 * bpb].reshape(b1 - b0, bpb), bpb, ss.CHORD_OCT[stem])
                    rows.append(('%s_%02d' % (stem, i + 1), 'm%d,%s' % (CHANNEL[stem], t if t else ds.rest_bars(b1 - b0, bpb)), [b0 + 1, b1]))
            what = 'One chord per beat'
        sc = chroma_score(stem, M)
        if not rows or sc is None:
            out[stem] = {'accuracy': None, 'empty': True, 'notes': 0}; continue
        acc = {'accuracy': sc[0], 'letter': letter(sc[0]), 'measure': 'pitch classes, beat by beat', 'notes': notes, 'beats_heard': sc[1], 'beats_played': sc[2]}
        out[stem] = dict(acc, mpl=pre + stem + '_MPL.json', audio=rel)
        ex = {'stems': {stem: src['stems'][stem]}} if stem in (src.get('stems') or {}) else None
        files[stem] = bank(src, base, stem, what, CHANNEL[stem], rows, acc, ex)

    os.makedirs(outdir, exist_ok=True)
    for stem, b in files.items():
        b['audio'] = out[stem]['audio']; b['description'] = b['description'].replace('%s/%s.m4a' % (KIT, stem), b['audio'])
        ds.dump_bank(b, os.path.join(outdir, stem + '_MPL.json'))
    block = {'made_by': 'stemscribe.py', 'date': time.strftime('%Y-%m-%d'), 'stems_from': 'Logic Pro 13 Stem Splitter, Individual Kit Pieces (%s)' % (pre or 'in the song folder'),
             'about': 'Each stem written out as MPL for the whole song, every note where it was found (no loops), in %s<stem>_MPL.json. accuracy is a percentage: drum pieces, '
                      'the MPL hits against the hits in the stem matched within 30 ms; vocals, bass, guitar, piano, other, the pitch classes the MPL plays against those heard, beat by beat. '
                      'Letters: A 90+, B 80-90, C 70-80, D 60-70, F below. empty: Logic found nothing for that stem.' % pre,
             'grid_shift_ms': shift_ms, 'drums': drums, 'stems': out}
    wrote = []
    # the song's MPL file as read, plus the block; written to the song folder and to any second copy (the gig cache)
    cur = dict(src); cur['logic13'] = block
    for path in [main_mpl] + ([a.also] if a.also else []):
        try: ds.dump_bank(cur, path); wrote.append(path)
        except Exception as e: print('COULD NOT UPDATE', path, repr(e)[:120], file=sys.stderr)
    print(json.dumps({'song': base, 'files': len(files), 'updated': len(wrote), 'shift_ms': shift_ms, 'drums': drums and drums['accuracy'],
                      'acc': {k: (v.get('accuracy'), v.get('energy_covered')) if 'energy_covered' in v else v.get('accuracy') for k, v in out.items()}}))


if __name__ == '__main__':
    main()
