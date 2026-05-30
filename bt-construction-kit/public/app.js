// Backing Track Construction Kit - Client Application Engine

// State management
let songLibrary = [];   // raw entries from server (one per file/folder)
let mergedLibrary = []; // grouped: one entry per song with .variants array
let filteredLibrary = []; // filtered view of mergedLibrary
let setlist = []; // Array of song items in setlist
let currentSong = null;
let currentMode = 'full'; // 'full' or 'loop' or 'outro'
let activeLoopNum = null;
let activeLoopMix = 'both'; // 'both', 'drums', 'bass'
let isPlaying = false;
let isLooping = false;
let playbackSpeed = 1.0;
let syncInterval = null;

// Outro Jam Stretching state
let stretchActive = false;
let stretchCycles = 2; // 2, 4, 8, 'infinite'
let isStretching = false;
let stretchCycleCount = 0;
let stretchTimer = null;
let currentMasterVolume = 1.0;

// Web Audio API variables
let audioCtx = null;
let analyserNode = null;
let masterGainNode = null;
let trackSources = {}; // trackKey -> MediaElementAudioSourceNode

// HTML5 Audio Elements
const audioElements = {
  vocals: new Audio(),
  drums: new Audio(),
  bass: new Audio(),
  guitar: new Audio(),
  piano: new Audio(),
  other: new Audio()
};

const CHANNELS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const LOOP_CAPABLE_CHANNELS = ['drums', 'bass', 'guitar', 'piano'];

// Helpers — setting audio.src='' does NOT actually clear the element; the
// property getter returns the resolved page URL, and the element will then
// try to *load* that page URL as media (→ MediaError, "no supported sources").
// Use the attribute helpers below for correct behavior.
function setAudioSrc(ae, url) {
  if (url) {
    ae.src = url;
  } else {
    ae.removeAttribute('src');
    try { ae.load(); } catch (e) {}
  }
}
function audioHasSrc(ae) {
  const s = ae.getAttribute('src');
  return !!s && s.length > 0;
}

// Track volumes and solo/mute states
const mixerState = {
  volumes: { vocals: 0.8, drums: 0.8, bass: 0.8, guitar: 0.8, piano: 0.8, other: 0.8 },
  muted:   { vocals: false, drums: false, bass: false, guitar: false, piano: false, other: false },
  soloed:  { vocals: false, drums: false, bass: false, guitar: false, piano: false, other: false }
};

// UI Elements
const els = {
  search: document.getElementById('song-search'),
  clearSearch: document.getElementById('clear-search'),
  filterAll: document.getElementById('btn-filter-all'),
  filterStems: document.getElementById('btn-filter-stems'),
  filterM4a: document.getElementById('btn-filter-m4a'),
  filterKey: document.getElementById('filter-key'),
  filterBpm: document.getElementById('filter-bpm'),
  
  // Stats
  statSongs: document.getElementById('stat-total-songs'),
  statStems: document.getElementById('stat-total-stems'),
  statM4as: document.getElementById('stat-total-m4as'),
  statArtists: document.getElementById('stat-total-artists'),
  barSlow: document.getElementById('tempo-slow-bar'),
  barMedium: document.getElementById('tempo-medium-bar'),
  barFast: document.getElementById('tempo-fast-bar'),
  countSlow: document.getElementById('tempo-slow-count'),
  countMedium: document.getElementById('tempo-medium-count'),
  countFast: document.getElementById('tempo-fast-count'),
  
  // Player
  playerIdle: document.getElementById('player-idle'),
  playerActive: document.getElementById('player-active'),
  trackType: document.getElementById('active-track-type'),
  trackTitle: document.getElementById('active-track-title'),
  trackArtist: document.getElementById('active-track-artist'),
  activeBpm: document.getElementById('active-bpm-value'),
  activeKey: document.getElementById('active-key-value'),
  activeKeySignature: document.getElementById('active-key-signature'),
  btnCollapsePlayer: document.getElementById('btn-collapse-player'),
  btnSpeedDialog: document.getElementById('btn-speed-dialog'),
  btnSpeedClose: document.getElementById('btn-speed-close'),
  speedPopover: document.getElementById('speed-popover'),
  speedDisplayMini: document.getElementById('speed-display-mini'),
  playerHeroSection: document.querySelector('.player-hero-section'),
  timeline: document.getElementById('player-timeline'),
  timelineFill: document.getElementById('timeline-progress'),
  timeCurrent: document.getElementById('time-current'),
  timeDuration: document.getElementById('time-duration'),
  buffering: document.getElementById('player-buffering-indicator'),
  
  // Controls
  btnPlay: document.getElementById('btn-play-pause'),
  btnStop: document.getElementById('btn-stop'),
  btnLoop: document.getElementById('btn-loop-toggle'),
  speedSlider: document.getElementById('speed-slider'),
  speedDisplay: document.getElementById('speed-display'),
  speedPresets: document.querySelectorAll('.preset-btn'),
  
  // Mixer
  mixerContainer: document.getElementById('mixer-container'),
  btnResetMixer: document.getElementById('btn-reset-mixer'),
  
  // Loops
  loopsContainer: document.getElementById('loops-container'),
  loopGrid: document.getElementById('loop-grid'),
  loopMixBoth: document.getElementById('loop-mix-both'),
  loopMixDrums: document.getElementById('loop-mix-drums'),
  loopMixBass: document.getElementById('loop-mix-bass'),

  // Outro loop stretch controls
  stretchToggle: document.getElementById('stretch-toggle'),
  stretchCyclesContainer: document.getElementById('stretch-cycles-container'),
  cycleBtns: document.querySelectorAll('.cycle-btn'),
  stretchInfo: document.getElementById('stretch-info-text'),
  
  // Library list
  songListBody: document.getElementById('song-list-body'),
  libraryContainer: document.getElementById('library-container'),
  btnListView: document.getElementById('btn-list-view'),
  btnGridView: document.getElementById('btn-grid-view'),
  countLabel: document.getElementById('library-count-label'),

  // Setlist Planner
  setlistStatsLabel: document.getElementById('setlist-stats-label'),
  btnClearSetlist: document.getElementById('btn-clear-setlist'),
  setlistStartTime: document.getElementById('setlist-start-time'),
  setlistName: document.getElementById('setlist-name'),
  setlistSongsContainer: document.getElementById('setlist-songs-container'),

  // Add-from-YouTube queue
  ytUrl: document.getElementById('yt-url'),
  btnEnqueue: document.getElementById('btn-enqueue'),
  queueStatus: document.getElementById('queue-status')
};

// CORS credentials requirement
Object.values(audioElements).forEach(ae => {
  ae.crossOrigin = "anonymous";
});

// Nominate vocals (or whatever exists) as master ended listener
Object.keys(audioElements).forEach(chan => {
  const ae = audioElements[chan];
  ae.addEventListener('ended', () => {
    // We only trigger ending coordinate logic from the master track
    const activeTracks = Object.keys(audioElements).filter(k => audioHasSrc(audioElements[k]));
    if (activeTracks[0] === chan) {
      handleMasterTrackEnded();
    }
  });
});

// Initialize the app
window.addEventListener('DOMContentLoaded', () => {
  fetchLibrary();
  setupEventListeners();
  loadSetlistFromLocalStorage();
  loadMixerState();
  startWallClock();
  startCacheStatusPoll();
  setupQueueUI();

  // Diagnostic: log audio element errors and unexpected ended events
  Object.keys(audioElements).forEach(chan => {
    const ae = audioElements[chan];
    ae.addEventListener('error', () => {
      console.warn(`[audio:${chan}] error`, ae.error, 'src=', ae.src);
    });
    ae.addEventListener('ended', () => {
      console.log(`[audio:${chan}] ended at`, ae.currentTime, '/', ae.duration);
    });
    ae.addEventListener('stalled', () => console.log(`[audio:${chan}] stalled`));
  });
});

// ── Add-from-YouTube queue ────────────────────────────────────────────────
function setupQueueUI() {
  if (!elements.btnEnqueue) return;
  elements.btnEnqueue.addEventListener('click', enqueueUrl);
  elements.ytUrl.addEventListener('keydown', e => { if (e.key === 'Enter') enqueueUrl(); });
  refreshQueue();
  setInterval(refreshQueue, 5000);
}

