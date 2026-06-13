// simpleStem visualizer — full-song waveform peaks with a live playhead.
//
// On song load, we fetch the audio file once, decode it via
// AudioContext.decodeAudioData, and compute a peaks array (max absolute
// sample value in each of ~1500 buckets across the canvas width). The
// result is rendered as a mirror-style amplitude graph, with louder
// sections taller — so the user can see verses vs choruses vs accents
// at a glance.
//
// A vertical playhead line tracks currentTime against duration. Click
// or drag anywhere on the waveform to seek.
//
// Falls back to a faint placeholder bar while peaks are loading. Stays
// silent (no draw loop) when no song is loaded.

let canvas = null;
let ctx = null;
let analyser = null;             // kept for back-compat with initVisualizer signature
// Per-stem peaks for stems songs: key → Float32Array(PEAK_BUCKETS). For m4a
// tracks the key is '__m4a__' and there's only one entry. Each frame we
// combine only the entries whose underlying audio element has volume > 0.01,
// so soloing drums shows only the drums envelope, muting bass drops the bass
// contribution, and so on — the visual matches what's audible.
let stemPeaks = new Map();
let stemPeaksRequestId = 0;      // monotonic; cancels older decodes
let waveformDuration = 0;
let waveformLoading = false;
let waveformError = false;
let animationFrameId = null;
let canvasBorderBeatClass = 'pulse-active';
let beatInterval = null;

const PEAK_BUCKETS = 1500;
const AUDIBLE_THRESHOLD = 0.01;

function initVisualizer(analyserNode) {
  canvas = document.getElementById('visualizer-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  analyser = analyserNode;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  // The canvas sits inside a flex layout that may finish sizing AFTER init
  // runs (fonts, web components, layout shift). A ResizeObserver catches any
  // post-init size change and re-syncs the pixel buffer to the display size,
  // so the waveform always draws end-to-end of the visible canvas.
  if (window.ResizeObserver) {
    new ResizeObserver(resizeCanvas).observe(canvas);
  }
  startLoop();

  // Click / drag to seek. We attach to the canvas itself; the canvas is
  // already sized to fill its container, so click coordinates map cleanly.
  let dragging = false;
  const onSeek = (e) => {
    if (waveformDuration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const targetSec = (x / rect.width) * waveformDuration;
    seekAllAudioTo(targetSec);
  };
  canvas.addEventListener('mousedown', (e) => { dragging = true; onSeek(e); });
  canvas.addEventListener('mousemove', (e) => { if (dragging) onSeek(e); });
  canvas.addEventListener('mouseup',   () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });
}

function startLoop() {
  if (animationFrameId) return;
  const loop = () => {
    animationFrameId = requestAnimationFrame(loop);
    draw();
  };
  loop();
}

function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

// Called from app.js when a song is loaded. `sources` is a map of key →
// audio URL. For stems songs it's {vocals: url, drums: url, ...} and the
// visualizer combines whichever stems are audible per frame; for m4a
// tracks the map has a single '__m4a__' key.
async function setWaveformStems(sources) {
  if (!ctx) return;
  // Cancel any in-flight decodes from the previous song.
  const requestId = ++stemPeaksRequestId;
  stemPeaks = new Map();
  waveformDuration = 0;
  waveformError = false;
  waveformLoading = true;

  const ac = (window.appAudioCtx) || new (window.AudioContext || window.webkitAudioContext)();
  const entries = Object.entries(sources || {});
  if (!entries.length) {
    waveformLoading = false;
    return;
  }

  // Decode every source in parallel; first one to complete also seeds the
  // duration (every stem has the same length).
  await Promise.all(entries.map(async ([key, url]) => {
    if (!url) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const buf = await new Promise((resolve, reject) => {
        try {
          const p = ac.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        } catch (e) { reject(e); }
      });
      if (requestId !== stemPeaksRequestId) return;  // newer song loaded
      if (!waveformDuration) waveformDuration = buf.duration;
      stemPeaks.set(key, computePeaks(buf, PEAK_BUCKETS));
    } catch (e) {
      console.warn('[visualizer] peaks failed for', key, url, e.message);
    }
  }));

  if (requestId !== stemPeaksRequestId) return;
  waveformLoading = false;
  if (!stemPeaks.size) waveformError = true;

  // Onset detection: walk the combined-peaks envelope and find local rises
  // that exceed a threshold with minimum spacing. Each rise is a 'spike'
  // — likely a drum hit, vocal attack, or other transient. The click
  // scheduler reads these as the times to fire clicks, so the click
  // genuinely follows the song's musical accents instead of the BPM grid.
  window.songOnsetTimes = computeOnsetTimes();
  // Also republish the BPM hint so the click scheduler can fall back when
  // onsets are sparse.
  window.songOnsetCount = window.songOnsetTimes ? window.songOnsetTimes.length : 0;
}

