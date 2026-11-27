#!/usr/bin/env python3
"""lyricplace.py — place a song's lyric lines on its timeline from the vocal stem.

For every song that has lyrics and no lyric line placed yet: speech recognition (faster-whisper) gives the words
heard in vocals.m4a with their times; the lyric words are matched to them in order; each line starts at its first
matched word, pulled back to the start of the sung phrase it belongs to (the stem's level rising after quiet),
and shown LEAD seconds early. Lines nothing was matched for take the free phrase starts between their neighbours.
The result is the same lyric-line actions the Performer's Place Lyrics button writes into metadata.json.

A song is written only when its confidence (the share of lines timed by one of their own words) reaches
--min-confidence: measured against 21 songs placed by hand, songs at 0.85 or more had 87% of their lines within
2 s of the hand placement, songs below it 53-71%.

    python3 lyricplace.py STEMS_DIR --cache ~/.bt-cache/STEMS --model MODEL_DIR [--write] [--only NAME]
                          [--min-confidence 0.85] [--work DIR] [--seconds N]

STEMS_DIR: the song folders with metadata.json (Drive). --cache: where vocals.m4a is read from. --model: a
faster-whisper model folder or name (small.en was used). --work: recognition results are kept there, so a run cut
short by --seconds is continued by the next one; the report (lyricplace_report.json) and, with --write, a copy of
every metadata.json before it is changed (backup/) go there too. Without --write nothing is changed.
Needs: pip install faster-whisper numpy; ffmpeg.
"""
import argparse, os, sys, time
import re, json, subprocess, difflib
import numpy as np
norm = lambda w: re.sub(r"[^a-z0-9]", '', w.lower().replace("'", ''))
WEAK = set('the a an and of to in it its i you oh but so that my we he she they is on for with'.split())
LEAD = 0.3                # a line appears this long before it is sung

def lyric_lines(text):
    return [s.strip() for s in (text or '').splitlines() if s.strip() and not re.match(r'^\[.*\]$', s.strip())]

def phrase_onsets(path):
    """Start times (s) of the sung phrases in a vocal stem: where its level rises after at least half a second of quiet."""
    x = np.frombuffer(subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], capture_output=True).stdout, dtype=np.int16).astype(float) / 32768
    h = 400; n = len(x) // h                                 # 50 ms frames
    if n < 20: return []
    r = np.sqrt((x[:n * h].reshape(n, h) ** 2).mean(1)); act = r > 0.08 * np.percentile(r, 98)
    on = []; quiet = 99
    for i, a in enumerate(act):
        if a:
            if quiet >= 10 and act[i:i + 4].sum() >= 3: on.append(i * h / 8000)
            quiet = 0
        else: quiet += 1
    return on

def sim(a, b):
    if a == b: return 2.0
    if len(a) >= 4 and len(b) >= 4 and (a.startswith(b) or b.startswith(a) or difflib.SequenceMatcher(None, a, b).ratio() >= 0.75): return 1.0
    return -1.0

def word_times(a, b):
    """Global alignment of the lyric words a with the recognised words b (in order, gaps allowed). Returns for each a: index in b or None."""
    n, m = len(a), len(b); GAP = -0.4
    S = np.zeros((n + 1, m + 1)); B = np.zeros((n + 1, m + 1), dtype=np.int8)
    S[1:, 0] = GAP * np.arange(1, n + 1); B[1:, 0] = 1; B[0, 1:] = 2          # leading recognised words cost nothing
    for i in range(1, n + 1):
        ai = a[i - 1]
        for j in range(1, m + 1):
            d = S[i - 1, j - 1] + sim(ai, b[j - 1]); u = S[i - 1, j] + GAP; l = S[i, j - 1] + (GAP if i < n else 0)
            if d >= u and d >= l: S[i, j] = d; B[i, j] = 0
            elif u >= l: S[i, j] = u; B[i, j] = 1
            else: S[i, j] = l; B[i, j] = 2
    out = [None] * n; i, j = n, m
    while i > 0 and j > 0:
        if B[i, j] == 0:
            if sim(a[i - 1], b[j - 1]) > 0: out[i - 1] = j - 1
            i -= 1; j -= 1
        elif B[i, j] == 1: i -= 1
        else: j -= 1
    return out

def confidence(out):
    """Share of the lines whose time comes from a recognised word of that line."""
    return sum(1 for o in out if o['how'].startswith('word')) / max(1, len(out))