async function enqueueUrl() {
  const url = (elements.ytUrl.value || '').trim();
  if (!url) return;
  elements.btnEnqueue.disabled = true;
  try {
    const res = await fetch('/api/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to queue');
    elements.ytUrl.value = '';
    refreshQueue();
  } catch (e) {
    if (elements.queueStatus) elements.queueStatus.innerHTML =
      `<span class="queue-err">${e.message}</span>`;
  } finally {
    elements.btnEnqueue.disabled = false;
  }
}

async function refreshQueue() {
  if (!elements.queueStatus) return;
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) return;
    renderQueue(await res.json());
  } catch (e) { /* server may be busy; leave last state */ }
}

function renderQueue(q) {
  const el = elements.queueStatus;
  const chips = [];
  if (q.processing) {
    const s = q.processing.song || q.processing.job || 'a song';
    const ph = q.processing.phase ? ` · ${q.processing.phase}` : '';
    const since = q.processing.phase_since ? ` (since ${q.processing.phase_since})` : '';
    chips.push(`<span class="queue-chip processing" title="rendering${since}">⚙ ${s}${ph}</span>`);
  }
  const incoming = (q.incoming || []).length;
  if (incoming) chips.push(`<span class="queue-chip">⏳ ${incoming} awaiting metadata</span>`);
  for (const j of (q.queued || [])) {
    chips.push(`<span class="queue-chip">▦ ${j.name}${j.type === 'setlist' ? ` (${j.songs})` : ''}</span>`);
  }
  const failed = (q.failed || []).length;
  if (failed) chips.push(`<span class="queue-chip queue-err">✕ ${failed} failed</span>`);
  el.innerHTML = chips.length ? chips.join(' ') : '<span class="queue-idle">Queue empty</span>';
}

// Fetch songs from server
async function fetchLibrary() {
  try {
    const res = await fetch('/api/library');
    if (!res.ok) throw new Error('Failed to load library');
    const data = await res.json();
    
    // Raw entries (one per file/folder)
    songLibrary = data.songs;

    // Merge entries that represent the same song across formats
    // (STEMS folder + M4A variants). Keyed by lowercase "title|artist".
    mergedLibrary = mergeByTitleArtist(songLibrary);
    mergedLibrary.sort((a, b) => a.title.localeCompare(b.title));

    filteredLibrary = [...mergedLibrary];
    
    renderStats(data.stats);
    renderLibrary();
    populateKeyFilter(data.songs);
    
    let ageStr = '';
    if (data.scannedAt)       ageStr += ` · scanned ${timeAgo(data.scannedAt)}`;
    if (data.checkedAt && data.checkedAt !== data.scannedAt) ageStr += ` (checked ${timeAgo(data.checkedAt)})`;
    if (data.sourceMtimes && data.sourceMtimes.stems) {
      ageStr += ` · folder mtime ${timeAgo(data.sourceMtimes.stems)}`;
    }
    els.countLabel.textContent = `Found ${mergedLibrary.length} unique songs (${songLibrary.length} files across formats)${ageStr}`;

    // Fresh library data is loaded — refresh cache chips immediately rather
    // than waiting for the next poll tick (which could be up to 4–20s away).
    if (typeof cacheStatusRefresh === 'function') cacheStatusRefresh();
  } catch (err) {
    console.error(err);
    els.songListBody.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle" class="text-red" style="width: 48px; height: 48px;"></i>
        <h2>Error Loading Library</h2>
        <p>Failed to communicate with the construction kit server. Make sure Node is running on port 3000.</p>
      </div>
    `;
    lucide.createIcons();
  }
}

// Group raw song entries (stems folders + m4a files) by (title, artist).
// Returns one item per unique song, with a `variants` array containing the
// underlying raw entries. The 'primary' is the stems variant if present,
// otherwise the first m4a. BPM/Key/Duration are inherited from primary.
function mergeByTitleArtist(rawSongs) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const groups = new Map();
  for (const s of rawSongs) {
    const key = `${norm(s.title)}|${norm(s.artist)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const merged = [];
  for (const [key, variants] of groups) {
    // Sort variants: stems first, then m4a variants in a sensible order
    variants.sort((a, b) => {
      const order = { STEMS: 0, FULL: 1, '-V': 2, '-V-G': 3, '-V-B': 4, '-V-G-B': 5, DO: 6 };
      return (order[a.variantCode] ?? 9) - (order[b.variantCode] ?? 9);
    });
    const primary = variants[0];
    merged.push({
      id: `merged-${key}`,
      type: 'merged',
      title: primary.title,
      artist: primary.artist,
      practiceBpm: primary.practiceBpm,
      originalBpm: primary.originalBpm,
      key: primary.key,
      duration: primary.duration,
      variants,
      primary
    });
  }
  return merged;
}

// Render library stats
function renderStats(stats) {
  els.statSongs.textContent = stats.totalSongs;
  els.statStems.textContent = stats.totalStems;
  els.statM4as.textContent = stats.totalM4as;
  els.statArtists.textContent = stats.artistCount;
  
  const totalWithBpm = stats.bpmDistribution.slow + stats.bpmDistribution.medium + stats.bpmDistribution.fast;
  
  if (totalWithBpm > 0) {
    const slowPct = (stats.bpmDistribution.slow / totalWithBpm) * 100;
    const medPct = (stats.bpmDistribution.medium / totalWithBpm) * 100;
    const fastPct = (stats.bpmDistribution.fast / totalWithBpm) * 100;
    
    els.barSlow.style.width = `${slowPct}%`;
    els.barMedium.style.width = `${medPct}%`;
    els.barFast.style.width = `${fastPct}%`;
    
    els.countSlow.textContent = stats.bpmDistribution.slow;
    els.countMedium.textContent = stats.bpmDistribution.medium;
    els.countFast.textContent = stats.bpmDistribution.fast;
  }
  
  // Render key spread spread in sidebar
  const keys = Object.keys(stats.keyDistribution).sort();
  if (keys.length > 0) {
    const keyContainer = document.createElement('div');
    keyContainer.className = 'key-dist-grid';
    
    keys.forEach(k => {
      const pill = document.createElement('div');
      pill.className = 'key-pill hover-glow';
      pill.textContent = `${k} (${stats.keyDistribution[k]})`;
      pill.title = `${stats.keyDistribution[k]} tracks in the key of ${k}`;
      pill.addEventListener('click', () => {
        els.filterKey.value = k;
        applyFilters();
      });
      keyContainer.appendChild(pill);
    });
    
    const statsCard = document.querySelector('.tempo-dist-card');
    const existing = document.querySelector('.key-dist-grid');
    if (existing) existing.remove();
    
    const keyHeader = document.createElement('h4');
    keyHeader.className = 'sub-title';
    keyHeader.style.marginTop = '16px';
    keyHeader.innerHTML = '<i data-lucide="key" style="width:12px;display:inline;vertical-align:middle;margin-right:4px;"></i> Key Signature Spread';
    
    statsCard.appendChild(keyHeader);
    statsCard.appendChild(keyContainer);
    lucide.createIcons();
  }
}

// Populate keys filter dropdown
function populateKeyFilter(songs) {
  const keys = [...new Set(songs.map(s => s.key).filter(Boolean))].sort();
  els.filterKey.innerHTML = '<option value="">Any Key</option>';
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    els.filterKey.appendChild(opt);
  });
}

