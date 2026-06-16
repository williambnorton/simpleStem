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

  // --- status ribbon ----------------------------------------------------
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
    // Transport
    { re: new RegExp('^play$'),         fn: () => clickById('btn-play-pause') },
    { re: new RegExp('^pause$'),        fn: () => clickById('btn-play-pause') },
    { re: new RegExp('^stop$'),         fn: () => clickById('btn-stop') },
    { re: new RegExp('^next( song)?$'), fn: () => clickById('btn-go-next') },
    { re: new RegExp('^restart( song)?$'), fn: () => seekTo(0) },

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
    { re: new RegExp('^click on$'),  fn: () => clickById('btn-click-toggle') },
    { re: new RegExp('^click off$'), fn: () => clickById('btn-click-toggle') },
    { re: new RegExp('^count in$'),  fn: () => clickById('btn-count-in-toggle') },

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

  function dispatch(command) {
    for (const c of COMMANDS) {
      const m = command.match(c.re);
      if (m) {
        try {
          c.fn(m);
          showStatus(`✓ ${command}`);
        } catch (e) {
          console.error('[HOLODECK] command error:', e);
          showStatus(`✗ ${command} — ${e.message}`, 4000, true);
        }
        return true;
      }
    }
    showStatus(`✗ Unknown: "${command}"`, 3500, true);
    return false;
  }

  // --- mic + recognition ------------------------------------------------
  async function startListening() {
    if (listening) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showStatus('Voice recognition is not supported in this browser.', 6000, true);
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      showStatus('Microphone permission denied.', 6000, true);
      return;
    }

    // Level meter
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      drawMeter();
    } catch (e) { console.warn('[HOLODECK] meter init failed:', e); }

    // Speech recognition
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = false;
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
    setMicButtonState(false);
    showStatus('HOLODECK stopped listening.', 2500);
  }

  function handleResult(event) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (!r.isFinal) continue;
      const transcript = (r[0].transcript || '').trim();
      if (!WAKE.test(transcript)) continue;
      const command = transcript
        .replace(WAKE, '')
        .replace(/^[,\s]+/, '')
        .replace(/[.,!?]+$/, '')
        .trim()
        .toLowerCase();
      if (!command) {
        showStatus('HOLODECK heard you. Awaiting command...');
        continue;
      }
      dispatch(command);
    }
  }

  function drawMeter() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    setMicLevel(Math.min(1, rms * 4));
    meterRAF = requestAnimationFrame(drawMeter);
  }
  function setMicLevel(level) {
    const m = document.getElementById('holodeck-mic-level');
    if (m) m.style.transform = `scaleX(${level})`;
  }
  function setMicButtonState(active) {
    const btn = document.getElementById('btn-holodeck');
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.title = active ? 'HOLODECK is listening (click to stop)' : 'Click to start HOLODECK voice control';
  }

  // --- init -------------------------------------------------------------
  function init() {
    const btn = document.getElementById('btn-holodeck');
    if (!btn) {
      console.warn('[HOLODECK] mic button not found; voice control unavailable');
      return;
    }
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
