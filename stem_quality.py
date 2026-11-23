#!/usr/bin/env python3
"""
stem_quality.py — measure how closely a song's six Demucs stems rebuild the
original stereo source, and record the result in the song's metadata.json.

What it measures (reconstruction fidelity, NOT separation quality):

    residual_pct = RMS(source - sum(stems)) / RMS(source) * 100     lower is better
    residual_db  = 20*log10(residual_pct / 100)                     more negative is better

A degenerate split that put the whole song in other.m4a would score ~0 %, so
this is a sanity gauge for the render (truncated stem, polarity flip, dropped
channel, wrong source), not a ranking of how well the instruments were
separated. Two extra readings help interpret the number:

    fit_gains        per-stem scalar gains that minimise the residual (LSQ);
                     ~1.0 everywhere is healthy, a negative gain is a polarity
                     flip, a gain far from 1 is a level mismatch.
    fit_residual_pct the residual after applying those gains.
    stem_energy_pct  share of the summed-stem energy carried by each stem;
                     a stem near 0 % is effectively empty.

Both source and stems are AAC, so the encoder priming delay can offset the
stems against the source by ~1000 samples. The script estimates that lag by
cross-correlation and removes it before measuring. The codec also sets a
floor: lossy-vs-lossy will never reach 0 %.

Files per song (looked up in --cache first, then --library):
    <base>/vocals.m4a drums.m4a bass.m4a guitar.m4a piano.m4a other.m4a
    <base>/<base>_SOURCE.m4a
The result is merged into <library>/<base>/metadata.json under "stem_quality".

Usage (Performer):
    stem_quality.py --base Song_Artist             one song
    stem_quality.py --all                          every song in --library
    stem_quality.py --all --dry-run                measure, print, write nothing
    stem_quality.py --all --force                  re-measure already-measured songs
    stem_quality.py --base Song_Artist --ext wav   from the stem.sh hook, on the
                                                   pre-transcode WAVs (no codec floor)

Dependencies: ffmpeg on PATH, numpy.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
SR = 48000
CH = 2
MAX_LAG = 8192          # samples searched either side when aligning
XCORR_SECONDS = 60      # excerpt length used for the lag estimate
SCRIPT = Path(__file__).name
PROGRESS_EVERY_SEC = 60


def log(msg):
    stamp = time.strftime("%a %b %d %H:%M:%S %Z %Y")
    print(f"{stamp}  {SCRIPT}  {msg}", flush=True)


def decode(path: Path) -> np.ndarray:
    """Decode any audio file to float32 stereo 48 kHz, shape (n, 2)."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path),
           "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(CH), "-ar", str(SR), "-"]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"ffmpeg failed on {path.name}: {out.stderr.decode(errors='replace').strip()[:200]}")
    buf = np.frombuffer(out.stdout, dtype=np.float32)
    return buf.reshape(-1, CH)


def estimate_lag(source: np.ndarray, stems: dict) -> int:
    """Return the number of samples the stems must be shifted to line up with
    the source (positive = stems are late). The lag is a property of the
    transcode, shared by all six stems, so it is estimated per stem against
    the source (|xcorr|, so a polarity-flipped stem still votes correctly)
    and the median vote wins. Uses a mono excerpt from the middle."""
    n = min([len(source)] + [len(s) for s in stems.values()])
    length = min(n, XCORR_SECONDS * SR)
    start = max(0, (n - length) // 2)
    size = 1 << int(np.ceil(np.log2(2 * length)))
    a = source[start:start + length].mean(axis=1).astype(np.float64)
    a -= a.mean()
    fa = np.fft.rfft(a, size)
    lags = np.concatenate([np.arange(0, MAX_LAG + 1), np.arange(-MAX_LAG, 0)])
    votes = []
    for s in stems.values():
        b = s[start:start + length].mean(axis=1).astype(np.float64)
        if np.max(np.abs(b)) < 1e-6:
            continue  # silent stem, no opinion
        b -= b.mean()
        corr = np.fft.irfft(fa * np.conj(np.fft.rfft(b, size)), size)
        # corr[k] is correlation at lag k (mod size); negative lags wrap to the end
        vals = np.abs(np.concatenate([corr[:MAX_LAG + 1], corr[size - MAX_LAG:]]))
        votes.append(int(lags[np.argmax(vals)]))
    return int(np.median(votes)) if votes else 0


def shift(x: np.ndarray, lag: int) -> np.ndarray:
    """Shift x so that x_shifted[i] = x[i - lag] (zero padded)."""
    if lag == 0:
        return x
    out = np.zeros_like(x)
    if lag > 0:
        out[lag:] = x[:-lag]
    else:
        out[:lag] = x[-lag:]
    return out


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))


