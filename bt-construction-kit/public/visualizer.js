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

// Zoom state — persists across songs within a session. New song load keeps
// the current vizZoom but recenters vizCenterSec to the new song's start.
// vizZoom is one of VIZ_ZOOM_LEVELS; vizCenterSec is the time at the
// HORIZONTAL CENTER of the visible window. visibleStartSec / visibleEndSec
// derive from those plus waveformDuration with clamping at the ends.
const VIZ_ZOOM_LEVELS = [1, 2, 4, 8, 16];
let vizZoom = (function () {
  try {
    const v = parseInt(localStorage.getItem('simpleStem.vizZoom') || '1', 10);
    return VIZ_ZOOM_LEVELS.includes(v) ? v : 1;
  } catch (e) { return 1; }
})();
let vizCenterSec = 0;

function visibleSpanSec() {
  if (!waveformDuration) return 0;
  return waveformDuration / vizZoom;
}
function visibleStartSec() {
  if (vizZoom === 1 || !waveformDuration) return 0;
  const span = visibleSpanSec();
  let s = vizCenterSec - span / 2;
  if (s < 0) s = 0;
  if (s + span > waveformDuration) s = Math.max(0, waveformDuration - span);
  return s;
}
function visibleEndSec() {
  if (vizZoom === 1 || !waveformDuration) return waveformDuration;
  return visibleStartSec() + visibleSpanSec();
}
function timeToX(t, width) {
  const s = visibleStartSec(), e = visibleEndSec();
  if (e <= s) return 0;
  return ((t - s) / (e - s)) * width;
}
function xToTime(x, width) {
  const s = visibleStartSec(), e = visibleEndSec();
  return s + (x / width) * (e - s);
}
function persistZoom() {
  try { localStorage.setItem('simpleStem.vizZoom', String(vizZoom)); } catch (e) {}
}
// Auto-follow the playhead. When zoomed in, recenter so the playhead
// doesn't scroll off the visible window mid-song. Only kicks in past
// 80% of the visible span on either side so we're not constantly
// recentering by half a beat.
function autoFollowPlayhead() {
  if (vizZoom === 1 || !waveformDuration) return;
  const t = currentPlaybackTime();
  if (t == null) return;
  const s = visibleStartSec(), e = visibleEndSec(), span = e - s;
  if (t > s + span * 0.8 || t < s + span * 0.2) {
    vizCenterSec = t + span * 0.3;        // give the playhead room to advance
  }
}