// Render Song Library Browser
function renderLibrary() {
  if (filteredLibrary.length === 0) {
    els.songListBody.innerHTML = `
      <div class="empty-state">
        <i data-lucide="music-off" style="width: 48px; height: 48px;"></i>
        <h2>No Tracks Found</h2>
        <p>No tracks match your search queries or filters.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  els.songListBody.innerHTML = '';
  
  filteredLibrary.forEach(merged => {
    const primary = merged.primary;
    const row = document.createElement('div');
    const isActive = currentSong && merged.variants.some(v => v.id === currentSong.id);
    row.className = `song-row ${isActive ? 'active' : ''}`;
    row.dataset.id = merged.id;

    // Setlist checkbox (toggles the primary variant)
    const selectCell = document.createElement('div');
    selectCell.className = 'song-select-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'song-checkbox';
    checkbox.checked = setlist.some(item => item.id === primary.id);
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) addToSetlist(primary);
      else removeFromSetlist(primary.id);
    });
    selectCell.appendChild(checkbox);

    // Title  (play button on the left starts STEMS variant immediately)
    const titleCell = document.createElement('div');
    titleCell.className = 'song-title-cell';
    titleCell.innerHTML = `
      <button class="play-row-btn" title="Play stems"><i data-lucide="play"></i></button>
      <span>${merged.title}</span>
    `;
    const playBtn = titleCell.querySelector('.play-row-btn');
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // If the player is currently collapsed, expand it so the mixer is visible
      const sect = els.playerHeroSection;
      if (sect && sect.classList.contains('player-collapsed') && els.btnCollapsePlayer) {
        els.btnCollapsePlayer.click();
      }
      // Fast-play decision:
      //   - If STEMS are cached → play STEMS (instant, full mixer).
      //   - Else, if a -V-G M4A exists → play that (one small file, plays now).
      //   - Else fall back to primary.
      const stems = merged.variants.find(v => v.type === 'stems');
      const vgM4a = merged.variants.find(v => v.type === 'm4a' && v.variantCode === '-V-G');
      let pick;
      if (stems && stems.cached) pick = stems;
      else if (vgM4a)            pick = vgM4a;
      else                       pick = merged.primary;
      loadSong(pick, { autoplay: true });
    });

    // Artist
    const artistCell = document.createElement('div');
    artistCell.className = 'song-artist-cell';
    artistCell.textContent = merged.artist;

    // BPM
    const bpmCell = document.createElement('div');
    bpmCell.className = 'song-bpm-cell';
    if (merged.practiceBpm) {
      if (merged.originalBpm) {
        bpmCell.innerHTML = `
          <span>${merged.practiceBpm} BPM</span>
          <span class="bpm-sub">Orig: ${merged.originalBpm}</span>
        `;
      } else {
        bpmCell.textContent = `${merged.practiceBpm} BPM`;
      }
    } else {
      bpmCell.textContent = '--';
    }

    // Key
    const keyCell = document.createElement('div');
    keyCell.className = 'song-key-cell';
    keyCell.textContent = merged.key || '--';

    // Format chips: one chip per variant, clickable to load that variant
    const formatCell = document.createElement('div');
    formatCell.className = 'song-format-cell';

    // "Cached / ready" badge — song plays instantly when clicked. Lights up
    // when EITHER stems are fully cached OR the -V-G m4a is cached.
    const stemsVariant = merged.variants.find(v => v.type === 'stems');
    const vgM4aCached = merged.variants.find(v => v.type === 'm4a' && v.variantCode === '-V-G' && v.cached);
    const stemsCached = stemsVariant && stemsVariant.cached;
    if (stemsCached || vgM4aCached) {
      const ready = document.createElement('span');
      ready.className = 'cached-chip' + (stemsCached ? ' cached-chip-stems' : '');
      ready.title = stemsCached
        ? 'Stems cached locally — instant full-mix playback'
        : 'M4A cached locally — instant backing-track playback';
      const label = stemsCached ? 'STEMS' : 'READY';
      ready.innerHTML = `<i data-lucide="zap" style="width:10px;height:10px;"></i> ${label}`;
      formatCell.appendChild(ready);
    }

    merged.variants.forEach(v => {
      const chip = document.createElement('button');
      const isStems = v.type === 'stems';
      const cachedCls = v.cached ? ' chip-cached' : '';
      const activeCls = currentSong && currentSong.id === v.id ? ' chip-active' : '';
      chip.className = `format-chip ${isStems ? 'chip-stems' : 'chip-m4a'}${cachedCls}${activeCls}`;
      chip.title = `${v.variantLabel}${v.cached ? ' — cached, instant play' : ''} — click to load`;
      chip.dataset.variantId = v.id;
      const icon = isStems ? 'sliders' : 'music-4';
      const label = isStems ? 'STEMS' : v.variantCode;
      chip.innerHTML = `<i data-lucide="${icon}" style="width:10px;height:10px;"></i> ${label}`;
      chip.addEventListener('click', e => {
        e.stopPropagation();
        loadSong(v);
      });
      formatCell.appendChild(chip);
    });

    // Action
    const actionCell = document.createElement('div');
    actionCell.className = 'col-action';
    actionCell.innerHTML = `<button class="btn-secondary" style="padding: 4px 10px;">Load</button>`;

    row.appendChild(selectCell);
    row.appendChild(titleCell);
    row.appendChild(artistCell);
    row.appendChild(bpmCell);
    row.appendChild(keyCell);
    row.appendChild(formatCell);
    row.appendChild(actionCell);

    // Row click loads the primary (richest) variant
    row.addEventListener('click', () => loadSong(primary));

    els.songListBody.appendChild(row);
  });
  
  lucide.createIcons();
}

// Client Side Search and Filters
function applyFilters() {
  const query = els.search.value.toLowerCase().trim();
  const format = document.querySelector('.filter-btn.active').id;
  const key = els.filterKey.value;
  const bpmRange = els.filterBpm.value;
  
  filteredLibrary = mergedLibrary.filter(song => {
    const titleMatch = song.title.toLowerCase().includes(query);
    const artistMatch = song.artist.toLowerCase().includes(query);
    const keyMatchStr = song.key && song.key.toLowerCase().includes(query);
    const matchesQuery = !query || titleMatch || artistMatch || keyMatchStr;

    let matchesFormat = true;
    if (format === 'btn-filter-stems') matchesFormat = song.variants.some(v => v.type === 'stems');
    if (format === 'btn-filter-m4a')   matchesFormat = song.variants.some(v => v.type === 'm4a');

    const matchesKey = !key || song.key === key;

    let matchesBpm = true;
    if (bpmRange && song.practiceBpm) {
      if (bpmRange === 'slow')   matchesBpm = song.practiceBpm < 90;
      if (bpmRange === 'medium') matchesBpm = song.practiceBpm >= 90 && song.practiceBpm <= 125;
      if (bpmRange === 'fast')   matchesBpm = song.practiceBpm > 125;
    } else if (bpmRange && !song.practiceBpm) {
      matchesBpm = false;
    }

    return matchesQuery && matchesFormat && matchesKey && matchesBpm;
  });
  
  els.countLabel.textContent = `Found ${filteredLibrary.length} tracks matching filters`;
  renderLibrary();
}

// Initialize Web Audio graph
function initAudioCtx() {
  if (audioCtx) return;
  
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  
  masterGainNode = audioCtx.createGain();
  currentMasterVolume = 1.0;
  masterGainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
  
  masterGainNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);
  
  Object.keys(audioElements).forEach(chan => {
    const ae = audioElements[chan];
    const source = audioCtx.createMediaElementSource(ae);
    source.connect(masterGainNode);
    trackSources[chan] = source;
  });
  
  initVisualizer(analyserNode);
}

// Load song into the mixer
function loadSong(song, opts) {
  opts = opts || {};
  initAudioCtx();

  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // If we're switching between variants of the SAME song (e.g. STEMS → -V-G),
  // capture the playhead + play state so we can resume at the same spot after
  // the new variant finishes loading. Only when they share a merged group.
  let resumeAt = 0;
  let resumePlaying = false;
  if (currentSong && song && currentSong.id !== song.id) {
    const oldMerged = mergedLibrary.find(m => m.variants.some(v => v.id === currentSong.id));
    const newMerged = mergedLibrary.find(m => m.variants.some(v => v.id === song.id));
    if (oldMerged && oldMerged === newMerged) {
      const activeEls = Object.values(audioElements).filter(audioHasSrc);
      if (activeEls.length > 0) {
        resumeAt = activeEls[0].currentTime || 0;
        resumePlaying = isPlaying;
      }
    }
  }

  // Stop running outro timers or playback
  if (stretchTimer) clearTimeout(stretchTimer);
  isStretching = false;
  els.buffering.style.display = 'none';

  stopAudio();
  
  currentSong = song;
  currentMode = 'full';
  activeLoopNum = null;
  // Reset loop-mode flag — a leftover `isLooping=true` from a previous loop
  // segment was causing the master 'ended' handler to restart playback at 0
  // every time, locking the playhead near the start.
  isLooping = false;
  if (els.btnLoop) els.btnLoop.classList.remove('active');
  
  // Reset master fader volume
  masterGainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
  currentMasterVolume = 1.0;
  
  // Active row highlight: a merged row is active when ANY of its variants matches the loaded song.
  document.querySelectorAll('.song-row').forEach(row => {
    const merged = mergedLibrary.find(m => m.id === row.dataset.id);
    const isActive = !!(merged && merged.variants.some(v => v.id === song.id));
    row.classList.toggle('active', isActive);
    // Highlight the active variant chip within that row
    row.querySelectorAll('.format-chip').forEach(chip => {
      chip.classList.toggle('chip-active', chip.dataset.variantId === song.id);
    });
  });
  
  els.playerIdle.style.display = 'none';
  els.playerActive.style.display = 'block';

  // Render variant picker (Source: STEMS / -V-G-B / -V-G / DO ...)
  renderVariantPicker(song);

  els.trackTitle.textContent = song.title;
  els.trackArtist.textContent = song.artist;
  els.activeBpm.textContent = song.practiceBpm || '--';
  els.activeKey.textContent = song.key || '--';
  if (els.activeKeySignature) {
    els.activeKeySignature.textContent = song.keySignature ? `(${song.keySignature})` : '';
  }
  
  // Set all tracks to non-loop browser-wise to prevent wrap stutter
  Object.values(audioElements).forEach(ae => {
    ae.loop = false;
  });
  
  if (song.type === 'stems') {
    els.trackType.textContent = 'STEMS';
    els.trackType.className = 'badge';
    els.mixerContainer.style.display = 'block';
    
    document.querySelectorAll('.channel-strip').forEach(c => c.style.display = 'flex');
    
    // Setup sources
    const folder = song.folderName;
    CHANNELS.forEach(chan => {
      const fileName = song.stems[chan];
      setAudioSrc(audioElements[chan], fileName ? `/api/audio/stems/${folder}/${fileName}` : '');
      const strip = document.querySelector(`.${chan}-strip`);
      if (strip) strip.style.display = fileName ? 'flex' : 'none';
    });

    // Per-instrument loop buttons inside each channel strip
    renderChannelLoopButtons(song.loops || []);

    // Enable Outro stretch controls if loops exist
    if (song.loops && song.loops.length > 0) {
      els.loopsContainer.style.display = 'block';
      document.querySelector('.stretch-outro-card').style.opacity = '1';
      document.querySelector('.stretch-outro-card').style.pointerEvents = 'auto';
      renderLoopButtons(song.loops);
    } else {
      els.loopsContainer.style.display = 'none';
      document.querySelector('.stretch-outro-card').style.opacity = '0.5';
      document.querySelector('.stretch-outro-card').style.pointerEvents = 'none';
      els.stretchToggle.checked = false;
      stretchActive = false;
      toggleStretchState();
    }
  } else {
    // M4A Track
    els.trackType.textContent = 'M4A BACKING TRACK';
    els.trackType.className = 'badge m4a-badge';
    
    els.mixerContainer.style.display = 'none';
    els.loopsContainer.style.display = 'none';
    document.querySelector('.stretch-outro-card').style.opacity = '0.5';
    document.querySelector('.stretch-outro-card').style.pointerEvents = 'none';
    els.stretchToggle.checked = false;
    stretchActive = false;
    toggleStretchState();
    
    // M4A is a single stereo file — route through the 'drums' element as a carrier.
    // Clear ONLY the non-drums channels (clearing then immediately reassigning
    // drums.src in the same tick races on some browsers — abort fires while the
    // new load is already in flight, audio appears to start then immediately ends).
    CHANNELS.forEach(chan => {
      if (chan !== 'drums') setAudioSrc(audioElements[chan], '');
    });
    setAudioSrc(audioElements.drums, `/api/audio/m4a/${encodeURIComponent(song.fileName)}`);

    document.querySelectorAll('.channel-strip').forEach(c => c.style.display = 'none');
  }
  
  // Buffering loader
  els.buffering.style.display = 'flex';
  
  let loadedCount = 0;
  const activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));
  
  activeElements.forEach(ae => {
    ae.load();
    ae.oncanplaythrough = () => {
      ae.oncanplaythrough = null;
      loadedCount++;
      if (loadedCount === activeElements.length) {
        els.buffering.style.display = 'none';
        // If we were mid-playback on another variant, seek to that position
        // on every active element and resume play (variant hot-swap).
        if (resumeAt > 0) {
          activeElements.forEach(el => {
            try {
              const seekTo = Math.min(resumeAt, (el.duration || resumeAt));
              el.currentTime = seekTo;
            } catch (e) {}
          });
          els.timeCurrent.textContent = formatTime(resumeAt);
        }
        if ((resumePlaying || opts.autoplay) && !isPlaying) {
          togglePlayPause();
        }
      }
    };
  });

  els.timeline.value = 0;
  els.timelineFill.style.width = '0%';
  els.timeCurrent.textContent = resumeAt > 0 ? formatTime(resumeAt) : '0:00';
  els.timeDuration.textContent = '0:00';
  
  const masterAe = activeElements[0];
  if (masterAe) {
    // Set accurate duration from metadata if available on backend, fallback to DOM
    if (song.duration) {
      els.timeDuration.textContent = formatTime(song.duration);
    }
    masterAe.addEventListener('durationchange', () => {
      els.timeDuration.textContent = formatTime(masterAe.duration);
    });
  }
  
  applyMixerVolumes();
  setPlaybackSpeed(playbackSpeed);
}

// Variant picker inside the player. Lets the user switch between STEMS and
// any M4A variants of the same song without going back to the library.
function renderVariantPicker(currentVariant) {
  const picker = document.getElementById('variant-picker');
  const chipsEl = document.getElementById('variant-picker-chips');
  if (!picker || !chipsEl) return;

  // Find the merged record that contains this variant
  const merged = mergedLibrary.find(m => m.variants.some(v => v.id === currentVariant.id));
  if (!merged || merged.variants.length <= 1) {
    picker.style.display = 'none';
    return;
  }

  picker.style.display = 'flex';
  chipsEl.innerHTML = '';
  merged.variants.forEach(v => {
    const btn = document.createElement('button');
    const isStems = v.type === 'stems';
    btn.className = `variant-chip ${isStems ? 'chip-stems' : 'chip-m4a'} ${v.id === currentVariant.id ? 'chip-active' : ''}`;
    const icon = isStems ? 'sliders' : 'music-4';
    const code = isStems ? 'STEMS' : v.variantCode;
    btn.innerHTML = `<i data-lucide="${icon}" style="width:12px;height:12px;"></i> ${code}`;
    btn.title = v.variantLabel;
    btn.addEventListener('click', () => loadSong(v));
    chipsEl.appendChild(btn);
  });
  lucide.createIcons();
}

// Per-channel inline loop buttons (drums/bass/guitar/piano).
// Clicking a number on a channel: plays ONLY that instrument's loop for that
// segment. Clicking the active one again exits loop mode back to full song.
function renderChannelLoopButtons(loops) {
  LOOP_CAPABLE_CHANNELS.forEach(chan => {
    const container = document.querySelector(`.channel-loops[data-channel="${chan}"]`);
    if (!container) return;
    container.innerHTML = '';

    const loopsForChan = loops.filter(l => l.files && l.files[chan]);
    if (loopsForChan.length === 0) return;

    loopsForChan.sort((a, b) => a.loopNum - b.loopNum).forEach(l => {
      const btn = document.createElement('button');
      btn.className = 'channel-loop-btn';
      btn.textContent = l.loopNum;
      btn.title = `Loop ${l.loopNum} (${l.bars} bars) — ${chan} only`;
      btn.dataset.channel = chan;
      btn.dataset.loopNum = l.loopNum;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const alreadyActive = currentMode === 'loop' && activeLoopNum === l.loopNum && activeLoopMix === chan;
        if (alreadyActive) {
          loadSong(currentSong); // exit loop mode
        } else {
          activeLoopMix = chan;
          // Sync the top mix-type buttons (which only know 'both'/'drums'/'bass')
          [els.loopMixBoth, els.loopMixDrums, els.loopMixBass].forEach(b => b && b.classList.remove('active'));
          if (chan === 'drums' && els.loopMixDrums) els.loopMixDrums.classList.add('active');
          else if (chan === 'bass' && els.loopMixBass) els.loopMixBass.classList.add('active');
          playLoopSegment(l.loopNum);
        }
        updateChannelLoopButtonStates();
      });
      container.appendChild(btn);
    });
  });
  updateChannelLoopButtonStates();
}

function updateChannelLoopButtonStates() {
  document.querySelectorAll('.channel-loop-btn').forEach(btn => {
    const active = currentMode === 'loop'
      && parseInt(btn.dataset.loopNum) === activeLoopNum
      && btn.dataset.channel === activeLoopMix;
    btn.classList.toggle('active', active);
  });
}

// Render synchronized jam loop segments
function renderLoopButtons(loops) {
  els.loopGrid.innerHTML = '';
  
  loops.forEach(l => {
    const btn = document.createElement('button');
    btn.className = 'loop-btn hover-glow';
    btn.innerHTML = `
      <span class="loop-btn-title">Loop Segment ${l.loopNum}</span>
      <span class="loop-btn-bars">${l.bars} Bars</span>
    `;
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentMode === 'loop' && activeLoopNum === l.loopNum) {
        loadSong(currentSong);
      } else {
        playLoopSegment(l.loopNum);
      }
    });
    
    els.loopGrid.appendChild(btn);
  });
}

// Play tiled loop version
function playLoopSegment(loopNum) {
  if (!currentSong || currentSong.type !== 'stems') return;
  
  stopAudio();
  
  currentMode = 'loop';
  activeLoopNum = loopNum;
  
  // Highlight loop button
  document.querySelectorAll('.loop-btn').forEach((btn, index) => {
    btn.classList.toggle('active', index === (loopNum - 1));
  });
  
  const loopObj = currentSong.loops.find(l => l.loopNum === loopNum);
  if (!loopObj) return;
  
  const folder = currentSong.folderName;

  // Clear all sources, then turn on the ones the active mix wants.
  // The mixer mute/solo buttons let the user toggle individual instruments
  // on/off in real time without reloading.
  CHANNELS.forEach(chan => { setAudioSrc(audioElements[chan], ''); });

  const wantedByMix = {
    both:   ['drums', 'bass', 'guitar', 'piano'],
    drums:  ['drums'],
    bass:   ['bass'],
    guitar: ['guitar'],
    piano:  ['piano']
  };
  const wanted = wantedByMix[activeLoopMix] || wantedByMix.both;

  wanted.forEach(chan => {
    const file = loopObj.files[chan];
    if (file) setAudioSrc(audioElements[chan], `/api/audio/stems/${folder}/${file}`);
  });

  // Show/hide channel strips to match what's playing in loop mode
  CHANNELS.forEach(chan => {
    const strip = document.querySelector(`.${chan}-strip`);
    if (strip) strip.style.display = audioHasSrc(audioElements[chan]) ? 'flex' : 'none';
  });
  
  // Use native gapless looping for loop-segment playback. The programmatic
  // 'ended' restart used to fire prematurely (~0.5s) on short WAVs because
  // oncanplaythrough could refire and HTMLAudioElement's ended event is
  // unreliable on short streamed segments. Native loop=true is gapless and
  // suppresses the ended event entirely, so tracks won't restart short.
  Object.values(audioElements).forEach(ae => { ae.loop = audioHasSrc(ae); });
  
  els.buffering.style.display = 'flex';
  let loadedCount = 0;
  const activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));
  
  let started = false;
  activeElements.forEach(ae => {
    ae.load();
    ae.oncanplaythrough = () => {
      ae.oncanplaythrough = null;
      loadedCount++;
      if (loadedCount === activeElements.length && !started) {
        started = true;
        els.buffering.style.display = 'none';
        togglePlayPause();
      }
    };
  });

  // Enable loop coordinator state
  isLooping = true;
  els.btnLoop.classList.add('active');
  
  const masterAe = activeElements[0];
  if (masterAe) {
    masterAe.addEventListener('durationchange', () => {
      els.timeDuration.textContent = formatTime(masterAe.duration);
    });
  }
  
  applyMixerVolumes();
  setPlaybackSpeed(playbackSpeed);
  updateChannelLoopButtonStates();
}

// Cooperative sync loop correction
function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);
  
  const activeTracks = Object.keys(audioElements).filter(k => audioHasSrc(audioElements[k]));
  if (activeTracks.length === 0) return;
  
  const masterTrack = activeTracks[0];
  const masterAe = audioElements[masterTrack];
  
  syncInterval = setInterval(() => {
    if (!isPlaying) return;
    
    const masterTime = masterAe.currentTime;
    
    // Update timeline slider
    const progress = (masterTime / masterAe.duration) * 100 || 0;
    els.timeline.value = progress;
    els.timelineFill.style.width = `${progress}%`;
    els.timeCurrent.textContent = formatTime(masterTime);
    
    // Synchronize rest of faders
    activeTracks.slice(1).forEach(chan => {
      const ae = audioElements[chan];
      const timeDiff = Math.abs(ae.currentTime - masterTime);
      
      if (timeDiff > 0.05) {
        ae.currentTime = masterTime;
      }
      
      if (ae.paused && !masterAe.paused) {
        ae.play().catch(err => console.warn('[audio.play] rejected:', err, 'src=', ae.src));
      }
    });
  }, 100);
}

// Synchronized ended coordinate wraps to solve the stutter loop
function handleMasterTrackEnded() {
  const activeTracks = Object.keys(audioElements).filter(k => audioHasSrc(audioElements[k]));
  
  if (isLooping) {
    // Seamless programmatic loop wrap!
    activeTracks.forEach(chan => {
      audioElements[chan].currentTime = 0;
      audioElements[chan].play().catch(() => {});
    });
  } else if (stretchActive && currentMode === 'full' && currentSong.type === 'stems') {
    // Trigger Outro Jam loop extension!
    triggerOutroStretch();
  } else if (isStretching) {
    // Loop the outro cycles programmatically
    stretchCycleCount++;
    const maxCycles = stretchCycles === 'infinite' ? Infinity : parseInt(stretchCycles);
    
    if (stretchCycleCount < maxCycles) {
      activeTracks.forEach(chan => {
        audioElements[chan].currentTime = 0;
        audioElements[chan].play().catch(() => {});
      });
      updateStretchInfoProgress();
    } else {
      // Completed outro cycles, perform smooth fade-out and stop
      fadeAndStop(1800);
    }
  } else {
    // Regular song end
    stopAudio();
    
    // Advance to next song in Setlist if playing setlist
    playNextInSetlist();
  }
}

// Dynamic Outro Song Stretching trigger
function triggerOutroStretch() {
  if (!currentSong || currentSong.loops.length === 0) {
    stopAudio();
    return;
  }
  
  isPlaying = false;
  clearInterval(syncInterval);
  stopBeatingVisualizer();
  
  isStretching = true;
  currentMode = 'outro';
  stretchCycleCount = 1;
  
  const loops = currentSong.loops;
  const lastLoop = loops[loops.length - 1]; // get last segment
  const folder = currentSong.folderName;
  
  // Outro: play whatever instrument loops we have for the last segment.
  // Mixer mute/solo lets the user shape it (e.g. drums+bass only).
  CHANNELS.forEach(chan => { setAudioSrc(audioElements[chan], ''); });
  LOOP_CAPABLE_CHANNELS.forEach(chan => {
    const file = lastLoop.files[chan];
    if (file) setAudioSrc(audioElements[chan], `/api/audio/stems/${folder}/${file}`);
  });
  
  Object.values(audioElements).forEach(ae => {
    ae.loop = false; // Programmatic wrap coord continues
  });
  
  els.buffering.style.display = 'flex';
  
  let loadedCount = 0;
  const activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));
  
  activeElements.forEach(ae => {
    ae.load();
    ae.oncanplaythrough = () => {
      loadedCount++;
      if (loadedCount === activeElements.length) {
        els.buffering.style.display = 'none';
        
        // Start Outro Jam
        isPlaying = true;
        const masterAe = activeElements[0];
        masterAe.currentTime = 0;
        
        activeElements.forEach(item => {
          item.currentTime = 0;
          item.play().catch(() => {});
        });
        
        // Calculate duration of outro cycle
        const bpm = currentSong.practiceBpm || 120;
        const totalBeats = lastLoop.bars * 4;
        const cycleDuration = (totalBeats * (60 / bpm)) / playbackSpeed;
        
        els.timeDuration.textContent = formatTime(cycleDuration);
        
        startSyncLoop();
        startBeatingVisualizer(bpm);
        updateStretchInfoProgress();
      }
    };
  });
  
  applyMixerVolumes();
  setPlaybackSpeed(playbackSpeed);
}

// Fade out Master Volume and Stop
function fadeAndStop(fadeTimeMs) {
  if (!masterGainNode || !audioCtx) {
    stopAudio();
    return;
  }
  
  const step = 0.05;
  const stepMs = fadeTimeMs * step;
  
  const fadeInterval = setInterval(() => {
    currentMasterVolume -= step;
    if (currentMasterVolume <= 0) {
      currentMasterVolume = 0;
      clearInterval(fadeInterval);
      
      // Stop completely
      stopAudio();
      isStretching = false;
      loadSong(currentSong); // Restore original faders
      
      playNextInSetlist();
    }
    masterGainNode.gain.setValueAtTime(currentMasterVolume, audioCtx.currentTime);
  }, stepMs);
}

// Show stretching overlay info text
function updateStretchInfoProgress() {
  const max = stretchCycles === 'infinite' ? '∞' : stretchCycles;
  els.stretchInfo.innerHTML = `<span class="text-green glow-green font-bold">OUTRO STRETCH ACTIVE:</span> Cycle ${stretchCycleCount} of ${max}`;
}

// Play / Pause Coordination
function togglePlayPause() {
  if (!currentSong) return;
  
  initAudioCtx();
  
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  
  const activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));
  
  if (isPlaying) {
    activeElements.forEach(ae => ae.pause());
    isPlaying = false;
    els.btnPlay.innerHTML = `<i data-lucide="play"></i>`;
    clearInterval(syncInterval);
    stopBeatingVisualizer();
  } else {
    const masterTime = activeElements[0].currentTime;
    activeElements.forEach(ae => {
      ae.currentTime = masterTime;
      ae.play().catch(err => console.warn('[audio.play] rejected:', err, 'src=', ae.src));
    });
    isPlaying = true;
    els.btnPlay.innerHTML = `<i data-lucide="pause"></i>`;
    
    startSyncLoop();
    startBeatingVisualizer(currentSong.practiceBpm || 100);
  }
  
  applyMixerVolumes();
  lucide.createIcons();
}

// Stop Audio
function stopAudio() {
  isPlaying = false;
  els.btnPlay.innerHTML = `<i data-lucide="play"></i>`;
  clearInterval(syncInterval);
  stopBeatingVisualizer();
  
  Object.values(audioElements).forEach(ae => {
    ae.pause();
    ae.currentTime = 0;
  });
  
  els.timeline.value = 0;
  els.timelineFill.style.width = '0%';
  els.timeCurrent.textContent = '0:00';
  
  applyMixerVolumes();
  lucide.createIcons();
}

// Click timeline to seek
function seekAudio(e) {
  const pct = parseFloat(e.target.value);
  const activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));
  if (activeElements.length === 0) return;
  
  const targetTime = (pct / 100) * activeElements[0].duration;
  
  activeElements.forEach(ae => {
    ae.currentTime = targetTime;
  });
  
  els.timeCurrent.textContent = formatTime(targetTime);
  els.timelineFill.style.width = `${pct}%`;
}

// Playback Speed control
function setPlaybackSpeed(speed) {
  playbackSpeed = speed;
  if (els.speedDisplay) els.speedDisplay.textContent = `${speed.toFixed(2)}x`;
  if (els.speedDisplayMini) els.speedDisplayMini.textContent = `${speed.toFixed(2)}x`;

  Object.values(audioElements).forEach(ae => {
    ae.playbackRate = speed;
  });
}

// Loop mode toggle
function toggleLooping() {
  isLooping = !isLooping;
  els.btnLoop.classList.toggle('active', isLooping);
}

// Mixer Math faders
function applyMixerVolumes() {
  // M4A playback uses the drums element as a single-track carrier — bypass
  // the multitrack mixer (mute/solo/faders) so leftover stems state can't
  // silence it. The mixer UI is hidden in M4A mode anyway.
  const m4aMode = currentSong && currentSong.type === 'm4a';
  if (m4aMode) {
    Object.keys(audioElements).forEach(chan => {
      audioElements[chan].volume = (chan === 'drums') ? 1.0 : 0;
    });
    return;
  }

  const isSoloActive = Object.values(mixerState.soloed).some(Boolean);

  Object.keys(audioElements).forEach(chan => {
    const ae = audioElements[chan];
    const strip = document.querySelector(`.${chan}-strip`);

    let targetVolume = mixerState.volumes[chan];

    if (mixerState.muted[chan]) {
      targetVolume = 0;
    } else if (isSoloActive && !mixerState.soloed[chan]) {
      targetVolume = 0;
    }

    ae.volume = targetVolume;
    
    if (strip) {
      if (targetVolume > 0 && isPlaying) {
        strip.classList.add('active-playing');
      } else {
        strip.classList.remove('active-playing');
      }
    }
  });
}

/* ==========================================
   SETLIST PLANNER & SCHEDULER IMPLEMENTATION
   ========================================== */

function addToSetlist(song) {
  // Avoid double adds
  if (setlist.some(item => item.id === song.id)) return;
  
  // Generate uniquely scheduled setlist item
  const setlistItem = {
    ...song,
    setlistItemId: `setlist-${song.id}-${Date.now()}`
  };
  
  setlist.push(setlistItem);
  saveSetlistToLocalStorage();
  renderSetlist();
  
  // Highlight row checkbox
  updateLibraryCheckboxes();
}

function removeFromSetlist(songId) {
  setlist = setlist.filter(item => item.id !== songId);
  saveSetlistToLocalStorage();
  renderSetlist();
  updateLibraryCheckboxes();
}

function removeSetlistItemById(setlistItemId) {
  setlist = setlist.filter(item => item.setlistItemId !== setlistItemId);
  saveSetlistToLocalStorage();
  renderSetlist();
  updateLibraryCheckboxes();
}

function clearSetlist() {
  setlist = [];
  saveSetlistToLocalStorage();
  renderSetlist();
  updateLibraryCheckboxes();
}

function updateLibraryCheckboxes() {
  document.querySelectorAll('.song-row').forEach(row => {
    const songId = row.dataset.id;
    const isChecked = setlist.some(item => item.id === songId);
    const cb = row.querySelector('.song-checkbox');
    if (cb) cb.checked = isChecked;
  });
}

// Render planned setlist rows
function renderSetlist() {
  const container = els.setlistSongsContainer;
  
  if (setlist.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="clipboard-list" style="width: 32px; height: 32px;"></i>
        <p>No tracks added to setlist yet. Use the library "Set" checkboxes to add songs.</p>
      </div>
    `;
    els.setlistStatsLabel.textContent = `0 tracks // 0 min total`;
    lucide.createIcons();
    return;
  }

  container.innerHTML = '';
  
  setlist.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'setlist-item';
    card.dataset.index = index;
    card.dataset.id = item.id;
    card.dataset.setlistItemId = item.setlistItemId;
    
    // Support browser Drag and Drop reordering natively
    card.draggable = true;
    setupDragAndDropEvents(card);
    
    // Index / Number indicator
    const num = document.createElement('span');
    num.className = 'setlist-item-num';
    num.textContent = `${index + 1}.`;
    
    // Drag grip handle
    const grip = document.createElement('span');
    grip.className = 'setlist-item-grip';
    grip.innerHTML = `<i data-lucide="grip-vertical" style="width: 14px; height: 14px;"></i>`;
    
    // Details
    const details = document.createElement('div');
    details.className = 'setlist-item-details';
    
    // Format tag badge
    const tagText = item.type === 'stems' ? 'stems' : 'm4a';
    details.innerHTML = `
      <span class="setlist-item-title">${item.title}</span>
      <span class="setlist-item-artist">${item.artist} <span class="tag tag-${tagText}" style="padding: 1px 4px; font-size: 8px;">${tagText}</span></span>
    `;
    
    // Meta / Timings
    const meta = document.createElement('div');
    meta.className = 'setlist-item-meta';
    
    const timeLabel = document.createElement('span');
    timeLabel.className = 'setlist-item-time';
    timeLabel.textContent = '--:--'; // Will be calculated dynamically next
    timeLabel.id = `time-lbl-${item.setlistItemId}`;
    
    const durationLabel = document.createElement('span');
    durationLabel.className = 'setlist-item-duration';
    const durSec = item.duration || 210; // default 3.5 min
    durationLabel.textContent = formatTime(durSec);
    
    meta.appendChild(timeLabel);
    meta.appendChild(durationLabel);
    
    // Trash delete action button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'setlist-item-delete';
    deleteBtn.innerHTML = `<i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>`;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSetlistItemById(item.setlistItemId);
    });
    
    card.appendChild(grip);
    card.appendChild(num);
    card.appendChild(details);
    card.appendChild(meta);
    card.appendChild(deleteBtn);
    
    // Clicking load and plays card
    card.addEventListener('click', () => {
      const songRef = songLibrary.find(s => s.id === item.id);
      if (songRef) loadSong(songRef);
    });
    
    container.appendChild(card);
  });
  
  // Calculate dynamic start times increments
  calculateSetlistTimes();
  lucide.createIcons();
}