def measure(stem_paths: dict, source_path: Path) -> dict:
    source = decode(source_path)
    stems = {name: decode(p) for name, p in stem_paths.items()}

    n = min([len(source)] + [len(s) for s in stems.values()])
    source = source[:n]
    stems = {k: v[:n] for k, v in stems.items()}

    mix = np.zeros_like(source)
    for s in stems.values():
        mix += s

    lag = estimate_lag(source, stems)
    if lag:
        stems = {k: shift(v, lag) for k, v in stems.items()}
        mix = shift(mix, lag)
    # drop the zero-padded edge so the shift itself is not counted as error
    edge = abs(lag)
    sl = slice(edge, n - edge) if edge else slice(0, n)
    src = source[sl]
    mix = mix[sl]

    src_rms = rms(src)
    if src_rms < 1e-9:
        raise RuntimeError("source is silent")
    residual_pct = rms(src - mix) / src_rms * 100.0

    # least-squares per-stem gains on the mono downmix (6x6 normal equations)
    cols = np.stack([stems[k][sl].mean(axis=1).astype(np.float64) for k in STEMS], axis=1)
    target = src.mean(axis=1).astype(np.float64)
    gains, *_ = np.linalg.lstsq(cols, target, rcond=None)
    fitted = np.zeros_like(src, dtype=np.float64)
    for g, k in zip(gains, STEMS):
        fitted += g * stems[k][sl]
    fit_residual_pct = rms(src - fitted) / src_rms * 100.0

    energies = {k: float(np.sum(stems[k][sl].astype(np.float64) ** 2)) for k in STEMS}
    total = sum(energies.values()) or 1.0

    def db(pct):
        return round(20.0 * np.log10(max(pct, 1e-6) / 100.0), 2)

    return {
        "residual_pct": round(residual_pct, 2),
        "residual_db": db(residual_pct),
        "fit_residual_pct": round(fit_residual_pct, 2),
        "fit_residual_db": db(fit_residual_pct),
        "fit_gains": {k: round(float(g), 3) for g, k in zip(gains, STEMS)},
        "stem_energy_pct": {k: round(energies[k] / total * 100.0, 1) for k in STEMS},
        "lag_samples": lag,
        "duration_sec": round(n / SR, 1),
        "method": "rms(source - sum6) / rms(source), lag-aligned, 48k stereo",
        "measured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def locate(base: str, roots: list, ext: str) -> tuple:
    """Find a folder holding all six stems, and the source (same folder preferred).
    Source names tried: <base>_SOURCE.<ext>, then source.wav (the pre-transcode
    render folder, when --ext wav is used from the stem.sh hook)."""
    stem_dir = None
    for root in roots:
        d = root / base
        if all((d / f"{k}.{ext}").exists() for k in STEMS):
            stem_dir = d
            break
    if stem_dir is None:
        return None, None
    for root in [stem_dir.parent] + roots:
        for name in (f"{base}_SOURCE.{ext}", f"{base}_SOURCE.m4a", "source.wav"):
            p = root / base / name
            if p.exists():
                return stem_dir, p
    return stem_dir, None


def already_measured(meta: dict, stem_dir: Path, ext: str) -> bool:
    q = meta.get("stem_quality")
    if not q or "stems_mtime" not in q:
        return False
    return q["stems_mtime"] == stems_mtime(stem_dir, ext)


def stems_mtime(stem_dir: Path, ext: str) -> int:
    return int(max((stem_dir / f"{k}.{ext}").stat().st_mtime for k in STEMS))


def write_metadata(meta_path: Path, result: dict):
    meta = {}
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
    meta["stem_quality"] = result
    tmp = meta_path.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, meta_path)