function initVisualizer(analyserNode) {
  // Idempotent: app.js calls this eagerly at boot with null and later
  // again from initAudioCtx with the real analyser. The second call only
  // refreshes the analyser reference; canvas + render loop are already
  // wired up.
  if (canvas) {
    analyser = analyserNode || analyser;
    return;
  }
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
  // xToTime converts the screen X into the song time using the current
  // zoom window — at 1x this is identity, at 16x this is the magnified
  // chunk around vizCenterSec.
  let dragging = false;
  const onSeek = (e) => {
    if (waveformDuration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    seekAllAudioTo(xToTime(x, rect.width));
  };
  canvas.addEventListener('mousedown', (e) => { dragging = true; onSeek(e); });
  canvas.addEventListener('mousemove', (e) => { if (dragging) onSeek(e); });
  canvas.addEventListener('mouseup',   () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  // Zoom: double-click anywhere on the canvas to zoom in centered at that
  // point; right-click to reset to 1x. The two single-clicks before the
  // double-click each seek (intentional — both land on the same point),
  // then the dblclick zooms.
  canvas.addEventListener('dblclick', (e) => {
    if (waveformDuration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const target = xToTime(x, rect.width);
    const idx = VIZ_ZOOM_LEVELS.indexOf(vizZoom);
    if (idx < VIZ_ZOOM_LEVELS.length - 1) vizZoom = VIZ_ZOOM_LEVELS[idx + 1];
    vizCenterSec = target;
    persistZoom();
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    vizZoom = 1;
    persistZoom();
  });
}

// Public zoom API used by the +/- buttons in the visualizer header.
function vizZoomIn() {
  const idx = VIZ_ZOOM_LEVELS.indexOf(vizZoom);
  if (idx < VIZ_ZOOM_LEVELS.length - 1) {
    vizZoom = VIZ_ZOOM_LEVELS[idx + 1];
    const t = currentPlaybackTime();
    if (t != null) vizCenterSec = t;
  }
  persistZoom();
  return vizZoom;
}
function vizZoomOut() {
  const idx = VIZ_ZOOM_LEVELS.indexOf(vizZoom);
  if (idx > 0) vizZoom = VIZ_ZOOM_LEVELS[idx - 1];
  persistZoom();
  return vizZoom;
}
function vizZoomResetPublic() { vizZoom = 1; persistZoom(); return vizZoom; }
function vizZoomLevel() { return vizZoom; }
// Expose on window for app.js wiring without a module system. The
// visible-window helpers let app.js render section bands, automation
// markers, and the timeline scrubber against the same time-window the
// waveform uses, so a Logic-style zoom stretches EVERYTHING in time.
window.vizZoomIn          = vizZoomIn;
window.vizZoomOut         = vizZoomOut;
window.vizZoomReset       = vizZoomResetPublic;
window.vizZoomLevel       = vizZoomLevel;
window.vizVisibleStartSec = () => visibleStartSec();
window.vizVisibleEndSec   = () => visibleEndSec();
window.vizSongDuration    = () => waveformDuration;

// Notify the host (app.js) when the visible window changes — wraps every
// zoom-state mutation so the section bands / lane / scrubber can repaint
// in lockstep with the canvas. Without this, mousewheel/double-click zoom
// would update the canvas but leave bands at the previous scale until the
// next renderAutomationLane fires.
function notifyZoomChanged() {
  try { window.dispatchEvent(new CustomEvent('viz-window-changed')); } catch (e) {}
}
// Re-wrap the public mutators so they emit the event after persisting.
['vizZoomIn', 'vizZoomOut', 'vizZoomReset'].forEach(fn => {
  const orig = window[fn];
  window[fn] = function () { const r = orig.apply(this, arguments); notifyZoomChanged(); return r; };
});
// Also fire after the inline canvas zoom mutators (double-click,
// right-click, autoFollow). We patch by hooking the existing functions —
// since they're closures we can't override them directly, so instead we
// emit from a low-frequency tick that detects vizZoom or vizCenterSec drift.
let _lastEmittedZoom = vizZoom, _lastEmittedCenter = vizCenterSec;
setInterval(() => {
  if (vizZoom !== _lastEmittedZoom || Math.abs(vizCenterSec - _lastEmittedCenter) > 0.05) {
    _lastEmittedZoom = vizZoom; _lastEmittedCenter = vizCenterSec;
    notifyZoomChanged();
  }
}, 100);

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
  // Invalidate the onset table IMMEDIATELY. It used to keep the PREVIOUS
  // song's onsets until this song finished decoding, so a count-in fired
  // early aligned its clicks to the wrong song (Bill 2026-07-03).
  window.songOnsetTimes = null;
  window.songOnsetCount = 0;
  window.songBeatGrid = null;
  onsetEnv = null;
  onsetEnvHopSec = 0;
  drumsEnv = null;
  drumsLowEnv = null;
  beatFitEnvName = 'mix';

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
      accumulateOnsetEnvelope(buf, key);
    } catch (e) {
      console.warn('[visualizer] peaks failed for', key, url, e.message);
    }
  }));

  if (requestId !== stemPeaksRequestId) return;
  waveformLoading = false;
  if (!stemPeaks.size) waveformError = true;
  // New song: reset zoom to 1x so the operator always sees the whole
  // song with sections filling it — preferred for playing along ("knowing
  // what's coming next"). Earlier spec was "keep current zoom"; live
  // experience showed that always leaves you zoomed into the wrong
  // place across song transitions. Also reset center.
  vizZoom = 1;
  vizCenterSec = waveformDuration ? waveformDuration / 2 : 0;
  persistZoom();

  // Onset detection: walk the combined-peaks envelope and find local rises
  // that exceed a threshold with minimum spacing. Each rise is a 'spike'
  // — likely a drum hit, vocal attack, or other transient. The click
  // scheduler reads these as the times to fire clicks, so the click
  // genuinely follows the song's musical accents instead of the BPM grid.
  window.songOnsetTimes = computeOnsetTimes();
  // Also republish the BPM hint so the click scheduler can fall back when
  // onsets are sparse.
  window.songOnsetCount = window.songOnsetTimes ? window.songOnsetTimes.length : 0;
  // Beat grid: BPM period + phase fitted to the onsets of THIS source.
  // Everything click-related (whole-song click, section click/count-in,
  // MIDI clock) consumes window.songBeatGrid so all four stay in lockstep
  // with the audio the operator is actually hearing.
  window.songBeatGrid = chooseBeatGrid(window.songOnsetTimes);
  if (window.songBeatGrid) {
    const g = window.songBeatGrid;
    console.log(`[visualizer] beat grid: ${g.bpm.toFixed(1)} bpm, phase ${g.phase.toFixed(3)}s, ` +
                `${g.beats ? g.beats.length + ' beats' : 'no beats'}, downbeat +${g.downbeat || 0}, ` +
                `score ${(g.score || 0).toFixed(1)} (${g.source}, fit: ${beatFitEnvName})`);
  }
}