// Dynamic Starting Time Increments Scheduler
function calculateSetlistTimes() {
  const startTimeVal = els.setlistStartTime.value; // e.g. "16:00"
  let [hours, minutes] = startTimeVal.split(':').map(Number);
  
  let currentDateTime = new Date();
  currentDateTime.setHours(hours, minutes, 0, 0);
  
  let totalDurationSec = 0;
  
  setlist.forEach(item => {
    const lbl = document.getElementById(`time-lbl-${item.setlistItemId}`);
    if (lbl) {
      // Formatted AM/PM clock time
      const timeStr = currentDateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lbl.textContent = timeStr;
    }
    
    const duration = item.duration || 210; // default 3.5 min
    totalDurationSec += duration;
    
    // Increment accumulated clock
    currentDateTime = new Date(currentDateTime.getTime() + duration * 1000);
  });
  
  // Update overall kit statistics
  const totalMin = Math.floor(totalDurationSec / 60);
  const totalSec = Math.floor(totalDurationSec % 60);
  els.setlistStatsLabel.textContent = `${setlist.length} tracks // ${totalMin}:${totalSec < 10 ? '0' : ''}${totalSec} total`;
}

// Drag and drop events setup for cards
let dragSourceEl = null;

function setupDragAndDropEvents(el) {
  el.addEventListener('dragstart', function(e) {
    dragSourceEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.index);
    this.classList.add('dragging');
  });
  
  el.addEventListener('dragover', function(e) {
    if (e.preventDefault) e.preventDefault();
    this.classList.add('drag-over-item');
    e.dataTransfer.dropEffect = 'move';
    return false;
  });
  
  el.addEventListener('dragleave', function() {
    this.classList.remove('drag-over-item');
  });
  
  el.addEventListener('drop', function(e) {
    e.stopPropagation();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
    const toIndex = parseInt(this.dataset.index);
    
    if (fromIndex !== toIndex) {
      // Reorder setlist model
      const movedItem = setlist.splice(fromIndex, 1)[0];
      setlist.splice(toIndex, 0, movedItem);
      saveSetlistToLocalStorage();
      renderSetlist();
    }
    this.classList.remove('drag-over-item');
    return false;
  });
  
  el.addEventListener('dragend', function() {
    this.classList.remove('dragging');
    document.querySelectorAll('.setlist-item').forEach(item => {
      item.classList.remove('drag-over-item');
    });
  });
}