function computeOnsetTimes() {
  if (!stemPeaks.size || !waveformDuration) return null;
  // Build a combined peaks envelope using max-of-stems (mute/solo state
  // doesn't matter here; we want the song's underlying structure).
  const N = PEAK_BUCKETS;
  const env = new Float32Array(N);
  for (const peaks of stemPeaks.values()) {
    for (let i = 0; i < N; i++) if (peaks[i] > env[i]) env[i] = peaks[i];
  }
  // Local-rise detection: spike[i] = env[i] - env[i-1]. Pick indices where
  // the rise is above THRESHOLD and at least MIN_SPACING buckets from the
  // last accepted index.
  const RISE_THRESHOLD = 0.18;
  const MIN_SPACING_MS = 110;            // can't fire two clicks in <110ms
  const bucketsPerSec = N / waveformDuration;
  const minSpacingBuckets = Math.ceil(bucketsPerSec * (MIN_SPACING_MS / 1000));
  const onsets = [];
  let lastIdx = -minSpacingBuckets;
  for (let i = 1; i < N; i++) {
    const rise = env[i] - env[i - 1];
    if (rise > RISE_THRESHOLD && (i - lastIdx) >= minSpacingBuckets) {
      onsets.push((i / N) * waveformDuration);
      lastIdx = i;
    }
  }
  return onsets;
}

// Back-compat wrapper for the old single-source API.
function setWaveformSource(url) {
  return setWaveformStems({ __m4a__: url });
}

function computePeaks(buf, bucketCount) {
  // Walk every channel and keep the maximum absolute sample per bucket —
  // gives us the envelope you'd expect from a DAW waveform display. With
  // stereo files (the m4a -V-G is stereo), this naturally captures the
  // louder of the two channels per bucket.
  const peaks = new Float32Array(bucketCount);
  const channels = Math.min(buf.numberOfChannels, 2);
  const samplesPerBucket = buf.length / bucketCount;
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < bucketCount; i++) {
      const start = Math.floor(i * samplesPerBucket);
      const end = Math.min(Math.floor((i + 1) * samplesPerBucket), data.length);
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      if (peak > peaks[i]) peaks[i] = peak;
    }
  }
  // Normalize to [0,1] using the loudest peak so the visualization uses
  // the full canvas height regardless of the song's mastering loudness.
  let max = 0;
  for (let i = 0; i < bucketCount; i++) if (peaks[i] > max) max = peaks[i];
  if (max > 0) {
    for (let i = 0; i < bucketCount; i++) peaks[i] /= max;
  }
  return peaks;
}