def align(lines, words, onsets=()):
    """words: [[start, end, text, prob], ...]. Returns one dict per line: t (seconds, None when nothing anchors it), how, hits, n."""
    lw = [(i, norm(w)) for i, l in enumerate(lines) for w in l.split() if norm(w)]
    rw = [(w[0], norm(w[2])) for w in words if norm(w[2])]
    idx = word_times([w for _, w in lw], [w for _, w in rw]) if lw and rw else [None] * len(lw)
    wt = [rw[k][0] if k is not None else None for k in idx]
    onsets = np.array(sorted(onsets)); out = []; pos = 0
    for i, l in enumerate(lines):
        ws = [w for j, w in lw if j == i]; n = len(ws); ts = wt[pos:pos + n]; pos += n
        got = [(k, t) for k, t in enumerate(ts) if t is not None]
        t = None; how = 'none'
        if got:
            k, t = got[0]
            # a weak first word ("the", "and") is often timed with the phrase before: trust the next word instead
            if len(got) > 1 and ws[k] in WEAK and got[1][1] - t > 1.2 + 0.4 * (got[1][0] - k): k, t = got[1]
            t = t - 0.35 * k; how = 'word %d' % (k + 1)
            if len(onsets):                                   # the phrase this word belongs to starts a little earlier
                c = onsets[(onsets <= t + 0.4) & (onsets >= t - 1.0 - 0.4 * k)]
                if len(c): t = float(c[-1]); how += ', phrase'
        out.append({'line': l, 't': None if t is None else max(0.0, t), 'how': how, 'hits': len(got), 'n': n})
    # a time that runs backwards against its neighbours is not an anchor
    anch = [i for i, o in enumerate(out) if o['t'] is not None]
    keep = []
    for i in anch:
        while keep and out[keep[-1]]['t'] >= out[i]['t'] and out[keep[-1]]['hits'] < out[i]['hits']: out[keep.pop()]['t'] = None
        if keep and out[keep[-1]]['t'] >= out[i]['t']: out[i]['t'] = None
        else: keep.append(i)
    # lines nothing anchored: the free phrase onsets between their anchored neighbours, in order; else spread evenly
    used = set(round(out[i]['t'], 2) for i in keep)
    i = 0
    while i < len(out):
        if out[i]['t'] is not None: i += 1; continue
        j = i
        while j < len(out) and out[j]['t'] is None: j += 1
        lo = out[i - 1]['t'] if i > 0 else None; hi = out[j]['t'] if j < len(out) else None
        if lo is not None and hi is not None:
            free = [float(p) for p in onsets if lo + 0.8 < p < hi - 0.5 and round(float(p), 2) not in used]
            k = j - i
            if len(free) >= k:
                pick = free[:k] if len(free) == k else [free[int(round(q))] for q in np.linspace(0, len(free) - 1, k)]
                for q, o in zip(pick, out[i:j]): o['t'] = q; o['how'] = 'free phrase'
            else:
                for q, o in enumerate(out[i:j]): o['t'] = lo + (hi - lo) * (q + 1) / (k + 1); o['how'] = 'between'
        elif k_run := (j - i):                                # a run at the very start or end: the phrases heard there, else the song's usual line spacing
            got = [o['t'] for o in out if o['t'] is not None]
            gap = float(np.median(np.diff(got))) if len(got) > 2 else 4.0
            if hi is None and lo is not None:
                free = [float(p) for p in onsets if p > lo + 0.8][:k_run]
                for q, o in enumerate(out[i:j]): o['t'] = free[q] if q < len(free) else (free[-1] if free else lo) + gap * (q - len(free) + 1); o['how'] = 'free phrase' if q < len(free) else 'guess'
            elif lo is None and hi is not None:
                free = [float(p) for p in onsets if p < hi - 0.5][-k_run:]
                for q, o in enumerate(out[i:j]):
                    r = q - (k_run - len(free))
                    o['t'] = free[r] if r >= 0 else max(0.0, (free[0] if free else hi) - gap * (-r)); o['how'] = 'free phrase' if r >= 0 else 'guess'
        i = j
    last = -1.0
    for o in out:
        if o['t'] is None: continue
        o['t'] = round(max(o['t'] - LEAD, 0.0), 3)
        if o['t'] <= last: o['t'] = round(last + 0.3, 3)
        last = o['t']
    return out


def recognise(model, path):
    segs, info = model.transcribe(path, language='en', word_timestamps=True, vad_filter=True, vad_parameters=dict(min_silence_duration_ms=400),
                                  condition_on_previous_text=False, beam_size=3, temperature=0.0)
    return {'duration': info.duration, 'words': [[round(w.start, 3), round(w.end, 3), w.word.strip(), round(w.probability, 3)] for s in segs for w in (s.words or [])]}

