#!/usr/bin/env python3
"""songpartscore.py — score the song MPL's pitched parts against their stems.

The song MPL (<song>_MPL.json) grades only its drum rows. This gives the other five parts (vocals, bass,
guitar, piano, other) a percentage with the measure stemscribe.py uses for the exact transcriptions
(logic13.stems.<stem>.accuracy): the pitch classes the part plays in each beat against those heard in the
stem in that beat, averaged over every beat where either is active. The notes are the ones the Performer
builds (songpartscore.js). Result: a "song_accuracy" block in the file, shown on the Performer's MPL buttons.

    python3 songpartscore.py STEMS_DIR [--write DIR ...] [--only NAME] [--seconds N] [--report FILE]

STEMS_DIR holds <song>/<song>_MPL.json and the stems (<stem>.m4a), e.g. ~/.bt-cache/STEMS. Each --write DIR
is a STEMS folder whose copy of the file gets the block (temp file, then rename). Without --write it only
reports. Songs already in the report are skipped, so a run cut short by --seconds can be continued.
"""
import argparse, json, os, subprocess, sys, time
from multiprocessing import Pool
import numpy as np
import drumlabel

STEMS = ('vocals', 'bass', 'guitar', 'piano', 'other')
HERE = os.path.dirname(os.path.abspath(__file__))


def letter(p):
    return 'A' if p >= 90 else 'B' if p >= 80 else 'C' if p >= 70 else 'D' if p >= 60 else 'F'


def played_matrix(events, bt):
    """(nbeats, 12): how long each pitch class sounds in each beat, in beats."""
    n = len(bt) - 1; M = np.zeros((n, 12)); idx = np.arange(len(bt), dtype=float)
    for t, ln, notes in events:
        b0, b1 = np.interp([t, t + max(ln, 0.01)], bt, idx)
        for k in range(max(0, int(b0)), min(n, int(np.ceil(b1)))):
            w = min(b1, k + 1) - max(b0, k)
            if w > 0:
                for m in notes: M[k, int(m) % 12] += w
    return M


def chroma_score(x, M, bt):
    """As stemscribe.chroma_score: (percent, beats heard, beats played), or None when nothing is heard or played."""
    if len(x) < drumlabel.LSR: return None
    n = len(bt) - 1
    C = drumlabel.beat_chroma(x, drumlabel.LSR, bt); rms = drumlabel.beat_rms(x, drumlabel.LSR, bt)
    ref = np.percentile(rms, 95)
    heard = (rms > 0.12 * ref) if ref >= 0.004 else np.zeros(n, dtype=bool)
    played = M.sum(axis=1) > 0
    act = heard | played
    if not act.any(): return None
    num = (C * M).sum(axis=1); den = np.linalg.norm(C, axis=1) * np.linalg.norm(M, axis=1)
    s = np.where(heard & played & (den > 0), num / np.maximum(den, 1e-9), 0.0)
    return round(100 * float(s[act].mean())), int(heard.sum()), int(played.sum())


def score_song(job):
    folder, built = job
    out = {'song': os.path.basename(folder), 'stems': {}}
    try:
        base = os.path.basename(folder)
        bank = json.load(open(os.path.join(folder, base + '_MPL.json')))
        bt = np.array((bank.get('analysis') or {}).get('beat_t') or [], dtype=float)
        if len(bt) < 4: out['error'] = 'no beat times'; return out
        for key in ('parts', 'exact'):
            for stem, ev in (built.get(key) or {}).items():
                p = os.path.join(folder, stem + '.m4a')
                if not ev or not os.path.isfile(p): continue
                sc = chroma_score(drumlabel.load(p), played_matrix(ev, bt), bt)
                if sc is None: continue
                rec = {'accuracy': sc[0], 'letter': letter(sc[0]), 'beats_heard': sc[1], 'beats_played': sc[2], 'notes': len(ev)}
                if key == 'parts': out['stems'][stem] = rec
                else: out.setdefault('exact', {})[stem] = rec
    except Exception as e:
        out['error'] = str(e)[:160]
    return out


def write_block(path, block):
    b = json.load(open(path))
    b['song_accuracy'] = block
    tmp = path + '.tmp_score'
    with open(tmp, 'w') as f: json.dump(b, f, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('stems_dir'); ap.add_argument('--write', action='append', default=[]); ap.add_argument('--only')
    ap.add_argument('--seconds', type=float, default=0); ap.add_argument('--report', default='songpartscore_report.json')
    ap.add_argument('--exact', action='store_true', help='also score the transcriptions beside the file (a check of the measure)')
    a = ap.parse_args()
    root = os.path.expanduser(a.stems_dir)
    rep = json.load(open(a.report)) if os.path.isfile(a.report) else {}
    songs = [d for d in sorted(os.listdir(root)) if os.path.isfile(os.path.join(root, d, d + '_MPL.json')) and (not a.only or a.only in d)]
    todo = [s for s in songs if s not in rep]
    files = '\n'.join(os.path.join(root, s, s + '_MPL.json') for s in todo)
    built = {}
    if todo:
        r = subprocess.run(['node', os.path.join(HERE, 'songpartscore.js')] + (['--exact'] if a.exact else []), input=files, capture_output=True, text=True)
        for line in r.stdout.splitlines():
            j = json.loads(line); built[os.path.basename(os.path.dirname(j['file']))] = j
    t0 = time.time(); done = 0
    block_of = lambda r: {'made_by': 'songpartscore.py', 'date': time.strftime('%Y-%m-%d'),
                          'about': "The song MPL's pitched parts against their stems: the pitch classes a part plays in each beat against those heard in the stem, "
                                   "averaged over every beat where either is active (the measure of logic13.stems.<stem>.accuracy). Drums: see grade.",
                          'stems': r['stems']}
    with Pool(4) as pool:
        for r in pool.imap_unordered(score_song, [(os.path.join(root, s), built.get(s, {})) for s in todo]):
            if not r.get('error'):
                for d in a.write:
                    p = os.path.join(os.path.expanduser(d), r['song'], r['song'] + '_MPL.json')
                    try: write_block(p, block_of(r))
                    except Exception as e: r.setdefault('write_failed', []).append('%s: %s' % (d, str(e)[:80]))
            rep[r['song']] = r; done += 1
            if done % 20 == 0:
                json.dump(rep, open(a.report, 'w'))
                print('%s songpartscore %d/%d' % (time.strftime('%H:%M:%S %Z'), len(rep), len(songs)), flush=True)
            if a.seconds and time.time() - t0 > a.seconds: pool.terminate(); break
    json.dump(rep, open(a.report, 'w'))
    print(json.dumps({'songs': len(songs), 'scored': len(rep), 'remaining': len(songs) - len(rep), 'errors': sum(1 for r in rep.values() if r.get('error')),
                      'write_failed': sum(1 for r in rep.values() if r.get('write_failed'))}))


if __name__ == '__main__':
    main()
