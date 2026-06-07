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
let waveformPeaks = null;        // Float32Array of [0..1] amplitudes
let waveformDuration = 0;
let waveformUrl = null;          // url whose peaks are currently displayed
let waveformLoading = false;
let animationFrameId = null;
let canvasBorderBeatClass = 'pulse-active';
let beatInterval = null;

const PEAK_BUCKETS = 1500;

function initVisualizer(analyserNode) {
  canvas = document.getElementById('visualizer-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  analyser = analyserNode;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
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

// Called from app.js whenever a song is loaded. `url` is the audio URL
// (the m4a variant currently in the player; we use this as the source of
// truth for the waveform). Computing peaks is async; loading state is
// rendered as a faint placeholder until the buffer arrives.
async function setWaveformSource(url) {
  if (!ctx || !url || url === waveformUrl) return;
  waveformUrl = url;
  waveformPeaks = null;
  waveformLoading = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    // Build a one-shot AudioContext just for decoding — keeps us from
    // touching whatever audio graph the player is currently running.
    const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    // Decode requires a regular (online) AudioContext, but we don't need
    // to play it — just decodeAudioData. The simpleStem app already has an
    // AudioContext open by this point; reuse it via window.appAudioCtx if
    // exposed, else make a transient one.
    const ac = (window.appAudioCtx) || new (window.AudioContext || window.webkitAudioContext)();
    const buf = await new Promise((resolve, reject) => {
      // Both callback and promise forms work; the promise form is the
      // newer API but older Safari needs the callback form.
      try {
        const p = ac.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
    if (waveformUrl !== url) return;   // a newer song was loaded mid-decode
    waveformDuration = buf.duration;
    waveformPeaks = computePeaks(buf, PEAK_BUCKETS);
  } catch (e) {
    console.warn('[visualizer] peaks failed for', url, e.message);
    waveformPeaks = null;
    waveformDuration = 0;
  } finally {
    waveformLoading = false;
  }
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
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, width, height);

  if (waveformLoading) {
    drawPlaceholder(width, height, 'analyzing waveform…');
    return;
  }
  if (!waveformPeaks) {
    drawPlaceholder(width, height, '');
    return;
  }

  // Mirror waveform: peaks drawn upward from the centerline AND downward,
  // colored with the same purple → cyan → green gradient the old EQ used,
  // so the visual identity is preserved.
  const grad = ctx.createLinearGradient(0, height, 0, 0);
  grad.addColorStop(0, 'rgba(156, 39, 176, 0.85)');
  grad.addColorStop(0.5, 'rgba(0, 188, 212, 0.85)');
  grad.addColorStop(1, 'rgba(46, 204, 113, 0.85)');

  const bucketW = width / waveformPeaks.length;
  const half = height / 2;
  ctx.fillStyle = grad;
  for (let i = 0; i < waveformPeaks.length; i++) {
    const p = waveformPeaks[i];
    const barH = p * (height * 0.9);
    const x = i * bucketW;
    const w = Math.max(0.6, bucketW - 0.3);
    ctx.fillRect(x, half - barH / 2, w, barH);
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

// Expose hook for app.js to use.
window.setWaveformSource = setWaveformSource;