// Mixer state persistence — survives reload AND is fixed across all songs.
// (User: "when I play I either need the drums or not for all songs.")
function saveMixerState() {
  try { localStorage.setItem('bt_mixer_state', JSON.stringify(mixerState)); } catch (e) {}
}
function loadMixerState() {
  try {
    const raw = localStorage.getItem('bt_mixer_state');
    if (!raw) return;
    const ms = JSON.parse(raw);
    if (ms && ms.volumes) Object.assign(mixerState.volumes, ms.volumes);
    if (ms && ms.muted)   Object.assign(mixerState.muted,   ms.muted);
    if (ms && ms.soloed)  Object.assign(mixerState.soloed,  ms.soloed);

    // Sync the DOM faders / buttons to the restored state
    CHANNELS.forEach(chan => {
      const fader = document.getElementById(`fader-${chan}`);
      const val   = document.getElementById(`val-${chan}`);
      const mute  = document.getElementById(`mute-${chan}`);
      const solo  = document.getElementById(`solo-${chan}`);
      if (fader) fader.value = mixerState.volumes[chan];
      if (val)   val.textContent = `${Math.round(mixerState.volumes[chan] * 100)}%`;
      if (mute)  mute.classList.toggle('active', !!mixerState.muted[chan]);
      if (solo)  solo.classList.toggle('active', !!mixerState.soloed[chan]);
    });
  } catch (e) { console.warn('mixer state restore failed', e); }
}

