#!/usr/bin/env python3
"""
Post-process demucs stems to better match the source.

Given source.wav + vocals/drums/bass/other.wav in <dir>, solve for the
per-stem scalar gains g_i that minimize ||sum(g_i * stem_i) - source||^2.

A negative gain naturally indicates polarity inversion in that stem
(demucs occasionally flips polarity); applying the gain corrects it.

By default the gains are applied to the stem files in place, with a
final overall scale-down if any balanced stem (or their sum) would clip.

Usage:
    post_process.py --dir <song_folder> [--dry-run]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf


STEM_NAMES = ["vocals", "drums", "bass", "other"]


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))


def db(x: float) -> float:
    return 20.0 * np.log10(max(x, 1e-12))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true",
                    help="Report gains without modifying files")
    ap.add_argument("--force", action="store_true",
                    help="Re-balance even if .stem_balanced marker exists")
    ap.add_argument("--max-gain", type=float, default=3.0,
                    help="Cap |gain| at this value (default: 3.0 ≈ +9.5 dB)")
    args = ap.parse_args()

    marker = args.dir / ".stem_balanced"
    if marker.exists() and not args.dry_run and not args.force:
        print("   stems already balanced (.stem_balanced exists); skipping. "
              "Use --force to re-run.")
        return

    paths = {n: args.dir / f"{n}.wav" for n in STEM_NAMES}
    paths["source"] = args.dir / "source.wav"
    for n, p in paths.items():
        if not p.exists():
            sys.exit(f"Missing: {p}")

    audio = {}
    for n, p in paths.items():
        y, sr = sf.read(str(p), always_2d=False)
        audio[n] = (y.astype(np.float32), sr)

    source, sr_s = audio["source"]
    stems = [audio[n][0] for n in STEM_NAMES]

    # Common length + channel count
    N = min(s.shape[0] for s in [source, *stems])
    source = source[:N]
    stems = [s[:N] for s in stems]

    # Flatten stereo by stacking channels into one long vector so a single
    # scalar gain applies equally to L and R (preserving stereo image).
    def flat(y):
        return y if y.ndim == 1 else y.reshape(-1)

    M = np.stack([flat(s) for s in stems], axis=1)  # (samples*channels, 4)
    s = flat(source)
    if M.shape[0] != s.shape[0]:
        sys.exit(f"Stem/source shape mismatch after flatten: {M.shape} vs {s.shape}")

    src_rms = rms(s)
    err_before = rms(M.sum(axis=1) - s)
    g, *_ = np.linalg.lstsq(M, s, rcond=None)
    err_after = rms(M @ g - s)

    print(f"   source RMS:                 {db(src_rms):+.2f} dB")
    print(f"   sum residual (unity gains): {db(err_before):+.2f} dB  "
          f"({100*err_before/max(src_rms,1e-12):.1f}% of source RMS)")
    print(f"   sum residual (balanced):    {db(err_after):+.2f} dB  "
          f"({100*err_after/max(src_rms,1e-12):.1f}% of source RMS)")
    print("   per-stem gain:")
    for n, gi in zip(STEM_NAMES, g):
        flip = " (polarity flipped)" if gi < 0 else ""
        print(f"     {n:<7s} gain={gi:+.4f}  [{db(abs(gi)):+.2f} dB]{flip}")

    # Cap each gain's magnitude to a sane range. Without this, a single
    # stem requesting (say) gain=5x would force a universal scale-down
    # to prevent it from clipping, which would silence the other three
    # stems.  Capping individual gains preserves each stem's audibility.
    GAIN_MIN, GAIN_MAX = 0.1, args.max_gain  # signed cap
    g_capped = np.sign(g) * np.clip(np.abs(g), GAIN_MIN, GAIN_MAX)
    if not np.allclose(g, g_capped):
        print(f"   one or more gains capped to |g| in [{GAIN_MIN}, {GAIN_MAX}]:")
        for n, gi, gc in zip(STEM_NAMES, g, g_capped):
            if abs(gi - gc) > 1e-6:
                print(f"     {n}: {gi:+.3f} -> {gc:+.3f}")

    if args.dry_run:
        return

    # Apply (capped) gains. We deliberately do NOT universal-scale to
    # prevent clipping: that would silence quiet stems whenever a loud
    # one was amplified. If a single stem peaks > 1.0 after balancing,
    # PCM_16 hard-clips it on write — distortion in that one stem,
    # but the other three keep their audible levels.
    for n, gi in zip(STEM_NAMES, g_capped):
        b = stems[STEM_NAMES.index(n)] * gi
        peak = float(np.max(np.abs(b)))
        if peak > 1.0:
            print(f"   warning: {n}.wav peak after balance = {peak:.3f} "
                  f"(will hard-clip on write)")
        sf.write(str(paths[n]), b, audio[n][1])

    marker.touch()
    print("   stems updated in place.")


if __name__ == "__main__":
    main()