// Grid selection (Bill 2026-07-07: "I want the entire song to be the basis
// of the click track pulses instead of spot creating it each time").
// PRIMARY: the rigid whole-song least-squares grid — one (period, phase)
// fitted against every onset in the song and projected forward from t=0.
// Steady by construction; studio recordings live here. FALLBACK: the DP
// drift tracker, kept ONLY when the rigid grid measurably fails to explain
// the whole song (live recordings whose tempo genuinely moves — a rigid
// grid there is off the beat for most of the track). Both candidates are
// scored the same way, proximity-weighted over every onset, and the rigid
// grid wins any tie by a wide margin (80% of the DP score is enough).
function chooseBeatGrid(onsets) {
  const dur = waveformDuration || 0;
  const rigid = buildBeatGrid(onsets);
  if (rigid && dur > 0) {
    rigid.beats = rigidBeatsFromFit(rigid, dur);
    rigid.score = beatsScore(rigid.beats, onsets);
  }
  let dp = buildBeatGridDP();
  if (dp) {
    dp.beats = smoothBeats(dp.beats);
    dp.score = beatsScore(dp.beats, onsets);
  }
  let grid;
  if (rigid && rigid.beats && (!dp || rigid.score >= 0.8 * dp.score)) {
    grid = rigid;
    grid.source = (grid.source === 'bpm-only') ? 'bpm-only' : 'rigid-lsq';
  } else {
    grid = dp || rigid;
  }
  if (grid && grid.beats && grid.beats.length) grid.downbeat = downbeatOffset(grid.beats);
  return grid;
}

// Proximity-weighted fit quality: how well does this beat list explain the
// song's onsets? Same metric for both grid candidates.
function beatsScore(beats, onsets) {
  if (!beats || !beats.length || !onsets || !onsets.length) return 0;
  const TOL = 0.07;
  let score = 0;
  for (const t of onsets) {
    let lo = 0, hi = beats.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < t) lo = m + 1; else hi = m; }
    const dR = lo < beats.length ? Math.abs(beats[lo] - t) : 1e9;
    const dL = lo > 0 ? Math.abs(beats[lo - 1] - t) : 1e9;
    const d = Math.min(dL, dR);
    if (d < TOL) score += 1 - d / TOL;
  }
  return score;
}

// Materialize the rigid fit as explicit beat times covering the WHOLE song,
// projected back to the first beat at/after t=0.
function rigidBeatsFromFit(fit, duration) {
  const beats = [];
  let t = fit.phase % fit.period;
  if (t < 0) t += fit.period;
  for (; t <= duration + 0.001; t += fit.period) beats.push(t);
  return beats;
}

