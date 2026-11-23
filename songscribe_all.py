#!/usr/bin/env python3
"""Run songscribe over a library: <folder>_MPL.json (the song as MPL: song = sections, section = parts) beside each song.

  python3 songscribe_all.py --stems <dir of <folder>/*.m4a> --songs <dir of <folder>/metadata.json>
                            [--out <dir, default = --songs>] [--copy <dir>] [--only a,b] [--midi] [--report file.json]

--copy also writes the file to <dir>/<folder>/ (the Performer's offline cache); --midi also writes <folder>_MPL.mid for Logic.
"""
import argparse, datetime, json, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drumscribe as ds
import songscribe as ss


def stamp():
    return datetime.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stems', required=True); ap.add_argument('--songs', required=True); ap.add_argument('--out'); ap.add_argument('--copy')
    ap.add_argument('--only'); ap.add_argument('--report'); ap.add_argument('--midi', action='store_true')
    a = ap.parse_args()
    out = a.out or a.songs
    names = sorted(d for d in os.listdir(a.songs) if os.path.isfile(os.path.join(a.songs, d, 'metadata.json')))
    if a.only: names = [n for n in names if n in set(a.only.split(','))]
    report = []; t0 = time.time(); now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for i, name in enumerate(names):
        rec = {'folder': name}
        try:
            m = json.load(open(os.path.join(a.songs, name, 'metadata.json')))
            meta = {'folder': name, 'title': m.get('title') or name, 'artist': m.get('artist') or '', 'bpm': m.get('bpm'), 'key': m.get('key') or '',
                    'sections': [x.get('t') for x in (m.get('sections') or []) if isinstance(x, dict) and x.get('t') is not None]}
            bank, r = ss.make_song(os.path.join(a.stems, name), meta, now)
            os.makedirs(os.path.join(out, name), exist_ok=True)
            if a.midi: bank['analysis']['midi'] = ds.write_midi(os.path.join(out, name, name + '_MPL.mid'), r, meta['title'])
            ds.dump_bank(bank, os.path.join(out, name, name + '_MPL.json'))
            if a.copy:
                os.makedirs(os.path.join(a.copy, name), exist_ok=True)
                ds.dump_bank(bank, os.path.join(a.copy, name, name + '_MPL.json'))
            g = bank['grade']
            rec.update({'status': 'ok', 'title': meta['title'], 'artist': meta['artist'], 'grade': g.get('letter'), 'pct': g.get('pct'), 'rows': len(bank['slots']),
                        'sections': len(bank['sections']), 'defs': sum(1 for s in bank['slots'] if s['role'] == 'section'), 'phrases': sum(1 for s in bank['slots'] if s['role'] == 'phrase'),
                        'parts': {st: sum(1 for s in bank['slots'] if s.get('stem') == st) for st in ds.STEM_ORDER},
                        'longest_row': max(len(s['src']) for s in bank['slots']), 'song': bank['slots'][0]['name'], 'src': bank['slots'][0]['src']})
        except Exception as e:
            rec.update({'status': 'failed', 'error': str(e)[:200]})
            if os.environ.get('DRUMSCRIBE_TRACE'): traceback.print_exc()
        report.append(rec)
        el = time.time() - t0; eta = el / (i + 1) * (len(names) - i - 1)
        print('%s  songscribe_all  %d/%d  ok %d  failed %d  ETA %d min' % (stamp(), i + 1, len(names), sum(1 for x in report if x['status'] == 'ok'),
                                                                         sum(1 for x in report if x['status'] == 'failed'), round(eta / 60)), flush=True)
    if a.report:
        with open(a.report, 'w') as f: json.dump(report, f, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