def lyric_events(out):
    return [{'t': o['t'], 'type': 'lyric-line', 'label': o['line'] if len(o['line']) <= 30 else o['line'][:28] + '\u2026', 'text': o['line'], 'mode': 'replace'} for o in out]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('stems_dir'); ap.add_argument('--cache', required=True); ap.add_argument('--model', default='small.en'); ap.add_argument('--work', default='lyricplace_work')
    ap.add_argument('--only'); ap.add_argument('--min-confidence', type=float, default=0.85); ap.add_argument('--write', action='store_true'); ap.add_argument('--seconds', type=float, default=0)
    a = ap.parse_args()
    root = os.path.expanduser(a.stems_dir); cache = os.path.expanduser(a.cache); work = os.path.expanduser(a.work)
    os.makedirs(work + '/asr', exist_ok=True); os.makedirs(work + '/backup', exist_ok=True)
    rp = work + '/lyricplace_report.json'; rep = json.load(open(rp)) if os.path.isfile(rp) else {}
    t0 = time.time(); model = None
    for s in sorted(os.listdir(root)):
        mp = os.path.join(root, s, 'metadata.json')
        if (a.only and a.only not in s) or not os.path.isfile(mp) or (rep.get(s) or {}).get('written'): continue
        if a.seconds and time.time() - t0 > a.seconds: break
        try:
            meta = json.load(open(mp)); lines = lyric_lines(meta.get('lyrics'))
            auto = meta.get('automation') or []
            if not lines or any(e.get('type') == 'lyric-line' for e in auto): continue          # no lyrics, or lines are placed already: never touched
            vp = os.path.join(cache, s, 'vocals.m4a'); ap_ = work + '/asr/' + s + '.json'
            if not os.path.isfile(vp): rep[s] = {'skipped': 'no vocals.m4a'}; continue
            if not os.path.isfile(ap_):
                if model is None:
                    from faster_whisper import WhisperModel
                    model = WhisperModel(a.model, device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 4)
                json.dump(recognise(model, vp), open(ap_, 'w'))
            asr = json.load(open(ap_))
            if 'words' not in asr: rep[s] = {'skipped': 'recognition failed'}; continue
            out = align(lines, asr['words'], phrase_onsets(vp))
            conf = round(confidence(out), 2)
            ok = conf >= a.min_confidence and all(o['t'] is not None for o in out) and out[-1]['t'] < asr.get('duration', 1e9)   # a line after the end of the song: not trusted
            r = rep[s] = {'lines': len(lines), 'confidence': conf, 'first': out[0]['t'], 'last': out[-1]['t'], 'guessed': sum(1 for o in out if o['how'] == 'guess'), 'placed': ok}
            if ok and a.write:
                meta = json.load(open(mp))                                                    # read again: the Performer rewrites this file (play counts)
                if any(e.get('type') == 'lyric-line' for e in (meta.get('automation') or [])): r['placed'] = False; r['skipped'] = 'placed meanwhile'; continue
                with open(os.path.join(work, 'backup', s + '.metadata.json'), 'w') as f: json.dump(meta, f, ensure_ascii=False, indent=1)
                meta['automation'] = sorted((meta.get('automation') or []) + lyric_events(out), key=lambda e: e.get('t', 0))
                meta['lyrics_placed'] = {'by': 'lyricplace.py', 'date': time.strftime('%Y-%m-%d'), 'model': os.path.basename(str(a.model).rstrip('/')), 'confidence': conf, 'lines': len(lines)}
                tmp = mp + '.tmp_lyricplace'
                with open(tmp, 'w') as f: f.write(json.dumps(meta, ensure_ascii=False, indent=2) + '\n')     # as the Performer writes it
                os.replace(tmp, mp); r['written'] = True
        except Exception as e:
            rep[s] = {'error': str(e)[:160]}
        json.dump(rep, open(rp, 'w'))
    json.dump(rep, open(rp, 'w'))
    v = [x for x in rep.values() if 'confidence' in x]
    print(json.dumps({'songs_with_lyrics_to_place': len(v), 'confident': sum(1 for x in v if x['placed']), 'below_threshold': sum(1 for x in v if not x['placed']),
                      'written': sum(1 for x in v if x.get('written')), 'errors': sum(1 for x in rep.values() if 'error' in x), 'skipped': sum(1 for x in rep.values() if 'skipped' in x)}))


if __name__ == '__main__':
    main()