// Local Storage persist
function saveSetlistToLocalStorage() {
  localStorage.setItem('bt_construction_setlist', JSON.stringify(setlist));
}

function saveSetlistName() {
  localStorage.setItem('bt_construction_setlist_name', els.setlistName.value || '');
}

function saveSetlistStartTime() {
  localStorage.setItem('bt_construction_setlist_start', els.setlistStartTime.value || '16:00');
}

function loadSetlistFromLocalStorage() {
  const data = localStorage.getItem('bt_construction_setlist');
  if (data) {
    try {
      setlist = JSON.parse(data);
      renderSetlist();
    } catch (e) {
      console.log('Error parsing localstorage setlist data', e);
    }
  }
  const name = localStorage.getItem('bt_construction_setlist_name');
  if (name && els.setlistName) els.setlistName.value = name;
  const start = localStorage.getItem('bt_construction_setlist_start');
  if (start && els.setlistStartTime) els.setlistStartTime.value = start;
}

// Auto-advance playlist play
function playNextInSetlist() {
  if (setlist.length === 0 || !currentSong) return;
  
  // Find index of current song in setlist
  const currentIndex = setlist.findIndex(item => item.id === currentSong.id);
  if (currentIndex !== -1 && currentIndex < setlist.length - 1) {
    // Next song exists! Play after a 2 second staggered pause
    const nextItem = setlist[currentIndex + 1];
    setTimeout(() => {
      const songRef = songLibrary.find(s => s.id === nextItem.id);
      if (songRef) {
        loadSong(songRef);
        togglePlayPause(); // Auto-start next song!
      }
    }, 2000);
  }
}

