// HOLODECK voice control + microphone level meter + named snapshots.
//
// Owns one MediaStream from the operator's microphone. Tees it into:
//   (a) browser SpeechRecognition for voice commands, and
//   (b) a small AnalyserNode for the level meter next to the button.
//
// Activation: click the mic button next to LOOPER. The browser asks for
// mic permission once, then listens continuously for the wake word
// HOLODECK. Anything that does NOT start with HOLODECK is discarded
// silently -- normal stage banter never triggers commands.
//
// Action commands fire silently (so we don't step on the band).
// Query commands speak a short reply via the browser's built-in TTS
// engine. Snapshot commands hit the server-side endpoints in server.js
// (/api/snapshot/save | /list | /restore/:name | /diff/:name).

(function () {
  const WAKE = /\b(holodeck|holo deck|holo-deck)\b/i;

  let recognition = null;
  let audioCtx = null;
  let analyser = null;
  let mediaStream = null;
  let meterRAF = 0;
  let listening = false;

  // --- status ribbon (toast for transient messages) ---------------------
  function ensureRibbon() {
    let el = document.getElementById('holodeck-status');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'holodeck-status';
    el.className = 'holodeck-status';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }
  function showStatus(text, ms = 3500, err = false) {
    const el = ensureRibbon();
    el.textContent = text;
    el.classList.toggle('error', err);
    el.style.display = '';
    clearTimeout(el._h);
    el._h = setTimeout(() => { el.style.display = 'none'; }, ms);
  }

  // --- HOLODECK console (floating panel) --------------------------------
  // A persistent bottom-right panel that gives the operator visibility
  // into what HOLODECK is hearing and how each phrase is being processed.
  // Contains a real segmented VU meter, the raw recognized transcript,
  // the parsed command (after the wake word is stripped), the dispatch
  // result, and a rolling log of the last 8 recognitions. This is the
  // primary diagnostic surface when commands stop working.
  const VU_SEGMENTS = 20;
  const LOG_MAX = 8;
  const transcriptLog = [];   // newest first; each { kind, raw, parsed, result, at }
  let peakHoldLevel = 0;
  let peakHoldT = 0;

  function ensureConsole() {
    let el = document.getElementById('holodeck-console');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'holodeck-console';
    el.className = 'holodeck-console';
    el.innerHTML = `
      <div class="hc-header">
        <span class="hc-title">HOLODECK Console</span>
        <span class="hc-state" id="hc-state">○ stopped</span>
        <button class="hc-close" id="hc-close" title="Hide console (HOLODECK keeps listening)" type="button">×</button>
      </div>
      <div class="hc-diag">
        <div class="hc-diag-row">
          <span class="hc-diag-key">Mic</span>
          <select id="hc-mic-select" class="hc-mic-select" title="Switch microphone input">
            <option value="">(default)</option>
          </select>
        </div>
        <div class="hc-diag-row">
          <span class="hc-diag-key">Stream</span><span class="hc-diag-val" id="hc-stream-state">—</span>
        </div>
        <div class="hc-diag-row">
          <span class="hc-diag-key">AudioCtx</span><span class="hc-diag-val" id="hc-actx-state">—</span>
        </div>
        <div class="hc-diag-row">
          <span class="hc-diag-key">RMS</span><span class="hc-diag-val" id="hc-rms">0.000</span>
          <span class="hc-diag-key" style="margin-left:8px;">Peak</span><span class="hc-diag-val" id="hc-peakraw">0</span>
        </div>
      </div>
      <div class="hc-vu-row">
        <span class="hc-vu-label">VU</span>
        <div class="hc-vu" id="hc-vu" aria-label="microphone level">
          ${Array.from({ length: VU_SEGMENTS }, (_, i) => `<span class="hc-vu-seg" data-i="${i}"></span>`).join('')}
          <span class="hc-vu-peak" id="hc-vu-peak"></span>
        </div>
        <span class="hc-vu-db" id="hc-vu-db">-∞</span>
      </div>
      <div class="hc-now">
        <div class="hc-row"><span class="hc-row-key">Heard</span><span class="hc-row-val" id="hc-heard">—</span></div>
        <div class="hc-row"><span class="hc-row-key">Command</span><span class="hc-row-val" id="hc-cmd">—</span></div>
        <div class="hc-row"><span class="hc-row-key">Result</span><span class="hc-row-val" id="hc-res">—</span></div>
      </div>
      <div class="hc-log-head">Recent</div>
      <div class="hc-log" id="hc-log"></div>
    `;
    document.body.appendChild(el);
    document.getElementById('hc-close').addEventListener('click', () => { el.style.display = 'none'; });
    populateMicSelector();
    document.getElementById('hc-mic-select').addEventListener('change', async (e) => {
      const deviceId = e.target.value;
      try { localStorage.setItem('holodeck_mic_id', deviceId); } catch (er) {}
      if (listening) {
        await stopListening();
        await new Promise(r => setTimeout(r, 200));
        startListening();
      }
    });
    return el;
  }

  // Populate the device picker from enumerateDevices(). Labels are only
  // available after the user has granted mic permission at least once;
  // before that the dropdown shows "(microphone N)" placeholders.
  async function populateMicSelector() {
    const sel = document.getElementById('hc-mic-select');
    if (!sel) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      const saved = (() => { try { return localStorage.getItem('holodeck_mic_id') || ''; } catch (e) { return ''; } })();
      sel.innerHTML = '<option value="">(default)</option>' + mics.map((d, i) => {
        const label = d.label || `microphone ${i + 1}`;
        const selected = d.deviceId === saved ? ' selected' : '';
        return `<option value="${d.deviceId}"${selected}>${label.replace(/[<>"&]/g, '')}</option>`;
      }).join('');
    } catch (e) { console.warn('[HOLODECK] enumerateDevices failed:', e); }
  }
  function showConsole(show) {
    const el = ensureConsole();
    el.style.display = show ? '' : 'none';
  }
  function setConsoleState(text, cls) {
    const el = document.getElementById('hc-state');
    if (!el) return;
    el.textContent = text;
    el.className = 'hc-state ' + (cls || '');
  }

  // Update the VU meter from the analyser's current RMS level (0..1).
  function setVU(level) {
    const segs = document.querySelectorAll('#hc-vu .hc-vu-seg');
    const lit = Math.round(level * VU_SEGMENTS);
    segs.forEach((s, i) => s.classList.toggle('lit', i < lit));
    // Peak hold: track the highest level seen recently, drop slowly.
    const now = performance.now();
    if (level >= peakHoldLevel) {
      peakHoldLevel = level;
      peakHoldT = now;
    } else if (now - peakHoldT > 800) {
      peakHoldLevel = Math.max(0, peakHoldLevel - 0.02);
    }
    const peakEl = document.getElementById('hc-vu-peak');
    if (peakEl) peakEl.style.left = `calc(${Math.min(1, peakHoldLevel) * 100}% - 2px)`;
    // dB-ish readout (rough): 20·log10(level). -inf when silent.
    const dbEl = document.getElementById('hc-vu-db');
    if (dbEl) {
      const db = level > 0.001 ? Math.max(-40, Math.min(0, 20 * Math.log10(level))).toFixed(0) : null;
      dbEl.textContent = db === null ? '-∞' : (db + ' dB');
    }
  }

  // Push a recognition into the log + update the "now" rows. kind is
  // 'cmd' (recognized + dispatched OK), 'unk' (HOLODECK heard but no
  // matching command), 'nowake' (heard but wake word was absent).
  function logRecognition(kind, raw, parsed, result) {
    transcriptLog.unshift({ kind, raw, parsed, result, at: new Date() });
    if (transcriptLog.length > LOG_MAX) transcriptLog.length = LOG_MAX;
    // Refresh "now" rows
    const heardEl = document.getElementById('hc-heard');
    const cmdEl   = document.getElementById('hc-cmd');
    const resEl   = document.getElementById('hc-res');
    if (heardEl) heardEl.textContent = raw || '—';
    if (cmdEl) {
      cmdEl.textContent = parsed || (kind === 'nowake' ? '(no wake word)' : '—');
      cmdEl.classList.toggle('faded', !parsed);
    }
    if (resEl) {
      resEl.textContent = result || '—';
      resEl.classList.remove('ok', 'err', 'meh');
      resEl.classList.add(kind === 'cmd' ? 'ok' : kind === 'unk' ? 'err' : 'meh');
    }
    // Refresh log
    const logEl = document.getElementById('hc-log');
    if (logEl) {
      logEl.innerHTML = transcriptLog.map(e => {
        const icon = e.kind === 'cmd' ? '✓' : e.kind === 'unk' ? '✗' : '○';
        const iconCls = e.kind === 'cmd' ? 'ok' : e.kind === 'unk' ? 'err' : 'meh';
        const time = e.at.toLocaleTimeString([], { hour12: false });
        const label = e.parsed ? e.parsed : e.raw;
        return `<div class="hc-log-row">
          <span class="hc-log-icon ${iconCls}">${icon}</span>
          <span class="hc-log-time">${time}</span>
          <span class="hc-log-text" title="${escapeAttr(e.raw)}">${escapeAttr(label)}</span>
        </div>`;
      }).join('');
    }
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  }
  function tts(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch (e) { console.warn('[HOLODECK] TTS failed:', e); }
  }

  // --- helpers ----------------------------------------------------------
  function clickById(id) {
    const el = document.getElementById(id);
    if (el) { el.click(); return true; }
    return false;
  }
  function clickQ(sel) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }
    return false;
  }
  function stripByChan(chan) { return document.querySelector('.' + chan + '-strip'); }

  // Seek every audio element to a time, defensively.
  function seekTo(t) {
    if (!window.audioElements) return;
    Object.values(window.audioElements).forEach(a => { try { a.currentTime = t; } catch (e) {} });
  }

  function seekToSection(name) {
    const sections = window.automationSections || [];
    const wanted = name.toLowerCase();
    const sec = sections.find(s => (s.label || '').toLowerCase().includes(wanted));
    if (sec) {
      seekTo(sec.t);
      showStatus(`Jumped to ${sec.label || name}`);
    } else {
      tts(`No ${name} section in this song.`);
    }
  }

  function toggleStripBtn(chan, kind, want) {
    const strip = stripByChan(chan);
    if (!strip) return;
    const btn = strip.querySelector('.' + kind + '-btn');
    if (!btn) return;
    const active = btn.classList.contains('active');
    if ((want && !active) || (!want && active)) btn.click();
  }

  function boostStrip(chan, db) {
    const strip = stripByChan(chan);
    if (!strip) return;
    const btn = strip.querySelector('.boost-' + db);
    if (btn) btn.click();
  }

  function nudgeFader(chan, delta) {
    if (!window.mixerState) return;
    const cur = window.mixerState.volumes[chan] || 0;
    const v = Math.max(0, Math.min(1, cur + delta));
    window.mixerState.volumes[chan] = v;
    if (typeof applyMixerVolumes === 'function') applyMixerVolumes();
    const strip = stripByChan(chan);
    const slider = strip && strip.querySelector('input[type="range"]');
    if (slider) {
      slider.value = v;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function nudgeSpeed(d) {
    const slider = document.getElementById('speed-slider');
    if (!slider) return;
    slider.value = Math.max(0.5, Math.min(1.5, parseFloat(slider.value) + d));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function setSpeed(v) {
    const slider = document.getElementById('speed-slider');
    if (!slider) return;
    slider.value = v;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function nudgePitch(deltaSemi) {
    if (typeof window.setPitch === 'function' && typeof window.pitchSemis === 'number') {
      window.setPitch('coarse', window.pitchSemis + deltaSemi);
    } else {
      const dir = deltaSemi > 0 ? '+1' : '-1';
      clickQ('.pitch-step-btn[data-knob="coarse"][data-dir="' + dir + '"]');
    }
  }
  function resetPitch() { clickById('btn-pitch-reset'); }

  function librarySearch(q) {
    const s = document.getElementById('song-search');
    if (!s) return;
    s.value = q;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    showStatus(`Searching: ${q}`);
  }
  function libraryLoad(q) {
    librarySearch(q);
    setTimeout(() => clickQ('.song-row'), 350);
  }
  // "Play <song name>" — filter the library to the query, then click the
  // first row's play button (the .play-row-btn — that's the codepath in
  // app.js that calls loadSong with { autoplay: true }). If no row
  // appears after the search, fall back to a TTS "not found" reply so
  // the operator hears the failure mode.
  function libraryPlay(q) {
    librarySearch(q);
    setTimeout(() => {
      const row = document.querySelector('.song-list-body .song-row');
      if (!row) { tts(`No song matching ${q}.`); return; }
      const playBtn = row.querySelector('.play-row-btn');
      if (playBtn) {
        playBtn.click();
        const titleEl = row.querySelector('.song-title-cell span');
        const heard = titleEl ? titleEl.textContent.trim() : q;
        showStatus(`▶ Playing: ${heard}`);
      } else {
        // Older builds without per-row play button: fall back to row click.
        row.click();
      }
    }, 400);
  }

  function switchToGig(slug) {
    const picker = document.getElementById('gig-picker');
    if (!picker) return;
    picker.value = slug;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function currentKey() {
    const k = document.getElementById('active-key')?.textContent?.trim() || 'Unknown';
    return `The key is ${k}.`;
  }
  function currentTempo() {
    const b = document.getElementById('active-bpm-value')?.textContent?.trim() || 'Unknown';
    return `The tempo is ${b} beats per minute.`;
  }
  function currentSinger() {
    const title = document.getElementById('active-track-title')?.textContent?.trim() || '';
    if (Array.isArray(window.mergedLibrary)) {
      const m = window.mergedLibrary.find(m => (m.title || '').trim() === title);
      const v = m && m.variants && m.variants.find(v => v.type === 'stems');
      if (v && v.singer_lead) return `${v.singer_lead} sings this one.`;
    }
    return 'No singer assigned to this song.';
  }

  // --- snapshots --------------------------------------------------------
  function collectClientState() {
    const state = {};
    try {
      const keys = ['bt_master_volume', 'simpleStem.vizMode'];
      keys.forEach(k => { const v = localStorage.getItem(k); if (v != null) state[k] = v; });
      if (window.mixerState) state.mixerState = JSON.parse(JSON.stringify(window.mixerState));
      if (window.routingMatrix) state.routingMatrix = JSON.parse(JSON.stringify(window.routingMatrix));
    } catch (e) {}
    return state;
  }
  function restoreClientState(state) {
    try {
      Object.keys(state || {}).forEach(k => {
        if (k === 'mixerState' || k === 'routingMatrix') return;
        if (typeof state[k] === 'string') localStorage.setItem(k, state[k]);
      });
    } catch (e) {}
  }

  async function saveSnapshot(rawName) {
    const name = (rawName || '').replace(/[^a-z0-9 _-]/gi, '').trim();
    if (!name) { tts('Snapshot name was empty.'); return; }
    showStatus(`Saving snapshot: ${name}...`);
    try {
      const r = await fetch('/api/snapshot/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, client_state: collectClientState() }),
      });
      const d = await r.json();
      if (r.ok) {
        showStatus(`✓ Saved: ${name}`);
        try { localStorage.setItem('holodeck_last_snapshot', name); } catch (e) {}
        tts(`Saved as ${name}.`);
      } else {
        tts(`Save failed: ${d.error || 'unknown'}.`);
      }
    } catch (e) { tts('Save failed.'); }
  }

  async function restoreLastSnapshot() {
    let last = null;
    try { last = localStorage.getItem('holodeck_last_snapshot'); } catch (e) {}
    if (!last) {
      try {
        const d = await fetch('/api/snapshot/list').then(r => r.json());
        if (d.snapshots && d.snapshots.length) last = d.snapshots[0].name;
      } catch (e) {}
    }
    if (!last) { tts('No previous snapshot to go back to.'); return; }
    restoreSnapshot(last);
  }

  async function restoreSnapshot(rawName) {
    const name = (rawName || '').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
    if (!name) { tts('Snapshot name was empty.'); return; }
    showStatus(`Restoring: ${name}...`);
    try {
      const r = await fetch('/api/snapshot/restore/' + encodeURIComponent(name), { method: 'POST' });
      const d = await r.json();
      if (r.ok) {
        if (d.client_state) restoreClientState(d.client_state);
        tts(`Restored ${name}. Reloading.`);
        setTimeout(() => location.reload(), 1500);
      } else {
        tts(`Restore failed: ${d.error || 'unknown'}.`);
      }
    } catch (e) { tts('Restore failed.'); }
  }

  async function diffSnapshot(rawName) {
    const name = (rawName || '').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_');
    if (!name) { tts('Snapshot name was empty.'); return; }
    try {
      const d = await fetch('/api/snapshot/diff/' + encodeURIComponent(name)).then(r => r.json());
      if (d.changes && d.changes.length) {
        const n = d.changes.length;
        showStatus(`${n} file${n === 1 ? '' : 's'} changed since ${name}: ${d.changes.slice(0, 3).join(', ')}${n > 3 ? ', ...' : ''}`, 6000);
        tts(`${n} file${n === 1 ? '' : 's'} changed since ${name}.`);
      } else {
        tts(`Nothing changed since ${name}.`);
      }
    } catch (e) { tts('Diff failed.'); }
  }

  // --- command vocabulary -----------------------------------------------
  const STEM = '(vocals|drums|bass|guitar|piano|other)';
  const SEC  = '(intro|verse|chorus|bridge|solo|outro|pre|tag|break|hook)';
  const SING = '(bill|matt|dan|jd)';
  const COMMANDS = [
    // Transport. The bare "play" / "pause" toggles the current song; the
    // longer forms ("play back in black") interpret the trailing text as
    // a library search and play the top match with autoplay. Order matters
    // here only for readability — each regex is anchored ^...$, so they
    // do not overlap.
    { re: new RegExp('^play (?:me |the song )?(.+)$'), fn: (m) => libraryPlay(m[1]) },
    // Bare transport verbs are 'fuzzy': they also match when the phrase
    // arrives padded with music bleed ("...holodeck pause [lyric words]").
    // pause/play check the transport state so a mis-toggled play-pause
    // button can't do the opposite of what was asked.
    { re: new RegExp('^play$'),  fuzzy: true, fn: () => transportIntent('play') },
    { re: new RegExp('^(?:pause|paws|paus)(?: it| the song| song| playback| the music| music)?$'),
      fuzzy: true, fn: () => transportIntent('pause') },
    { re: new RegExp('^stop(?: it| the song| song| playback| the music| music)?$'),
      fuzzy: true, fn: () => clickById('btn-stop') },
    { re: new RegExp('^next( song)?$'), fuzzy: true, fn: () => clickById('btn-go-next') },
    { re: new RegExp('^restart( song)?$'), fuzzy: true, fn: () => seekTo(0) },

    // Sections
    { re: new RegExp('^jump to ' + SEC + '$'),     fn: (m) => seekToSection(m[1]) },
    { re: new RegExp('^go to ' + SEC + '$'),       fn: (m) => seekToSection(m[1]) },
    { re: new RegExp('^loop( this)? section$'),    fn: () => clickById('btn-section-looper') },
    { re: new RegExp('^stop loop(ing)?$'),         fn: () => { const b = document.getElementById('btn-section-looper'); if (b && b.classList.contains('active')) b.click(); } },

    // Mixer
    { re: new RegExp('^mute '   + STEM + '$'),     fn: (m) => toggleStripBtn(m[1], 'mute', true)  },
    { re: new RegExp('^unmute ' + STEM + '$'),     fn: (m) => toggleStripBtn(m[1], 'mute', false) },
    { re: new RegExp('^solo '   + STEM + '$'),     fn: (m) => toggleStripBtn(m[1], 'solo', true)  },
    { re: new RegExp('^unsolo ' + STEM + '$'),     fn: (m) => toggleStripBtn(m[1], 'solo', false) },
    { re: new RegExp('^boost '  + STEM + '( ten| five)?$'),
                                                  fn: (m) => boostStrip(m[1], m[2] && m[2].includes('ten') ? 10 : 5) },
    { re: new RegExp('^'        + STEM + ' (up|down)$'),
                                                  fn: (m) => nudgeFader(m[1], m[2] === 'up' ? 0.1 : -0.1) },

    // Click / count-in
    { re: new RegExp('^click on$'),  fuzzy: true, fn: () => clickById('btn-click-toggle') },
    { re: new RegExp('^click off$'), fuzzy: true, fn: () => clickById('btn-click-toggle') },
    { re: new RegExp('^count in$'),  fuzzy: true, fn: () => clickById('btn-count-in-toggle') },

    // Help panel
    { re: new RegExp('^(?:list|show)(?: me)?(?: the| all)? commands$|^help$|^what can i say$'),
      fuzzy: true, fn: () => showCommandHelp() },
    { re: new RegExp('^(?:close|hide)(?: the)? (?:commands|help|command list)$'),
      fuzzy: true, fn: () => hideCommandHelp() },

    // Speed / pitch
    { re: new RegExp('^tempo up$'),       fn: () => nudgeSpeed( 0.05) },
    { re: new RegExp('^tempo down$'),     fn: () => nudgeSpeed(-0.05) },
    { re: new RegExp('^reset tempo$'),    fn: () => setSpeed(1.0) },
    { re: new RegExp('^pitch up( half)?$'),   fn: () => nudgePitch( 0.5) },
    { re: new RegExp('^pitch down( half)?$'), fn: () => nudgePitch(-0.5) },
    { re: new RegExp('^reset pitch$'),    fn: resetPitch },

    // Library / favorites
    { re: new RegExp('^favorite( this)?$'), fn: () => clickById('active-track-star') },
    { re: new RegExp('^star( this)?$'),     fn: () => clickById('active-track-star') },
    { re: new RegExp('^find (.+)$'),        fn: (m) => librarySearch(m[1]) },
    { re: new RegExp('^load (.+)$'),        fn: (m) => libraryLoad(m[1]) },
    { re: new RegExp('^search (.+)$'),      fn: (m) => librarySearch(m[1]) },

    // Gigs
    { re: new RegExp('^switch to ' + SING + ' songs$'), fn: (m) => switchToGig('__' + m[1] + '_songs__') },
    { re: new RegExp('^switch to round ?robin$'),       fn: () => switchToGig('__round_robin__') },
    { re: new RegExp('^switch to favorites$'),          fn: () => switchToGig('__favorites__') },
    { re: new RegExp('^switch to recents$'),            fn: () => switchToGig('__recents__') },

    // Sound check
    { re: new RegExp('^sound ?check$'), fn: () => clickById('btn-sound-check') },

    // Queries (spoken reply). Apostrophes optional because some
    // recognizers transcribe "what's" as "whats" or as "what is".
    { re: new RegExp("^what(?:'s| is| s)? the key$"),   fn: () => tts(currentKey()) },
    { re: new RegExp("^what(?:'s| is| s)? the tempo$"), fn: () => tts(currentTempo()) },
    { re: new RegExp("^who sings this( one)?$"),         fn: () => tts(currentSinger()) },

    // Snapshots
    { re: new RegExp('^save( this)? as (.+)$'),                        fn: (m) => saveSnapshot(m[2]) },
    { re: new RegExp('^name (?:the current state|this) (.+)$'),        fn: (m) => saveSnapshot(m[1]) },
    { re: new RegExp('^snapshot (?:this )?(?:as )?(.+)$'),             fn: (m) => saveSnapshot(m[1]) },
    { re: new RegExp('^go back( a version)?$'),                         fn: restoreLastSnapshot },
    { re: new RegExp('^undo$'),                                         fn: restoreLastSnapshot },
    { re: new RegExp('^restore (.+)$'),                                 fn: (m) => restoreSnapshot(m[1]) },
    { re: new RegExp('^what changed since (.+)$'),                      fn: (m) => diffSnapshot(m[1]) },
  ];

  // Transport intents that respect the CURRENT state, so "pause" while
  // already paused can't start playback via the shared toggle button.
  function transportIntent(kind) {
    const playing = (typeof window.clickPlaybackState === 'function')
      ? !!window.clickPlaybackState().playing : null;
    if (kind === 'pause') {
      if (playing === false) { tts('Already paused.'); return; }
      clickById('btn-play-pause');
    } else if (kind === 'play') {
      if (playing === true) { tts('Already playing.'); return; }
      clickById('btn-play-pause');
    }
  }

  // Dispatch returns one of 'ok', 'err'. raw is the original transcript
  // (with wake word) so the console can show what HOLODECK actually heard,
  // not just the stripped command.
  function dispatch(command, raw) {
    for (const c of COMMANDS) {
      const m = command.match(c.re);
      if (m) {
        try {
          c.fn(m);
          showStatus(`✓ ${command}`);
          flashCommand('✓ ' + command, 'cmd');
          logRecognition('cmd', raw || command, command, '✓ executed');
        } catch (e) {
          console.error('[HOLODECK] command error:', e);
          showStatus(`✗ ${command} — ${e.message}`, 4000, true);
          flashCommand('✗ ' + command, 'unk');
          logRecognition('unk', raw || command, command, '✗ ' + e.message);
        }
        return 'ok';
      }
    }
    // Fuzzy fallback (Bill 2026-07-12: "pause"/"stop" failed while music
    // played). With the band sounding, the recognizer pads the phrase
    // with lyric bleed — "holodeck pause oh baby" — so anchored regexes
    // miss. Retry the FUZZY-flagged commands (short, unambiguous verbs)
    // against the leading and trailing 1-3 words of the transcript.
    const words = command.split(/\s+/);
    if (words.length > 1) {
      for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
        for (const piece of [words.slice(0, n).join(' '), words.slice(-n).join(' ')]) {
          for (const c of COMMANDS) {
            if (!c.fuzzy) continue;
            const m = piece.match(c.re);
            if (m) {
              try {
                c.fn(m);
                showStatus(`✓ ${piece} (from "${command}")`);
                flashCommand('✓ ' + piece, 'cmd');
                logRecognition('cmd', raw || command, piece, '✓ fuzzy match');
              } catch (e) {
                logRecognition('unk', raw || command, piece, '✗ ' + e.message);
              }
              return 'ok';
            }
          }
        }
      }
    }
    showStatus(`✗ Unknown: "${command}"`, 3500, true);
    flashCommand('✗ ' + command, 'unk');
    logRecognition('unk', raw || command, command, '✗ no matching command');
    // Spoken feedback so the operator knows the failure was at parse,
    // not at recognition. Kept short so it doesn't step on the band.
    try { tts(`I didn't understand "${command}".`); } catch (e) {}
    return 'err';
  }

  // --- mic + recognition ------------------------------------------------
  async function startListening() {
    if (listening) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showStatus('Voice recognition is not supported in this browser.', 6000, true);
      return;
    }

    // Use the saved deviceId if the operator picked a specific mic via
    // the console's dropdown. Falls back to the browser default when no
    // pick has been saved.
    let savedMic = '';
    try { savedMic = localStorage.getItem('holodeck_mic_id') || ''; } catch (e) {}
    const constraints = savedMic
      ? { audio: { deviceId: { exact: savedMic } } }
      : { audio: true };
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('[HOLODECK] getUserMedia failed:', e);
      showStatus('Microphone permission denied or device unavailable.', 6000, true);
      return;
    }
    // After the first permission grant, device labels become available --
    // refresh the picker so the operator sees real names.
    populateMicSelector();

    // Level meter
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Chrome sometimes starts the context in 'suspended' state until a
      // user gesture has fully propagated. Force-resume so the analyser
      // actually receives audio frames; otherwise drawMeter sees all-
      // 128 byte values and the meter is stuck at 0.
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) { console.warn('[HOLODECK] audioCtx resume failed:', e); }
      }
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      src.connect(analyser);
      drawMeter();
      console.log('[HOLODECK] mic up:', mediaStream.getAudioTracks().map(t => t.label || '(no label)').join(', '), '| audioCtx:', audioCtx.state);
    } catch (e) { console.warn('[HOLODECK] meter init failed:', e); }

    // Speech recognition. interimResults: true so we can show the
    // operator the live transcript as they're speaking, not just after
    // they pause. Only FINAL results trigger command dispatch -- interim
    // text only updates the "Heard" line in the console + the flash.
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = handleResult;
    recognition.onerror = (e) => {
      console.warn('[HOLODECK] recognition error:', e.error);
    };
    recognition.onend = () => {
      if (listening) {
        setTimeout(() => { try { recognition.start(); } catch (e) {} }, 250);
      }
    };
    try { recognition.start(); } catch (e) { console.warn('[HOLODECK] start failed:', e); }

    listening = true;
    setMicButtonState(true);
    showStatus('🎤 HOLODECK listening. Say "HOLODECK, ..." to command.', 4500);
    showConsole(true);
    setConsoleState('● listening', 'on');
  }

  function stopListening() {
    listening = false;
    try { recognition && recognition.stop(); } catch (e) {}
    try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { audioCtx && audioCtx.close(); } catch (e) {}
    recognition = null;
    mediaStream = null;
    audioCtx = null;
    analyser = null;
    cancelAnimationFrame(meterRAF);
    setMicLevel(0);
    setVU(0);
    setMicButtonState(false);
    setConsoleState('○ stopped', '');
    showStatus('HOLODECK stopped listening.', 2500);
  }

  function handleResult(event) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const transcript = (r[0].transcript || '').trim();
      // Interim results: show them live in the console + the flash so
      // the operator sees what HOLODECK thinks they're saying AS they
      // speak. Do NOT dispatch -- only final results trigger commands.
      if (!r.isFinal) {
        updateInterim(transcript);
        continue;
      }
      // Final results: log + dispatch.
      // Log everything, including phrases without the wake word, so the
      // operator can see what HOLODECK is actually hearing. The wake-word
      // filter is only the gate that decides whether to ACT on a phrase.
      if (!WAKE.test(transcript)) {
        clearInterim();
        logRecognition('nowake', transcript, null, '○ no wake word');
        continue;
      }
      const command = transcript
        .replace(WAKE, '')
        .replace(/^[,\s]+/, '')
        .replace(/[.,!?]+$/, '')
        .trim()
        .toLowerCase();
      clearInterim();
      if (!command) {
        showStatus('HOLODECK heard you. Awaiting command...');
        logRecognition('nowake', transcript, null, '○ wake word only');
        continue;
      }
      dispatch(command, transcript);
    }
  }

  // Live "Heard" line update during interim recognition.
  function updateInterim(transcript) {
    const heardEl = document.getElementById('hc-heard');
    if (heardEl) {
      heardEl.textContent = transcript + ' …';
      heardEl.classList.add('interim');
    }
    flashCommand(transcript, 'interim');
  }
  function clearInterim() {
    const heardEl = document.getElementById('hc-heard');
    if (heardEl) heardEl.classList.remove('interim');
  }

  // Big heads-up flash overlay: pops the recognized command in large
  // text in the center-top of the screen for ~1.5 seconds. Two states:
  //   'interim' (yellow, dashed border, "…" suffix) -- live transcript
  //   'cmd'     (green, solid border)               -- dispatched OK
  //   'unk'     (red,   solid border)               -- failed match
  let _flashEl = null;
  let _flashHideTimer = 0;
  function ensureFlash() {
    if (_flashEl) return _flashEl;
    _flashEl = document.createElement('div');
    _flashEl.id = 'holodeck-flash';
    _flashEl.className = 'holodeck-flash';
    _flashEl.style.display = 'none';
    document.body.appendChild(_flashEl);
    return _flashEl;
  }
  function flashCommand(text, kind, ms) {
    const el = ensureFlash();
    el.textContent = text;
    el.className = 'holodeck-flash kind-' + (kind || 'cmd');
    el.style.display = '';
    clearTimeout(_flashHideTimer);
    const hideAfter = ms || (kind === 'interim' ? 1500 : 1800);
    _flashHideTimer = setTimeout(() => { el.style.display = 'none'; }, hideAfter);
  }

  let _diagFrameCounter = 0;
  function drawMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0, peakRaw = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
      const av = Math.abs(data[i] - 128);
      if (av > peakRaw) peakRaw = av;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 4);
    setMicLevel(level);
    setVU(level);
    // Update numeric diagnostic readouts at ~4 Hz so the values are
    // readable without strobing.
    if ((_diagFrameCounter++ & 15) === 0) {
      const rmsEl = document.getElementById('hc-rms');
      const peakEl = document.getElementById('hc-peakraw');
      if (rmsEl)  rmsEl.textContent  = rms.toFixed(3);
      if (peakEl) peakEl.textContent = String(peakRaw);
      const actx = document.getElementById('hc-actx-state');
      if (actx) actx.textContent = audioCtx ? audioCtx.state : '—';
      const ss = document.getElementById('hc-stream-state');
      if (ss && mediaStream) {
        const tracks = mediaStream.getAudioTracks();
        const t = tracks[0];
        if (t) {
          ss.textContent = `${t.readyState} · ${t.label.slice(0, 32) || '(no label)'}${t.muted ? ' · OS-muted' : ''}`;
        } else {
          ss.textContent = 'no track';
        }
      }
    }
    meterRAF = requestAnimationFrame(drawMeter);
  }
  function setMicLevel(level) {
    const m = document.getElementById('holodeck-mic-level');
    if (m) m.style.transform = `scaleX(${level})`;
  }
  // The button's title from index.html carries the full command list;
  // keep it in BOTH states (Bill 2026-07-12) — only the first line
  // changes to reflect listening state.
  let micBtnBaseTitle = null;
  function setMicButtonState(active) {
    const btn = document.getElementById('btn-holodeck');
    if (!btn) return;
    if (micBtnBaseTitle === null) {
      const t = btn.title || '';
      micBtnBaseTitle = t.includes('\n') ? t.slice(t.indexOf('\n')) : '';
    }
    btn.classList.toggle('active', active);
    btn.title = (active
      ? 'HOLODECK IS LISTENING — click to stop. Say "HOLODECK, list commands" (or right-click here) for the full list.'
      : 'Click to start HOLODECK voice control — then say "HOLODECK, <command>". Right-click here for the command list.')
      + micBtnBaseTitle;
  }

  // --- floating command help panel ---------------------------------------
  // Opened by voice ("HOLODECK, list commands" / "help") or by
  // right-clicking the mic button. Closed by voice ("HOLODECK, close
  // help"), the X, or Esc.
  const COMMAND_HELP = [
    ['Transport', [
      ['play', 'start playback (no-op if already playing)'],
      ['pause', 'pause playback (no-op if already paused)'],
      ['stop', 'stop — rewinds and arms at the top'],
      ['next / next song', 'skip to the next setlist song'],
      ['restart', 'jump back to the beginning'],
      ['play <song name>', 'search the library and play the top match'],
    ]],
    ['Sections', [
      ['jump to <section> / go to <section>', 'seek to intro, verse, chorus, bridge, solo, outro, pre, tag, break or hook'],
      ['loop section', 'engage the LOOPER on the current section'],
      ['stop looping', 'disengage the LOOPER'],
    ]],
    ['Mixer (stems: vocals, drums, bass, guitar, piano, other)', [
      ['mute <stem> / unmute <stem>', 'strip mute on/off'],
      ['solo <stem> / unsolo <stem>', 'strip solo on/off'],
      ['boost <stem> [five|ten]', 'engage the +5 or +10 dB boost'],
      ['<stem> up / <stem> down', 'nudge the fader by 10%'],
    ]],
    ['Click track', [
      ['click on / click off', 'toggle the click track at the playhead (records the action)'],
      ['count in', 'arm/disarm the 4-beat count-in'],
    ]],
    ['Tempo & pitch', [
      ['tempo up / tempo down', 'nudge playback speed ±5%'],
      ['reset tempo', 'back to 1.00×'],
      ['pitch up / pitch down [half]', 'shift pitch a half step'],
      ['reset pitch', 'back to 0'],
    ]],
    ['Library', [
      ['find <text> / search <text>', 'filter the library'],
      ['load <song>', 'load the top match without playing'],
      ['favorite this / star this', 'toggle the star on the active song'],
    ]],
    ['Gigs', [
      ['switch to <bill|matt|dan|jd> songs', 'load a singer pseudo-gig'],
      ['switch to round robin / favorites / recents', 'load that pseudo-gig'],
    ]],
    ['Queries (spoken reply)', [
      ["what's the key", 'speaks the active song\'s key'],
      ["what's the tempo", 'speaks the BPM'],
      ['who sings this', 'speaks the lead singer'],
    ]],
    ['Snapshots & misc', [
      ['save this as <name> / snapshot as <name>', 'save the mixer state under a name'],
      ['restore <name>', 'recall a named snapshot'],
      ['undo / go back', 'restore the previous snapshot'],
      ['what changed since <name>', 'speaks the diff'],
      ['sound check', 'run the sound check'],
      ['list commands / help', 'open this panel'],
      ['close help', 'close this panel'],
    ]],
  ];

  function showCommandHelp() {
    let el = document.getElementById('holodeck-help');
    if (!el) {
      el = document.createElement('div');
      el.id = 'holodeck-help';
      el.className = 'holodeck-help';
      let html = '<div class="hh-header"><span class="hh-title">HOLODECK commands — say "HOLODECK, …"</span>' +
                 '<button class="hh-close" id="hh-close" type="button" title="Close (or say: HOLODECK, close help)">×</button></div>' +
                 '<div class="hh-body">';
      for (const [group, items] of COMMAND_HELP) {
        html += `<div class="hh-group"><div class="hh-group-title">${group}</div>`;
        for (const [say, does] of items) {
          html += `<div class="hh-row"><span class="hh-say">${say}</span><span class="hh-does">${does}</span></div>`;
        }
        html += '</div>';
      }
      html += '</div>';
      el.innerHTML = html;
      document.body.appendChild(el);
      el.querySelector('#hh-close').addEventListener('click', hideCommandHelp);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideCommandHelp();
      });
    }
    el.style.display = '';
  }

  function hideCommandHelp() {
    const el = document.getElementById('holodeck-help');
    if (el) el.style.display = 'none';
  }

  // --- init -------------------------------------------------------------
  function init() {
    const btn = document.getElementById('btn-holodeck');
    if (!btn) {
      console.warn('[HOLODECK] mic button not found; voice control unavailable');
      return;
    }
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const el = document.getElementById('holodeck-help');
      if (el && el.style.display !== 'none') hideCommandHelp();
      else showCommandHelp();
    });
    btn.addEventListener('click', () => {
      if (listening) stopListening();
      else startListening();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Debug surface so the operator can call commands without speaking.
  window.HOLODECK = {
    start: startListening,
    stop: stopListening,
    dispatch,
    save: saveSnapshot,
    restore: restoreSnapshot,
    diff: diffSnapshot,
    commands: () => COMMANDS.map(c => c.re.source),
  };
})();