// Savitzky-Golay-style linear smoothing of DP beat times (±8 beats): keeps
// slow genuine tempo drift, kills the beat-to-beat jitter that made the
// click "speed up and slow down" on sparse intros.
function smoothBeats(beats) {
  if (!beats || beats.length < 9) return beats;
  const out = beats.slice();
  const W = 8;
  for (let i = 0; i < beats.length; i++) {
    const a = Math.max(0, i - W), b = Math.min(beats.length - 1, i + W);
    let sn = 0, st = 0, snn = 0, snt = 0, m = 0;
    for (let j = a; j <= b; j++) { sn += j; st += beats[j]; snn += j * j; snt += j * beats[j]; m++; }
    const den = m * snn - sn * sn;
    if (den) {
      const slope = (m * snt - sn * st) / den;
      const inter = (st - slope * sn) / m;
      out[i] = inter + slope * i;
    }
  }
  return out;
}

// Which of the 4 beat positions is beat 1 of the measure? Sum the song's
// onset-envelope energy at beats k ≡ r (mod 4) and take the strongest —
// the accent structure of the whole song picks its own downbeat.
function downbeatOffset(beats) {
  // The KICK owns beat 1. Total-mix energy picks the snare (beats 2/4) on
  // most rock recordings — Bill heard exactly that on Long Hard Ride. Use
  // the low-passed drums envelope when available; fall back to the drums
  // stem, then the mix.
  const env = drumsLowEnv || drumsEnv || onsetEnv;
  if (!env || !onsetEnvHopSec || !beats.length) return 0;
  const sums = [0, 0, 0, 0];
  for (let k = 0; k < beats.length; k++) {
    const i = Math.round(beats[k] / onsetEnvHopSec);
    if (i >= 1 && i < env.length - 1) {
      sums[k % 4] += Math.max(env[i - 1], env[i], env[i + 1]);
    }
  }
  let best = 0;
  for (let r = 1; r < 4; r++) if (sums[r] > sums[best]) best = r;
  return best;
}

// Dynamic-programming beat tracker (Ellis-style). A single global
// (phase, period) grid locks at its fit anchor and drifts audibly against
// any recording without a studio click — i.e. most of this library (Bill
// 2026-07-07: click synced at the start of the song, off the beat two
// minutes in). This walks the high-res onset-strength envelope with a
// tempo prior around the metadata BPM and returns EXPLICIT beat times that
// follow the band's drift. Consumers get {beats: [...]} plus the median
// period/phase fields for back-compat.
function buildBeatGridDP() {
  const srcEnv = (beatFitEnvName === 'drums' && drumsEnv) ? drumsEnv : onsetEnv;
  if (!srcEnv || !onsetEnvHopSec) return null;
  const hop = onsetEnvHopSec, N = srcEnv.length;
  if (N < 200) return null;
  const hint = Number(window.songBpmHint);
  const bpm0 = (isFinite(hint) && hint >= 40 && hint <= 260) ? hint : 120;
  // Onset strength: rectified 2-frame rise, normalized to mean 1.
  const LAG = 2;
  let max = 0;
  for (let i = 0; i < N; i++) if (srcEnv[i] > max) max = srcEnv[i];
  if (!max) return null;
  const O = new Float32Array(N);
  let sum = 0;
  for (let i = LAG; i < N; i++) {
    const r = (srcEnv[i] - srcEnv[i - LAG]) / max;
    if (r > 0) { O[i] = r; sum += r; }
  }
  if (!sum) return null;
  const mean = sum / N;
  for (let i = 0; i < N; i++) O[i] /= mean;
  const P = (60 / bpm0) / hop;                    // target period in frames
  const lo = Math.max(2, Math.round(P * 0.65));
  const hi = Math.round(P * 1.55);
  const TIGHT = 9;                                // tempo-prior tightness
  const score = new Float32Array(N);
  const from = new Int32Array(N).fill(-1);
  for (let i = lo; i < N; i++) {
    let bs = -1e9, bj = -1;
    const j1 = i - lo, j0 = Math.max(0, i - hi);
    for (let j = j0; j <= j1; j++) {
      const pen = Math.log((i - j) / P);
      const v = score[j] - TIGHT * pen * pen;
      if (v > bs) { bs = v; bj = j; }
    }
    score[i] = O[i] + (bj >= 0 ? bs : 0);
    from[i] = bj;
  }
  // Backtrack from the best-scoring frame near the end of the song.
  let end = -1, besc = -1e9;
  for (let i = Math.max(0, N - Math.round(2.2 * P)); i < N; i++) {
    if (score[i] > besc) { besc = score[i]; end = i; }
  }
  if (end < 0) return null;
  const idxs = [];
  for (let i = end; i >= 0 && idxs.length < 30000; i = from[i]) {
    idxs.push(i);
    if (from[i] < 0) break;
  }
  idxs.reverse();
  if (idxs.length < 8) return null;
  const beats = idxs.map(i => (i - LAG / 2) * hop);
  const iv = [];
  for (let k = 1; k < beats.length; k++) iv.push(beats[k] - beats[k - 1]);
  iv.sort((a, b) => a - b);
  const med = iv[Math.floor(iv.length / 2)];
  if (!(med > 0.15 && med < 2)) return null;
  return {
    bpm: 60 / med, period: med, phase: beats[0], beats,
    score: besc, onsetCount: idxs.length, source: 'dp',
  };
}