function draw() {
  if (!canvas || !ctx) return;
  // Buffer-to-display sync: if the CSS-rendered canvas no longer matches the
  // backing pixel buffer (parent flex finished laying out, window resized,
  // sidebar collapsed, etc.) re-size before drawing. Cheaper than a global
  // ResizeObserver and 100% reliable.
  const rect = canvas.getBoundingClientRect();
  const expectedW = Math.round(rect.width * window.devicePixelRatio);
  const expectedH = Math.round(rect.height * window.devicePixelRatio);
  if (rect.width > 0 && rect.height > 0 && (canvas.width !== expectedW || canvas.height !== expectedH)) {
    resizeCanvas();
  }
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, width, height);

  if (waveformLoading && stemPeaks.size === 0) {
    drawPlaceholder(width, height, 'analyzing waveform…');
    return;
  }
  if (waveformError || stemPeaks.size === 0) {
    drawPlaceholder(width, height, '');
    return;
  }

  // Render mode — SUM (combined waveform) or STEMS (six per-stem lanes).
  // Set via #viz-mode-toggle in the visualizer area; persisted in
  // localStorage as 'simpleStem.vizMode' ('sum' or 'stems').
  const mode = (window.__vizMode === 'stems') ? 'stems' : 'sum';

  if (mode === 'sum') {
    // Combine the per-stem peaks weighted by audible volume.
    const combined = combineAudiblePeaks();
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, 'rgba(156, 39, 176, 0.85)');
    grad.addColorStop(0.5, 'rgba(0, 188, 212, 0.85)');
    grad.addColorStop(1, 'rgba(46, 204, 113, 0.85)');
    const bucketW = width / combined.length;
    const half = height / 2;
    ctx.fillStyle = grad;
    for (let i = 0; i < combined.length; i++) {
      const p = combined[i];
      const scaled = Math.min(1, Math.sqrt(p) * 1.15);
      const barH = scaled * (height * 0.95);
      const x = i * bucketW;
      const w = Math.max(0.6, bucketW - 0.3);
      ctx.fillRect(x, half - barH / 2, w, barH);
    }
  } else {
    // STEMS mode — six horizontal lanes (top → bottom V/D/B/G/P/O). Each
    // lane shows the SOURCE peak signal for that stem at FULL STRENGTH,
    // independent of mute / solo / fader. This is a structural reference
    // for timing instrument entries, not a live mix meter; the mute/solo/
    // fader controls still affect what you HEAR, but the lane stays lit
    // so you can see when each part comes in.
    //
    // Bigger, bolder per-stem labels at the left edge in the lane's color
    // pop through any section-band overlay (.player-wave-overlay) sitting
    // on top of the canvas.
    const STEM_ORDER = [
      { key: 'vocals', color: 'rgba(233, 30, 99, 0.95)',  label: 'V' },
      { key: 'drums',  color: 'rgba(46, 204, 113, 0.95)', label: 'D' },
      { key: 'bass',   color: 'rgba(41, 128, 185, 0.95)', label: 'B' },
      { key: 'guitar', color: 'rgba(241, 196, 15, 0.95)', label: 'G' },
      { key: 'piano',  color: 'rgba(156, 39, 176, 0.95)', label: 'P' },
      { key: 'other',  color: 'rgba(255, 152, 0, 0.95)',  label: 'O' },
    ];
    const laneH = height / STEM_ORDER.length;
    const labelPadLeft = 18;   // reserve space at the left for the label
    ctx.font = 'bold 13px "Space Grotesk", sans-serif';
    ctx.textBaseline = 'middle';
    for (let li = 0; li < STEM_ORDER.length; li++) {
      const { key, color, label } = STEM_ORDER[li];
      const peaks = stemPeaks.get(key) || stemPeaks.get('__m4a__');
      const laneTop = li * laneH;
      const laneMid = laneTop + laneH / 2;
      // Faint lane separator
      if (li > 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneTop);
        ctx.lineTo(width, laneTop);
        ctx.stroke();
      }
      // Stem label — solid color so it stays legible over section bands.
      // Black halo around the letter for extra punch against any band fill.
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.strokeText(label, 4, laneMid);
      ctx.fillStyle = color;
      ctx.fillText(label, 4, laneMid);
      if (!peaks) continue;
      // Always draw at FULL strength — visualizer is a song reference,
      // not a live mix meter. Volume / mute / solo are unrelated.
      const drawX0 = labelPadLeft;
      const drawW  = width - labelPadLeft;
      const bucketW = drawW / peaks.length;
      ctx.fillStyle = color;
      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        const scaled = Math.min(1, Math.sqrt(p) * 1.15);
        const barH = scaled * (laneH * 0.88);
        const x = drawX0 + i * bucketW;
        const w = Math.max(0.6, bucketW - 0.3);
        ctx.fillRect(x, laneMid - barH / 2, w, barH);
      }
    }
  }

  // Beat grid — vertical markers at every beat boundary computed from the
  // current song's BPM. Downbeats (every 4 in 4/4) get a brighter, thicker
  // line so bars are visible. This is what the click track aligns to —
  // visual and audible beat reinforce each other for practice.
  const bpm = (window.currentSong && window.currentSong.practiceBpm) || null;
  if (bpm && waveformDuration > 0) {
    const beatSec = 60 / bpm;
    const totalBeats = Math.floor(waveformDuration / beatSec);
    // Skip beat 0 (left edge is its own boundary); start at 1.
    for (let i = 1; i <= totalBeats; i++) {
      const x = (i * beatSec / waveformDuration) * width;
      const isDownbeat = i % 4 === 0;
      ctx.strokeStyle = isDownbeat ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = isDownbeat ? 1.5 : 0.6;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  // Played portion gets a brighter overlay — like a progress fill.
  const playedX = getPlayheadPxX(width);
  if (playedX > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fillRect(0, 0, playedX, height);
  }

  // Playhead line.
  if (playedX > 0 && playedX < width) {
    ctx.strokeStyle = 'rgba(46, 204, 113, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playedX, 0);
    ctx.lineTo(playedX, height);
    ctx.stroke();
  }
}

// Walks the per-stem peaks, weighting each by its current audible volume
// (so dragging a fader down dims that stem's contribution). For each bucket
// the result is the sum of weighted contributions, clamped to [0,1].
function combineAudiblePeaks() {
  const out = new Float32Array(PEAK_BUCKETS);
  const audio = window.audioElements;
  for (const [key, peaks] of stemPeaks) {
    let weight;
    if (key === '__m4a__') {
      // M4A mode plays through the 'drums' carrier; same audible check.
      const ae = audio && audio.drums;
      weight = (ae && ae.volume > AUDIBLE_THRESHOLD) ? ae.volume : 0;
    } else {
      const ae = audio && audio[key];
      weight = (ae && ae.volume > AUDIBLE_THRESHOLD) ? ae.volume : 0;
    }
    if (weight <= 0) continue;
    for (let i = 0; i < peaks.length; i++) {
      const v = peaks[i] * weight;
      if (v > out[i]) out[i] = v;     // use max so stems don't sum past 1
    }
  }
  return out;
}

function drawPlaceholder(width, height, label) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(0, height / 2 - 1, width, 2);
  if (label) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = `12px 'Space Grotesk', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, width / 2, height / 2 - 16);
  }
}

function getPlayheadPxX(width) {
  if (!waveformDuration) return -1;
  const t = currentPlaybackTime();
  if (t == null) return -1;
  return (t / waveformDuration) * width;
}

// Best-effort: read currentTime off any HTMLAudioElement the app exposes.
// The app's `audioElements` object is shared on window when the player
// initializes; fall back to scanning DOM <audio> tags.
function currentPlaybackTime() {
  const els = window.audioElements;
  if (els) {
    for (const k of Object.keys(els)) {
      const ae = els[k];
      if (ae && ae.src && !ae.paused) return ae.currentTime || 0;
    }
    // No element is currently playing — fall back to whatever's loaded
    for (const k of Object.keys(els)) {
      const ae = els[k];
      if (ae && ae.src && (ae.currentTime > 0 || ae.duration > 0)) return ae.currentTime || 0;
    }
  }
  return null;
}

function seekAllAudioTo(seconds) {
  const els = window.audioElements;
  if (!els) return;
  for (const k of Object.keys(els)) {
    const ae = els[k];
    if (ae && ae.src) {
      try { ae.currentTime = Math.max(0, Math.min(seconds, ae.duration || seconds)); } catch (e) {}
    }
  }
}

// Compat with the old API — app.js calls startBeatingVisualizer(bpm)
// to flash the canvas border on the beat. Keep working unchanged.
function startBeatingVisualizer(bpm) {
  stopBeatingVisualizer();
  if (!bpm) bpm = 120;
  const beatMs = 60000 / bpm;
  const container = document.querySelector('.player-visualization-area');
  if (!container) return;
  beatInterval = setInterval(() => {
    container.classList.add(canvasBorderBeatClass);
    setTimeout(() => container.classList.remove(canvasBorderBeatClass), 120);
  }, beatMs);
  const cssId = 'beat-pulsation-css';
  if (!document.getElementById(cssId)) {
    const style = document.createElement('style');
    style.id = cssId;
    style.innerHTML = `
      .player-visualization-area { transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .player-visualization-area.pulse-active {
        border-color: rgba(0, 188, 212, 0.6) !important;
        box-shadow: 0 0 15px rgba(0, 188, 212, 0.3);
      }`;
    document.head.appendChild(style);
  }
}

function stopBeatingVisualizer() {
  if (beatInterval) { clearInterval(beatInterval); beatInterval = null; }
  const c = document.querySelector('.player-visualization-area');
  if (c) c.classList.remove(canvasBorderBeatClass);
}

// Expose hooks for app.js to use.
window.setWaveformSource = setWaveformSource;
window.setWaveformStems  = setWaveformStems;
