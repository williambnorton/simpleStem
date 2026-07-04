# The Audio Wedge — Deep-Dive Research Report

*Researched 2026-07-04 after three wedges in two days on the Performer. Five
parallel research passes (macOS/coreaudiod history, XR18/X AIR specifics,
community-confirmed fixes, Chromium source analysis, live-rig watchdog
practice), synthesized against our own captured evidence.*

## Executive summary

The "previous AI" was right on both counts, with one refinement each:

1. **coreaudiod wedging IS a known, recurring macOS failure class** — not
   folklore. It is disproportionately reported on Apple Silicon and had
   documented regression waves in Sonoma 14.0–14.4 and Sequoia 15.x. Apple
   itself shipped USB/audio fixes in 14.4.1. Sleep/wake is the most-cited
   trigger. `sudo killall coreaudiod` is the community-canonical recovery
   (`launchctl kickstart -k` of coreaudiod is **blocked since macOS 14.4**).
2. **The XR18 side is real too, but it isn't the firmware "giving up" by
   design** — the board's USB audio runs on an XMOS XS1 controller (with a
   Microchip USB3340 PHY), and the evidence points at the *link* (cable,
   dongle, port, occasionally cracked USB-port solder joints) glitching,
   after which the XMOS endpoint can hang in a state only a physical
   replug/power-cycle resets. Behringer's own firmware 1.23 changelog says
   **"Fixed: USB audio issues (mostly at 44K1)"** — vendor acknowledgment
   that the USB implementation had bugs.

Our triple-symptom pattern is fully explained by a two-sided wedge:

- **Daemon-side wedge** (Jul 3): coreaudiod hung; `killall coreaudiod`
  fixed audio in 4 ms. Classic macOS failure class.
- **Board-side wedge** (Jul 4): the XR18's USB endpoint itself hung;
  killing coreaudiod couldn't help (the fresh daemon re-opened a dead
  endpoint) — only the USB replug reset the XMOS controller.
- **The 2-channel "orphaned" re-enumeration** after a coreaudiod kick
  matches community reports that the X AIR's 2-in/2-out USB mode "doesn't
  seem to work" on Mac and that re-enumeration can land in the wrong mode
  before recovering.

## Why the whole app freezes (Chromium internals)

Chrome runs ALL CoreAudio calls in a separate sandboxed **audio service
process**. That is why HTTP fetches stay perfect while every media element
stalls — network and audio never share a process.

Chromium source facts that matter to us:

- New media elements request **device authorization** from the audio
  service; if CoreAudio is hung this request hangs. Chrome bounds it with a
  **10-second timeout** (crbug 615589), after which playback proceeds into
  a **silent null sink** ("no audio" — useless at a gig, but not a stall).
- simpleStem's stem watchdog fires at **3 seconds** — inside that window.
  So a wedged coreaudiod always presents as *"no stems responded after 3s"*
  before Chrome's own fallback engages. The watchdog isn't wrong — there is
  genuinely no audio coming — but the message can't distinguish "cache
  problem" from "audio device wedged".
- If the audio service's own thread hangs, Chrome kills and relaunches the
  service after **~3 minutes** (AudioThreadHangMonitor). Already-playing
  elements go silent until reloaded.
- After a coreaudiod bounce, client processes (Chrome included) can hold
  corrupted audio state and re-apply it to the fresh daemon — documented in
  the wild. This is why the portal's "STEREO ONLY · CLICK TO RELOAD &
  RE-DETECT" page reload is a required rung of the ladder, not paranoia.

One honest caveat: a strict reading of Chromium's pipeline suggests
metadata (`readyState 1`) should arrive from the demuxer even with a hung
device, yet we observed hard `readyState 0` stalls on an in-memory WAV
blob that cleared the instant audio was fixed. Either audio-only blob
playback takes a path that blocks earlier, or the hung service stalls the
renderer-side decoder setup. Our empirical evidence is unambiguous about
the correlation; the exact Chromium line responsible is not pinned down.

## Evidence highlights (curated citations)

**macOS / coreaudiod (well-corroborated):**
- Apple Dev Forums 742465 — Sonoma 14.0–14.2, M1/M2: coreaudiod crashing
  dozens of times a day, system-wide audio freezes.
- Apple 14.4.1 release notes — fixes for USB hubs and Audio Unit
  validation: Apple shipped, then fixed, USB/audio regressions.
- Apple Dev Forums 748228 — since 14.4 `launchctl kickstart`/`stop` on
  coreaudiod returns "not permitted"; `sudo killall coreaudiod` still works.
- Apple Communities 255788454 — Sequoia 15.x: coreaudiod "resource
  limitation" wedging every audio app (Rogue Amoeba support statement).
- Focusrite official KBs acknowledge Sonoma/Sequoia USB-interface
  recognition bugs with replug as the workaround — the failure class is
  vendor-acknowledged, not XR18-specific.

**XR18 / X AIR (vendor + community):**
- Behringer firmware **v1.23 changelog: "Fixed: USB audio issues (mostly
  at 44K1)"** — run 1.23, stay at 48 kHz (simpleStem is all-48k already).
