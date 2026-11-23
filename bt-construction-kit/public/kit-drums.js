// DRUM KIT (Bill 2026-11-21): the Logic Pro 13 kit pieces of a song — kick, snare,
// hi-hat, toms, cymbals, percussion (in the song folder, beside the six stems) — each on its own fader
// and spread around the six amps. Shown only for a song that has the pieces.
//
// With KIT on, the six pieces play in place of the whole drum stem. They follow the
// drum stem's transport, and the Drums strip stays their master: its fader, M, S and
// boost scale all six. Each piece has a strip like a stem's: the ring of amp buttons,
// a fader with its preset buttons (80% is the level the piece has in the drum stem),
// M and S, and a level fill. Wherever the app silences the drum stem itself (LOOPER, MPL
// drums) the pieces are silent too. If a piece cannot play (not loaded, stalled),
// the whole drum stem comes back, so the drums never drop out.

const KIT_PIECES = [
  { id: 'kick',       label: 'Kick',    amp: 'D', rgb: '46, 204, 113' },   // the drum amp, where the whole kit used to be
  { id: 'snare',      label: 'Snare',   amp: 'V', rgb: '231, 76, 60' },    // straight across the circle from the kick
  { id: 'toms',       label: 'Toms',    amp: 'G', rgb: '230, 126, 34' },
  { id: 'hihat',      label: 'Hi-Hat',  amp: 'P', rgb: '241, 196, 15' },
  { id: 'cymbals',    label: 'Cymbals', amp: 'O', rgb: '52, 152, 219' },
  { id: 'percussion', label: 'Perc',    amp: 'B', rgb: '155, 89, 182' },
];
// Merger input for each button — the same indices the strips use (HOME_CHAN in app.js).
const KIT_OUT = { L: 0, R: 1, V: 10, D: 11, B: 12, G: 13, P: 14, O: 15 };
const KIT_KEY = 'performer.kit.v2';
const KIT_TICK_MS = 40;
const KIT_UNITY = 0.8;       // where a fader rests, like the stem faders: the piece at the level it has in the drum stem
const KIT_PRESETS = [100, 75, 50, 10, 5];

const kit = { on: false, vol: {}, mute: {}, solo: {}, routes: {} };
let kitSong = null;          // folder whose pieces are loaded into the elements
let kitProbe = null;         // folder being asked "do you have kit pieces?"
let kitFailed = false;       // a piece of kitSong would not load
let kitNodes = null;         // audio graph, built once the app's graph exists
let kitWasLive = null;
let kitBadSince = 0, kitHadAll = false, kitLastG = -1;
const kitEls = {};
const kitNudge = {};

function kitSpread() { const r = {}; for (const p of KIT_PIECES) r[p.id] = ['L', 'R', p.amp]; return r; }

(function kitLoadState() {
  kit.routes = kitSpread();
  for (const p of KIT_PIECES) { kit.vol[p.id] = KIT_UNITY; kit.mute[p.id] = false; kit.solo[p.id] = false; }
  try {
    const s = JSON.parse(localStorage.getItem(KIT_KEY) || 'null');
    if (!s) return;
    kit.on = !!s.on;
    for (const p of KIT_PIECES) {
      if (typeof (s.vol || {})[p.id] === 'number') kit.vol[p.id] = Math.max(0, Math.min(1, s.vol[p.id]));
      kit.mute[p.id] = !!(s.mute || {})[p.id]; kit.solo[p.id] = !!(s.solo || {})[p.id];
      const r = (s.routes || {})[p.id];
      if (Array.isArray(r)) kit.routes[p.id] = r.filter(k => k in KIT_OUT);
    }
  } catch (e) {}
})();
function kitSave() { try { localStorage.setItem(KIT_KEY, JSON.stringify(kit)); } catch (e) {} }

