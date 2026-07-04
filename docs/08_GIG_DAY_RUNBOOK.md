# Gig day runbook

The checklist and the fixes, in the order you'll need them. The governing
rule behind everything here is the **offline contract**: the venue has no
internet, and every song in the library must play end-to-end from the
laptop's local cache anyway. Everything in this runbook exists to make
that true before you leave, and to recover fast if hardware misbehaves
after you arrive.

## The night before (at home, on wifi)

1. **Update and restart.** In Terminal on the Performer:

   ```
   cd ~/simpleStem-code
   git pull
   ./performer.sh restart
   ```

2. **Flash Cache.** In the portal, click the **Flash Cache** button
   (hard-drive-download icon in the mixer header — or **Cmd+Shift+P**, or
   the button on the library's warning banner if one is showing). It
   copies every song's six stems, every drum pattern, and every clip from
   Drive into `~/.bt-cache`. Progress shows on the button itself; it's
   safe to repeat. **Shift-click** forces overwrite if you suspect stale
   cache files. Wait for it to finish.

3. **The offline test.** This is the one that counts:
   - Play any song, confirm audio.
   - **Turn wifi off.**
   - Reload the portal and play two or three songs from tonight's
     setlists end-to-end, including any drum-machine and backing-track
     songs.
   - Everything must play. Any "failed to load" here is a show-stopper —
     fix it tonight, not at the venue ([09_TROUBLESHOOTING.md](09_TROUBLESHOOTING.md)).
   - Wifi back on.

4. **Walk the setlists.** Open the gig, spot-check song order, singers,
   and that every song's playback mode (stems / drum / backing) is what
   you expect. **Cmd+Shift+B** bounces through four songs automatically
   if you want a quick auto-advance sanity check.

![Flash Cache](images/runbook_flash_cache.png)
*SCREENSHOT: the Flash Cache button showing progress, and the library cache banner cleared*

## At the venue — XR18 hookup and sound check

1. Connect the XR18 by USB. **The XR18 needs USB 2.0** — some downgrading
   adapters will show 18 channels but pass no audio.
2. Set the XR18 as the Mac's output: System Settings → Sound → Output, or
   just click **→ XR18** in the mixer header (it switches the default
   output and reloads the page so Chrome rebinds — your state restores
   automatically).
3. Confirm the badge reads **XR18 ACTIVE · 18 ch out** (green).
4. **Sound Check.** Click the bell icon. It speaks *"Left, Right, One,
   Two, Three, Four, Five, Six"* onto XR18 outputs 1, 2, 11, 12, 13, 14,
   15, 16 in turn — walk the PA and wedges and confirm each lands where
   it should. If everything comes out of the same speaker, the XR18's USB
   Sends/Returns map is sending all USB channels to Main LR: open X-Air →
   Setup → Routing → USB Sends/Returns and map USB 11–16 to six channel
   strips.
5. Check per-strip routing in the mixer console. Each stem's home letter
   (V/D/B/G/P/O) should be lit; add L/R or numeric outputs as the room
   requires. Routing persists between sessions.
6. Click the **snapshot** button (clipboard icon) once everything is
   good — a known-good baseline in the debug log is gold if anything
   degrades later.

## During the gig

- Load the gig, press play on song one; **auto-advance** carries you
  through the setlist. **Cmd+]** skips ahead; **⏭⏭** skips to the next
  section inside a song.
- Song-specific automation (Helix patches, mutes, clips, lyrics) fires
  from each song's timeline on its own.
- Keep hands off anything that isn't the mixer and transport. Do not
  ingest songs, do not run Re-stem, do not touch the Librarian — render
  work does not belong at a gig.
- If a singer steps out: switch to the **🎙 RoundRobin** pseudo-gig or
  skip their songs; see [04_GIGS_AND_SETLISTS.md](04_GIGS_AND_SETLISTS.md).

## When the audio breaks — the first-aid ladder

Symptoms this ladder covers: every song suddenly refuses to start ("no
stems responded after 3s" toasts), the XR18 badge goes red **XR18
ORPHANED**, or output dies mid-song while the UI keeps running.

The ladder below is quoted verbatim from the first-aid button's tooltip
(the medical-briefcase icon in the mixer header). Follow it **in order** —
the button itself is step 2, not step 1:

> ⚠ TRY USB UNPLUG/REPLUG FIRST. First aid kicks coreaudiod
> (sudo killall coreaudiod) — this resets the Mac side of Core Audio but
> can ORPHAN the XR18 when the board's USB endpoint is already flaky.
> Logic will show '(XR18)' in parens (= unavailable) afterward, and
> you'll need a physical USB replug to get it back.
>
> Use this button only when the Mac-side audio daemon is wedged (rare).
> The full recovery ladder, in order:
> 1. Unplug USB at the XR18 end, wait 5s, replug. Switch to Sys Out →
>    switch to XR18.
> 2. IF #1 didn't help: this button (first aid / kick coreaudiod).
> 3. Restart backend (↻ button).
> 4. Power-cycle the XR18 (off, 10s, on). Re-pick XR18 in macOS Sound.
> 5. Try a different USB cable / port. XR18 needs USB 2.0 — downgrading
>    adapters show 18 channels but pass no audio.

Notes from the field:

- The **→ Sys Out** button is your triage fork: switch to the laptop
  speakers and play something. If the speakers work, the problem is the
  XR18 side (ladder steps 1, 4, 5). If even the speakers won't play,
  it's the Mac's audio daemon — that's the coreaudiod wedge, and the
  first-aid button fixes it instantly.
- After a coreaudiod kick the XR18 may briefly show **ORPHANED · 2 ch**
  and then recover to 18 channels on its own; give it a moment before
  escalating.
- Click **snapshot** before and after each step so the debug log captures
  the transition.
- Worst case, stems keep playing through the laptop on **→ Sys Out** —
  a thin mix beats dead air.

## The offline contract, in plain words

If a song shows in the library, its audio is already on this laptop, and
it will play with the wifi dead. That's not best-effort — it's the
contract the whole system is built around. The portal serves audio only
from the local cache, never from Drive, during playback; Drive is touched
only by background copying. If you ever see behavior that smells like
"it's waiting for the network" at a gig, that's a bug worth reporting
with a snapshot — not something to work around by tethering.
