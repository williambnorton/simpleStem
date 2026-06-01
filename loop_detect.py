#!/usr/bin/env python3
"""
Detect repeated sections in a reference audio file, then extract and
seamlessly tile those sections from one or more target stems.

Usage:
    loop_detect.py --ref REF.wav --target T1.wav [T2.wav ...] --out OUT_DIR
                   [--max-loops 4] [--beats-per-bar 4]

For each target, writes up to MAX_LOOPS files named
    <target_basename>_loop<i>_<N>bars.wav
each containing the section tiled with a short crossfade to the full
song length.

Loops are ranked by how often the section recurs in the song
(most-repeated first). Section semantics (intro/verse/chorus) are not
inferred — only repetition structure.

Assumptions:
    - 4/4 time (override with --beats-per-bar).
    - Segmentation uses beat-synchronized mel features + agglomerative
      clustering; expect ~70-80% accuracy on typical pop/rock material.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf


def write_m4a(samples, sr, out_path):
    """Write samples as a compressed .m4a (AAC) instead of a giant WAV.
    Encodes via ffmpeg through a temporary WAV. ~10x smaller than raw WAV, which
    matters because loops are tiled to full song length."""
    out_path = Path(out_path)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tf:
        tmp = tf.name
    try:
        sf.write(tmp, samples, sr)
        subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp,
             '-c:a', 'aac', '-b:a', '256k', str(out_path)],
            check=True, stdin=subprocess.DEVNULL)
    finally:
        try: Path(tmp).unlink()
        except OSError: pass


def detect_sections(ref_path, max_loops, beats_per_bar):
    """Returns (loops, sr, total_len, tempo) where loops is a list of
    (start_sample, end_sample, n_bars) tuples ranked by recurrence."""
    y, sr = sf.read(str(ref_path), always_2d=False)
    y_mono = y.mean(axis=1) if y.ndim > 1 else y
    y_mono = y_mono.astype(np.float32)
    total_len = y_mono.shape[0]

    tempo, beat_frames = librosa.beat.beat_track(y=y_mono, sr=sr)
    tempo = float(np.asarray(tempo).flatten()[0])
    if len(beat_frames) < beats_per_bar * 2:
        return [], sr, total_len, tempo

    beat_samples = np.concatenate(
        [librosa.frames_to_samples(beat_frames), [total_len]]
    )
    samples_per_bar = int(round(60.0 / tempo * beats_per_bar * sr))

    # Beat-synced features for segmentation: MFCC[1:] captures timbre
    # (dropping MFCC[0] removes overall-loudness bias), chroma captures
    # harmony. Each feature row is z-scored across time so no single
    # dimension dominates cosine similarity.
    mfcc = librosa.feature.mfcc(y=y_mono, sr=sr, n_mfcc=20)[1:]
    chroma = librosa.feature.chroma_cqt(y=y_mono, sr=sr)
    F = np.vstack([mfcc, chroma])
    F = (F - F.mean(axis=1, keepdims=True)) / (F.std(axis=1, keepdims=True) + 1e-9)
    S_sync = librosa.util.sync(F, beat_frames, aggregate=np.mean)

    # Pick K boundaries: enough to surface recurrence, not so many we
    # over-segment.
    k = min(max(4, max_loops * 2 + 2),
            max(2, S_sync.shape[1] // beats_per_bar))
    if k < 2 or S_sync.shape[1] < k:
        return [], sr, total_len, tempo
    boundaries = librosa.segment.agglomerative(S_sync, k=k)
    boundaries = np.concatenate([boundaries, [S_sync.shape[1]]])

    # Build segments + their feature centroids (z-normalized so cosine
    # similarity reflects shape, not magnitude).
    def znorm(v):
        v = v - v.mean()
        n = np.linalg.norm(v)
        return v / (n + 1e-9)

    segments = []
    for i in range(len(boundaries) - 1):
        bs, be = int(boundaries[i]), int(boundaries[i + 1])
        if be - bs < beats_per_bar:
            continue
        centroid = znorm(S_sync[:, bs:be].mean(axis=1))
        segments.append((bs, be, centroid))

    # Cluster segments by cosine similarity; each cluster ≈ one section type
    SIM_THRESH = 0.80
    clusters = []  # list of {"members": [seg_idx], "centroid": ndarray}
    for idx, (_, _, c) in enumerate(segments):
        placed = False
        for cl in clusters:
            denom = np.linalg.norm(c) * np.linalg.norm(cl["centroid"]) + 1e-9
            sim = float(np.dot(c, cl["centroid"]) / denom)
            if sim > SIM_THRESH:
                n = len(cl["members"]) + 1
                cl["centroid"] = (cl["centroid"] * (n - 1) + c) / n
                cl["members"].append(idx)
                placed = True
                break
        if not placed:
            clusters.append({"members": [idx], "centroid": c.copy()})

    # Rank by recurrence count, then by total duration
    def cluster_dur(cl):
        return sum(segments[i][1] - segments[i][0] for i in cl["members"])

    clusters.sort(key=lambda cl: (-len(cl["members"]), -cluster_dur(cl)))
    clusters = clusters[:max_loops]

    # For each cluster, pick longest member as representative; snap to bars
    loops = []
    for cl in clusters:
        rep_idx = max(cl["members"],
                      key=lambda i: segments[i][1] - segments[i][0])
        bs, be, _ = segments[rep_idx]
        start_sample = int(beat_samples[min(bs, len(beat_samples) - 1)])
        end_sample = int(beat_samples[min(be, len(beat_samples) - 1)])
        seg_len = end_sample - start_sample
        n_bars = max(1, round(seg_len / samples_per_bar))
        end_sample = min(start_sample + n_bars * samples_per_bar, total_len)
        n_bars = max(1, (end_sample - start_sample) // samples_per_bar)
        if n_bars < 1 or end_sample - start_sample < sr // 2:
            continue
        loops.append((start_sample,
                      start_sample + n_bars * samples_per_bar,
                      int(n_bars)))
    return loops, sr, total_len, tempo


def tile_with_crossfade(loop, total_len, sr):
    """Tile loop to total_len with a short overlap-add crossfade."""
    L = loop.shape[0]
    xfade = min(int(0.02 * sr), max(1, L // 8))  # ~20 ms
    fade = np.linspace(0, 1, xfade, dtype=np.float32)
    loop_xf = loop.astype(np.float32, copy=True)
    if loop.ndim == 1:
        loop_xf[:xfade] *= fade
        loop_xf[-xfade:] *= fade[::-1]
        out = np.zeros(total_len + L, dtype=np.float32)
    else:
        loop_xf[:xfade] *= fade[:, None]
        loop_xf[-xfade:] *= fade[::-1, None]
        out = np.zeros((total_len + L, loop.shape[1]), dtype=np.float32)
    step = L - xfade
    pos = 0
    while pos < total_len:
        end = min(pos + L, out.shape[0])
        out[pos:end] += loop_xf[:end - pos]
        pos += step
    return out[:total_len]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, type=Path)
    ap.add_argument("--target", nargs="+", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--max-loops", type=int, default=4)
    ap.add_argument("--beats-per-bar", type=int, default=4)
    ap.add_argument("--max-duration", type=float, default=600.0,
                    help="skip loop generation if the source is longer than this "
                         "many seconds (default 600 = 10 min). Live concerts / "
                         "multi-song uploads are not single songs and produce "
                         "meaningless, multi-GB tiled loops.")
    args = ap.parse_args()

    # Guard: don't loop-detect long/multi-song sources (live concerts, full
    # albums). Tiling a 95-min source to song length yields 1GB+ files and the
    # detected 'sections' are just different songs, not a repeating groove.
    try:
        dur = sf.info(str(args.ref)).duration
        if dur > args.max_duration:
            print(f"   source is {dur:.0f}s (> {args.max_duration:.0f}s) — "
                  "looks like a concert/album, skipping loop generation.")
            return
    except Exception as e:
        print(f"   could not read source duration ({e}); proceeding cautiously.")

    loops, sr_ref, total_len, tempo = detect_sections(
        args.ref, args.max_loops, args.beats_per_bar
    )
    print(f">> reference: {args.ref.name}  tempo≈{tempo:.1f} BPM  "
          f"sections={len(loops)}")

    args.out.mkdir(parents=True, exist_ok=True)

    # Load + align all targets to the reference length so sample indices
    # from `loops` apply identically to each.
    loaded = []  # list of (name, y, sr)
    for tgt in args.target:
        y, sr = sf.read(str(tgt), always_2d=False)
        if sr != sr_ref:
            y_t = y.T if y.ndim > 1 else y
            y_t = librosa.resample(y_t, orig_sr=sr, target_sr=sr_ref)
            y = y_t.T if y_t.ndim > 1 else y_t
            sr = sr_ref
        if y.shape[0] < total_len:
            pad_shape = list(y.shape)
            pad_shape[0] = total_len - y.shape[0]
            y = np.concatenate([y, np.zeros(pad_shape, dtype=y.dtype)], axis=0)
        else:
            y = y[:total_len]
        loaded.append((tgt.stem, y, sr))

    # Write the full-length rhythm-section mix as bass+drums.wav whenever
    # both stems are present. This is independent of loop detection so we
    # still produce a useful practice track on songs where librosa can't
    # find a steady tempo. Also queues "drumsbass" as an extra loop target.
    names = [name for name, _, _ in loaded]
    if 'drums' in names and 'bass' in names:
        yd = loaded[names.index('drums')][1].astype(np.float32)
        yb = loaded[names.index('bass')][1].astype(np.float32)
        combined = yd + yb
        peak = float(np.max(np.abs(combined)))
        if peak > 1.0:
            combined = combined / peak
        full_path = args.out / 'bass+drums.wav'
        sf.write(str(full_path), combined, sr_ref)
        print(f">> wrote {full_path.name} (full-length rhythm-section mix)")
        loaded.append(('drumsbass', combined, sr_ref))

    if not loops:
        print("   no usable sections detected; skipping loop tiling.")
        return

    for name, y, sr in loaded:
        print(f">> {name}: writing {len(loops)} tiled loop(s) as m4a…")
        for i, (s, e, n_bars) in enumerate(loops, start=1):
            seg = y[s:e]
            tiled = tile_with_crossfade(seg, total_len, sr)
            out_path = args.out / f"{name}_loop{i}_{n_bars}bars.m4a"
            write_m4a(tiled, sr, out_path)
            print(f"   -> {out_path.name}")


if __name__ == "__main__":
    main()