for (const p of KIT_PIECES) {
  const el = new Audio();
  el.preload = 'auto';
  el.addEventListener('error', () => {
    if (!kitSong || kitFailed || !el.getAttribute('src')) return;
    kitFailed = true;
    try { showToast('Drum kit pieces for this song would not load — playing the whole drum stem.'); } catch (e) {}
  });
  kitEls[p.id] = el;
}

function kitSongWanted() {
  return (typeof currentSong !== 'undefined' && currentSong && currentSong.type === 'stems' && currentSong.folderName) || null;
}

// Does this song have kit pieces? One small request per song load; a song without them answers 404.
function kitCheckSong(folder) {
  kitProbe = folder;
  kitUnload();
  if (!folder) return;
  const base = `/api/audio/stems/${encodeURIComponent(folder)}/`;
  fetch(base + 'kick.m4a', { method: 'HEAD' }).then(r => {
    if (kitProbe !== folder || !r.ok || /text\/html/.test(r.headers.get('content-type') || '')) return;
    kitSong = folder; kitFailed = false; kitHadAll = false; kitBadSince = 0;
    for (const p of KIT_PIECES) { kitEls[p.id].src = base + p.id + '.m4a'; kitEls[p.id].load(); }
    kitPaint();
  }).catch(() => {});
}
function kitUnload() {
  if (!kitSong) return;
  kitSong = null; kitFailed = false;
  for (const p of KIT_PIECES) { const el = kitEls[p.id]; try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} }
  kitPaint();
}

function kitWire() {
  const dn = stripNodes.drums;
  const n = { piece: {} };
  // between the drum stem and its strip: closed while the pieces play in its place
  n.duck = audioCtx.createGain();
  dn.mediaMute.disconnect(dn.preFader);
  dn.mediaMute.connect(n.duck); n.duck.connect(dn.preFader);
  // the pieces light the Drums strip's level fill, as the stem did
  n.pre = audioCtx.createGain(); n.pre.gain.value = 0; n.pre.connect(dn.meter);
  for (const p of KIT_PIECES) {
    const src = audioCtx.createMediaElementSource(kitEls[p.id]);
    const fader = audioCtx.createGain();
    const group = audioCtx.createGain(); group.gain.value = 0;      // follows the Drums strip
    const split = audioCtx.createChannelSplitter(2);
    const mono = audioCtx.createGain();                             // an amp gets left + right, halved
    mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
    src.connect(fader); fader.connect(group); group.connect(split); group.connect(mono);
    src.connect(n.pre);
    const meter = audioCtx.createAnalyser(); meter.fftSize = 1024; meter.smoothingTimeConstant = 0;   // the strip's level fill, pre-fader
    src.connect(meter);
    n.piece[p.id] = { fader, group, split, mono, meter };
  }
  kitNodes = n;
  kitApplyFaders();
  for (const p of KIT_PIECES) kitApplyRoutes(p.id);
  // follow the drum stem's transport at once, not a tick later
  for (const ev of ['play', 'pause', 'seeking', 'ratechange']) audioElements.drums.addEventListener(ev, () => { try { kitTick(); } catch (e) {} });
}

// M and S work among the six pieces as they do among the six stems.
function kitApplyFaders() {
  if (!kitNodes) return;
  const anySolo = KIT_PIECES.some(p => kit.solo[p.id]);
  for (const p of KIT_PIECES) {
    const off = kit.mute[p.id] || (anySolo && !kit.solo[p.id]);
    kitNodes.piece[p.id].fader.gain.value = off ? 0 : kit.vol[p.id] / KIT_UNITY;
  }
}
function kitApplyRoutes(id) {
  if (!kitNodes) return;
  const n = kitNodes.piece[id];
  try { n.split.disconnect(); } catch (e) {}
  try { n.mono.disconnect(); } catch (e) {}
  let outs = (kit.routes[id] || []).filter(k => KIT_OUT[k] < outputChannelCount);
  // every lit amp is missing on this audio device (stereo only): keep the piece audible on L+R
  if (!outs.length && (kit.routes[id] || []).length) outs = ['L', 'R'];
  for (const k of outs) {
    if (k === 'L') n.split.connect(masterMerger, 0, 0);
    else if (k === 'R') n.split.connect(masterMerger, 1, 1);
    else n.mono.connect(masterMerger, 0, KIT_OUT[k]);
  }
}

