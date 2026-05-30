# simpleStem

A self-contained pipeline for splitting songs into 6-stem multitracks and
practice mixes for live band rehearsal. Point it at a song title and
artist; it pulls the audio from YouTube (or imports a local file),
separates it into vocals/drums/bass/other/piano/guitar with Demucs, tags
it with BPM/key/release-date metadata, builds rhythm-section minus-mixes
as M4As, and tiles the most-repeated sections into song-length jam loops.

Built around `demucs htdemucs_6s` plus `librosa` for tempo/structure
analysis. Output is uniform 48 kHz WAV throughout the pipeline so the
files can be dropped straight into a DAW or Ableton session.

---

## How it works

For one song, end to end:

1. **Source acquisition** — `stem.sh` picks audio from one of three
   sources, in this order of precedence:
   1. `--source PATH` — convert a local audio file to `source.wav`
      with ffmpeg.
   2. Explicit YouTube ID or URL as the third positional arg.
   3. Smart search: `ytsearch5:"<artist> <title> official audio"`,
      filtering out any result whose title matches
      `live|concert|cover|tribute|karaoke` (case-insensitive).

2. **Rate normalization** — every `source.wav` is forced to 48 kHz
   (resampled in place if yt-dlp/ffmpeg returned anything else).

3. **Metadata** — `metadata.py` writes `metadata.json` *before* Demucs
   runs, so the BPM / key / release-date info is captured even if the
   separation step later fails. Idempotent — re-runs skip if
   `metadata.json` is already present.

4. **6-stem separation** — `demucs -n htdemucs_6s` produces `vocals.wav`,
   `drums.wav`, `bass.wav`, `other.wav`, `piano.wav`, `guitar.wav`. Each
   stem is then re-normalized to 48 kHz (Demucs's output rate varies by
   version).

5. **Minus-mix encoding** — three M4As are written into a separate
   `M4A/` directory for easy AirDrop to a phone:
   - `<Title>_<Artist>_DO.m4a` — drums only.
   - `<Title>_<Artist>_-V-G.m4a` — source minus vocals and guitar.
   - `<Title>_<Artist>_-V-G-B.m4a` — source minus vocals, guitar, and
     bass.

   Minus-mixes are built by phase-inverting the unwanted stems
   (`volume=-1`) and summing them onto the source with
   `amix=normalize=0`. Cleaner than re-summing the remaining stems and
   it preserves whatever residue Demucs left behind.

6. **Loop detection** — `loop_detect.py` does beat-synced segmentation
   on `source.wav` (MFCC + chroma → agglomerative clustering), ranks
   clusters by recurrence, and tiles the top sections from each rhythm
   stem with a short crossfade out to song length. Produces up to four
   loops per stem, named `<stem>_loop<i>_<N>bars.wav`. A full-length
   `bass+drums.wav` mix is written whenever both stems exist —
   independent of loop detection, so songs where librosa can't lock
   onto a tempo still get a usable practice track.

7. **(Optional) Gain rebalance** — `post_process.py` is *not* called
   automatically; invoke it manually if you want least-squares
   gain-matching between stems.

Re-running on the same song is idempotent at every step: existing
`source.wav` → skip download; existing stems → skip Demucs; existing
`bass+drums.wav` → skip loop detection; existing M4As → skip encoding.

---

## Files

### Pipeline scripts

| File | Role |
|---|---|
| `stem.sh` | Main per-song pipeline. Source acquisition → Demucs → 48 kHz normalize → metadata → M4A minus-mixes → loop detection. The entry point for a single song. |
| `metadata.py` | Writes `metadata.json` per song. Detects BPM and key (Krumhansl-Schmuckler), classifies version (live/studio/official/cover/karaoke) from the YouTube title, looks up the earliest release date on MusicBrainz, and includes ready-made Google-lyrics and Ultimate-Guitar search URLs. |
| `loop_detect.py` | Beat-synced segmentation of `source.wav`; tiles the most-repeated sections of each target stem into crossfaded song-length loops. Also writes `bass+drums.wav` when both stems exist. |
| `post_process.py` | LSQ gain-matching pass over the stems. **Not auto-invoked** — run by hand if you want stem rebalancing. |