/* =============================
   OUTRO SONG STRETCHING HANDLERS
   ============================= */

function toggleStretchState() {
  if (stretchActive) {
    els.stretchCyclesContainer.style.opacity = '1';
    els.stretchCyclesContainer.style.pointerEvents = 'auto';
    els.stretchInfo.textContent = 'Will seamlessly stretch outro loop when song ends.';
  } else {
    els.stretchCyclesContainer.style.opacity = '0.5';
    els.stretchCyclesContainer.style.pointerEvents = 'none';
    els.stretchInfo.textContent = 'Extend track using the last loop.';
    if (isStretching) {
      stopAudio();
      isStretching = false;
      loadSong(currentSong);
    }
  }
}

/* ===============================
   DASHBOARD INPUT EVENT SETUP
   =============================== */

function setupEventListeners() {
  // Search inputs
  els.search.addEventListener('input', () => {
    els.clearSearch.style.display = els.search.value ? 'block' : 'none';
    applyFilters();
  });
  
  els.clearSearch.addEventListener('click', () => {
    els.search.value = '';
    els.clearSearch.style.display = 'none';
    applyFilters();
  });
  
  // Format Toggles
  [els.filterAll, els.filterStems, els.filterM4a].forEach(btn => {
    btn.addEventListener('click', () => {
      [els.filterAll, els.filterStems, els.filterM4a].forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    });
  });
  
  // Filters dropdown
  els.filterKey.addEventListener('change', applyFilters);
  els.filterBpm.addEventListener('change', applyFilters);
  
  // View mode toggles
  els.btnListView.addEventListener('click', () => {
    els.btnListView.classList.add('active');
    els.btnGridView.classList.remove('active');
    els.libraryContainer.classList.remove('grid-mode');
    els.libraryContainer.classList.add('list-mode');
  });
  
  els.btnGridView.addEventListener('click', () => {
    els.btnGridView.classList.add('active');
    els.btnListView.classList.remove('active');
    els.libraryContainer.classList.remove('list-mode');
    els.libraryContainer.classList.add('grid-mode');
  });
  
  // Player Controls
  els.btnPlay.addEventListener('click', togglePlayPause);
  els.btnStop.addEventListener('click', stopAudio);
  els.btnLoop.addEventListener('click', toggleLooping);
  
  els.timeline.addEventListener('input', seekAudio);
  
  // Playback Speed controls
  els.speedSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    setPlaybackSpeed(val);
  });
  
  els.speedPresets.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseFloat(btn.dataset.speed);
      els.speedPresets.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      els.speedSlider.value = val;
      setPlaybackSpeed(val);
    });
  });
  
  // Outro Jam Stretch controls
  els.stretchToggle.addEventListener('change', (e) => {
    stretchActive = e.target.checked;
    toggleStretchState();
  });
  
  els.cycleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      els.cycleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      stretchCycles = btn.dataset.cycles;
      if (isStretching) updateStretchInfoProgress();
    });
  });
  
  // Player section collapse/expand — frees up the song list on large displays
  if (els.btnCollapsePlayer) {
    els.btnCollapsePlayer.addEventListener('click', () => {
      const sect = els.playerHeroSection;
      if (!sect) return;
      sect.classList.toggle('player-collapsed');
      const collapsed = sect.classList.contains('player-collapsed');
      els.btnCollapsePlayer.innerHTML = collapsed
        ? `<i data-lucide="chevrons-down"></i>`
        : `<i data-lucide="chevrons-up"></i>`;
      els.btnCollapsePlayer.title = collapsed ? 'Expand player' : 'Collapse player';
      localStorage.setItem('bt_player_collapsed', collapsed ? '1' : '0');
      lucide.createIcons();
    });
    // Restore state
    if (localStorage.getItem('bt_player_collapsed') === '1') {
      els.btnCollapsePlayer.click();
    }
  }

  // Playback speed popover
  if (els.btnSpeedDialog && els.speedPopover) {
    els.btnSpeedDialog.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = els.speedPopover.style.display === 'block';
      els.speedPopover.style.display = open ? 'none' : 'block';
    });
    if (els.btnSpeedClose) {
      els.btnSpeedClose.addEventListener('click', () => {
        els.speedPopover.style.display = 'none';
      });
    }
    // Click outside to close
    document.addEventListener('click', (e) => {
      if (els.speedPopover.style.display !== 'block') return;
      if (!els.speedPopover.contains(e.target) && e.target !== els.btnSpeedDialog && !els.btnSpeedDialog.contains(e.target)) {
        els.speedPopover.style.display = 'none';
      }
    });
  }

  // Setlist Controls
  els.btnClearSetlist.addEventListener('click', clearSetlist);
  els.setlistStartTime.addEventListener('change', () => {
    saveSetlistStartTime();
    calculateSetlistTimes();
  });
  els.setlistName.addEventListener('input', saveSetlistName);
  
  // Mixer faders
  CHANNELS.forEach(chan => {
    const fader = document.getElementById(`fader-${chan}`);
    fader.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      mixerState.volumes[chan] = vol;
      document.getElementById(`val-${chan}`).textContent = `${Math.round(vol * 100)}%`;
      applyMixerVolumes();
      saveMixerState();
    });

    const muteBtn = document.getElementById(`mute-${chan}`);
    muteBtn.addEventListener('click', () => {
      mixerState.muted[chan] = !mixerState.muted[chan];
      muteBtn.classList.toggle('active', mixerState.muted[chan]);
      applyMixerVolumes();
      saveMixerState();
    });

    const soloBtn = document.getElementById(`solo-${chan}`);
    soloBtn.addEventListener('click', () => {
      mixerState.soloed[chan] = !mixerState.soloed[chan];
      soloBtn.classList.toggle('active', mixerState.soloed[chan]);
      applyMixerVolumes();
      saveMixerState();
    });
  });
  
  els.btnResetMixer.addEventListener('click', () => {
    CHANNELS.forEach(chan => {
      mixerState.volumes[chan] = 0.8;
      mixerState.muted[chan] = false;
      mixerState.soloed[chan] = false;
      
      const fader = document.getElementById(`fader-${chan}`);
      const val   = document.getElementById(`val-${chan}`);
      const mute  = document.getElementById(`mute-${chan}`);
      const solo  = document.getElementById(`solo-${chan}`);
      if (fader) fader.value = 0.8;
      if (val)   val.textContent = '80%';
      if (mute)  mute.classList.remove('active');
      if (solo)  solo.classList.remove('active');
    });
    applyMixerVolumes();
    saveMixerState();
  });
  
  [els.loopMixBoth, els.loopMixDrums, els.loopMixBass].forEach(btn => {
    btn.addEventListener('click', () => {
      [els.loopMixBoth, els.loopMixDrums, els.loopMixBass].forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      if (btn === els.loopMixBoth) activeLoopMix = 'both';
      if (btn === els.loopMixDrums) activeLoopMix = 'drums';
      if (btn === els.loopMixBass) activeLoopMix = 'bass';
      
      if (currentMode === 'loop' && isPlaying) {
        playLoopSegment(activeLoopNum);
      }
    });
  });
}

