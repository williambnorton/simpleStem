# Clip Librarian

A curation surface for `CUSTOM_LOOPS/*.m4a` — the m4a clips that the live App
fires as **Play Clip** actions during a song.

The App itself doesn't fetch or trim clips. It assumes `CUSTOM_LOOPS/` is
populated with finished `.m4a` files; it auto-precaches them so they play
instantly during a gig, no internet required. Putting curation outside the App
is the same model the project already uses for songs (`webloc_watch.sh`,
`metadata.py`, `catalog.py` run on the Song Librarian, not in the portal).

## What goes in CUSTOM_LOOPS/

Just m4a files. Naming is freeform but try to be descriptive:

```
CUSTOM_LOOPS/
  fake_quote_bowie.m4a
  crowd_cheering_short.m4a
  matt_solo_break.m4a
  cowbell_one_shot.m4a
```

That's it. No subfolders, no metadata sidecar, no naming convention to follow.
The App lists every file at boot and surfaces them in:

- The **Sampler panel** in the Clip Library tab — pick one and attach it as an
  item in the active song's ActionSequence
- The **+ CLIP** button under the visualizer — drop a Play Clip action at the
  current playhead, picking from a dropdown

## Two paths for getting audio in

### Easy path — yt-dlp friendly sources

For YouTube, SoundCloud, Vimeo, Bandcamp, anything yt-dlp handles cleanly:

```bash
# Snip a 60-second sample starting at t=120 from a YouTube URL
./fetch_clip.sh \
    --url "https://www.youtube.com/watch?v=Oy0zq8YzY9w&t=120s" \
    --duration 60 \
    --name fake_quote_bowie

# Inspect what landed
ls CUSTOM_LOOPS/

# Trim it down to the actual sample window (in seconds)
./trim_clip.sh CUSTOM_LOOPS/raw_fake_quote_bowie_*.m4a \
    --start 4.2 --end 8.6 \
    --name fake_quote_bowie

# Delete the raw scratch file
rm CUSTOM_LOOPS/raw_*.m4a
```

The fetch script writes raw_*.m4a; the trim script writes the named final.
Same two-stage workflow the in-App editor used, just done at the shell.

### Hard path — sites yt-dlp can't grab (Twitter, etc.)

Some sources rate-limit yt-dlp, hide behind auth, or use weird stream formats.
For those, route system audio through BlackHole and record in Logic Pro.

**One-time setup:**

1. Install **[BlackHole](https://github.com/ExistentialAudio/BlackHole)** —
   `brew install --cask blackhole-2ch`. It's a virtual audio cable.
2. In macOS **Audio MIDI Setup**, create a Multi-Output Device:
   - BlackHole 2ch
   - Your speakers / headphones (so you can hear what you're capturing)
   - This becomes your system audio output during capture.
3. In **Logic Pro**, set the input device to **BlackHole 2ch**.
4. Create a stereo audio track armed to record.

**Per-clip workflow:**

1. Set macOS system output to the Multi-Output Device.
2. Open the video / page in your browser. Play it. Logic captures every
   sample BlackHole sees.
3. Stop the source, stop Logic. Trim the region around the clip you want.
4. Set the cycle range to your clip's bounds.
5. **File → Bounce → Project or Section** with these options:
   - Destination: `~/My Drive/ClaudeDrive/simpleStem/CUSTOM_LOOPS/`
   - Format: M4A
   - Bitrate: 256 kbps stereo
   - Filename: descriptive (e.g. `crowd_cheering_short.m4a`)
6. Set macOS system output back to your normal speakers.

The bounced .m4a lands in CUSTOM_LOOPS/ and Drive sync replicates it to the
Performer. The App's auto-precache pass picks it up on the next sweep
(boot + hourly), or you can force it now with:

```bash
curl -s -X POST http://localhost:3000/api/precache/custom-loops
```

(Performer-side endpoint; documented under "API contract" below.)

### Why bother with Logic Pro?

Three things the in-App workflow couldn't do well:

- **Effects chain.** Squash a hot capture with a limiter, EQ a muddy YouTube
  rip, gate a noisy mic recording — Logic's effects work better and faster
  than anything we'd build into the portal.
- **Multi-region edits.** Splice the middle out of a 12-second clip, fade
  the ends in/out, normalize. Done in Logic in seconds.
- **Bounce settings under your control.** AAC bitrate, sample rate, true peak
  limiting on the bounce, etc. Nothing baked in.

## What's NOT here (intentionally)

- **No fetcher daemon.** The Song Librarian has `webloc_watch.sh` as a
  always-on background process because songs come in piecemeal over weeks.
  Clips are typically curated in a focused 30-minute session, so a CLI you
  invoke when you want it is more honest.
- **No metadata sidecar.** Clips don't carry BPM/key/etc. The filename IS
  the metadata.
- **No catalog.** The App reads CUSTOM_LOOPS/ directly each time
  `/api/custom-loops/list` is called. With ~100 clips this is cheap; if the
  count grows past a thousand we'll add a CATALOG-style cache.

## Files in this directory

- `fetch_clip.sh` — yt-dlp wrapper. Downloads the full audio from a URL into
  CUSTOM_LOOPS/ as `raw_*.m4a` for you to trim.
- `trim_clip.sh` — ffmpeg wrapper. Crops a raw_*.m4a to start/end seconds,
  writes the named final, leaves the raw intact (you delete when ready).
- This README.

## API contract (Performer-side)

The App exposes only **read** endpoints for clips:

- `GET /api/custom-loops/list` → `{ loops: [{ file, url, size, mtime }] }`
- `GET /api/audio/custom-loop/:file` → the m4a, with `~/.bt-cache/` warming
- `DELETE /api/custom-loops/:file` → removes a clip (also clears its cache)
- `POST /api/precache/custom-loops` → forces an immediate warm pass over the
  whole folder (idempotent)

The legacy `POST /api/loops/from-url` and `POST /api/custom-loops/trim`
endpoints have been removed from the App since fetching and trimming live
outside it now. If you need them, they're preserved in the fetch_clip.sh and
trim_clip.sh scripts that wrap the same underlying yt-dlp + ffmpeg calls.