### Batch drivers

| File | Role |
|---|---|
| `batch.bash` | Hardcoded list of `./stem.sh "Song" "Artist"` invocations. Edit in place to change the queue. |
| `mpbbatch.bash` | Pulls (`Song`, `Artist`, `videoid`) rows from a public Google Sheet (CSV export endpoint) and runs `stem.sh` on each one serially. Skips rows where all four stems already exist. Logs per-song to `STEMS/<slug>/run.log`. |

### Container / install

| File | Role |
|---|---|
| `Dockerfile` | Image definition. *(Locked at write time — see "Docker section needs verification" below.)* |
| `docker-compose.yml` | Compose service definition. *(Locked at write time.)* |
| `entrypoint.sh` | Container entry point. *(Locked at write time.)* |
| `.dockerignore` | Excludes `STEMS/`, `*.log`, `.DS_Store`, `.git/`, `.gitignore` from the build context (STEMS/ can be many GBs). |
| `install.sh` | Host install script (Homebrew + pipx). *(Locked at write time.)* |

---

## Output layout

```
~/ClaudeDrive/simpleStem/
├── STEMS/
│   └── <SlugTitle>_<SlugArtist>/
│       ├── source.wav                       # 48 kHz, post-resample
│       ├── source.info.json                 # yt-dlp metadata, if downloaded
│       ├── metadata.json                    # BPM/key/release/lyrics+chords URLs
│       ├── vocals.wav  drums.wav  bass.wav
│       ├── other.wav   piano.wav  guitar.wav
│       ├── bass+drums.wav                   # full-length rhythm-section mix
│       ├── drums_loop{1..4}_<N>bars.wav     # tiled, song-length jam loops
│       ├── bass_loop{1..4}_<N>bars.wav
│       ├── drumsbass_loop{1..4}_<N>bars.wav
│       ├── piano_loop{1..4}_<N>bars.wav
│       ├── guitar_loop{1..4}_<N>bars.wav
│       └── run.log                          # if launched via mpbbatch.bash
└── M4A/
    ├── <SlugTitle>_<SlugArtist>_DO.m4a      # drums only
    ├── <SlugTitle>_<SlugArtist>_-V-G.m4a    # source - vocals - guitar
    └── <SlugTitle>_<SlugArtist>_-V-G-B.m4a  # source - vocals - guitar - bass
```

Slugs are ASCII alphanumeric + `_` / `-` only; spaces and punctuation
collapse to `_`. `stem.sh` and `mpbbatch.bash` use the same `slugify`
function so the existence checks line up.

### `metadata.json` schema

```json
{
  "title": "Come Together",
  "artist": "Beatles",
  "youtube_title": "The Beatles - Come Together (Remastered 2009)",
  "youtube_uploader": "TheBeatlesVEVO",
  "youtube_upload_date": "2018-06-19",
  "release_date": "1969-09-26",
  "source_url": "https://www.youtube.com/watch?v=...",
  "version": "official",
  "duration_sec": 259,
  "bpm": 84.7,
  "key": "D minor",
  "key_signature": "1 flat",
  "lyrics_search_url": "https://www.google.com/search?q=...",
  "chords_search_url": "https://www.ultimate-guitar.com/search.php?...",
  "generated_at": "2026-05-25T19:52:00Z"
}
```

---

## Running it — Docker

> The Docker examples below are based on the project layout, `stem.sh`'s
> output paths, and `.dockerignore`. I wasn't able to read `Dockerfile`,
> `docker-compose.yml`, or `entrypoint.sh` while drafting (Google Drive
> was holding a sync lock). **Verify the mount paths and entrypoint
> signature against the actual files before publishing.**

