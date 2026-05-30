# simpleStem

Fetch a song from YouTube, separate it into vocals/drums/bass/other with
Demucs, balance the stems against the original, and generate
beat-synced jam loops for practice.

Built for the New Mitchell Park band: drummer wants drums-only tracks
to practice over, bass wants bass-only, guitar/vocals want the full
rhythm section. simpleStem produces all three from any YouTube URL or
search query.

## What you get per song

All song outputs live under `~/ClaudeDrive/simpleStem/STEMS/`. Per song
folder `STEMS/${Title}_${Artist}/`:

```
source.wav                          downloaded audio
vocals.wav   drums.wav   bass.wav   other.wav   demucs stems
                                                (balanced to match source)
bass+drums.wav                      full-length rhythm-section mix

drums_loop{1..4}_<N>bars.wav        loops (drum-only) tiled to song length
bass_loop{1..4}_<N>bars.wav         loops (bass-only)
drumsbass_loop{1..4}_<N>bars.wav    loops (combined rhythm section)

run.log                             batch run log (only when launched
                                    via mpbbatch.bash)
.stem_balanced                      marker — stems have been gain-matched
```

The simpleStem project folder itself stays clean: only the scripts +
README live there; the `STEMS/` subdirectory holds everything else.

Up to 4 loops per stem, ranked by how often that section recurs (loop1 is
usually the chorus or main groove).

## Install

```
./install.sh
```

Installs ffmpeg, yt-dlp, pipx via Homebrew, then demucs (with torch,
torchcodec, librosa, soundfile) into an isolated pipx venv. Idempotent —
safe to re-run if anything is missing.

Prereq: [Homebrew](https://brew.sh). The script verifies brew is on PATH
before doing anything.

## Usage

### One song

```
./stem.sh "I Melt With You" "Modern English"
```

Search is `ytsearch1:Modern English I Melt With You`; usually returns
the studio version, but YouTube ordering isn't guaranteed. If you need
a specific upload, edit the `yt-dlp` query line in `stem.sh` to a URL.

Re-running on the same title is cheap: each step is idempotent.

- `source.wav` exists       → skip download
- all 4 stems exist         → skip Demucs
- `.stem_balanced` exists   → skip post-processing
- `bass+drums.wav` exists   → skip loop detection

To force a step to re-run, delete its output (e.g. `rm bass+drums.wav`
to regenerate loops only).

### Batch from the band's Google Sheet

```
nohup ./mpbbatch.bash > batch.log 2>&1 &
tail -f batch.log
```

Pulls every row with both Song and Artist filled from
[the master list sheet](https://docs.google.com/spreadsheets/d/1e3DewMjHOmf_OlexPo6E1F_2i69YTYGMemJIZyRQIJA),
skips anything already fully stemmed, and launches each missing song's
`stem.sh` in the background with a 60-second stagger.

Edit `SLEEP_BETWEEN` at the top of `mpbbatch.bash` to throttle (Demucs is
CPU-heavy; many parallel jobs will pin a Mac). Change `GID` to pull from
a different sheet tab.

Per-song log: `~/ClaudeDrive/simpleStem/STEMS/${Title}_${Artist}/run.log`.

To kill the whole batch:
```
pkill -f mpbbatch.bash ; pkill -f stem.sh
```

## How the stages work

**Download** — `yt-dlp` extracts best audio, converts to WAV via ffmpeg.

**Demucs (htdemucs model)** — 4-stem separation. ~5–15 min per song on
CPU. The stems land in `htdemucs/source/`; we flatten them up next to
`source.wav`.

**Post-process (`post_process.py`)** — Solves for the per-stem scalar
gains that minimize ‖Σ gᵢ·stemᵢ − source‖². A negative gain indicates
polarity inversion (which Demucs occasionally produces); applying the
gain corrects it. Prints before/after sum-vs-source residual in dB.

**Loop detection (`loop_detect.py`)** — Beat-tracks `source.wav` with
librosa, builds beat-synced MFCC+chroma features, agglomeratively
segments, clusters similar sections by cosine similarity, and picks up
to N representatives ranked by recurrence count. For each representative
it snaps the time range to whole bars (assuming 4/4) and tiles it to
song length with a ~20 ms crossfade. The same time ranges are applied
to drums and bass so the loop sets align across stems.

## Troubleshooting

**`pipx install demucs` fails with PEP 668 / externally-managed-environment**
  → That's the modern Homebrew Python lockout. Use the `install.sh`
    script; it routes everything through `pipx` which sidesteps PEP 668.

**`demucs: command not found` after install**
  → `pipx ensurepath` writes to `~/.zshrc` but your current shell
    doesn't see it. Open a new terminal or `exec zsh`. The install.sh
    script also adds the PATH export to `~/.zshrc` directly.

**`ImportError: TorchCodec is required for save_with_torchcodec`**
  → Newer `torchaudio` delegates WAV writing to `torchcodec`.
    `pipx inject demucs torchcodec` (install.sh does this).

**`librosa/soundfile not available in the demucs env`**
  → `stem.sh` auto-injects on failure, but if that fails too:
    `pipx inject demucs librosa soundfile`.

**Search returns a cover or live version**
  → Edit `stem.sh` and replace the `"$QUERY"` argument to `yt-dlp` with
    a direct YouTube URL. Then delete the song's folder and re-run.

**Tempo detected at half/double**
  → Known librosa quirk. Loop bar counts will halve or double — the
    audio is still musically correct, just labeled differently. Pass
    `--beats-per-bar 4` (default) or override for waltz time.

**Demucs picks the wrong polarity for a stem**
  → `post_process.py` should catch this and apply a negative gain.
    Inspect the per-stem gains it prints; any with `(polarity flipped)`
    were corrected.

## Files

| File                | What                                                          |
|---------------------|---------------------------------------------------------------|
| `install.sh`        | One-shot prereq installer (Homebrew + pipx + injects)         |
| `stem.sh`           | Per-song pipeline: download → demucs → balance → loops        |
| `post_process.py`   | LSQ gain match of stems to source                              |
| `loop_detect.py`    | Section detection + beat-aligned crossfade tiling             |
| `mpbbatch.bash`     | Batch driver: pull Song/Artist from the Google Sheet          |

## Limits worth knowing

- 4/4 assumed. Other meters: pass `--beats-per-bar 3` to `loop_detect.py`.
- Demucs runs CPU-only by default — slow but reliable. Apple Silicon
  users could try MPS but htdemucs is finicky on Metal; leaving as CPU.
- Segmentation is heuristic — expect ~70–80% accuracy on
  standard pop/rock; less reliable for ambient/jam material.
- YouTube downloading is technically against TOS. This is for personal
  practice use.