// All six pieces able to play. A piece that is briefly not ready (a seek) does not
// bring the whole stem back; one that stays that way for 400 ms does.
function kitReady() {
  if (!kitSong || kitFailed) return false;
  let ok = true;
  for (const p of KIT_PIECES) { const el = kitEls[p.id]; if (el.error || el.readyState < (el.paused ? 2 : 3)) ok = false; }
  if (ok) { kitHadAll = true; kitBadSince = 0; return true; }
  if (!kitHadAll) return false;
  if (!kitBadSince) kitBadSince = performance.now();
  return performance.now() - kitBadSince < 400;
}

function kitTick() {
  const want = kitSongWanted();
  if (want !== kitProbe) kitCheckSong(want);
  if (!kitNodes) {
    if (typeof audioCtx === 'undefined' || !audioCtx || !stripNodes || !stripNodes.drums || !masterMerger) return;
    kitWire();
  }
  if (!kitSong && kitWasLive === false && kitLastG === 0) return;      // nothing to play, graph already at rest
  const dn = stripNodes.drums, d = audioElements.drums;
  const live = kit.on && kitReady();
  if (live !== kitWasLive) { kitWasLive = live; kitPaint(); }
  const stem = dn.mediaMute.gain.value * dn.preFader.gain.value;   // 0 while the app has the drum stem silenced (LOOPER, MPL drums)
  const g = live ? dn.stripGain.gain.value * stem : 0;
  if (g !== kitLastG) {
    kitLastG = g;
    for (const p of KIT_PIECES) kitNodes.piece[p.id].group.gain.setTargetAtTime(g, audioCtx.currentTime, 0.012);
  }
  const duck = live ? 0 : 1, pre = live ? stem : 0;
  if (kitNodes.duck.gain.value !== duck) kitNodes.duck.gain.value = duck;
  if (kitNodes.pre.gain.value !== pre) kitNodes.pre.gain.value = pre;

  // transport: the pieces go where the drum stem goes
  const follow = kit.on && kitSong && !kitFailed;
  const playing = follow && audioHasSrc(d) && !d.paused && !d.ended;
  const t = d.currentTime, rate = d.playbackRate;
  for (const p of KIT_PIECES) {
    const el = kitEls[p.id];
    if (!follow) { if (!el.paused) el.pause(); continue; }
    if (el.preservesPitch !== d.preservesPitch) el.preservesPitch = d.preservesPitch;
    if (el.readyState < 1) continue;
    const ahead = el.currentTime - t, off = Math.abs(ahead);
    let r = rate;
    if (!playing) {
      if (!el.paused) el.pause();
      if (off > 0.02 && !el.seeking) el.currentTime = t;
      kitNudge[p.id] = false;
    } else if (el.paused) {
      el.currentTime = t;
      el.play().catch(() => {});
    } else if (off > 0.25) {
      if (!el.seeking) el.currentTime = t;            // a seek or a loop: jump
      kitNudge[p.id] = false;
    } else {
      // a few ms out (each element starts in its own time): close the gap by ear-safe speed, not a jump
      if (off > 0.005) kitNudge[p.id] = true; else if (off < 0.0015) kitNudge[p.id] = false;
      if (kitNudge[p.id]) r = rate * (ahead > 0 ? 0.97 : 1.03);
    }
    if (el.playbackRate !== r) el.playbackRate = r;
  }
}