The container bundles `ffmpeg`, `yt-dlp`, and `demucs` (pip-installed,
with `librosa` and `soundfile`). `STEMS/` and `M4A/` are not baked into
the image — bind-mount them in so the output survives container restart.

### Single song — smart search

```bash
docker run --rm \
  -v "$PWD/STEMS:/data/STEMS" \
  -v "$PWD/M4A:/data/M4A" \
  simplestem "Come Together" "Beatles"
```

### Single song — explicit YouTube ID

Use this when smart search picks a live recording or wrong upload:

```bash
docker run --rm \
  -v "$PWD/STEMS:/data/STEMS" \
  -v "$PWD/M4A:/data/M4A" \
  simplestem "Whip It" "Devo" oh5p5f5_-7A
```

### Single song — local audio file

```bash
docker run --rm \
  -v "$PWD/STEMS:/data/STEMS" \
  -v "$PWD/M4A:/data/M4A" \
  -v "$PWD/my-recording.flac:/in/track.flac:ro" \
  simplestem --source /in/track.flac "Bad Moon Rising" "CCR"
```

### Batch from a Google Sheet (docker-compose)

```bash
docker compose run --rm stem-batch
```

This runs `mpbbatch.bash` inside the container against the sheet
configured by `SHEET_ID` / `GID`. The sheet must be set to
"Anyone with the link can view".

### Re-running

All steps are idempotent — re-running on a song folder that's already
fully stemmed is a no-op. Useful if a batch run died partway:

```bash
docker compose run --rm stem-batch  # picks up where it left off
```

---

## Running it — host (macOS, no Docker)

```bash
# One-time install
brew install ffmpeg yt-dlp pipx
pipx ensurepath
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
pipx install demucs
pipx inject demucs torchcodec librosa soundfile

# One song
./stem.sh "Come Together" "Beatles"

# Pinned to a specific YouTube ID
./stem.sh "Whip It" "Devo" oh5p5f5_-7A

# From a local file
./stem.sh --source ~/Music/track.flac "Bad Moon Rising" "CCR"
```

A `htdemucs_6s` separation runs roughly 10–25 minutes per song on CPU
(M-series Mac); GPU is faster but not required.

### Batch on the host

Edit `batch.bash` to update the song list, then:

```bash
./batch.bash
```

Or pull a queue from a Google Sheet (sheet must have `Song`, `Artist`,
and optionally `videoid` columns; must be publicly viewable):

```bash
./mpbbatch.bash
# or detached
nohup ./mpbbatch.bash > mpbbatch.log 2>&1 &
```

`mpbbatch.bash` runs jobs sequentially (one Demucs at a time, so the
Mac stays usable), skips songs whose folders are already fully stemmed,
and reports total elapsed time + bytes added when it finishes.

---

## Requirements

- **ffmpeg** — audio I/O, resampling, minus-mix encoding.
- **yt-dlp** — YouTube fetch (audio only, WAV output).
- **demucs** — separation. `htdemucs_6s` is the default model.
- **Python 3** with **librosa** and **soundfile** (injected into the
  demucs venv on host installs; pre-installed in the Docker image).

Disk: each song folder is roughly 200–400 MB once stems and loops are
written. Plan accordingly for batch runs over hundreds of songs.

---

## Caveats

- **Section labeling is recurrence-only.** `loop_detect.py` doesn't
  know which cluster is the verse vs the chorus — it just ranks by
  how often a section repeats. Expect ~70-80% accuracy on typical
  pop/rock material; sparser arrangements (folk, ambient) are harder.
- **BPM detection assumes a steady tempo.** Songs with significant
  rubato or tempo changes will produce low-confidence loops. The
  full-length `bass+drums.wav` is always written even when loop
  detection fails.
- **Smart search isn't infallible.** If you get a karaoke version or a
  live cut, re-run with the explicit YouTube ID as the third arg.
- **MusicBrainz lookups can fail silently** (network, rate limit, no
  match). `release_date` will simply be `null` in `metadata.json`.
