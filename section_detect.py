#!/usr/bin/env python3
"""section_detect.py — Find candidate section boundaries in a multi-stem
song folder by detecting moments when multiple stems change energy
simultaneously.

Algorithm — a basic novelty function over the multi-stem set:

  1. For each stem (vocals/drums/bass/guitar/piano/other), load the audio
     and compute RMS energy at 10 Hz (one sample per 100 ms hop).
  2. Take the per-stem absolute first derivative (rate of energy change).
  3. Sum the per-stem derivatives at every timestep → the combined
     "section change strength" signal. This spikes when several stems
     change at once, which is the unique fingerprint of a section
     boundary (intro→verse, verse→chorus, bridge entry, outro, etc.).
     Mid-section drum fills or vocal phrases produce smaller bumps in
     one or two stems but rarely a multi-stem cluster.
  4. Find peaks above a fraction of the global maximum, with minimum
     spacing of ~6 seconds (typical shortest section).
  5. Write the resulting peak timestamps (seconds) to the song's
     metadata.json as `sectionCandidates: [t1, t2, ...]`.

The client uses this array to snap user-placed section boundaries to the
nearest detected change point — see snapTimeToBeat() in app.js.

Usage
-----
    ./section_detect.py STEMS/<song_folder>
    ./section_detect.py STEMS/<song_folder> --dry-run
    ./section_detect.py STEMS/<song_folder> --force

Install
-------
    pipx inject demucs librosa   # if librosa isn't in your demucs venv
"""

import sys
import json
from pathlib import Path

try:
    import librosa
    import numpy as np
except ImportError:
    print("ERROR: librosa + numpy required.", file=sys.stderr)
    print("Inject into the demucs venv (per the project's library convention):", file=sys.stderr)
    print("    pipx inject demucs librosa", file=sys.stderr)
    sys.exit(1)


STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
SAMPLE_RATE = 44100
HOP_LENGTH = 4410  # 100 ms hop at 44.1 kHz → 10 Hz envelope
RMS_FRAME = 8820   # 200 ms RMS frame
MIN_SPACING_SEC = 6.0        # shortest plausible section length
THRESHOLD_FRACTION = 0.35    # peak must reach ≥ 35% of global max
SMOOTH_FRAMES = 3            # 3 frames = 300 ms moving-average smoothing


def compute_envelope(audio_path: Path):
    """Return the 10 Hz RMS envelope for one stem, or None if it can't load."""
    try:
        y, _ = librosa.load(str(audio_path), sr=SAMPLE_RATE, mono=True)
    except Exception as e:
        print(f"  [{audio_path.name}] decode failed: {e}", file=sys.stderr)
        return None
    if len(y) < RMS_FRAME:
        return None
    rms = librosa.feature.rms(
        y=y, frame_length=RMS_FRAME, hop_length=HOP_LENGTH
    )[0]
    return rms


def detect_sections(song_dir: Path):
    """Return a list of candidate boundary timestamps (seconds)."""
    envelopes = []
    for stem in STEMS:
        # Prefer the small m4a stems (faster); fall back to wav.
        for ext in (".m4a", ".wav"):
            path = song_dir / f"{stem}{ext}"
            if path.exists():
                env = compute_envelope(path)
                if env is not None:
                    envelopes.append(env)
                break
    if not envelopes:
        print(f"  no stems found in {song_dir}", file=sys.stderr)
        return []

    # Align lengths to the shortest envelope.
    n = min(len(e) for e in envelopes)
    envelopes = [e[:n] for e in envelopes]

    # Per-stem absolute derivative (rate of energy change).
    derivs = [np.abs(np.diff(e, prepend=e[0])) for e in envelopes]
    combined = np.sum(derivs, axis=0)

    # Smooth slightly so a single sample blip doesn't read as a peak.
    if len(combined) > SMOOTH_FRAMES:
        kernel = np.ones(SMOOTH_FRAMES) / SMOOTH_FRAMES
        combined = np.convolve(combined, kernel, mode="same")

    if combined.max() == 0:
        return []

    threshold = THRESHOLD_FRACTION * combined.max()
    min_spacing_frames = int(MIN_SPACING_SEC * SAMPLE_RATE / HOP_LENGTH)

    # Peak finder with min-spacing. Keeps the strongest peak in any window.
    peaks = []
    for i in range(1, len(combined) - 1):
        if combined[i] < threshold:
            continue
        if combined[i] <= combined[i - 1] or combined[i] <= combined[i + 1]:
            continue
        if peaks and (i - peaks[-1]) < min_spacing_frames:
            # Same window as the previous peak — keep the stronger one.
            if combined[i] > combined[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)

    return [round(p * HOP_LENGTH / SAMPLE_RATE, 2) for p in peaks]


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    song_dir = Path(argv[0]).resolve()
    dry_run = "--dry-run" in argv[1:]
    force   = "--force" in argv[1:]

    if not song_dir.is_dir():
        print(f"ERROR: not a directory: {song_dir}", file=sys.stderr)
        sys.exit(2)
    metadata_path = song_dir / "metadata.json"
    if not metadata_path.exists():
        print(f"ERROR: no metadata.json in {song_dir}", file=sys.stderr)
        sys.exit(3)

    meta = json.loads(metadata_path.read_text())
    if "sectionCandidates" in meta and not force and not dry_run:
        print(f"[section_detect] {song_dir.name}: already has "
              f"{len(meta['sectionCandidates'])} candidate(s); "
              f"skip (--force to recompute)")
        return

    print(f"[section_detect] {song_dir.name}")
    candidates = detect_sections(song_dir)
    head = candidates[:8]
    tail = "..." if len(candidates) > 8 else ""
    print(f"  found {len(candidates)} candidate(s): {head}{tail}")

    if dry_run:
        return

    meta["sectionCandidates"] = candidates
    metadata_path.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"  wrote sectionCandidates to metadata.json")


if __name__ == "__main__":
    main(sys.argv[1:])