// ── panel: a second row of strips, built like the stem strips ─────────────
function kitBuild() {
  const host = document.querySelector('.faders-container');
  if (!host || document.getElementById('kit-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'kit-panel'; panel.className = 'kit-panel'; panel.style.display = 'none';
  const out = (p, k) => `<button class="pos-btn pos-${k} kit-out" data-out="${k}" title="${p.label} → ${k === 'L' ? 'left main' : k === 'R' ? 'right main' : 'amp ' + k}">${k}</button>`;
  panel.innerHTML = `
    <div class="kit-head">
      <span class="kit-title">DRUM KIT</span>
      <button id="kit-on" class="kit-on" title="KIT: play this song's six drum pieces (Logic Pro 13 stems) in place of the whole drum stem, each on its own fader and amp. The Drums strip's fader, M and S still control all six.">KIT OFF</button>
      <span id="kit-status" class="kit-status"></span>
      <button id="kit-spread" class="kit-preset" title="Spread: one piece on each amp round the circle — kick D, snare V, toms G, hi-hat P, cymbals O, percussion B — and every piece on L and R.">Spread</button>
      <button id="kit-home" class="kit-preset" title="Drum amp: every piece on the drum amp (D) and L and R, as the whole drum stem plays.">Drum amp</button>
    </div>
    <div class="kit-strips">${KIT_PIECES.map(p => `
      <div class="kit-strip" data-kit="${p.id}">
        <div class="strip-level-fill" style="--lvl-rgb: ${p.rgb};"></div>
        <div class="pos-top-row">${out(p, 'V')}</div>
        <div class="pos-middle-row">
          <div class="pos-side-left">${out(p, 'O')}${out(p, 'L')}${out(p, 'G')}</div>
          <div class="fader-container">
            <div class="channel-header"><span class="channel-icon text-green"><i data-lucide="drum"></i></span><span class="channel-name">${p.label}</span></div>
            <div class="fader-track has-presets">
              <input type="range" class="vertical-slider kit-fader" min="0" max="1" step="0.01" title="${p.label} level — 80% is the level it has in the drum stem">
              <div class="fader-presets">${KIT_PRESETS.map(v => `<button type="button" class="fader-preset" data-pct="${v}" title="Set ${p.label} to ${v}%">${v}</button>`).join('')}</div>
            </div>
            <div class="fader-value"></div>
          </div>
          <div class="pos-side-right">${out(p, 'P')}${out(p, 'R')}${out(p, 'B')}</div>
        </div>
        <div class="pos-bottom-row">${out(p, 'D')}</div>
        <div class="channel-buttons">
          <button class="mute-btn kit-mute" title="Mute ${p.label}">M</button>
          <button class="solo-btn kit-solo" title="Solo ${p.label} among the drum pieces">S</button>
        </div>
      </div>`).join('')}
    </div>`;
  host.insertAdjacentElement('afterend', panel);
  try { lucide.createIcons(); } catch (e) {}

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const strip = b.closest('.kit-strip'), id = strip && strip.dataset.kit;
    if (b.id === 'kit-on') { kit.on = !kit.on; }
    else if (b.id === 'kit-spread') { kit.routes = kitSpread(); KIT_PIECES.forEach(p => kitApplyRoutes(p.id)); }
    else if (b.id === 'kit-home') { for (const p of KIT_PIECES) { kit.routes[p.id] = ['L', 'R', 'D']; kitApplyRoutes(p.id); } }
    else if (id && b.classList.contains('kit-out')) {
      const k = b.dataset.out, r = kit.routes[id] || [];
      kit.routes[id] = r.includes(k) ? r.filter(x => x !== k) : r.concat(k);
      kitApplyRoutes(id);
    }
    else if (id && b.classList.contains('fader-preset')) { kit.vol[id] = +b.dataset.pct / 100; kitApplyFaders(); }
    else if (id && b.classList.contains('kit-mute')) { kit.mute[id] = !kit.mute[id]; kitApplyFaders(); }
    else if (id && b.classList.contains('kit-solo')) { kit.solo[id] = !kit.solo[id]; kitApplyFaders(); }
    else return;
    kitSave(); kitPaint();
  });
  panel.addEventListener('input', (e) => {
    const f = e.target.closest('.kit-fader'); if (!f) return;
    const id = f.closest('.kit-strip').dataset.kit;
    kit.vol[id] = parseFloat(f.value); kitApplyFaders(); kitSave(); kitPaint();
  });
  kitPaint();
}

