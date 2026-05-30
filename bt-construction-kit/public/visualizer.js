// StemJam Audio Visualizer - Canvas Real-time Rendering

let canvas = null;
let ctx = null;
let analyser = null;
let dataArray = [];
let bufferLength = 0;
let animationFrameId = null;

// Beat pulsation variables
let beatInterval = null;
let canvasBorderBeatClass = 'pulse-active';

/**
 * Initialize the visualizer canvas and hooks
 */
function initVisualizer(analyserNode) {
  canvas = document.getElementById('visualizer-canvas');
  if (!canvas) return;
  
  ctx = canvas.getContext('2d');
  analyser = analyserNode;
  
  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
  
  // Set initial canvas resolution
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // Start the draw loop
  draw();
}

/**
 * Resize canvas dynamically to match container resolution
 */
function resizeCanvas() {
  if (!canvas) return;
  
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

/**
 * Main draw loop using requestAnimationFrame
 */
function draw() {
  animationFrameId = requestAnimationFrame(draw);
  
  if (!canvas || !ctx || !analyser) return;
  
  const width = canvas.width / window.devicePixelRatio;
  const height = canvas.height / window.devicePixelRatio;
  
  // Clear with a slightly transparent dark slate blue to get a motion blur/ghosting effect
  ctx.fillStyle = 'rgba(12, 13, 22, 0.25)';
  ctx.fillRect(0, 0, width, height);
  
  // Get frequency data
  analyser.getByteFrequencyData(dataArray);
  
  // Draw glowing frequency bars
  const barWidth = (width / (bufferLength / 2)) * 1.6;
  let barHeight;
  let x = 0;
  
  // We'll draw two symmetrical halves for a sleek audio dashboard style
  const activeBins = Math.floor(bufferLength * 0.7); // skip top inaudible frequencies
  
  // Custom neon gradient for the visualizer
  const gradient = ctx.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, '#9c27b0'); // purple faders base
  gradient.addColorStop(0.5, '#00bcd4'); // cyan mid faders
  gradient.addColorStop(1, '#2ecc71'); // neon green peak faders
  
  ctx.shadowBlur = 4;
  ctx.shadowColor = 'rgba(0, 188, 212, 0.4)';
  
  for (let i = 0; i < activeBins; i++) {
    // scale frequency value to fit canvas height
    barHeight = (dataArray[i] / 255) * height * 0.9;
    
    // Left-to-right bars
    ctx.fillStyle = gradient;
    ctx.fillRect(x, height - barHeight, barWidth - 2, barHeight);
    
    // Symmetrical right-to-left bars
    ctx.fillStyle = gradient;
    ctx.fillRect(width - x - barWidth, height - barHeight, barWidth - 2, barHeight);
    
    x += barWidth;
  }
  
  // Draw centered pulsing glowing wave (represents sub-bass/bass level)
  let bassSum = 0;
  for (let i = 0; i < 6; i++) { // average the lowest 6 frequency bins (bass frequencies)
    bassSum += dataArray[i];
  }
  const bassAverage = bassSum / 6;
  const bassScale = 1 + (bassAverage / 255) * 0.2; // pulse factor
  
  // Draw a sleek waveform line across the middle
  ctx.beginPath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.shadowBlur = 10 * (bassAverage / 255);
  ctx.shadowColor = '#00bcd4';
  
  const sliceWidth = width / bufferLength;
  let lineX = 0;
  
  for (let i = 0; i < bufferLength; i++) {
    // Use bass scaling to affect the line amplitude
    const v = dataArray[i] / 128.0;
    const y = (v * height) / 2;
    
    if (i === 0) {
      ctx.moveTo(lineX, y);
    } else {
      ctx.lineTo(lineX, y);
    }
    
    lineX += sliceWidth;
  }
  
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  
  // Reset shadow for performance
  ctx.shadowBlur = 0;
}

/**
 * Animate the border glow of the visualizer box to sync up with BPM beats
 */
function startBeatingVisualizer(bpm) {
  stopBeatingVisualizer();
  
  if (!bpm) bpm = 120;
  const beatMs = 60000 / bpm;
  
  const container = document.querySelector('.player-visualization-area');
  if (!container) return;
  
  // Synchronous beat pulsing loop
  beatInterval = setInterval(() => {
    container.classList.add(canvasBorderBeatClass);
    // Visual glow is a short peak pulse
    setTimeout(() => {
      container.classList.remove(canvasBorderBeatClass);
    }, 120);
  }, beatMs);
  
  // Add CSS styles for beat border glow dynamically
  const cssId = 'beat-pulsation-css';
  if (!document.getElementById(cssId)) {
    const style = document.createElement('style');
    style.id = cssId;
    style.innerHTML = `
      .player-visualization-area {
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .player-visualization-area.pulse-active {
        border-color: rgba(0, 188, 212, 0.6) !important;
        box-shadow: 0 0 15px rgba(0, 188, 212, 0.3);
      }
    `;
    document.head.appendChild(style);
  }
}

/**
 * Stop visualizer beats
 */
function stopBeatingVisualizer() {
  if (beatInterval) {
    clearInterval(beatInterval);
    beatInterval = null;
  }
  const container = document.querySelector('.player-visualization-area');
  if (container) {
    container.classList.remove(canvasBorderBeatClass);
  }
}
