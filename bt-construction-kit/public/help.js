// help.js — the ? button and per-view help overlay (Bill 2026-08-28).
//
// Creative-user mandate: the portal has four views full of tools the
// operator has not discovered yet. Every view gets a floating ? button
// that opens a full-page guide to THAT view: what it is for, what each
// region does, and the habits worth knowing. Content lives here, keyed
// by page, so all four surfaces share one file and one look.
//
// Offline mandate: no fetches, no remote assets. Everything is inline.
// Test hook: window.ssHelp.open() / .close() for automated checks.

(function () {
  'use strict';

  // ── Which view is this? ──────────────────────────────────────────────
  var path = (location.pathname || '/').toLowerCase();
  var PAGE =
    path.indexOf('librarian') >= 0 ? 'librarian' :
    path.indexOf('midi-console') >= 0 ? 'midi' :
    path.indexOf('desktop-proto') >= 0 ? 'desktop' : 'performer';

  // ── Content ──────────────────────────────────────────────────────────
  // s(heading, [ [name, text], ... ]) builds one section. Plain strings
  // in the list render as paragraphs.
  function s(h, items) { return { h: h, items: items }; }

  var CONTENT = {
    performer: {
      title: '🎛 Performer — the live mixer',
      lead: 'This is the gig surface. Every song is six separate stems (vocals, drums, bass, guitar, piano, other) mixed live in the browser and routed to the XR18. Everything plays from the local cache, so the venue needs no internet.',
      sections: [
        s('Header row', [
          ['Version stamp', 'The build you are running, V1.MMDDHHMM. It advances by itself when newer code lands; no manual bumping.'],
          ['⟳ reset', 'Relaunches the MIDI sidecar and portal server. SAFE: an active render is left alone. The full restart including the render queue lives in the Stem Mixer Console.'],
          ['View buttons', 'Four surfaces of one system: Performer (this mixer), Librarian (the pipeline dashboard), MIDI (the control room), Desktop (a file-level prototype). The lit button is where you are.'],
          ['Flash Cache (hard-drive icon)', 'Forces every song’s stems into ~/.bt-cache before you leave for a gig. Shift-click overwrites files already cached. If a song is in the library, its six stems are on local disk: that is the offline contract.'],
          ['Queue chips', 'Live render status: downloading source, analyzing BPM/key, separating stems (Demucs, 10-25 min per song), mixing m4a. A red ✕ webloc chip means a YouTube URL could not be fetched; hover it for the fix.'],
        ]),
        s('Library', [
          ['Columns', 'Set / Title (with ☆ favorite star) / Artist / Duration / Tempo / Key / Singer / Action (⋯ menu). The singer cell is a pulldown; changing it re-buckets the song in the singer views immediately.'],
          ['Drum pattern pill', 'The opaque pattern tag from the band sheet, like 120@130. Shown next to BPM and key; the drum machine uses it to pick a pattern.'],
          ['Add from YouTube', 'Paste a video or playlist URL. It becomes a .webloc for the Librarian, which downloads the audio and queues the render. A new song appears when Demucs finishes.'],
          ['Filters', 'Tempo, key, singer, readiness. A song with no BPM or tags stays visible when every filter is checked; vanishing rows are a bug, not a feature.'],
        ]),
        s('Gig sidebar: Gig ▸ Setlist ▸ Song', [
          'A performance is a gig holding ordered setlists holding ordered songs. Real gigs are editable files; the picker also offers built-in views that need no setup:',
          ['YouTube Sync', 'Setlists mirrored from YouTube playlists. Read-only, because the next sync would overwrite edits.'],
          ['Manual Setlists', 'Setlists you build in the planner. Fully editable, saved automatically.'],
          ['Recents / Favorites', 'The last 50 songs you loaded, and every song you starred.'],
          ['Singer views + Round Robin', 'Bill, Matt, Dan, and JD each get their bucket, and Round Robin interleaves all four (shuffled) so no singer sings twice in a row.'],
        ]),
        s('Channel strips', [
          ['Fader + mute/solo', 'Per-stem level into the client-side mix. The fader is the single source of loudness truth.'],
          ['+5 / +10 boost', 'Latching gain trims flanking the routing button. They sit on top of the fader and are never recorded into automation: a quiet stem gets help without rewriting the mix.'],
          ['D routing button', 'Sends the stem to its XR18 bus for per-stem front-of-house control.'],
        ]),
        s('Transport, pitch, and the visualizer', [
          ['Scrubbing', 'Click or drag anywhere in the waveform. Lyrics, sections, and automation all follow the playhead in both directions.'],
          ['SEMI knob', 'Transpose ±3 semitones in half-step stops. Tempo moves with pitch by design; that trade keeps the audio path glitch-free.'],
          ['FINE knob', '±50 cents in 1-cent steps for tuning to a recording.'],
          ['Click + Count-in', 'Both act on the CURRENT section’s click flag, not the whole song. They live next to LOOPER because that is where you rehearse.'],
          ['LOOPER', 'Seamlessly repeats the current section for practice. Disengage hands playback back to the normal transport.'],
        ]),
        s('Sections, actions, and the timeline', [
          ['Sections', 'Keys 1-9 drop section markers. Placement snaps to detected boundaries (the faint vertical ticks are the detector’s suggestions) and falls back to the BPM grid.'],
          ['+ Action / + Clip / Skip Section', 'Authoring tools for the yellow automation lane: MIDI events to the Helix, XR18, or Logic, sample clips, and skip jumps. Each event fires as the playhead crosses it.'],
          ['SAVE is the only commit', 'Nothing auto-saves. SAVE persists everything including placed lyric lines. CLEAR wipes actions but keeps sections. INIT replaces only the initial-state event.'],
          ['+ Lyric', 'Places the next cached lyric line at the playhead. When no lines remain the button becomes Fetch Lyrics and opens the editor directly.'],
        ]),
        s('Hardware', [
          ['XR18 button', 'Makes the mixer the audio output. The gig test warns if it is not the default output before the downbeat.'],
          ['MIDI events', 'The browser posts each automation event to the local sidecar, which drives the Helix (U2MIDI), the XR18 (USB), and Logic (IAC bus).'],
        ]),
      ],
    },

    librarian: {
      title: '🤖 Librarian — the pipeline dashboard',
      lead: 'This view watches the song factory: URLs dropped on the Mac mini become analyzed, stem-separated library entries. Use it to see what is flowing, what is stuck, and what the scheduled passes are doing.',
      sections: [
        s('Plumbing and the living pipeline', [
          'The flow reads left to right: INCOMING_WEBLOC (dropped URLs) ▸ STEM_QUEUE (render jobs) ▸ STEMS (finished songs). Counts update live; a growing _failed or a red webloc badge is the thing to investigate.',
          ['✕ webloc failed', 'yt-dlp could not fetch a URL (403, deleted, age-restricted). Delete the .failed file in INCOMING_WEBLOC or fix the URL and re-drop it. Updating yt-dlp on the mini cures most VEVO 403s.'],
          ['Failed renders', 'Demucs crashed or the source was corrupt. The job sits in STEM_QUEUE/_failed so it cannot loop forever.'],
        ]),
        s('Pending & recent', [
          'What is queued right now and what just landed, with the current render’s phase. A new song appears in the library the moment its six stems and metadata exist.',
        ]),
        s('Library statistics + stems health', [
          'Totals for the library plus a per-song completeness check: every song should show 6/6 stems. Anything less is listed with which stems are missing.',
        ]),
        s('Active tasks', [
          'The countdown badges are the scheduled passes: stem precache (hourly), clip, drum, and backing precache (hourly), catalog consistency (hourly on the mini), band-sheet sync (daily). Each badge shows when it last ran and when it fires next.',
        ]),
        s('Librarian daemons', [
          'Status of the services on the Mac mini: the webloc watcher, the cataloger, and the sheet sync. If one is down, run ./librarian.sh start on the mini.',
        ]),
      ],
    },

    midi: {
      title: '🎹 MIDI Console — the control room',
      lead: 'Direct access to the MIDI layer that the Performer view automates: the sidecar on port 5555 and the devices behind it (Helix, XR18, Logic Pro). Use it to test a patch change before trusting it to a song timeline.',
      sections: [
        s('Ports and health', [
          'The sidecar lists every MIDI port it can see. Helix arrives via the U2MIDI Pro cable, the XR18 over USB, Logic over the IAC bus. A missing port usually means a cable; the watchdog restarts the sidecar itself within about 50 seconds.',
        ]),
        s('MIDI CLOCK + CHAIN', [
          'Tempo-synced clock out to the chain so delay times and modulation on the Helix follow the song BPM.',
        ]),
        s('MIDI COMPOSER and MPL', [
          'Compose Program Change and Control Change sequences in MPL, the small MIDI programming language, and send them live. What works here is what a song’s automation lane will do at the same timestamp on stage.',
        ]),
        s('Habits', [
          'Test every new Helix patch number here first: one wrong PC at a gig is a wrong amp on a downbeat. The sidecar matches port names by substring, so renamed devices usually keep working.',
        ]),
      ],
    },

    desktop: {
      title: '🖥 Desktop — the file-level view',
      lead: 'A prototype surface that shows the system the way the disk sees it: song folders, the local cache, and live MIDI instrumentation for each hardware device. It is the inspection hatch, not a performance tool.',
      sections: [
        s('Song folders', [
          'Browse STEMS/ folder by folder: the six stems, source.wav, and metadata.json for each song, as files.',
        ]),
        s('~/.bt-cache — the offline contract on disk', [
          'The local cache that makes a no-internet gig safe. Here you can see it: every library song’s six m4as on the SSD. If a song is missing here, Flash Cache in the Performer view fills it.'],
        ),
        s('Hardware instrumentation', [
          'Live MIDI property cards for the XR18, Helix Stadium, Ditto X4, and Logic Pro: what each device exposes and what the sidecar can drive.',
        ]),
        s('MPL reference', [
          'The MIDI Programming Language docs, rendered in place. The same syntax the MIDI Console’s composer accepts.',
        ]),
      ],
    },
  };

  // ── Styles ───────────────────────────────────────────────────────────
  var css = [
    '#ss-help-btn{position:fixed;right:16px;bottom:16px;z-index:99990;width:40px;height:40px;',
    'border-radius:50%;border:1px solid #94a3b8;background:#1e293b;color:#f1f5f9;',
    'font:700 19px/38px -apple-system,sans-serif;text-align:center;cursor:pointer;',
    'box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.85}',
    '#ss-help-btn:hover{opacity:1;transform:scale(1.06)}',
    '#ss-help-overlay{position:fixed;inset:0;z-index:99991;background:rgba(10,14,20,.72);',
    'display:none;overflow-y:auto;padding:4vh 16px}',
    '#ss-help-overlay.open{display:block}',
    '#ss-help-card{max-width:760px;margin:0 auto;background:#f8fafc;color:#1e293b;',
    'border-radius:12px;padding:26px 30px 34px;box-shadow:0 12px 40px rgba(0,0,0,.5);',
    'font:15px/1.55 -apple-system,BlinkMacSystemFont,sans-serif}',
    '#ss-help-card h1{font-size:1.35rem;margin:0 0 6px}',
    '#ss-help-card .ss-lead{color:#475569;margin:0 0 18px}',
    '#ss-help-card h2{font-size:1.02rem;margin:20px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}',
    '#ss-help-card p{margin:6px 0;color:#334155}',
    '#ss-help-card .ss-item{margin:7px 0}',
    '#ss-help-card .ss-item b{color:#0f172a}',
    '#ss-help-close{float:right;border:none;background:#e2e8f0;color:#334155;border-radius:8px;',
    'padding:5px 12px;font:600 13px -apple-system,sans-serif;cursor:pointer}',
    '#ss-help-close:hover{background:#cbd5e1}',
    '#ss-help-card .ss-foot{margin-top:22px;padding-top:10px;border-top:1px solid #e2e8f0;',
    'color:#64748b;font-size:.82rem}',
  ].join('');

  // ── Build DOM ────────────────────────────────────────────────────────
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render() {
    var c = CONTENT[PAGE];
    var html = '<button id="ss-help-close" title="Close (Esc)">Close ✕</button>';
    html += '<h1>' + esc(c.title) + '</h1><p class="ss-lead">' + esc(c.lead) + '</p>';
    c.sections.forEach(function (sec) {
      html += '<h2>' + esc(sec.h) + '</h2>';
      sec.items.forEach(function (it) {
        if (typeof it === 'string') html += '<p>' + esc(it) + '</p>';
        else html += '<div class="ss-item"><b>' + esc(it[0]) + '.</b> ' + esc(it[1]) + '</div>';
      });
    });
    html += '<div class="ss-foot">The other views have their own ? button. ' +
      'Deeper docs live in USER_GUIDE.md and CLAUDE.md in the code folder.</div>';
    return html;
  }

  function init() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'ss-help-btn';
    btn.textContent = '?';
    btn.title = 'What is this view? Every feature, explained.';
    document.body.appendChild(btn);

    var ov = document.createElement('div');
    ov.id = 'ss-help-overlay';
    ov.innerHTML = '<div id="ss-help-card">' + render() + '</div>';
    document.body.appendChild(ov);

    function open() { ov.classList.add('open'); }
    function close() { ov.classList.remove('open'); }
    btn.addEventListener('click', open);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.getElementById('ss-help-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ov.classList.contains('open')) close();
    });
    window.ssHelp = { open: open, close: close, page: PAGE };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