// Fit a beat grid (period + phase) to the detected onsets. The BPM hint
// comes from the app (metadata.json practiceBpm, set on window.songBpmHint
// before setWaveformStems is called); when absent we estimate it from the
// median inter-onset interval folded into 70-180 BPM. The period is allowed
// to flex +/-1.5% around the hint (librosa's estimate is good but not
// sample-exact) and the phase candidates are the first onsets themselves.
// Score = proximity-weighted count of onsets within 70 ms of a grid line.
function buildBeatGrid(onsets) {
  const hint = Number(window.songBpmHint);
  let bpm = (isFinite(hint) && hint >= 40 && hint <= 260) ? hint : null;
  if (!bpm && Array.isArray(onsets) && onsets.length >= 8) {
    const iois = [];
    for (let i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);
    iois.sort((x, y) => x - y);
    let p = iois[Math.floor(iois.length / 2)];
    if (p > 0.01) {
      while (60 / p > 180) p *= 2;
      while (60 / p < 70) p /= 2;
      bpm = 60 / p;
    }
  }
  if (!bpm) bpm = 120;
  const basePeriod = 60 / bpm;
  if (!Array.isArray(onsets) || onsets.length < 4) {
    return { bpm, period: basePeriod, phase: 0, score: 0, onsetCount: 0, source: 'bpm-only' };
  }
  let best = { score: -1, period: basePeriod, phase: 0 };
  const TOL = 0.07;
  for (let pm = -3; pm <= 3; pm++) {
    const period = basePeriod * (1 + pm * 0.005);
    const phases = onsets.slice(0, 24).map(t => t % period);
    for (const phase of phases) {
      let score = 0;
      for (const t of onsets) {
        const d = Math.abs(t - phase - Math.round((t - phase) / period) * period);
        if (d < TOL) score += 1 - d / TOL;
      }
      if (score > best.score) best = { score, period, phase };
    }
  }
  // Least-squares refinement over matched onsets (t ≈ phase + n·period):
  // kills the residual per-beat drift the coarse candidate search leaves.
  for (let pass = 0; pass < 2; pass++) {
    let sn = 0, st = 0, snn = 0, snt = 0, m = 0;
    for (const t of onsets) {
      const n = Math.round((t - best.phase) / best.period);
      const dev = t - (best.phase + n * best.period);
      if (Math.abs(dev) < TOL) { sn += n; st += t; snn += n * n; snt += n * t; m++; }
    }
    if (m >= 8) {
      const denom = m * snn - sn * sn;
      if (denom !== 0) {
        const period = (m * snt - sn * st) / denom;
        const phase = (st - period * sn) / m;
        if (period > 0.15 && Math.abs(period - best.period) < best.period * 0.03) {
          best.period = period;
          best.phase = phase;
        }
      }
    }
  }
  let score = 0;
  for (const t of onsets) {
    const dev = Math.abs(t - best.phase - Math.round((t - best.phase) / best.period) * best.period);
    if (dev < TOL) score += 1 - dev / TOL;
  }
  best.score = score;
  let phase = best.phase % best.period;
  if (phase < 0) phase += best.period;
  return {
    bpm: 60 / best.period, period: best.period, phase,
    score: best.score, onsetCount: onsets.length, source: 'onset-fit',
  };
}

