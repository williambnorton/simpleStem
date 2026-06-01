# simpleStem — architecture (cache model)

This replaces the older split described in `CLAUDE.md`. The heavy memory work
(Demucs) moves to the 36 GB laptop; the always-on 8 GB Mac mini becomes the
**Librarian**. The big audio file is fetched **once** and cached, instead of
being downloaded from YouTube twice (which is what happens today).

## Machines

| Machine | Role | Drive mode | Runs | Never runs |
|---|---|---|---|---|
| **Mac mini** (8 GB, 24/7, external disk) | **Librarian** | mirrors Drive to external disk | ingest + download + metadata + queue + daily catalog poll | Demucs |
| **MacBook Pro** (36 GB, travels to gigs) | **Performer** | streams Drive, pins active jobs | Demucs render + m4a mixdowns + portal | heavy ingest |

Why this split: Demucs needs several GB of RAM and crashed the 8 GB machine.
It belongs on the 36 GB laptop. The mini's jobs are all light and I/O-bound, so
8 GB is plenty, and it can stay on 24/7 with the full library on a big external
disk.

## The cache: `source.wav` is fetched once

Today YouTube is hit twice per song (analyze, then re-download to stem). In the
cache model the Librarian downloads `source.wav` **once** into the canonical
cache location — `STEMS/<slug>/source.wav` — which is exactly where `stem.sh`
already looks. The Performer reuses the cached file (`stem.sh` already skips the
download when `source.wav` exists), so the audio crosses the network once, at
home on wifi, and never touches the gig tether.

For a chaptered "full album", the album video is downloaded once and every
chapter is sliced to its own cached `source.wav` — replacing today's
re-download-per-chapter.

```mermaid
flowchart TD
    subgraph MINI["Mac mini — Librarian (8 GB, 24/7)"]
        IN["INCOMING_WEBLOC/<br/>dropped URLs"]
        WW["webloc_watch.sh<br/>download ONCE + metadata.py"]
        CACHE["STEMS/&lt;slug&gt;/source.wav<br/>+ metadata.json (the cache)"]
        Q["STEM_QUEUE/&lt;slug&gt;.json<br/>tiny job, points at cache"]
        POLL["catalog poll (daily)<br/>build CATALOG.json · fill gaps · flag drift"]
        CAT["CATALOG.json<br/>master index + rendition pointers"]
    end

    subgraph DRIVE["Google Drive (2 TB)"]
        D["mirrors / streams<br/>both machines share this"]
    end

    subgraph LAPTOP["MacBook Pro — Performer (36 GB)"]
        QR["queue_runner.sh + stem.sh<br/>reuse cached source.wav → Demucs"]
        OUT["STEMS/&lt;slug&gt;/ 6 stems + M4A/<br/>-V · -V-G · -V-G-B · DO"]
        PORTAL["bt-construction-kit<br/>plays from CATALOG.json"]
    end

    IN --> WW --> CACHE --> Q
    CACHE --> POLL --> CAT
    Q -.tiny json.-> D -.tiny json.-> QR
    CACHE -.source.wav once, at home.-> D -.-> QR
    QR --> OUT --> D
    OUT --> POLL
    CAT --> PORTAL
```

## Master catalog (`CATALOG.json`)

The Librarian keeps per-song `metadata.json` **and** aggregates them into one
`CATALOG.json` at the repo root. The portal reads the single file and shows only
audio that actually exists. Each song entry carries pointers to its available
renditions:

```json
{
  "magic_man_heart": {
    "title": "Magic Man", "artist": "Heart",
    "bpm": 208.3, "key": "G major", "release_date": "1978",
    "renditions": {
      "stems_dir": "STEMS/magic_man_heart/",
      "m4a": {
        "-V-G":   "M4A/Magic_Man_Heart_-V-G.m4a",
        "-V-G-B": "M4A/Magic_Man_Heart_-V-G-B.m4a",
        "DO":     "M4A/Magic_Man_Heart_DO.m4a"
      }
    },
    "status": "complete"
  }
}
```

## Daily consistency poll (Librarian)

Once a day the mini reconciles the library, **fill-gaps-only** (it never
overwrites good data):

- Scan `STEMS/` and `M4A/`; rebuild `CATALOG.json` with current rendition
  pointers.
- For songs missing tag fields (title/artist/album/year): look them up on
  **MusicBrainz** and fill the blanks.
- For songs missing **bpm/key**: compute locally with librosa from the cached
  `source.wav` (not from the web — web BPM/key is unreliable).
- **Flag** (don't overwrite) mismatches and orphans for review — e.g. the
  current drift of 117 STEMS dirs vs 105 `metadata.json` files.

## Control scripts (same verbs as `studio.sh`)

- **Mini:** `librarian.sh start|stop|restart|status|logs` — runs the watcher and
  the daily catalog poll.
- **Laptop:** `performer.sh start|stop|restart|status|logs` — runs the queue
  runner (Demucs) and, if you want, the portal.

Both follow the exact pidfile/log/tree-kill pattern already in `studio.sh`.

## What changes vs today

- `webloc_watch.sh`: stop deleting the downloaded WAV; write it to
  `STEMS/<slug>/source.wav` (the cache) instead of `/tmp`. Album videos sliced
  once into per-chapter caches.
- `stem.sh`: no change needed — it already reuses an existing `source.wav`.
- New: `catalog.py` (build/refresh `CATALOG.json`, fill gaps, flag drift).
- New: `librarian.sh` and `performer.sh` (split of `studio.sh`'s roles).
- `CLAUDE.md`: update the machine-split section to match this document.