- Apple Communities 255046431 — XR18 absent from Sound devices on M1;
  fixes: power-cycle the board and wait, different hub, and **set USB mode
  to 18-in/18-out ("the 2 in 2 out doesn't seem to work")** — the 2-ch
  mode is implicated in exactly our "orphaned" symptom.
- Teardown (vogelchr, 2015): XMOS XS1 16-core + USB3340 ULPI PHY — a
  standard class-compliant UAC2 stack; nothing macOS-proprietary.
- Community reports of cracked USB-port solder joints causing intermittent
  XR18 USB failure; USB-2-behind-USB-3/hubs sensitivity reported on both
  Mac and Windows (host-controller sensitivity, not macOS-only).

**Community-confirmed fixes, ranked:**
1. **Single quality USB-C→USB-B cable, ≤2 m, direct into the Mac — no
   dongle, no passive hub.** The strongest fix in confirmed-by-OP threads;
   passive USB-C hubs/dongles with USB-2 devices are a documented MacBook
   failure wave. *This maps directly onto our rig's suspected adapter.*
2. **Firmware 1.23 + USB mode 18/18 + 48 kHz pinned.**
3. **No sleep at gigs** — AC power, lid open, `caffeinate -dims` or
   Amphetamine; sleep/wake is the top wedge trigger.
4. If a hub is truly needed: **externally powered Thunderbolt dock** (the
   only hub class that resolved the MacBook USB-2 disconnect wave).
5. Recovery commands: `sudo killall coreaudiod` (kickstart is blocked
   ≥14.4). Expect to reload the portal tab afterwards.
6. Niche/nuclear: a smart hub with per-port power switching + `uhubctl`
   is the only way to "replug" USB from software on macOS.

Note on the common "disable Wi-Fi/Bluetooth for live rigs" advice (Rane et
al.): our rig *needs* Wi-Fi for X AIR control — skip that one, or move
mixer control to wired Ethernet if radio interference is ever suspected.

## The recovery ladder, annotated with what each rung resets

| Rung | Resets | Right when |
|---|---|---|
| 1. Unplug XR18 USB, wait 5 s, replug | The board's XMOS USB controller | Board-side hang — killall didn't stick (our Jul 4 wedge) |
| 2. `sudo killall coreaudiod` | The macOS audio daemon | Daemon-side hang (our Jul 3 wedge — 4 ms fix). May briefly re-enumerate the board as 2-ch |
| 3. Reload the portal tab | Chrome's client audio state | Always after rungs 1–2 — clients re-apply corrupted state to the fresh daemon |
| 4. Power-cycle the XR18 (10 s off) | Everything board-side | Replug didn't do it; re-pick the device in macOS Sound |
| 5. Different cable / different port | The physical link | Recurring wedges — that link is the prime suspect |

## Recommendations for simpleStem

1. **Hardware first**: replace the cable path with one direct USB-C→B
   cable and retire the dongle. Given three wedges in two days, this is
   the highest-probability permanent fix. Check the board is on firmware
   1.23 and USB mode 18/18.
2. **App-side triage** (small change, big gig value): when the stem
   watchdog fires, automatically run the P7 blob-WAV probe. If the blob
   also fails, show "AUDIO DEVICE WEDGED — first-aid ladder" instead of
   "song failed to load — pick another song", because no song will load
   and the operator should reach for the ladder, not the setlist.
3. **Watchdog pattern** (optional): probe device enumeration from a
   *disposable child process* (a hung CoreAudio call blocks its caller
   forever — the same lesson as the sync-Drive-read postmortem), e.g.
   `system_profiler SPAudioDataType` with a timeout, and surface a red
   banner when the probe hangs. Nobody ships this as a ready-made tool;
   the polling-child pattern is the accepted practice.
4. Keep `sudo killall coreaudiod` wired to the first-aid button (it is
   already) and keep the tooltip's warning — research confirms both the
   usefulness and the orphaning side-effect.

## Source index

Apple Dev Forums threads 742465, 748228 · Apple Communities 255186400,
255788454, 255046431, 252799475, 254719539, 255521879 · Apple 14.4.1
release notes (macrumors.com/2024/03/25) · Focusrite KBs 15437020104082,
23248965091730 · Behringer changelog ideas.behringer.com/changelog/x18-xr18-mr18-firmware-v1-23
· behringer.world t=739 · Cockos forum t=204519 · Steinberg forum 138291 ·
vogelchr.blogspot.com XR18 teardown (2015) · Chromium source:
content_features.cc, audio_device_factory.cc (kMaxAuthorizationTimeout),
audio_renderer_impl.cc (null-sink fallback), audio_thread_hang_monitor.cc
(3-min deadline), services/audio README · crbug 160920, 615589, 422522,
40298707 · webrtc bug 4799 · Hancke "Goodbye macOS WebRTC audio bug" ·
Kevin M. Cox on launchctl kickstart changes in 14.4 · metrovoc gist
(daemon-set restart) · MacRumors 2020 MacBook USB-2 disconnect thread ·
Sweetwater/RØDE/Rane optimization guides · uhubctl (github.com/mvp/uhubctl)
· metalcoder.dev reset-audio recipe.
