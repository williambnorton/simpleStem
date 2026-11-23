#!/usr/bin/env python3
"""Run drumscribe over a library: one <folder>_MPL.json beside each song.

  python3 drumscribe_all.py --stems <dir of <folder>/drums.m4a> --songs <dir of <folder>/metadata.json>
                            [--out <dir, default = --songs>] [--only a,b] [--skip-existing] [--report file.json] [--expect file.json] [--midi]
                            [--beats [--copy <dir>]]

--stems and --songs can be the same folder. The bank is written to <out>/<folder>/<folder>_MPL.json;
--midi also writes <folder>_MPL.mid (tempo map, section markers, detected and MPL drum tracks) for Logic.
--beats leaves each existing file as it is and only adds analysis.beat_t (the recording's beat times), after
checking that the drum stem still measures to the same whole-song string; --copy also writes the result to
<dir>/<folder>/<folder>_MPL.json (the Performer's offline cache).
"""
import argparse, datetime, json, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drumscribe as ds


def stamp():
    return datetime.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stems'); ap.add_argument('--songs', required=True); ap.add_argument('--out')
    ap.add_argument('--only'); ap.add_argument('--skip-existing', action='store_true')
    ap.add_argument('--report'); ap.add_argument('--expect'); ap.add_argument('--midi', action='store_true'); ap.add_argument('--upgrade', action='store_true')
    ap.add_argument('--beats', action='store_true'); ap.add_argument('--copy')
    a = ap.parse_args()
    out = a.out or a.songs
    names = sorted(d for d in os.listdir(a.songs) if os.path.isfile(os.path.join(a.songs, d, 'metadata.json')))
    if a.upgrade:                                           # no audio: add the per-stem places to files already written
        n = 0
        for name in names:
            dest = os.path.join(out, name, name + '_MPL.json')
            if not os.path.isfile(dest): continue
            bank = ds.add_stem_slots(json.load(open(dest)))
            ds.dump_bank(bank, dest); n += 1
        print('%s  drumscribe_all  upgraded %d files' % (stamp(), n)); return 0
    if a.only: names = [n for n in names if n in set(a.only.split(','))]
    report, expect = [], {}
    t0 = time.time(); now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for i, name in enumerate(names):
        dest = os.path.join(out, name, name + '_MPL.json')
        rec = {'folder': name}
        try:
            if a.skip_existing and os.path.exists(dest):
                rec['status'] = 'kept'; report.append(rec); continue
            src = next((p for p in (os.path.join(a.stems, name, 'logic', 'drums.m4a'), os.path.join(a.stems, name, 'drums.m4a')) if os.path.isfile(p)), None)
            if not src: raise RuntimeError('no drums.m4a')
            m = json.load(open(os.path.join(a.songs, name, 'metadata.json')))
            meta = {'folder': name, 'title': m.get('title') or name, 'artist': m.get('artist') or '', 'bpm': m.get('bpm'),
                    'sections': [x.get('t') for x in (m.get('sections') or []) if isinstance(x, dict) and x.get('t') is not None]}
            if a.beats:                                     # add the beat times, change nothing else
                if not os.path.isfile(dest): rec['status'] = 'no file'; report.append(rec); continue
                bank = json.load(open(dest))
                r = ds.analyze(src, meta)
                if r['whole']['src'] != bank['slots'][0]['src']:
                    rec['status'] = 'differs'; report.append(rec); continue
                bank.setdefault('analysis', {}).update(ds.beat_times(r))
                ds.dump_bank(bank, dest)
                if a.copy:
                    os.makedirs(os.path.join(a.copy, name), exist_ok=True)
                    ds.dump_bank(bank, os.path.join(a.copy, name, name + '_MPL.json'))
                rec.update({'status': 'ok', 'beats': len(bank['analysis']['beat_t']) - 1}); report.append(rec); continue
            r = ds.analyze(src, meta, stem_dir=os.path.dirname(src))
            if r.get('label_error'): rec['label_error'] = r['label_error']
            bank = ds.make_bank(meta, r, now)
            if a.expect is not None:
                expect[name] = {s['name']: {'src': s['src'], 'expect': e} for s, e in
                                zip(bank['slots'], [r['whole']['expect']] + [x['expect'] for x in r['rows']])}
                expect[name]['_beats'] = {bank['slots'][0]['name']: r['whole']['beats'], **{s['name']: x['beats'] for s, x in zip(bank['slots'][1:], r['rows'])}}
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if a.midi: bank['analysis']['midi'] = ds.write_midi(os.path.join(out, name, name + '_MPL.mid'), r, meta['title'])
            ds.dump_bank(bank, dest)
            g = r['whole']['grade']
            rec.update({'status': 'ok', 'title': meta['title'], 'artist': meta['artist'], 'bpm': r['bpm'], 'meta_bpm': r['meta_bpm'],
                        'tempo_note': r['tempo_note'], 'meter': r['beats_per_bar'], 'grid': r['steps_per_beat'], 'grid_fit': r['grid_fit'],
                        'bars': r['bars'], 'sections': len(r['rows']), 'whole': g, 'whole_chars': len(r['whole']['src']),
                        'whole_plain': r['whole'].get('plain', False),
                        'section_pcts': [x['grade'].get('pct') for x in r['rows']],
                        'labels': [(x.get('label') or {}).get('label') for x in r['rows']],
                        'label_conf': [(x.get('label') or {}).get('confidence') for x in r['rows']]})
        except Exception as e:
            rec.update({'status': 'failed', 'error': str(e)[:200]})
            if os.environ.get('DRUMSCRIBE_TRACE'): traceback.print_exc()
        report.append(rec)
        if (i + 1) % 10 == 0 or i + 1 == len(names):
            el = time.time() - t0; eta = el / (i + 1) * (len(names) - i - 1)
            print('%s  drumscribe_all  %d/%d  ok %d  failed %d  ETA %d min' % (
                stamp(), i + 1, len(names), sum(1 for x in report if x['status'] == 'ok'),
                sum(1 for x in report if x['status'] == 'failed'), round(eta / 60)), flush=True)
    if a.report:
        with open(a.report, 'w') as f: json.dump(report, f, indent=1)
    if a.expect:
        with open(a.expect, 'w') as f: json.dump(expect, f)
    return 0


if __name__ == '__main__':
    sys.exit(main())
