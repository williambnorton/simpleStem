# Mark5

> **Name.** Mark5 is the name of the app; it was called simpleStem until November 2026. The repository, the Drive folder and the file names keep the old name (`~/simpleStem-code`, `ClaudeDrive/simpleStem`).

A band backing-track system. Turns YouTube songs into separated stems
(vocals · drums · bass · guitar · piano · other) plus six drum-kit
pieces and an MPL (MIDI) version of every part, and serves them
through a web studio you load setlists into for rehearsal and live use.

Built for and around the New Mitchell Park band. Two Macs share the
work: a Mac mini (Librarian) ingests and indexes; a MacBook Pro
(Performer) fetches new songs, makes their stems with Logic Pro's Stem
Splitter, and serves the portal on stage.

**See it working:** open `http://localhost:3000/README.html` from a running
portal for the active infographic, an explanation of every stage with live
readings laid on top.

---

## The shape of the system

```mermaid
flowchart TB
    GH["GitHub · simpleStem repo<br/><i>canonical CODE</i>"]

    subgraph MINI["Mac mini · LIBRARIAN · 8 GB · always on"]
      MC["~/simpleStem-code/<br/>git clone"]
      WW["webloc_watch.sh<br/>ingest + metadata"]
    end

    subgraph LAPTOP["MacBook Pro · PERFORMER · 36 GB · travels"]
      LC["~/simpleStem-code/<br/>git clone"]
      QR["queue_runner.sh + stem.sh<br/>→ Logic stemming queue"]
      PORTAL["bt-construction-kit<br/>portal :3000"]
    end

    subgraph DRIVE["Google Drive · ~/ClaudeDrive/simpleStem/ · DATA only"]
      STEMS["STEMS/&lt;slug&gt;/<br/>STEM_QUEUE/<br/>LOGIC_QUEUE/"]
    end

    GH ==git pull==> MC
    GH ==git pull==> LC
    WW --> STEMS
    STEMS --> QR
    QR --> STEMS
    STEMS --> PORTAL

    classDef machine fill:#f6f8fc,stroke:#3f6fd6,stroke-width:2px;
    classDef data fill:#fdf6e3,stroke:#b58900,stroke-width:1.5px;
    classDef code fill:#eef9e8,stroke:#2e8b57,stroke-width:1.5px;
    class MINI,LAPTOP machine;
    class DRIVE data;
    class GH code;
```

Code lives in GitHub. Both machines clone it onto local disk under
`~/simpleStem-code/`. Drive holds only the data (song folders, queue,
m4as). The machines never share code; they only share the data folder.

Two-machine split exists because stem separation needs Logic Pro and RAM
that the 8 GB mini does not have. The 36 GB laptop owns stemming; the mini
owns 24/7 ingest. Audio is fetched from YouTube **once** (on the mini,
into the cache) and reused by the laptop — the gig tether never hits
YouTube.

---

## Where to go from here

**If you're a bandmate using the portal** —
[USER_GUIDE.md](USER_GUIDE.md) walks through adding a song, finding
songs, the stem mixer, loops, and setlist planning. No internals.

**If you're a developer / forker / project owner** —
[ARCHITECTURE.md](ARCHITECTURE.md) covers the two-machine model, the
end-to-end pipeline, data contracts (`metadata.json`, M4A naming,
slugs), the code map, all Express endpoints, the optional Logic Pro
re-stem hand-off, operations, and the roadmap.

**If you're an AI coding agent** — [CLAUDE.md](CLAUDE.md) is the
project-specific guide loaded automatically each session.

---

## Quick start

### Install

```
./install.sh
```

Installs Homebrew prereqs (ffmpeg, yt-dlp, pipx), then the Python
environment with librosa / soundfile (still installed under the pipx name
`demucs`; the Demucs program itself is no longer used). Idempotent —
re-run if anything is missing.

### Run

```
cd ~/simpleStem-code
(cd bt-construction-kit && npm install)   # once

# Librarian (mini)
./librarian.sh start         # watcher + daily catalog poll

# Performer (laptop)
./performer.sh start         # queue runner (ingest) + portal at :3000
```

Then open <http://localhost:3000>, paste a YouTube URL into "Paste a
YouTube URL", and click Add. The song is fetched in about a minute and is then
in the library marked LOGIC QUEUE, playable as the original stereo. Its six
stems and six drum-kit pieces are made by Logic Pro's Stem Splitter (about
3 minutes per song) when the Logic stemming queue is run from the Performer.

For non-developers, see [USER_GUIDE.md](USER_GUIDE.md). For the
single-machine legacy path or the Docker setup, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## License

Personal project for the New Mitchell Park band. YouTube downloading is
technically against TOS — used here for personal practice and live use.