function kitPaint() {
  const panel = document.getElementById('kit-panel'); if (!panel) return;
  panel.style.display = kitSong ? '' : 'none';
  if (!kitSong) return;
  const live = kit.on && kitReady();
  panel.classList.toggle('on', kit.on);
  const on = document.getElementById('kit-on');
  on.textContent = kit.on ? 'KIT ON' : 'KIT OFF'; on.classList.toggle('active', kit.on);
  document.getElementById('kit-status').textContent =
    !kit.on ? 'Off — the whole drum stem is playing. Click KIT to play the six pieces on their own faders and amps.'
    : kitFailed ? 'The pieces would not load — the whole drum stem is playing.'
    : !live ? 'Loading the six pieces… the whole drum stem plays until they are ready.'
    : 'Six pieces in place of the drum stem. The Drums fader, M and S control them all.';
  const stereo = typeof outputChannelCount !== 'undefined' && outputChannelCount <= 2;
  for (const strip of panel.querySelectorAll('.kit-strip')) {
    const id = strip.dataset.kit, r = kit.routes[id] || [];
    for (const b of strip.querySelectorAll('.kit-out')) {
      b.classList.toggle('active', r.includes(b.dataset.out));
      b.disabled = stereo && KIT_OUT[b.dataset.out] > 1;      // no such output on this audio device, as on the stem strips
    }
    const f = strip.querySelector('.kit-fader'), pct = Math.round(kit.vol[id] * 100);
    if (document.activeElement !== f) f.value = kit.vol[id];
    strip.querySelector('.fader-value').textContent = pct + '%';
    for (const b of strip.querySelectorAll('.fader-preset')) b.classList.toggle('active', +b.dataset.pct === pct);
    strip.querySelector('.kit-mute').classList.toggle('active', kit.mute[id]);
    strip.querySelector('.kit-solo').classList.toggle('active', kit.solo[id]);
  }
}

// level fill behind each strip, like the stems' (pre-fader, fast up, slow fall)
const kitLevelHold = {}; let kitLevelBuf = null, kitLevelLastT = 0;
function kitLevels(now) {
  requestAnimationFrame(kitLevels);
  if (now - kitLevelLastT < 33) return;
  kitLevelLastT = now;
  const panel = document.getElementById('kit-panel');
  if (!panel || !panel.offsetParent || !kitNodes) return;
  for (const p of KIT_PIECES) {
    const m = kitNodes.piece[p.id].meter; let lvl = 0;
    if (kitWasLive) {
      if (!kitLevelBuf || kitLevelBuf.length !== m.fftSize) kitLevelBuf = new Float32Array(m.fftSize);
      m.getFloatTimeDomainData(kitLevelBuf);
      let sum = 0; for (let i = 0; i < kitLevelBuf.length; i++) sum += kitLevelBuf[i] * kitLevelBuf[i];
      const rms = Math.sqrt(sum / kitLevelBuf.length), db = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
      lvl = Math.min(1, Math.max(0, (db + 50) / 44));
    }
    const prev = kitLevelHold[p.id] || 0, v = lvl >= prev ? lvl : prev * 0.85 + lvl * 0.15;
    kitLevelHold[p.id] = v;
    const fill = panel.querySelector(`.kit-strip[data-kit="${p.id}"] > .strip-level-fill`);
    if (fill) fill.style.height = (v * 100).toFixed(1) + '%';
  }
}

kitBuild();
requestAnimationFrame(kitLevels);
setInterval(() => { try { kitTick(); } catch (e) { console.warn('[kit]', e); } }, KIT_TICK_MS);