def process(base: str, args, roots: list) -> str:
    stem_dir, source = locate(base, roots, args.ext)
    if stem_dir is None:
        return "skipped: missing stems"
    if source is None:
        return "skipped: missing source"
    meta_path = args.library / base / "metadata.json"
    meta = {}
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
    if not args.force and not args.dry_run and already_measured(meta, stem_dir, args.ext):
        return "skipped: already measured"

    result = measure({k: stem_dir / f"{k}.{args.ext}" for k in STEMS}, source)
    result["model"] = (meta.get("processing") or {}).get("model", "htdemucs_6s")
    result["stems_mtime"] = stems_mtime(stem_dir, args.ext)
    result["stems_dir"] = str(stem_dir)
    result["stems_format"] = args.ext
    result["source_file"] = source.name

    summary = (f"residual {result['residual_pct']:.1f}% ({result['residual_db']} dB)  "
               f"fit {result['fit_residual_pct']:.1f}%  lag {result['lag_samples']}  "
               f"gains " + " ".join(f"{k[0]}={v:+.2f}" for k, v in result["fit_gains"].items()))
    if args.dry_run:
        return "ok (dry-run): " + summary
    write_metadata(meta_path, result)
    return "ok: " + summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", action="append", default=[], help="song folder name; repeatable")
    ap.add_argument("--all", action="store_true", help="every song folder under --library")
    ap.add_argument("--cache", type=Path, default=Path.home() / ".bt-cache" / "STEMS")
    ap.add_argument("--library", type=Path, default=Path.home() / "ClaudeDrive" / "simpleStem" / "STEMS")
    ap.add_argument("--ext", default="m4a", choices=["m4a", "wav"],
                    help="stem file extension; wav measures the pre-transcode render (no codec floor)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if not args.base and not args.all:
        ap.error("give --base <folder> or --all")
    bases = list(args.base)
    if args.all:
        bases += sorted(d.name for d in args.library.iterdir()
                        if d.is_dir() and not d.name.startswith((".", "_")) and d.name != "inbox")
    roots = [args.cache, args.library]

    total = len(bases)
    counts = {"ok": 0, "skipped": 0, "failed": 0}
    t0 = time.time()
    last_progress = t0

    def progress(done, final=False):
        elapsed = time.time() - t0
        rate = done / elapsed if elapsed > 0 and done else 0.0
        remaining = (total - done) / rate if rate else float("inf")
        eta = "n/a" if remaining == float("inf") else f"~{int(remaining // 3600)}h {int(remaining % 3600 // 60)}m"
        log(f"progress: {done}/{total} ({counts['ok']} ok, {counts['skipped']} skipped, {counts['failed']} failed)"
            f" — ETA {eta} remaining @ {rate * 60:.1f} songs/min" + ("  DONE" if final else ""))

    for i, base in enumerate(bases, 1):
        try:
            status = process(base, args, roots)
        except Exception as e:  # keep the batch moving
            status = f"failed: {e}"
        key = status.split(":")[0].split(" ")[0]
        counts[key if key in counts else "failed"] += 1
        log(f"{base}: {status}")
        if time.time() - last_progress >= PROGRESS_EVERY_SEC or i % 25 == 0:
            progress(i)
            last_progress = time.time()
    progress(total, final=True)
    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