// High-resolution onset envelope, separate from the drawing peaks. The
// drawing envelope has PEAK_BUCKETS buckets across the WHOLE song — ~190 ms
// each on a 5-minute track — which quantized onset timestamps so badly the
// fitted beat grid wandered audibly off the music (Bill 2026-07-07: "the
// click does not sound like it is sync'd"). This one is 512 samples per
// frame (~10.7 ms at 48 kHz), max-combined across stems during decode.
let onsetEnv = null;        // all stems combined (fallback + m4a sources)
let onsetEnvHopSec = 0;
let drumsEnv = null;        // drums stem alone — the beat-fit anchor
let drumsLowEnv = null;     // drums low-passed (~150 Hz) — the KICK, for downbeats
let beatFitEnvName = 'mix'; // which envelope the grid was fitted against

function accumulateOnsetEnvelope(buf, key) {
  const HOP = 512;
  const n = Math.floor(buf.length / HOP);
  if (n < 4) return;
  if (!onsetEnv || n > onsetEnv.length) {
    const grown = new Float32Array(n);
    if (onsetEnv) grown.set(onsetEnv);
    onsetEnv = grown;
  }
  onsetEnvHopSec = HOP / buf.sampleRate;
  const channels = Math.min(buf.numberOfChannels, 2);
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      const start = i * HOP, end = start + HOP;
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
      if (peak > onsetEnv[i]) onsetEnv[i] = peak;
    }
  }
  // The drums stem gets two dedicated envelopes: full-band (grid fitting —
  // a guitar strum a hair ahead of the kick can no longer drag the phase)
  // and low-passed (the kick drum, which owns the downbeat).
  if (key === 'drums') {
    drumsEnv = new Float32Array(n);
    drumsLowEnv = new Float32Array(n);
    const data = buf.getChannelData(0);
    const a = 1 - Math.exp(-2 * Math.PI * 150 / buf.sampleRate);  // one-pole LPF @ ~150 Hz
    let y = 0;
    for (let i = 0; i < n; i++) {
      let peak = 0, lowPeak = 0;
      const start = i * HOP, end = start + HOP;
      for (let j = start; j < end; j++) {
        const x = data[j];
        const v = Math.abs(x);
        if (v > peak) peak = v;
        y += a * (x - y);
        const lv = Math.abs(y);
        if (lv > lowPeak) lowPeak = lv;
      }
      drumsEnv[i] = peak;
      drumsLowEnv[i] = lowPeak;
    }
  }
}

function computeOnsetTimesHighRes(env) {
  const hop = onsetEnvHopSec, N = env.length;
  let max = 0;
  for (let i = 0; i < N; i++) if (env[i] > max) max = env[i];
  if (!max) return null;
  // Half-wave-rectified rise over a ~21 ms lag, peak-picked with an
  // adaptive threshold and 110 ms minimum spacing.
  const LAG = 2;
  const d = new Float32Array(N);
  let dsum = 0, dcnt = 0;
  for (let i = LAG; i < N; i++) {
    const r = (env[i] - env[i - LAG]) / max;
    if (r > 0) { d[i] = r; dsum += r; dcnt++; }
  }
  const thr = Math.max(0.06, 1.8 * (dcnt ? dsum / dcnt : 0));
  const minSpace = Math.ceil(0.11 / hop);
  const onsets = [];
  let last = -minSpace;
  for (let i = LAG; i < N - 1; i++) {
    if (d[i] >= thr && d[i] >= d[i - 1] && d[i] >= d[i + 1] && (i - last) >= minSpace) {
      onsets.push((i - LAG / 2) * hop);
      last = i;
    }
  }
  return onsets.length ? onsets : null;
}

