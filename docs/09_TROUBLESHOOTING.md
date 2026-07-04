# Troubleshooting

Indexed by symptom. Anything gig-critical also appears in the
[Gig Day Runbook](08_GIG_DAY_RUNBOOK.md); this page adds the at-home and
between-machine problems.

## A song fails to load / "no stems responded after 3s"

**One song fails, the rest play:** the song's stems are missing or
incomplete. Check it on the Librarian dashboard's Library table (search
its title — the **Stems** column shows `N/6`), or open the song's ⋯ menu →
All metadata to see the file inventory. Fix by **Re-fetch** from the ⋯
menu (re-downloads and re-renders) or wait for a pending render. The
portal greys out rows it knows failed to load so you don't hit them
again mid-gig.

**Every song fails, one after another — and the rest of the UI is fine:**
this is almost never the app. It's the Mac's Core Audio daemon
(`coreaudiod`) wedged — usually after an XR18 USB handshake failure. The
tell: audio elements refuse to load *anything* (even other Chrome tabs),
while the network tab / everything else works, and restarting Chrome does
NOT fix it. Don't debug the app. Go straight to the first-aid ladder:
USB unplug/replug at the XR18 end first, then the **first aid** button
(kick coreaudiod) in the mixer header. Playback recovers instantly when
the daemon restarts. Expect the XR18 badge to flash **ORPHANED · 2 ch**
briefly afterward; it normally recovers to 18 channels on its own.

**A stem stalls buffering with the Play Anyway button showing:** on a
cached library this should not happen; note the song and take a snapshot.
Play Anyway starts with whatever has buffered as an escape hatch.

## "SERVER NOT RESPONDING — CLICK HERE TO RESTART" banner

The portal heartbeats the backend and raises this banner when a health
check actually fails. Clicking the banner restarts the backend
(`performer.sh restart`) — the portal reconnects by itself within about
half a minute.

If the banner appears the moment you return to a tab that's been in the
background a while, give it a beat: Chrome throttles background-tab timers,
and the portal fires an immediate fresh probe on focus which clears a
stale banner within a few seconds. (Older builds could show this banner
falsely on a healthy server; that was fixed 2026-07-02 — if you're seeing
chronic false banners, pull latest code.)

If a restart genuinely doesn't bring it back, go to Terminal:

```
cd ~/simpleStem-code
./performer.sh restart
./performer.sh status
```

## Stems missing or partial — the Drive " (1)" problem

Google Drive resolves sync conflicts by keeping both copies and renaming
one `file (1).m4a`. The library scanner ignores these duplicates, but the
underlying conflict can leave a song with a stale or partial stem set.

Recognize it: a song plays with an instrument missing, or the Librarian
health table shows `5/6`, or you find `vocals (1).m4a`-style files inside
`~/ClaudeDrive/simpleStem/STEMS/<song>/`.

Fix: eyeball the song's folder in Finder, trash the ` (N)` copies (keep
the newest good file under the canonical name), then re-run Flash Cache
(Shift-click to force overwrite) so the cache picks up the corrected
files. If the stem set itself is broken, ⋯ → Re-fetch re-renders the song
cleanly.

Prevention: this usually comes from both machines writing the same file,
or from interrupted syncs. Let each machine own its side (Librarian
writes metadata/catalog; Performer writes stems) and give Drive time to
settle after big renders.

## A render failed

The ingest tracker shows *failed*, or the Librarian dashboard's **Render
failures** card has a count. Open the triage page:

```
http://localhost:3000/failed-renders.html
```

Each failed job is listed with its error; you can **retry** or **clear**
per row, or in bulk. The page refreshes itself every 30 seconds. Common
causes: a YouTube URL that went private or region-locked (paste a
different upload via ⋯ → Re-fetch), or a transient download error
(retry usually just works).

## The two machines disagree (Drive sync issues)

Symptoms: a song exists on one machine and not the other; the Performer's
library count differs from the Librarian's catalog count; a brand-new
render shows `0/6` health for a few minutes.

- **Give sync a minute.** The catalog rebuilds within seconds on the
  Librarian, but Drive still has to move files between machines. A fresh
  render showing 0/6 that self-heals shortly after is sync latency, not
  data loss.
- **Check Drive itself.** The Librarian dashboard's Plumbing card shows
  Drive health and latency; "DRIVE OK · 0ms" means the folder is live.
- **Never both at once.** If a file is being edited on both machines in
  the same minute, Drive will fork it into ` (1)` copies (see above).

## Git on two machines

Code moves through GitHub, never through Drive. The rules:

- Both machines: pull before editing, commit small, push promptly.
- **Never run git on both machines at the same moment.**
- The Performer is the primary editor and pusher; the Librarian mostly
  pulls (and its auto-update service pulls for it).

If git refuses to run with `Unable to create '.git/index.lock': File
exists` (leftover lock files), clear them and retry:

```
cd ~/simpleStem-code
rm -f .git/index.lock .git/HEAD.lock .git/objects/maintenance.lock
```

After pulling code on the Performer, `./performer.sh restart` picks it
up; the Librarian's auto-update restarts its own services.

## The Singer or drum pattern I set got reverted

The band's Google Sheet ("New Mitchell Park Song List") is the canonical
source for singer assignments, required members, drum patterns, and
readiness. The Librarian re-syncs it daily and overwrites those fields.
Portal-side edits (the Singer pulldown) are for quick triage; make the
change in the sheet if you want it to stick.

## Sections/automation edits disappeared

Timeline edits save on **SAVE** and auto-save at song end. If you edit
and immediately navigate away mid-song, unsaved changes (the ● dot next
to the action counter) are lost. Get in the habit of hitting SAVE after
an editing session.

## Still stuck

Take a **snapshot** (clipboard icon, or Cmd+Shift+;) before and after
reproducing the problem, note the time, and tell Claude/Bill what you
saw — the snapshot log usually contains the answer.