// Poll /api/cache-status periodically to update the "READY" chip / green
// format-chip background on any rows whose cache state changed. Cheap —
// server just stats sentinel files. Polled every 8s while the m4a precache
// is still filling, then every 20s once steady.
let _cacheStatusInterval = null;
async function cacheStatusRefresh() {
  try {
    const r = await fetch('/api/cache-status');
    if (!r.ok) return;
    const body = await r.json();
    const stemsCached = body.cached || {};
    const m4aCached   = body.m4a   || {};
    let dirty = false;
    for (const s of songLibrary) {
      let isCached;
      if (s.type === 'stems')    isCached = !!stemsCached[s.folderName];
      else if (s.type === 'm4a') isCached = !!m4aCached[s.fileName];
      else continue;
      if (!!s.cached !== isCached) {
        s.cached = isCached;
        dirty = true;
      }
    }
    if (dirty) {
      mergedLibrary = mergeByTitleArtist(songLibrary);
      mergedLibrary.sort((a, b) => a.title.localeCompare(b.title));
      applyFilters();
    }
  } catch (e) { /* offline / server down — silent */ }
}

function startCacheStatusPoll() {
  // Poll fast initially (every 4s while the precache is still filling chips),
  // then back off to every 20s once the rate of change slows.
  let fastTicksRemaining = 60;  // ~4 minutes of fast polling on cold start
  const tick = async () => {
    await cacheStatusRefresh();
    fastTicksRemaining--;
    const next = fastTicksRemaining > 0 ? 4000 : 20000;
    _cacheStatusInterval = setTimeout(tick, next);
  };
  tick();
}

// Relative time formatter — "3m ago", "2h ago"
function timeAgo(iso) {
  try {
    const then = new Date(iso).getTime();
    const sec = Math.max(1, Math.floor((Date.now() - then) / 1000));
    if (sec < 60)   return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  } catch (e) { return ''; }
}

// Wall clock — "Wed May 27  4:31 PM"
function startWallClock() {
  const el = document.getElementById('wall-clock');
  if (!el) return;
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const tick = () => {
    const d = new Date();
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    const mm = m < 10 ? `0${m}` : `${m}`;
    el.textContent = `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}  ${h}:${mm} ${ampm}`;
  };
  tick();
  setInterval(tick, 1000 * 15); // refresh every 15s, plenty for minute precision
}

// Utility formattings (secs -> MM:SS)
function formatTime(secs) {
  if (isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
