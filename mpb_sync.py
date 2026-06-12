#!/usr/bin/env python3
"""mpb_sync.py — sync the Mitchell Park Band Songlist Google Sheet into simpleStem.

Pulls the master songlist and the per-gig sheet tabs as CSVs via the public
gviz endpoint, then:

  1. Matches each master-list row to a STEMS/<slug>/ folder by normalized
     title + artist. Updates that song's metadata.json with the four fields
     the band already keeps in the Sheet:
         singer_raw, singer_lead, singer_backup, singer_group_vocal
         drum_pattern
         band_required   (list, e.g. ["Bill","Matt","Dan"])
         readiness       ("InTheCan" / "Rehearse" / "tbd")

  2. For each gig tab, splits songs into setlists at Seq=N00 boundaries,
     pulls the block titles from divider rows ("5:50PM Mid Rally Set", "Break",
     "Encore", "On Cores", etc.), matches each song to a STEMS folder, and
     writes GIGS/<gig_slug>.json.

  3. Writes LOGS/mpb_sync_report.json with stats + unmatched rows for triage.
     NEVER auto-creates new STEMS dirs and NEVER enqueues renders.

Source-of-truth model: the Google Sheet wins. Re-running the script overwrites
the MPB fields in each matched metadata.json. Other metadata fields (bpm, key,
sectionCandidates, automation, …) are NOT touched.

Sheet requirement: must be shared as "Anyone with the link can view" so the
gviz endpoint returns CSV without OAuth.

Usage:
    mpb_sync.py                  # full sync (master + gigs + report)
    mpb_sync.py --master-only    # skip the gig parsing
    mpb_sync.py --dry-run        # parse + match, don't write metadata or gigs
    mpb_sync.py --root DIR       # override the simpleStem root
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

CONFIG_NAME = "mpb_sync_config.json"
GVIZ_URL = ("https://docs.google.com/spreadsheets/d/{sheet_id}"
            "/gviz/tq?tqx=out:csv&sheet={sheet_name}")
FUZZY_THRESHOLD = 0.88   # below this we won't claim a fuzzy title match


# ---------- root + config ----------

def default_root():
    env = os.environ.get("SIMPLE_STEM_ROOT")
    return Path(env) if env else Path.home() / "ClaudeDrive" / "simpleStem"


def load_config(script_dir):
    p = script_dir / CONFIG_NAME
    if not p.exists():
        sys.exit(f"!! missing {p}; edit {CONFIG_NAME} with your sheet_id + tabs")
    return json.loads(p.read_text())


# ---------- fetch ----------

def fetch_csv(sheet_id, sheet_name):
    url = GVIZ_URL.format(sheet_id=sheet_id,
                          sheet_name=urllib.parse.quote(sheet_name))
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8")
    except Exception as e:
        raise RuntimeError(f"fetch failed for '{sheet_name}': {e}")


# ---------- normalization + matching ----------

def norm_key(s):
    """Aggressive normalize for fuzzy matching.
    Strips parentheticals, lowercases, drops 'the' anywhere (word-boundary),
    then drops all non-alphanumerics. Maps 'AC/DC' and 'ACDC' to the same
    key, and 'The Kinks' to the same key as 'Kinks'.
    """
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"\([^)]*\)", "", s)
    # Replace separators with spaces first so \bthe\b fires even when 'the'
    # is sandwiched between underscores in a slug like "Sun_The_Beatles".
    s = re.sub(r"[_\-/\.]", " ", s)
    s = re.sub(r"\bthe\b", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    return s


def match_key(title, artist):
    return f"{norm_key(title)}::{norm_key(artist or '')}"


def build_stems_index(stems_dir):
    """Return ({match_key: slug}, {title_only_key: [slugs]}, {slug: artist_norm},
                {concat_key: slug}).

    `by_concat` is a fallback for songs whose metadata.json is missing (so we
    don't know title vs artist). The slug itself encodes
    `<TitleWords>_<ArtistWords>`, so once we strip underscores and case we
    get the same string as `norm_key(title) + norm_key(artist)` from the
    Sheet row — which is exactly what the match function will look up.
    """
    by_full = {}
    by_title = {}
    artist_of = {}
    by_concat = {}
    if not stems_dir.exists():
        return by_full, by_title, artist_of, by_concat
    for d in sorted(stems_dir.iterdir()):
        if not d.is_dir():
            continue
        if re.search(r" \(\d+\)$", d.name):
            continue
        title = artist = None
        meta_p = d / "metadata.json"
        if meta_p.exists():
            try:
                m = json.loads(meta_p.read_text())
                title = m.get("title")
                artist = m.get("artist")
            except Exception:
                pass
        if not title:
            title = d.name.replace("_", " ")
        by_full[match_key(title, artist or "")] = d.name
        by_title.setdefault(norm_key(title), []).append(d.name)
        artist_of[d.name] = norm_key(artist or "")
        # Slug-derived concatenated key — covers the case where there's no
        # metadata.json yet, so the slug is the only source of truth.
        slug_concat = norm_key(d.name)
        by_concat[slug_concat] = d.name
    return by_full, by_title, artist_of, by_concat


def find_match(title, artist, by_full, by_title, artist_of, by_concat):
    """Return (slug, confidence) or (None, 0)."""
    k = match_key(title, artist)
    if k in by_full:
        return by_full[k], 1.0
    # Slug-derived concat: norm_key(title)+norm_key(artist) often equals
    # the lowercased, underscore-stripped slug exactly.
    concat = norm_key(title) + norm_key(artist or "")
    if concat in by_concat:
        return by_concat[concat], 0.97
    nt = norm_key(title)
    cands = by_title.get(nt, [])
    if len(cands) == 1:
        return cands[0], 0.95
    if cands:
        na = norm_key(artist or "")
        best, best_score = None, 0.0
        for slug in cands:
            s = SequenceMatcher(None, na, artist_of.get(slug, "")).ratio()
            if s > best_score:
                best, best_score = slug, s
        if best and best_score >= 0.5:
            return best, 0.85
    # Containment fallback — covers slugs that embed extra annotation words
    # the Sheet drops, like "Cissy_Strut_loopable_The_Meters" vs the Sheet's
    # "Cissy Strut (loopable)" + "The Meters" (parens get stripped). If the
    # Sheet's normalized prefix (title) AND suffix (artist) both appear in the
    # slug's normalized form, that's a confident match.
    nt = norm_key(title)
    na = norm_key(artist or "")
    if nt and na and len(nt) >= 4 and len(na) >= 3:
        for ck, slug in by_concat.items():
            if ck.startswith(nt) and ck.endswith(na):
                return slug, 0.9
    # Fuzzy concat fallback — covers slight variants like "American Girl
    # Tom Petty" vs "American Girl Tom Petty and the Heartbreakers".
    best, best_score = None, 0.0
    for ck, slug in by_concat.items():
        s = SequenceMatcher(None, concat, ck).ratio()
        if s > best_score:
            best, best_score = slug, s
    if best and best_score >= FUZZY_THRESHOLD:
        return best, best_score
    # Whole-index fuzzy title fallback
    best, best_score = None, 0.0
    for k2, slug in by_full.items():
        t2 = k2.split("::", 1)[0]
        s = SequenceMatcher(None, nt, t2).ratio()
        if s > best_score:
            best, best_score = slug, s
    if best and best_score >= FUZZY_THRESHOLD:
        return best, best_score
    return None, 0.0


# ---------- field parsers ----------

def parse_reqd(r):
    """Bill&Matt&Dan → ['Bill','Matt','Dan']"""
    if not r:
        return []
    return [p.strip() for p in r.split("&") if p.strip()]


def parse_lead_singer(v):
    """Take the first name token before any separator. None for All/?/n_a."""
    if not v:
        return None
    v = v.strip()
    if v.lower() in ("all", "?", "n/a", ""):
        return None
    # drop parenthesized backup
    v = re.sub(r"\s*\(.*?\)\s*", "", v).strip()
    for sep in ["/", ",", " or ", " - ", " - "]:
        if sep in v:
            v = v.split(sep)[0]
            break
    v = v.strip()
    # filter out instrument annotations that occasionally appear standalone
    if v.lower() in ("keys", "flute", "harp", "guitar", "drums", "bass"):
        return None
    return v or None


def parse_backup_singer(v):
    """'JD (Matt)' → 'Matt'. None if no parenthesized name."""
    if not v:
        return None
    m = re.search(r"\(([^)]+)\)", v)
    if not m:
        return None
    return m.group(1).strip().split("/")[0].strip() or None


def parse_vocals(v):
    if not v:
        return {}
    v = v.strip()
    return {
        "vocals_raw": v,
        "lead": parse_lead_singer(v),
        "backup": parse_backup_singer(v),
        "group_vocal": v.lower() == "all",
    }


# ---------- column discovery ----------

def find_col(headers, *names):
    low = [(h or "").strip().lower() for h in headers]
    for n in names:
        try:
            return low.index(n.lower())
        except ValueError:
            continue
    return -1


def col(row, idx):
    if idx < 0 or idx >= len(row):
        return ""
    return (row[idx] or "").strip()


# ---------- master sync ----------

def sync_master(text, stems_dir, by_full, by_title, artist_of, by_concat,
                dry_run=False):
    rdr = csv.reader(io.StringIO(text))
    rows = list(rdr)
    if not rows:
        return {"rows": 0, "matched": 0, "unmatched": []}
    headers = rows[0]
    i_song = find_col(headers, "Song")
    i_artist = find_col(headers, "Artist")
    i_drums = find_col(headers, "Drums")
    i_voc = find_col(headers, "Vocals")
    i_reqd = find_col(headers, "Reqd")
    i_state = find_col(headers, "State")
    # Master list keeps State in the unnamed first column.
    if i_state < 0:
        i_state = 0

    matched = 0
    unmatched = []
    preview = []
    for r in rows[1:]:
        title = col(r, i_song)
        artist = col(r, i_artist)
        if not title:
            continue
        slug, conf = find_match(title, artist, by_full, by_title, artist_of, by_concat)
        if not slug:
            unmatched.append({"title": title, "artist": artist})
            continue
        matched += 1
        voc = parse_vocals(col(r, i_voc))
        fields = {
            "singer_raw": voc.get("vocals_raw"),
            "singer_lead": voc.get("lead"),
            "singer_backup": voc.get("backup"),
            "singer_group_vocal": voc.get("group_vocal", False),
            "drum_pattern": col(r, i_drums) or None,
            "band_required": parse_reqd(col(r, i_reqd)),
            "readiness": col(r, i_state) or None,
            "mpb_sync_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # Drop None/empty for cleanliness, but keep the boolean false for
        # group_vocal so the field is always defined when other singer fields are.
        fields = {k: v for k, v in fields.items()
                  if v not in (None, "", []) or k == "singer_group_vocal"}
        if dry_run:
            preview.append({"slug": slug, "fields": fields,
                            "confidence": round(conf, 3)})
            continue
        meta_p = stems_dir / slug / "metadata.json"
        try:
            meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
        except Exception:
            meta = {}
        for k, v in fields.items():
            meta[k] = v
        meta_p.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")

    return {
        "rows": len(rows) - 1,
        "matched": matched,
        "unmatched_count": len(unmatched),
        "unmatched": unmatched,
        "preview": preview if dry_run else None,
    }


# ---------- gig sync ----------

DIVIDER_KEYWORDS = ("set", "break", "encore", "on cores", "rally",
                    "mid rally", "post rally", "opening", "closer")


def looks_like_divider(s):
    s = (s or "").lower()
    return any(kw in s for kw in DIVIDER_KEYWORDS)


def block_title_from_row(row, i_song, i_state):
    """Block divider rows often have the block name in the Song column or
    just to the right. Return the cleaned title or None."""
    candidates = []
    for idx in (i_song, i_state, 1, 4):
        if 0 <= idx < len(row):
            candidates.append(row[idx])
    for c in candidates:
        s = (c or "").strip()
        if s and looks_like_divider(s):
            return s
    return None


def slug_of(s):
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^a-z0-9_-]", "", s)
    return s or "untitled"


def find_gig_seq_col(headers, first_row):
    """Gig sheets put the gig-position in an unnamed first column with
    numeric values. If that's not the shape, fall back to the 'Seq' header.
    """
    if headers and not (headers[0] or "").strip() and first_row:
        v = (first_row[0] or "").strip() if first_row else ""
        if re.match(r"^-?\d+", v):
            return 0
    i = find_col(headers, "Seq")
    if i < 0:
        i = 0
    return i


def sync_gig(text, gig_title, gigs_dir, by_full, by_title, artist_of,
             by_concat, dry_run=False):
    rdr = csv.reader(io.StringIO(text))
    rows = list(rdr)
    if not rows:
        return {"setlists": 0, "songs": 0, "unmatched": [], "unmatched_count": 0}
    headers = rows[0]
    first_data = rows[1] if len(rows) > 1 else []
    i_song = find_col(headers, "Song")
    i_artist = find_col(headers, "Artist")
    i_state = find_col(headers, "State")
    if i_state < 0:
        i_state = 0
    i_seq = find_gig_seq_col(headers, first_data)

    setlists = [{"title": "Opening", "songs": []}]
    current_bucket = -1
    unmatched = []

    for r in rows[1:]:
        seq_s = col(r, i_seq)
        title = col(r, i_song)
        artist = col(r, i_artist)

        seq = None
        m = re.match(r"-?\d+", seq_s)
        if m:
            try:
                seq = int(m.group(0))
            except ValueError:
                seq = None

        # Bucket boundary → start a new setlist
        if seq is not None:
            bucket = seq // 100
            if bucket != current_bucket:
                current_bucket = bucket
                divider_title = block_title_from_row(r, i_song, i_state)
                if divider_title and (not title or looks_like_divider(title)):
                    setlists.append({"title": divider_title, "songs": []})
                    continue
                # bucket change with an actual song — open a generically-named set
                if setlists and (setlists[-1]["songs"] or bucket > 0):
                    setlists.append({"title": f"Set {bucket}", "songs": []})

        # Pure divider row (no usable song title)
        if not title or looks_like_divider(title) and not artist:
            dt = block_title_from_row(r, i_song, i_state)
            if dt:
                setlists.append({"title": dt, "songs": []})
            continue

        slug, conf = find_match(title, artist, by_full, by_title, artist_of, by_concat)
        if not slug:
            unmatched.append({"title": title, "artist": artist})
            continue
        setlists[-1]["songs"].append({"slug": slug, "title": title})

    # Drop any leading empty setlists
    while setlists and not setlists[0]["songs"] and len(setlists) > 1:
        setlists = setlists[1:]
    # Drop trailing empty setlists
    while len(setlists) > 1 and not setlists[-1]["songs"]:
        setlists.pop()

    total_songs = sum(len(s["songs"]) for s in setlists)
    gig = {
        "title": gig_title,
        "source": "mpb_sync",
        "synced_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "setlists": setlists,
    }
    if not dry_run:
        gigs_dir.mkdir(exist_ok=True)
        out = gigs_dir / f"{slug_of(gig_title)}.json"
        out.write_text(json.dumps(gig, indent=2, ensure_ascii=False) + "\n")

    return {
        "setlists": len(setlists),
        "songs": total_songs,
        "unmatched_count": len(unmatched),
        "unmatched": unmatched,
        "gig": gig if dry_run else None,
    }


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=default_root())
    ap.add_argument("--master-only", action="store_true",
                    help="skip the gig parsing")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + match, don't write metadata or gigs")
    ap.add_argument("--config",
                    help="alternate path to mpb_sync_config.json")
    args = ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    cfg_dir = Path(args.config).resolve().parent if args.config else script_dir
    cfg = load_config(cfg_dir)
    sheet_id = cfg["sheet_id"]

    stems_dir = args.root / "STEMS"
    gigs_dir = args.root / "GIGS"
    logs_dir = args.root / "LOGS"
    if not stems_dir.exists():
        sys.exit(f"!! no STEMS/ under {args.root}")

    print(f">> indexing {stems_dir}")
    by_full, by_title, artist_of, by_concat = build_stems_index(stems_dir)
    print(f"   {len(by_full)} songs in local library")

    report = {
        "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dry_run": args.dry_run,
        "master": None,
        "gigs": [],
    }

    print(f">> fetching master sheet '{cfg['master_sheet']}'")
    try:
        master_text = fetch_csv(sheet_id, cfg["master_sheet"])
    except Exception as e:
        sys.exit(f"!! master fetch failed: {e}")
    master_result = sync_master(master_text, stems_dir, by_full, by_title,
                                artist_of, by_concat, dry_run=args.dry_run)
    report["master"] = master_result
    print(f"   {master_result['matched']}/{master_result['rows']} matched, "
          f"{master_result['unmatched_count']} unmatched")

    if not args.master_only:
        for g in cfg.get("gig_sheets", []):
            name = g["sheet_name"]
            print(f">> fetching gig '{name}'")
            try:
                txt = fetch_csv(sheet_id, name)
            except Exception as e:
                print(f"   !! skip: {e}")
                report["gigs"].append({"name": name, "error": str(e)})
                continue
            res = sync_gig(txt, name, gigs_dir, by_full, by_title, artist_of,
                           by_concat, dry_run=args.dry_run)
            res["name"] = name
            report["gigs"].append(res)
            print(f"   → {res['setlists']} sets · {res['songs']} songs · "
                  f"{res['unmatched_count']} unmatched")

    logs_dir.mkdir(exist_ok=True)
    rp = logs_dir / "mpb_sync_report.json"
    rp.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f">> wrote {rp}")


if __name__ == "__main__":
    main()