function computeOnsetTimes() {
  // Prefer the isolated drums stem: its onsets ARE the beat. Fall back to
  // the combined envelope when there's no drums stem (backing/drum-machine
  // m4a) or the drums are too sparse to trust (brushes, acoustic tunes).
  if (drumsEnv && onsetEnvHopSec > 0) {
    const hi = computeOnsetTimesHighRes(drumsEnv);
    const need = Math.max(24, (waveformDuration || 60) / 3);
    if (hi && hi.length >= need) { beatFitEnvName = 'drums'; return hi; }
  }
  if (onsetEnv && onsetEnvHopSec > 0) {
    const hi = computeOnsetTimesHighRes(onsetEnv);
    if (hi) { beatFitEnvName = 'mix'; return hi; }
  }
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
  // Single-m4a sources (drum machine, backing track, legacy m4a) are ONE
  // stereo file -- always draw them as one full-height lane. Rendering the
  // same waveform in six stem lanes implied six stems that don't exist
  // (Bill 2026-07-04).
  const mode = stemPeaks.has('__m4a__') ? 'sum'
             : (window.__vizMode === 'stems') ? 'stems' : 'sum';

  // Auto-follow the playhead if we're zoomed and it's drifting out of
  // the visible window. Runs before any draw math so this frame uses the
  // newly-recentered window.
  autoFollowPlayhead();

  // Compute the visible peak slice for the current zoom window. At 1x
  // this is the whole peaks array; at NX it's a 1/N-wide slice.
  const _vs = visibleStartSec(), _ve = visibleEndSec();
  const _sliceStartFrac = waveformDuration > 0 ? _vs / waveformDuration : 0;
  const _sliceEndFrac   = waveformDuration > 0 ? _ve / waveformDuration : 1;

  if (mode === 'sum') {
    // Combine the per-stem peaks weighted by audible volume.
    const combined = combineAudiblePeaks();
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, 'rgba(156, 39, 176, 0.85)');
    grad.addColorStop(0.5, 'rgba(0, 188, 212, 0.85)');
    grad.addColorStop(1, 'rgba(46, 204, 113, 0.85)');
    // Slice the full-song peaks down to the visible window. At 1x this
    // is the whole array; at higher zoom we render only the buckets
    // covering [_vs, _ve] across the full canvas width.
    const startBucket = Math.max(0, Math.floor(_sliceStartFrac * combined.length));
    const endBucket   = Math.min(combined.length, Math.ceil(_sliceEndFrac * combined.length));
    const visBuckets  = Math.max(1, endBucket - startBucket);
    const bucketW = width / visBuckets;
    const half = height / 2;
    ctx.fillStyle = grad;
    for (let i = 0; i < visBuckets; i++) {
      const p = combined[startBucket + i];
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
      if (peaks) {
        // Peaks span the FULL canvas width [0, width], matching the
        // playhead and beat grid coordinate system. With zoom active we
        // render only the slice covering [visibleStart, visibleEnd]; at
        // zoom=1 startBucket=0 and endBucket=peaks.length so this is
        // identical to the unzoomed path.
        const startBucket = Math.max(0, Math.floor(_sliceStartFrac * peaks.length));
        const endBucket   = Math.min(peaks.length, Math.ceil(_sliceEndFrac * peaks.length));
        const visBuckets  = Math.max(1, endBucket - startBucket);
        const bucketW = width / visBuckets;
        ctx.fillStyle = color;
        for (let i = 0; i < visBuckets; i++) {
          const p = peaks[startBucket + i];
          const scaled = Math.min(1, Math.sqrt(p) * 1.15);
          const barH = scaled * (laneH * 0.88);
          const x = i * bucketW;
          const w = Math.max(0.6, bucketW - 0.3);
          ctx.fillRect(x, laneMid - barH / 2, w, barH);
        }
      }
      // Stem label — drawn AFTER the peaks so it sits visibly on top of
      // the (usually quiet) first-bucket waveform. Black halo for punch
      // over any section-band overlay.
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.strokeText(label, 4, laneMid);
      ctx.fillStyle = color;
      ctx.fillText(label, 4, laneMid);
    }
  }

  // Beat grid — vertical markers at every beat boundary computed from the
  // current song's BPM. Downbeats (every 4 in 4/4) get a brighter, thicker
  // line so bars are visible. This is what the click track aligns to —
  // visual and audible beat reinforce each other for practice.
  const bpm = (window.currentSong && window.currentSong.practiceBpm) || null;
  if (bpm && waveformDuration > 0) {
    const beatSec = 60 / bpm;
    // With zoom, only draw beat lines that fall inside the visible
    // window. At 1x this is every beat in the song; at 16x it's just
    // those in the magnified slice.
    const firstBeat = Math.max(1, Math.ceil(_vs / beatSec));
    const lastBeat  = Math.floor(_ve / beatSec);
    for (let i = firstBeat; i <= lastBeat; i++) {
      const x = timeToX(i * beatSec, width);
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

  // Playhead — drawn last so it sits ON TOP of section bands and the
  // waveform. Thick solid black line per user spec; thin white halo
  // for contrast against dark regions.
  if (playedX > 0 && playedX < width) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(playedX, 0);
    ctx.lineTo(playedX, height);
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(playedX, 0);
    ctx.lineTo(playedX, height);
    ctx.stroke();
    ctx.restore();
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
  // Uses the zoom-aware mapping so the playhead lands at the right pixel
  // inside the visible window. Off-window times return a value outside
  // [0,width] and the draw code naturally clips them.
  return timeToX(t, width);
}

// Best-effort: read currentTime off any HTMLAudioElement the app exposes.
// The app's `audioElements` object is shared on window when the player
// initializes; fall back to scanning DOM <audio> tags.
//
// PLAYHEAD-OFFSET COMPENSATION
// Bill observed at 16x zoom that the audible sound lags the visual
// playhead by ~200ms. Two causes stacked: macOS Core Audio outputLatency
// (~20-80ms on USB) and AAC decoder pre-roll on m4a stems (~50-200ms).
// The element's currentTime is the file position being DECODED, which is
// ahead of what's coming out of the speakers — so the visual playhead
// draws ahead of audible sound. We subtract a compensation value so the
// playhead lands where you HEAR.
//
// `vizPlayheadOffsetMs` is the total compensation in ms (default 200,
// user-tunable via window.setVizPlayheadOffsetMs() or just edit the
// localStorage key). Positive = shift visual playhead BACK in time so
// it matches the speakers.
let vizPlayheadOffsetMs = (function () {
  try {
    const v = parseInt(localStorage.getItem('simpleStem.vizPlayheadOffsetMs') || '200', 10);
    return Number.isFinite(v) ? v : 200;
  } catch (e) { return 200; }
})();
window.setVizPlayheadOffsetMs = function (ms) {
  vizPlayheadOffsetMs = Math.max(-500, Math.min(1000, Number(ms) || 0));
  try { localStorage.setItem('simpleStem.vizPlayheadOffsetMs', String(vizPlayheadOffsetMs)); } catch (e) {}
  return vizPlayheadOffsetMs;
};
window.getVizPlayheadOffsetMs = function () { return vizPlayheadOffsetMs; };

function currentPlaybackTime() {
  const offsetSec = (vizPlayheadOffsetMs || 0) / 1000;
  const els = window.audioElements;
  if (els) {
    for (const k of Object.keys(els)) {
      const ae = els[k];
      if (ae && ae.src && !ae.paused) {
        // Don't pull the playhead below 0 during the first few hundred
        // ms of playback — compensation only matters once we're moving.
        return Math.max(0, (ae.currentTime || 0) - offsetSec);
      }
    }
    // No element is currently playing — fall back to whatever's loaded.
    // While paused we don't apply offset (no audio rendering pipeline
    // running, so currentTime IS the position).
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
  // Scrub the lyrics overlay to match the new playhead position so the
  // operator sees which line lives there — not just whichever line was
  // last fired during playback.
  try {
    if (typeof window.syncLyricsToPlayhead === 'function') {
      window.syncLyricsToPlayhead(seconds);
    }
  } catch (e) {}
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
