// Backing Track Construction Kit - Client Application Engine

// State management
let songLibrary = [];   // raw entries from server (one per file/folder)
let mergedLibrary = []; // grouped: one entry per song with .variants array
let filteredLibrary = []; // filtered view of mergedLibrary
let formatVariantFilters = { STEMS: false, '-V': false, '-V-G': false, '-V-G-B': false, DO: false };
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
let currentMasterVolume = 0.75;

// Web Audio API variables
let audioCtx = null;
let analyserNode = null;
let masterGainNode = null;
let trackSources = {}; // trackKey -> MediaElementAudioSourceNode

// Multi-channel output routing (XR18 + similar interfaces).
// When the system audio device exposes more than 2 output channels (the XR18
// presents 18 USB returns), each stem channel can be routed independently to
// one or more output pairs. A 'route' is { lOut, rOut } describing the stereo
// destination channels (0-indexed). Multiple routes per stem fan the same
// source to multiple amp/aux destinations — exactly what the XR18-aux-per-amp
// setup wants.
let stripNodes = {};            // stem → { stripGain, splitter } (post-source)
let masterMerger = null;        // ChannelMergerNode with maxChannelCount inputs
let outputChannelCount = 2;     // detected from destination.maxChannelCount
let routingMatrix = {};         // stem → [{ lOut, rOut }, ...]
const ROUTING_STORAGE_KEY = 'simpleStem.routingMatrix.v1';
const ROUTING_MULTI_KEY    = 'simpleStem.routingMultiOn';

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
  // Saved SetLists panel
  setlistsList: document.getElementById('setlists-list'),
  btnRefreshSetlists: document.getElementById('btn-refresh-setlists'),
  btnSaveSetlist: document.getElementById('btn-save-setlist'),
  // Master volume (right rail)
  masterVol: document.getElementById('master-vol'),
  masterVolPct: document.getElementById('master-vol-pct'),
  // Version / update
  versionRunning: document.getElementById('version-running'),
  btnUpdate: document.getElementById('btn-update'),
  updateLabel: document.getElementById('update-label'),
  // Stemming progress
  stemProgress: document.getElementById('stem-progress'),
  stemProgressLabel: document.getElementById('stem-progress-label'),
  stemProgressCount: document.getElementById('stem-progress-count'),
  stemProgressFill: document.getElementById('stem-progress-fill'),
  stemProgressNow: document.getElementById('stem-progress-now'),

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
  setupSetlistsPanel();
  setupVersionWatch();
  setupMasterVolume();
  setupTabs();
  setupDrumLoopsTab();
  setupLoopSequenceUI();
  setupGigMode();
  setupRollups();
  setupGigSidebar();
  setupRoutingUI();
  setupFormatFilters();
  setupClickTrack();
  try { setupMidiUI(); } catch (e) { console.warn('[midi] setup failed:', e); }
  try { setupStemHotkeys(); } catch (e) { console.warn('[hotkeys] setup failed:', e); }
  // Pre-fetch the drum-loops index so library rows can show drum-loop chips
  // immediately on first render. (Drum Loops tab uses the same data — no
  // second round-trip if/when the user opens it.)
  loadDrumLoops();

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

// ── Sidebar rollups (Library Analytics, Setlist) ──────────────────────────
// Generic click-to-collapse pattern. The header has aria-expanded;
// localStorage remembers it between sessions so the sidebar starts where the
// user last left it.
function setupRollups() {
  document.querySelectorAll('.rollup').forEach(roll => {
    const header = roll.querySelector('.rollup-header');
    if (!header) return;
    // v2 key — the v1 key persisted a stale 'closed' state for the setlist
    // rollup so a returning user could end up with the panel hidden by
    // default. Bumping the key resets to the documented defaults below.
    const key = `simpleStem.rollup.v2.${roll.id || header.textContent.trim()}`;
    let stored = null;
    try { stored = localStorage.getItem(key); } catch (e) {}
    // Default: analytics collapsed (user asked for it), setlist expanded.
    const defaultOpen = roll.id !== 'analytics-rollup';
    const open = stored == null ? defaultOpen : stored === '1';
    apply(open);
    header.addEventListener('click', () => apply(!isOpen()));
    function isOpen() { return header.getAttribute('aria-expanded') === 'true'; }
    function apply(o) {
      header.setAttribute('aria-expanded', o ? 'true' : 'false');
      roll.setAttribute('data-collapsed', o ? 'false' : 'true');
      try { localStorage.setItem(key, o ? '1' : '0'); } catch (e) {}
    }
  });
}

// ── Sidebar gig hierarchy ─────────────────────────────────────────────────
// A gig is the unit you plan for: title + 1-4 setlists, each setlist is
// title + ordered songs[]. Sidebar shows ONE active gig; the picker switches
// between gigs; duplicate copies a gig (with its setlists) to start a new
// one. All mutations debounce-save to /api/gigs/:slug so reloads pick up
// where you left off.
//
// Drag model: drag a song row out of one setlist body and drop it on
// another setlist (header or body) to MOVE it; hold Alt while dropping
// to COPY (same song base, new setlistItemId). Drop inside the same
// setlist to reorder.

let activeGig = null;             // { slug, title, setlists: [...] } — live edited
let activeSetlistIdx = 0;          // which setlist the ghost-row + adds to
let gigSaveTimer = null;
// Expansion state for setlists in the sidebar. Tracks which idxs are open so
// the user can keep multiple setlists open at once and the open/closed state
// survives re-renders (drag, edit, etc.). Reset to {0} on each gig load so
// the first setlist starts expanded.
let openSetlistIdxs = new Set([0]);
// Sequential-playback state: when a setlist is playing through, these point
// at which setlist + which song are live. null/null when no setlist is playing.
let gigPlayingSetlistIdx = null;
let gigPlayingSongIdx = null;

const GIG_ACTIVE_SLUG_KEY = 'simpleStem.activeGigSlug';

function setupGigSidebar() {
  document.getElementById('gig-new-btn').addEventListener('click', onGigNew);
  document.getElementById('gig-dup-btn').addEventListener('click', onGigDuplicate);
  document.getElementById('gig-del-btn').addEventListener('click', onGigDelete);
  document.getElementById('gig-picker').addEventListener('change', e => {
    if (e.target.value) loadActiveGig(e.target.value);
  });
  document.getElementById('gig-add-setlist-btn').addEventListener('click', () => {
    if (!activeGig || activeGig.setlists.length >= 4) return;
    activeGig.setlists.push({ title: `Set ${activeGig.setlists.length + 1}`, songs: [] });
    renderGigSidebar();
    scheduleGigSave();
  });

  refreshGigList().then(initialSlug => {
    // Fall back to whatever the picker landed on if refreshGigList didn't
    // return a slug — e.g. the live fetch failed but the warm cache painted
    // options. Without this, the sidebar stays empty on boot when only the
    // cache succeeded.
    const picker = document.getElementById('gig-picker');
    const slugToLoad = initialSlug || (picker && picker.value) || null;
    if (slugToLoad) loadActiveGig(slugToLoad);
    else renderGigSidebar();
  });
}

// Synthetic gig slugs. The portal exposes two virtual gigs that aggregate
// standalone setlists (files in SETLISTS/ that don't belong to any real gig
// in GIGS/):
//   __youtube_sync__   — origin: 'playlist'  → read-only, owned by
//                         setlist_sync.py
//   __manual_setlists__ — origin: 'manual'   → editable; songs added/removed
//                         through the sidebar persist via POST /api/setlists
// Real gigs (from GIGS/<slug>.json) appear in the picker AFTER both synthetic
// gigs.
const YOUTUBE_SYNC_GIG_SLUG    = '__youtube_sync__';
const MANUAL_SETLISTS_GIG_SLUG = '__manual_setlists__';
const SYNTHETIC_GIG_SLUGS = new Set([YOUTUBE_SYNC_GIG_SLUG, MANUAL_SETLISTS_GIG_SLUG]);

// localStorage warm-cache keys. We paint the sidebar from these before the
// server responds so the picker feels instant. Then we revalidate against
// /api/gigs and /api/setlists in the background and re-render if anything
// changed. Cached entries are tiny (one summary line per gig/setlist).
const GIGS_CACHE_KEY     = 'bt_gigs_summary_v1';
const SETLISTS_CACHE_KEY = 'bt_setlists_summary_v1';
const GIG_DETAIL_CACHE_PREFIX     = 'bt_gig_detail_v1_';
const SETLIST_DETAIL_CACHE_PREFIX = 'bt_setlist_detail_v1_';

function readCache(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function writeCache(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

// Fetch /api/gigs and populate the picker. Returns the slug to load on init
// (last-used from localStorage if it still exists, else the most-recently-
// updated one, else null). ALSO prepends a synthetic "YouTube Sync" gig if
// any playlist-origin setlists exist in /api/setlists.
async function refreshGigList() {
  const picker = document.getElementById('gig-picker');
  // ── Warm-cache pass: paint immediately from localStorage so the sidebar
  // doesn't flash empty while the server reply lands. The cached lists are
  // just the summary rows /api/gigs and /api/setlists return, so painting
  // them is identical to painting the live response.
  const cachedGigs = readCache(GIGS_CACHE_KEY);
  const cachedSetlists = readCache(SETLISTS_CACHE_KEY) || [];
  if (cachedGigs || cachedSetlists.length) {
    paintGigPicker(
      cachedGigs || [],
      cachedSetlists.filter(s => s.origin === 'playlist'),
      cachedSetlists.filter(s => (s.origin || 'manual') === 'manual'),
    );
  }
  try {
    const [gigRes, setlistRes] = await Promise.all([
      fetch('/api/gigs').catch(() => null),
      fetch('/api/setlists').catch(() => null),
    ]);
    const gigData = gigRes ? await gigRes.json() : { gigs: [] };
    const setlistData = setlistRes ? await setlistRes.json() : { setlists: [] };
    const gigs = gigData.gigs || [];
    const allSetlists = setlistData.setlists || [];
    const playlistSetlists = allSetlists.filter(s => s.origin === 'playlist');
    const manualSetlists   = allSetlists.filter(s => (s.origin || 'manual') === 'manual');
    // Stash for the next page load.
    writeCache(GIGS_CACHE_KEY, gigs);
    writeCache(SETLISTS_CACHE_KEY, allSetlists);

    return paintGigPicker(gigs, playlistSetlists, manualSetlists);
  } catch (e) {
    if (!picker.options.length) picker.innerHTML = '<option value="">(error)</option>';
    return null;
  }
}

// Render the gig picker from gigs + playlist setlist summaries. Returns the
// slug that should be loaded as the initial active gig (last-used → first
// gig → null). Shared between the warm-cache pass and the live response.
function paintGigPicker(gigs, playlistSetlists, manualSetlists) {
  const picker = document.getElementById('gig-picker');
  const options = [];
  if (playlistSetlists.length) {
    options.push(
      `<option value="${YOUTUBE_SYNC_GIG_SLUG}">▶ YouTube Sync (${playlistSetlists.length})</option>`
    );
  }
  if (manualSetlists.length) {
    options.push(
      `<option value="${MANUAL_SETLISTS_GIG_SLUG}">✎ Manual Setlists (${manualSetlists.length})</option>`
    );
  }
  for (const g of gigs) {
    options.push(`<option value="${escapeHtml(g.slug)}">${escapeHtml(g.title)} (${g.setlist_count})</option>`);
  }
  picker.innerHTML = options.length
    ? options.join('')
    : '<option value="">— no gigs yet —</option>';

  let initial = null;
  try { initial = localStorage.getItem(GIG_ACTIVE_SLUG_KEY); } catch (e) {}
  const slugExists = (s) => {
    if (s === YOUTUBE_SYNC_GIG_SLUG)    return playlistSetlists.length > 0;
    if (s === MANUAL_SETLISTS_GIG_SLUG) return manualSetlists.length > 0;
    return gigs.some(g => g.slug === s);
  };
  if (initial && slugExists(initial)) {
    picker.value = initial;
  } else if (playlistSetlists.length) {
    picker.value = YOUTUBE_SYNC_GIG_SLUG;
    initial = YOUTUBE_SYNC_GIG_SLUG;
  } else if (manualSetlists.length) {
    picker.value = MANUAL_SETLISTS_GIG_SLUG;
    initial = MANUAL_SETLISTS_GIG_SLUG;
  } else if (gigs.length) {
    picker.value = gigs[0].slug;
    initial = gigs[0].slug;
  } else {
    initial = null;
  }
  return initial;
}

// Build a synthetic gig (YouTube Sync or Manual Setlists) by fetching each
// matching standalone setlist's full JSON and stitching them into a
// gig-shaped object the existing renderer can swallow.
//
// Args
//   wantOrigin: 'playlist' | 'manual'
//   readOnly:   true for YouTube Sync (owned by setlist_sync.py), false for Manual
async function loadSyntheticGig(slug, wantOrigin, readOnly, title) {
  let summaries = [];
  try {
    const r = await fetch('/api/setlists');
    const d = await r.json();
    summaries = (d.setlists || []).filter(s => (s.origin || 'manual') === wantOrigin);
  } catch (e) {
    return { slug, title, setlists: [], readOnly, synthetic: true, syntheticKind: wantOrigin };
  }
  const setlistObjs = await Promise.all(summaries.map(async (s) => {
    try {
      const r = await fetch(`/api/setlists/${encodeURIComponent(s.slug)}`);
      const d = await r.json();
      const obj = {
        title: d.title || s.title || s.slug,
        slug:  s.slug,
        songs: Array.isArray(d.songs) ? d.songs : [],
        origin: wantOrigin,
        source_url: s.source_url || d.source_url || null,
        synced_at:  s.synced_at  || d.synced_at  || null,
      };
      writeCache(SETLIST_DETAIL_CACHE_PREFIX + s.slug, obj);
      return obj;
    } catch (e) {
      return readCache(SETLIST_DETAIL_CACHE_PREFIX + s.slug) || null;
    }
  }));
  return {
    slug, title, readOnly, synthetic: true, syntheticKind: wantOrigin,
    setlists: setlistObjs.filter(Boolean),
  };
}

const loadYoutubeSyncGig    = () => loadSyntheticGig(YOUTUBE_SYNC_GIG_SLUG,    'playlist', true,  'YouTube Sync');
const loadManualSetlistsGig = () => loadSyntheticGig(MANUAL_SETLISTS_GIG_SLUG, 'manual',   false, 'Manual Setlists');

async function loadActiveGig(slug) {
  if (!slug) { activeGig = null; renderGigSidebar(); return; }
  // Synthetic gigs (YouTube Sync, Manual Setlists) — built client-side from
  // the SETLISTS/ folder. They live in JS only; no GIGS/<slug>.json.
  if (SYNTHETIC_GIG_SLUGS.has(slug)) {
    try {
      activeGig = slug === YOUTUBE_SYNC_GIG_SLUG
        ? await loadYoutubeSyncGig()
        : await loadManualSetlistsGig();
      if (!Array.isArray(activeGig.setlists) || !activeGig.setlists.length) {
        const placeholderTitle = slug === YOUTUBE_SYNC_GIG_SLUG
          ? '(no playlist setlists yet)'
          : '(no manual setlists yet — save one from the planner)';
        activeGig.setlists = [{ title: placeholderTitle, songs: [] }];
      }
      activeSetlistIdx = Math.min(activeSetlistIdx, activeGig.setlists.length - 1);
      openSetlistIdxs = new Set([0]);
      try { localStorage.setItem(GIG_ACTIVE_SLUG_KEY, slug); } catch (e) {}
      renderGigSidebar();
      if (document.body.classList.contains('gig-mode')) {
        precacheActiveGig();
      }
    } catch (e) {
      console.warn('[synthetic-gig] failed to build', slug, e);
      activeGig = null;
      renderGigSidebar();
    }
    return;
  }
  // Warm-cache pass: if we have the full gig from last session, paint it
  // first. Then the live fetch replaces the data — usually it matches and
  // re-render is a no-op visually.
  const cachedGig = readCache(GIG_DETAIL_CACHE_PREFIX + slug);
  if (cachedGig) {
    activeGig = cachedGig;
    if (!Array.isArray(activeGig.setlists) || !activeGig.setlists.length) {
      activeGig.setlists = [{ title: 'Set 1', songs: [] }];
    }
    activeSetlistIdx = Math.min(activeSetlistIdx, activeGig.setlists.length - 1);
    openSetlistIdxs = new Set([0]);
    renderGigSidebar();
  }
  try {
    const res = await fetch(`/api/gigs/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error((await res.json()).error || 'load failed');
    activeGig = await res.json();
    if (!Array.isArray(activeGig.setlists) || !activeGig.setlists.length) {
      activeGig.setlists = [{ title: 'Set 1', songs: [] }];
    }
    activeSetlistIdx = Math.min(activeSetlistIdx, activeGig.setlists.length - 1);
    // Fresh gig load → expand the first setlist by default; collapse the rest.
    openSetlistIdxs = new Set([0]);
    try { localStorage.setItem(GIG_ACTIVE_SLUG_KEY, slug); } catch (e) {}
    writeCache(GIG_DETAIL_CACHE_PREFIX + slug, activeGig);
    renderGigSidebar();
    if (document.body.classList.contains('gig-mode')) {
      precacheActiveGig();
    }
  } catch (e) {
    if (!cachedGig) {
      alert(`Couldn't load gig: ${e.message}`);
      activeGig = null;
      renderGigSidebar();
    }
  }
}

function precacheActiveGig() {
  if (!activeGig || !activeGig.slug) return;
  fetch(`/api/precache/gig/${encodeURIComponent(activeGig.slug)}`, { method: 'POST' })
    .then(r => r.json())
    .then(d => console.log(`[gig precache] ${activeGig.slug}: queued ${d.songs} songs`))
    .catch(err => console.warn('[gig precache] failed to start:', err.message));
}

// ── Sequential setlist playback ───────────────────────────────────────────
// Press ▶ on a setlist → load + play song 0, advance to next on song-end,
// loop until ⏹ or end of setlist. ⏭/⏮ skip without waiting. The player
// area stays visible the whole time so the stem mixer is reachable.

// Choose a variant for setlist playback. Prefer STEMS so the mixer comes
// Used to hard-default to STEMS when present; now defers to whatever the
// user last picked (preferredPlayVariant reads bt_last_variant_code from
// localStorage). So if you're playing the setlist in -V-G mode, the next
// song auto-advances in -V-G; if you switched to STEMS, the next stays
// in STEMS.
function setlistPlayVariant(merged) {
  return preferredPlayVariant(merged);
}

function findMergedForBase(base) {
  return mergedLibrary.find(m => {
    const sv = m.variants.find(v => v.type === 'stems');
    return sv && sv.folderName === base;
  });
}

function ensurePlayerVisible() {
  const sect = els.playerHeroSection;
  if (sect && sect.classList.contains('player-collapsed') && els.btnCollapsePlayer) {
    els.btnCollapsePlayer.click();
  }
}

function playGigSetlistFromStart(setlistIdx) {
  if (!activeGig || !activeGig.setlists[setlistIdx]) return;
  if (!activeGig.setlists[setlistIdx].songs.length) {
    alert('That setlist is empty.');
    return;
  }
  gigPlayingSetlistIdx = setlistIdx;
  gigPlayingSongIdx = -1;
  // Playing this setlist makes it the active one in the sidebar, and we
  // ensure it's expanded so the user can watch the song-row highlight move.
  activeSetlistIdx = setlistIdx;
  openSetlistIdxs.add(setlistIdx);
  ensurePlayerVisible();
  advanceGigSetlistPlayback();
}

function advanceGigSetlistPlayback() {
  if (gigPlayingSetlistIdx == null) return;
  const sl = activeGig && activeGig.setlists[gigPlayingSetlistIdx];
  if (!sl) { stopGigSetlistPlayback(); return; }
  const nextIdx = gigPlayingSongIdx + 1;
  if (nextIdx >= sl.songs.length) {
    stopGigSetlistPlayback();
    return;
  }
  loadGigSetlistSong(gigPlayingSetlistIdx, nextIdx);
}

function gigSetlistJump(setlistIdx, delta) {
  // Skip ⏭ / ⏮ in this same setlist. If nothing is currently playing, ⏭ starts
  // from song 0 and ⏮ does nothing.
  if (!activeGig || !activeGig.setlists[setlistIdx]) return;
  const sl = activeGig.setlists[setlistIdx];
  if (gigPlayingSetlistIdx !== setlistIdx) {
    if (delta > 0) playGigSetlistFromStart(setlistIdx);
    return;
  }
  const target = (gigPlayingSongIdx == null ? 0 : gigPlayingSongIdx) + delta;
  if (target < 0 || target >= sl.songs.length) return;
  loadGigSetlistSong(setlistIdx, target);
}

// ⏮ specifically — mirror the convention every media player uses: if more
// than a couple of seconds into the current song, restart THIS song. Only
// when near the beginning does it actually skip back to the prior song.
function gigSetlistPrev(setlistIdx) {
  const RESTART_THRESHOLD_SEC = 3;
  if (gigPlayingSetlistIdx === setlistIdx) {
    const livePos = (() => {
      for (const ch of CHANNELS) {
        const ae = audioElements[ch];
        if (ae && audioHasSrc(ae)) return ae.currentTime || 0;
      }
      return 0;
    })();
    if (livePos > RESTART_THRESHOLD_SEC) {
      Object.values(audioElements).forEach(el => {
        if (audioHasSrc(el)) { try { el.currentTime = 0; } catch (e) {} }
      });
      return;
    }
  }
  gigSetlistJump(setlistIdx, -1);
}

function loadGigSetlistSong(setlistIdx, songIdx) {
  const sl = activeGig.setlists[setlistIdx];
  const entry = sl && sl.songs[songIdx];
  if (!entry) { stopGigSetlistPlayback(); return; }
  const merged = findMergedForBase(entry.song_base);
  if (!merged) {
    // Song not in library — skip ahead instead of stalling
    console.warn(`[setlist play] ${entry.song_base} not in library; skipping`);
    gigPlayingSongIdx = songIdx;
    advanceGigSetlistPlayback();
    return;
  }
  gigPlayingSetlistIdx = setlistIdx;
  gigPlayingSongIdx = songIdx;
  ensurePlayerVisible();
  loadSong(setlistPlayVariant(merged), { autoplay: true });
  renderGigSidebar();
}

function stopGigSetlistPlayback() {
  gigPlayingSetlistIdx = null;
  gigPlayingSongIdx = null;
  stopAudio();
  renderGigSidebar();
}

async function onGigNew() {
  const title = prompt('Name this new gig:');
  if (!title || !title.trim()) return;
  try {
    const res = await fetch('/api/gigs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), setlists: [{ title: 'Set 1', songs: [] }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'create failed');
    await refreshGigList();
    document.getElementById('gig-picker').value = data.slug;
    loadActiveGig(data.slug);
  } catch (e) { alert(`Couldn't create gig: ${e.message}`); }
}

async function onGigDuplicate() {
  if (!activeGig || !activeGig.slug) return;
  const newTitle = prompt('Name the duplicated gig:', `${activeGig.title} (copy)`);
  if (!newTitle || !newTitle.trim()) return;
  try {
    const res = await fetch(`/api/gigs/${encodeURIComponent(activeGig.slug)}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newTitle: newTitle.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'duplicate failed');
    await refreshGigList();
    document.getElementById('gig-picker').value = data.slug;
    loadActiveGig(data.slug);
  } catch (e) { alert(`Couldn't duplicate: ${e.message}`); }
}

async function onGigDelete() {
  if (!activeGig || !activeGig.slug) return;
  if (!confirm(`Delete the gig "${activeGig.title}"? Its setlists go too.`)) return;
  try {
    const res = await fetch(`/api/gigs/${encodeURIComponent(activeGig.slug)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'delete failed');
    try { localStorage.removeItem(GIG_ACTIVE_SLUG_KEY); } catch (e) {}
    activeGig = null;
    const initial = await refreshGigList();
    if (initial) loadActiveGig(initial);
    else renderGigSidebar();
  } catch (e) { alert(`Couldn't delete: ${e.message}`); }
}

function scheduleGigSave() {
  if (!activeGig || !activeGig.slug) return;
  // YouTube Sync is read-only — playlist setlists are owned by setlist_sync.py.
  if (activeGig.readOnly) return;
  if (gigSaveTimer) clearTimeout(gigSaveTimer);
  // The Manual Setlists synthetic gig saves each member setlist back to its
  // own SETLISTS/<slug>.json via POST /api/setlists instead of the gigs API.
  if (activeGig.synthetic && activeGig.syntheticKind === 'manual') {
    gigSaveTimer = setTimeout(persistManualSetlists, 600);
    return;
  }
  gigSaveTimer = setTimeout(persistActiveGig, 600);
}

// Persist each setlist in the Manual Setlists pseudo-gig back to its own
// standalone SETLISTS/<slug>.json. The server-side POST /api/setlists is
// "create or replace"; we POST every setlist that has a real slug. Skips
// the placeholder row that appears when there are no manual setlists yet.
async function persistManualSetlists() {
  if (!activeGig || activeGig.syntheticKind !== 'manual') return;
  for (const sl of activeGig.setlists) {
    if (!sl.slug) continue;
    try {
      const songs = (sl.songs || []).map(s => s.song_base).filter(Boolean);
      await fetch('/api/setlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: sl.title, songs }),
      });
    } catch (e) {
      console.warn('[manual-save] failed for', sl.slug, e);
    }
  }
}

async function persistActiveGig() {
  if (!activeGig || !activeGig.slug) return;
  try {
    const res = await fetch(`/api/gigs/${encodeURIComponent(activeGig.slug)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: activeGig.title, setlists: activeGig.setlists }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');
    if (data.renamed_from) {
      // Slug changed (title was edited). Re-fetch the list + update the picker.
      activeGig.slug = data.slug;
      try { localStorage.setItem(GIG_ACTIVE_SLUG_KEY, data.slug); } catch (e) {}
      await refreshGigList();
      document.getElementById('gig-picker').value = data.slug;
    }
    // If Gig Mode is on, re-precache so newly added songs land in cache too.
    // The server skips files already cached, so this is cheap on no-op saves.
    if (document.body.classList.contains('gig-mode')) {
      precacheActiveGig();
    }
  } catch (e) {
    console.warn('[gig save]', e.message);
  }
}

function renderGigSidebar() {
  const nameEl = document.getElementById('gig-side-name');
  const countEl = document.getElementById('gig-side-count');
  const setlistsEl = document.getElementById('gig-setlists');
  const addBtn = document.getElementById('gig-add-setlist-btn');
  const dupBtn = document.getElementById('gig-dup-btn');
  const delBtn = document.getElementById('gig-del-btn');
  if (!nameEl || !setlistsEl) return;

  if (!activeGig) {
    nameEl.textContent = 'Untitled';
    countEl.textContent = '0';
    setlistsEl.innerHTML = '<div class="setlist-side-hint">No gig loaded. Hit + to create one.</div>';
    addBtn.disabled = true;
    dupBtn.disabled = true;
    delBtn.disabled = true;
    return;
  }

  nameEl.textContent = activeGig.title;
  countEl.textContent = activeGig.setlists.length;
  // Disable gig-level mutation buttons on synthetic gigs: dup/del/add don't
  // map cleanly to standalone setlists. Per-setlist title edits + per-setlist
  // song adds/removes still work on the Manual Setlists pseudo-gig (saved via
  // POST /api/setlists). YouTube Sync remains fully read-only.
  const synthetic = !!activeGig.synthetic;
  const ro = !!activeGig.readOnly;
  dupBtn.disabled = ro || synthetic;
  delBtn.disabled = ro || synthetic;
  addBtn.disabled = ro || synthetic || activeGig.setlists.length >= 4;
  if (ro) {
    dupBtn.title = 'YouTube Sync gig is read-only';
    delBtn.title = 'YouTube Sync gig is read-only';
    addBtn.title = 'YouTube Sync gig is read-only';
  } else if (synthetic) {
    dupBtn.title = 'Synthetic gig — use the Setlist Planner to add setlists';
    delBtn.title = 'Synthetic gig — delete setlists individually';
    addBtn.title = 'Synthetic gig — create new setlists from the planner';
  } else {
    dupBtn.title = ''; delBtn.title = ''; addBtn.title = '';
  }

  setlistsEl.innerHTML = '';
  activeGig.setlists.forEach((sl, idx) => {
    const node = renderOneGigSetlist(sl, idx);
    setlistsEl.appendChild(node);
  });
  if (window.lucide) lucide.createIcons();
}

function renderOneGigSetlist(sl, idx) {
  const open = openSetlistIdxs.has(idx);
  const wrap = document.createElement('div');
  wrap.className = 'gig-setlist';
  wrap.dataset.setlistIdx = String(idx);
  wrap.dataset.open = open ? 'true' : 'false';

  const head = document.createElement('div');
  head.className = 'gig-setlist-head';
  const isPlayingThisSetlist = gigPlayingSetlistIdx === idx;
  const isActiveSetlist = idx === activeSetlistIdx;
  head.innerHTML = `
    <i data-lucide="list-music" style="width:14px;height:14px;"></i>
    <input class="gig-setlist-title-input" type="text" value="${escapeHtml(sl.title)}" maxlength="40" />
    <span class="gig-setlist-count">${sl.songs.length}</span>
    <button class="gig-setlist-del" title="Remove this setlist from the gig">×</button>
    <i data-lucide="chevron-down" class="gig-setlist-caret" style="width:14px;height:14px;"></i>
  `;
  if (isPlayingThisSetlist) wrap.classList.add('playing');
  // .active = the "ready to play" setlist (where ghost-row appears, where
  // adds land). When something is actually playing, .playing wins visually.
  if (isActiveSetlist) wrap.classList.add('active');
  head.addEventListener('click', e => {
    if (e.target.closest('.gig-setlist-title-input') || e.target.closest('.gig-setlist-del')) return;
    // Click behavior:
    //   1. If this setlist isn't the active one  → make it active AND ensure
    //      it's expanded. (No close-others; multiple may stay open.)
    //   2. If this setlist IS already the active one → toggle its open/closed
    //      state. We never let the active setlist auto-collapse — if the user
    //      collapses the active one, it stays active; another click reopens.
    if (activeSetlistIdx !== idx) {
      activeSetlistIdx = idx;
      openSetlistIdxs.add(idx);
    } else {
      if (openSetlistIdxs.has(idx)) openSetlistIdxs.delete(idx);
      else openSetlistIdxs.add(idx);
    }
    renderGigSidebar();
  });
  const titleInput = head.querySelector('.gig-setlist-title-input');
  titleInput.addEventListener('input', e => {
    sl.title = e.target.value;
    scheduleGigSave();
  });
  titleInput.addEventListener('click', e => e.stopPropagation());
  head.querySelector('.gig-setlist-del').addEventListener('click', e => {
    e.stopPropagation();
    if (activeGig.setlists.length <= 1) {
      alert("Can't delete the only setlist in the gig.");
      return;
    }
    if (!confirm(`Remove "${sl.title}" from the gig?`)) return;
    activeGig.setlists.splice(idx, 1);
    if (activeSetlistIdx >= activeGig.setlists.length) activeSetlistIdx = activeGig.setlists.length - 1;
    renderGigSidebar();
    scheduleGigSave();
  });

  const body = document.createElement('div');
  body.className = 'gig-setlist-body';

  // No per-setlist add/remove toggle — adding happens via the ghost preview
  // row's green + (active setlist) or by dragging from another setlist; the
  // × on each song row handles remove.

  // Transport: ⏮ ⏹ ▶ ⏭ to drive sequential playback of this setlist.
  // ▶ starts from song 0 (or resumes if this setlist is the one playing);
  // song-ended advances to next automatically (see handleMasterTrackEnded).
  const transport = document.createElement('div');
  transport.className = 'gig-setlist-transport' + (isPlayingThisSetlist ? ' playing' : '');
  transport.innerHTML = `
    <button class="ss-tr ss-tr-prev" title="Previous song"><i data-lucide="skip-back"></i></button>
    <button class="ss-tr ss-tr-stop" title="Stop"><i data-lucide="square"></i></button>
    <button class="ss-tr ss-tr-play" title="Play this setlist from the start"><i data-lucide="${isPlayingThisSetlist ? 'pause' : 'play'}"></i></button>
    <button class="ss-tr ss-tr-next" title="Next song"><i data-lucide="skip-forward"></i></button>
    <span class="ss-tr-pos">${isPlayingThisSetlist && gigPlayingSongIdx != null ? `${gigPlayingSongIdx + 1} / ${sl.songs.length}` : ''}</span>
  `;
  transport.querySelector('.ss-tr-play').addEventListener('click', e => {
    e.stopPropagation();
    if (isPlayingThisSetlist) togglePlayPause();
    else playGigSetlistFromStart(idx);
  });
  transport.querySelector('.ss-tr-stop').addEventListener('click', e => {
    e.stopPropagation();
    stopGigSetlistPlayback();
  });
  transport.querySelector('.ss-tr-next').addEventListener('click', e => {
    e.stopPropagation();
    gigSetlistJump(idx, +1);
  });
  transport.querySelector('.ss-tr-prev').addEventListener('click', e => {
    e.stopPropagation();
    gigSetlistPrev(idx);
  });
  body.appendChild(transport);

  // Songs list
  const songsEl = document.createElement('div');
  songsEl.className = 'gig-setlist-songs';
  sl.songs.forEach((s, songIdx) => {
    const merged = mergedLibrary.find(m => {
      const sv = m.variants.find(v => v.type === 'stems');
      return sv && sv.folderName === s.song_base;
    });
    const title = (merged && merged.title) || s.song_base.replace(/_/g, ' ');
    const artist = (merged && merged.artist) || '';
    const row = document.createElement('div');
    row.className = 'sls-row';
    if (isPlayingThisSetlist && gigPlayingSongIdx === songIdx) row.classList.add('playing');
    row.draggable = true;
    row.dataset.setlistIdx = String(idx);
    row.dataset.songIdx = String(songIdx);
    row.innerHTML = `
      <span class="sls-grip">⋮⋮</span>
      <span class="sls-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      <span class="sls-artist">${escapeHtml(artist)}</span>
      <button class="sls-del" title="Remove from setlist">×</button>
    `;
    row.querySelector('.sls-del').addEventListener('click', e => {
      e.stopPropagation();
      sl.songs.splice(songIdx, 1);
      renderGigSidebar();
      scheduleGigSave();
    });
    row.addEventListener('click', e => {
      if (e.target.closest('.sls-del') || e.target.closest('.sls-grip')) return;
      if (!merged) return;
      // Click a setlist row → start playing the setlist FROM that song.
      // The auto-advance handler picks up from here, walking through the
      // rest of the setlist in order until ⏹ or end-of-setlist.
      loadGigSetlistSong(idx, songIdx);
    });
    songsEl.appendChild(row);
  });

  // Ghost preview slot — only on the ACTIVE setlist, only when there's a
  // current song that isn't already in this setlist. Greyed out, with a
  // bright green + so the user sees exactly what would happen if they
  // confirmed: 'this song would land here'.
  if (idx === activeSetlistIdx && currentSong) {
    const previewBase = songBaseOf(currentSong);
    const alreadyIn = previewBase && sl.songs.some(s => s.song_base === previewBase);
    if (previewBase && !alreadyIn) {
      const ghost = document.createElement('div');
      ghost.className = 'sls-row sls-ghost';
      ghost.innerHTML = `
        <span class="sls-grip" style="visibility:hidden;">⋮⋮</span>
        <span class="sls-title sls-ghost-title" title="Click + to add — '${escapeHtml(currentSong.title)}'">${escapeHtml(currentSong.title)}</span>
        <span class="sls-artist sls-ghost-artist">${escapeHtml(currentSong.artist || '')}</span>
        <button class="sls-add-ghost" title="Add the currently loaded song to this setlist"><i data-lucide="plus"></i></button>
      `;
      ghost.querySelector('.sls-add-ghost').addEventListener('click', e => {
        e.stopPropagation();
        sl.songs.push({ song_base: previewBase });
        renderGigSidebar();
        scheduleGigSave();
      });
      // Clicking elsewhere on the ghost row does nothing (no song loaded here yet)
      songsEl.appendChild(ghost);
    }
  }

  body.appendChild(songsEl);

  attachGigDragHandlers(wrap, songsEl);

  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function songBaseOf(song) {
  // If this song is itself a stems variant, use its folderName.
  if (song && song.folderName) return song.folderName;
  // Else find the merged record and use the stems variant's folderName.
  const merged = mergedLibrary.find(m => m.variants.some(v => v.id === song.id));
  if (!merged) return null;
  const sv = merged.variants.find(v => v.type === 'stems');
  return (sv && sv.folderName) || null;
}

// Drag-between setlists in the same gig.
// - Drag a .sls-row: dragstart sets payload {fromSetlist, fromSongIdx}.
// - Drop on a .gig-setlist: append the dragged song there (or insert at
//   computed position if dropped on a row). Alt held → copy instead of move.
function attachGigDragHandlers(wrap, songsEl) {
  songsEl.querySelectorAll('.sls-row').forEach(row => {
    row.addEventListener('dragstart', e => {
      const payload = {
        fromSetlist: Number(row.dataset.setlistIdx),
        fromSong:    Number(row.dataset.songIdx),
      };
      e.dataTransfer.setData('application/x-simpleStem-song', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copyMove';
      row.classList.add('sls-drag');
    });
    row.addEventListener('dragend', () => row.classList.remove('sls-drag'));
  });

  wrap.addEventListener('dragover', e => {
    if (!hasOurPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    wrap.dataset.dropTarget = 'true';
  });
  wrap.addEventListener('dragleave', e => {
    if (e.target === wrap) wrap.dataset.dropTarget = 'false';
  });
  wrap.addEventListener('drop', e => {
    if (!hasOurPayload(e)) return;
    e.preventDefault();
    wrap.dataset.dropTarget = 'false';
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-simpleStem-song')); }
    catch (err) { return; }
    if (!activeGig) return;
    const fromSl = activeGig.setlists[payload.fromSetlist];
    if (!fromSl) return;
    const moved = fromSl.songs[payload.fromSong];
    if (!moved) return;
    const toIdx = Number(wrap.dataset.setlistIdx);
    const toSl = activeGig.setlists[toIdx];
    if (!toSl) return;

    // Insert position: drop near a row → before that row; otherwise append
    const targetRow = e.target.closest && e.target.closest('.sls-row');
    let insertAt = toSl.songs.length;
    if (targetRow && targetRow.parentElement === wrap.querySelector('.gig-setlist-songs')) {
      insertAt = Number(targetRow.dataset.songIdx);
      const rect = targetRow.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) insertAt += 1;
    }

    if (e.altKey) {
      // copy: leave the source alone, insert a new reference
      toSl.songs.splice(insertAt, 0, { song_base: moved.song_base });
    } else if (payload.fromSetlist === toIdx) {
      // reorder within same setlist
      fromSl.songs.splice(payload.fromSong, 1);
      const adj = insertAt > payload.fromSong ? insertAt - 1 : insertAt;
      fromSl.songs.splice(adj, 0, moved);
    } else {
      // move across setlists
      fromSl.songs.splice(payload.fromSong, 1);
      toSl.songs.splice(insertAt, 0, moved);
    }
    renderGigSidebar();
    scheduleGigSave();
  });
}

function hasOurPayload(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('application/x-simpleStem-song');
}

// Bridges: callers from before the gig rewrite (loadSong, addToSetlist,
// removeFromSetlist, loadSetlistsList) still invoke these — wire them to the
// gig render so the sidebar updates on song-load / saved-setlist-load.
function renderSidebarSetlist() { renderGigSidebar(); }
function _cacheSavedSetlistMeta() { /* gig sidebar doesn't depend on flat setlists */ }


// ── Gig Mode ──────────────────────────────────────────────────────────────
// A header toggle the user flips before walking on stage. While on:
//   - the body gets `class="gig-mode"`; CSS then hides every chip that
//     isn't .chip-cached so the user literally can't click anything that
//     would stall on a Drive fetch
//   - song rows with zero cached variants are marked `.gig-uncached` and
//     hidden too — the library shrinks to just what's safe to play
//   - the toggle glows red so you can't forget you're in stage mode
// Persisted in localStorage so a server restart doesn't reset stage state.
function setupGigMode() {
  const btn = document.getElementById('btn-gig-mode');
  if (!btn) return;
  const apply = (on) => {
    document.body.classList.toggle('gig-mode', on);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem('simpleStem.gigMode', on ? '1' : '0'); } catch (e) {}
    // Re-render the library so per-row .gig-uncached classes get
    // applied/cleared based on current cache state.
    if (typeof renderSongList === 'function' && mergedLibrary && mergedLibrary.length) {
      renderSongList();
    }
    // Going on while a gig is loaded: precache the whole gig so nothing
    // can spin during the show. Fire-and-forget; the server returns
    // immediately and works in the background.
    if (on && activeGig && activeGig.slug) {
      precacheActiveGig();
    }
  };
  btn.addEventListener('click', () => apply(!document.body.classList.contains('gig-mode')));
  let initial = false;
  try { initial = localStorage.getItem('simpleStem.gigMode') === '1'; } catch (e) {}
  apply(initial);
}

// ── Tab system ────────────────────────────────────────────────────────────
// One docked player at top + three swappable tabs below: Library / Setlist /
// Drum Loops. Tab switching is purely cosmetic — audio keeps playing because
// the player section sits OUTSIDE the tab container.
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      const target = t.dataset.tab;
      tabs.forEach(b => {
        const active = b === t;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panes.forEach(p => {
        p.classList.toggle('tab-pane-active', p.dataset.tabPane === target);
      });
      // Lazy-load drum loops the first time the tab is opened
      if (target === 'drumloops' && !drumLoopsLoaded) {
        loadDrumLoops();
      }
    });
  });
}

// ── Drum Loops tab ────────────────────────────────────────────────────────
// Library-wide grid of every song's drums-only loops (the `_DO_loopN_Nbars.m4a`
// mixdowns from stem.sh). Each card plays the loop on click; clicking the
// playing card stops it. Uses the same `m4a` audio element as the rest of
// the player so master volume + transport state apply uniformly.
let drumLoopsLoaded = false;
let drumLoopsAll = [];
let drumLoopsByBase = new Map();   // songBase → [loops sorted by loopNumber]
let drumLoopAudio = null;
let drumLoopPlayingId = null;
// Per-file cache state. fileName → true (cached) | false (not cached) | 'loading' (currently fetching).
let loopCacheStatus = new Map();
// Instrument filter for the Loops tab. Empty Set = show all; otherwise only
// rows whose .inst is in the set are shown. Same toggle semantics as the
// FORMAT column filter in the library.
const INSTRUMENTS = ['drums', 'drumsbass', 'bass', 'guitar', 'piano'];
let drumLoopInstFilter = new Set();
// Column sort. key ∈ {'song','bpm','bars','inst'}. Default 'song'.
let loopSort = { key: 'song', dir: 'asc' };
// Construction-kit state: which individual instrument chips are currently
// selected (across all rows). Mix-and-match the drums from one song with
// the bass from another, then "Add as Combo" drops the set into the
// sequence as a single concurrent-play entry.
//   Map<fileName, loopRecord>
let selectedKitChips = new Map();
// Currently-playing combo: array of Audio elements playing simultaneously.
let comboAudios = [];

function setupDrumLoopsTab() {
  const searchEl = document.getElementById('drumloops-search');
  const sortEl   = document.getElementById('drumloops-sort');
  if (searchEl) searchEl.addEventListener('input', renderDrumLoops);
  if (sortEl)   sortEl.addEventListener('change', renderDrumLoops);
}

// Fetches the drum-loops catalog once and indexes it by songBase so both
// the Drum Loops tab and the per-row chips in the Library tab can share
// the same data without two round-trips.
async function loadDrumLoops() {
  const grid = document.getElementById('drumloops-grid');
  // Loading indicator while the catalog is in flight + while initial cache
  // status is fetched in parallel.
  if (grid) grid.innerHTML = `
    <div class="loops-loading">
      <div class="spinner"></div>
      <div>Loading loop catalog from Drive…</div>
    </div>
  `;
  try {
    const res = await fetch('/api/drum-loops');
    const data = await res.json();
    drumLoopsAll = data.loops || [];
    drumLoopsByBase = new Map();
    for (const l of drumLoopsAll) {
      if (!drumLoopsByBase.has(l.songBase)) drumLoopsByBase.set(l.songBase, []);
      drumLoopsByBase.get(l.songBase).push(l);
    }
    for (const arr of drumLoopsByBase.values()) arr.sort((a, b) => a.loopNumber - b.loopNumber);
    drumLoopsLoaded = true;
    const label = document.getElementById('drumloops-count-label');
    if (label) label.textContent = `${drumLoopsAll.length} loops across ${drumLoopsByBase.size} songs`;
    // Kick off cache-state hydration in the background. The first render
    // shows everything as "uncached"; the hydration call updates the map
    // and re-renders.
    hydrateLoopCacheStatus();
    if (grid) renderDrumLoops();
    if (typeof renderSongList === 'function' && mergedLibrary && mergedLibrary.length) {
      renderSongList();
    }
  } catch (e) {
    if (grid) grid.innerHTML = `<div class="empty-state">Couldn't load loops: ${escapeHtml(e.message)}</div>`;
  }
}

// Ask the server which loop files are already in the local audio cache so
// each pill can be marked "cached" (instant play) vs "uncached" (will spin
// fetching from Drive on first play). Called once after the catalog loads,
// and again after each precache POST settles.
async function hydrateLoopCacheStatus(filenames) {
  const files = filenames || drumLoopsAll.map(l => l.fileName).filter(Boolean);
  if (!files.length) return;
  try {
    const res = await fetch('/api/loop-cache-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    if (!res.ok) return;
    const data = await res.json();
    for (const [f, cached] of Object.entries(data.status || {})) {
      loopCacheStatus.set(f, !!cached);
    }
    renderDrumLoops();
    renderLoopSequence();
  } catch (e) { /* cache hydration is best-effort */ }
}

// Trigger a background copy from Drive into the local cache. Resolves true if
// the server confirmed the file is now (or already was) cached. Used by
// loopSeqAdd so any loop dropped into the sequence is on disk before its
// turn comes up in playback.
async function precacheLoop(fileName) {
  if (!fileName) return false;
  if (loopCacheStatus.get(fileName) === true) return true;
  loopCacheStatus.set(fileName, 'loading');
  renderLoopSequence();
  // Capture the current AbortController so Stop can cancel us mid-poll.
  const signal = driveFetchAbort.signal;
  try {
    const res = await fetch(`/api/precache/loop/${fileName}`, { method: 'POST', signal });
    const data = await res.json();
    if (data.cached || data.alreadyCached) {
      loopCacheStatus.set(fileName, true);
      renderLoopSequence();
      return true;
    }
    for (let i = 0; i < 30; i++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      await new Promise(r => setTimeout(r, 1000));
      const s = await fetch('/api/loop-cache-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [fileName] }),
        signal,
      }).then(r => r.json()).catch(() => null);
      if (s && s.status && s.status[fileName]) {
        loopCacheStatus.set(fileName, true);
        renderLoopSequence();
        return true;
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('[precacheLoop] cancelled by Stop:', fileName);
    }
  }
  // Don't downgrade a cached entry just because the poll bailed out.
  if (loopCacheStatus.get(fileName) !== true) loopCacheStatus.set(fileName, false);
  renderLoopSequence();
  return false;
}

// One CARD per song (not per loop). Each card has the song header + a row of
// loop buttons inside, so a 4-loop song shows up as one card with 4 buttons —
// matching how a drummer thinks about it ("give me Harvest Moon's loops").
function renderDrumLoops() {
  const grid = document.getElementById('drumloops-grid');
  if (!grid) return;
  const q = (document.getElementById('drumloops-search')?.value || '').toLowerCase().trim();

  // Default each loop's inst to 'drums' if the server didn't fill it in
  // (legacy DO_loop rows pre-upgrade).
  let rows = drumLoopsAll.map(l => Object.assign({ inst: l.inst || 'drums' }, l));
  rows = rows.filter(l => {
    if (drumLoopInstFilter.size > 0 && !drumLoopInstFilter.has(l.inst)) return false;
    if (!q) return true;
    return (l.title || '').toLowerCase().includes(q) ||
           (l.artist || '').toLowerCase().includes(q) ||
           (l.fileName || '').toLowerCase().includes(q);
  });

  // GROUP by song only (one row per song). Each row carries every
  // (instrument, bars) combination available for that song as a chip.
  // Normalize slug so modern LOOPS/ entries and legacy DO_loop entries for
  // the same song collapse together.
  const normalizeSlug = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_do$/, '');
  const groups = new Map();
  for (const l of rows) {
    const slug = normalizeSlug(l.songBase || l.songSlug || l.title);
    if (!groups.has(slug)) {
      groups.set(slug, {
        slug,
        songBase: l.songBase,
        title: l.title,
        artist: l.artist,
        bpm: l.bpm,
        key: l.key || null,
        loops: [],
      });
    }
    const g = groups.get(slug);
    // Carry the first non-null bpm/key from any loop in the group.
    if (!g.bpm && l.bpm) g.bpm = l.bpm;
    if (!g.key && l.key) g.key = l.key;
    g.loops.push(l);
  }
  const groupRows = [...groups.values()];

  // Sort groups by selected column.
  const dir = loopSort.dir === 'desc' ? -1 : 1;
  const cmpNum = (a, b) => ((a || 0) - (b || 0)) * dir;
  const cmpStr = (a, b) => (a || '').localeCompare(b || '') * dir;
  groupRows.sort((a, b) => {
    switch (loopSort.key) {
      case 'bpm':   return cmpNum(a.bpm, b.bpm) || cmpStr(a.title, b.title);
      case 'key':   return cmpStr(a.key, b.key) || cmpStr(a.title, b.title);
      case 'song':
      default:      return cmpStr(a.title, b.title) || cmpNum(a.bpm, b.bpm);
    }
  });

  const fmtBpm = (n) => n ? String(n) : '—';
  const sortIcon = (k) => loopSort.key === k
    ? (loopSort.dir === 'asc' ? '▲' : '▼')
    : '↕';

  // Construction-kit combo controls. Shows current selection count, BPM
  // sanity (all selected should share BPM), and buttons to play/clear/add.
  const sel = [...selectedKitChips.values()];
  const selBpms = [...new Set(sel.map(l => l.bpm).filter(Boolean))];
  const selBars = [...new Set(sel.map(l => l.bars).filter(Boolean))];
  const mismatch = selBpms.length > 1;
  const comboBar = `
    <div class="combo-bar${sel.length ? ' active' : ''}${mismatch ? ' mismatch' : ''}">
      <span class="combo-bar-label">
        Combo: <strong>${sel.length}</strong> selected
        ${sel.length ? `· BPM <strong>${selBpms.join(' / ')}</strong> · bars <strong>${selBars.join(' / ')}</strong>` : ''}
        ${mismatch ? '<span class="combo-warning">⚠ mixed BPM</span>' : ''}
      </span>
      <button class="combo-btn combo-btn-play" id="combo-btn-play" ${sel.length ? '' : 'disabled'}>▶ Play Selected</button>
      <button class="combo-btn combo-btn-add" id="combo-btn-add" ${sel.length ? '' : 'disabled'}>+ Add as Combo</button>
      <button class="combo-btn combo-btn-clear" id="combo-btn-clear" ${sel.length ? '' : 'disabled'}>Clear</button>
    </div>
  `;

  // Column header row.
  const header = `
    <div class="loops-table-header kit-header">
      <button class="lt-col lt-col-bpm lt-sort${loopSort.key === 'bpm' ? ' active' : ''}" data-sort="bpm">
        BPM <span class="lt-sort-arrow">${sortIcon('bpm')}</span>
      </button>
      <button class="lt-col lt-col-key lt-sort${loopSort.key === 'key' ? ' active' : ''}" data-sort="key">
        KEY <span class="lt-sort-arrow">${sortIcon('key')}</span>
      </button>
      <button class="lt-col lt-col-song lt-sort${loopSort.key === 'song' ? ' active' : ''}" data-sort="song">
        SONG <span class="lt-sort-arrow">${sortIcon('song')}</span>
      </button>
      <div class="lt-col lt-col-chips">LOOPS (instrument · bars — click to add to combo)</div>
    </div>
  `;

  if (groupRows.length === 0) {
    grid.innerHTML = comboBar + header + '<div class="empty-state">No loops match.</div>';
    renderInstrumentFilters();
    bindSortHeaderClicks(grid);
    bindComboBarHandlers(grid);
    return;
  }

  const body = groupRows.map(g => {
    // Group this song's loops by instrument. Within each instrument, dedupe
    // by bar count — modern LOOPS/ entries and legacy DO_loop entries can
    // both produce a DRUMS 8b for the same song. Prefer the modern entry
    // (source === 'loops') so the file in the LOOPS/ folder is used.
    const byInst = {};
    for (const l of g.loops) {
      const inst = l.inst || 'drums';
      if (!byInst[inst]) byInst[inst] = new Map();
      const existing = byInst[inst].get(l.bars);
      if (!existing || (l.source === 'loops' && existing.source !== 'loops')) {
        byInst[inst].set(l.bars, l);
      }
    }
    // Convert each instrument's Map → sorted array by bars ascending.
    for (const inst of Object.keys(byInst)) {
      byInst[inst] = [...byInst[inst].values()].sort((a, b) => (a.bars || 0) - (b.bars || 0));
    }

    // Render in canonical INSTRUMENTS order so columns line up across rows.
    const chipsHtml = INSTRUMENTS.flatMap(inst => {
      const loops = byInst[inst] || [];
      if (!loops.length) return [];
      return loops.map(l => {
        const cs = loopCacheStatus.get(l.fileName);
        const cacheClass = cs === true ? ' kit-chip-cached'
                         : cs === 'loading' ? ' kit-chip-loading' : '';
        const selectedClass = selectedKitChips.has(l.fileName) ? ' kit-chip-selected' : '';
        return `<button class="kit-chip kit-chip-${escapeHtml(inst)}${cacheClass}${selectedClass}"
                        data-file="${encodeURIComponent(l.fileName)}"
                        data-inst="${escapeHtml(inst)}"
                        data-bpm="${l.bpm || ''}"
                        data-bars="${l.bars}"
                        data-key="${escapeHtml(l.key || '')}"
                        data-source="${escapeHtml(l.source || '')}"
                        data-title="${escapeHtml(l.title || '')}"
                        data-id="${escapeHtml(l.id)}"
                        title="${escapeHtml(l.fileName || '')}">
                  <span class="kit-chip-label">${escapeHtml(inst.toUpperCase())}</span>
                  <span class="kit-chip-bars">${l.bars}b</span>
                </button>`;
      });
    }).join('');
    return `
      <div class="kit-row" data-groupkey="${escapeHtml(g.slug)}">
        <div class="kit-col kit-col-bpm">${fmtBpm(g.bpm)}</div>
        <div class="kit-col kit-col-key">${escapeHtml(g.key || '—')}</div>
        <div class="kit-col kit-col-song" title="${escapeHtml(g.title || '')}">${escapeHtml(g.title || '')}</div>
        <div class="kit-col kit-col-chips">${chipsHtml}</div>
      </div>
    `;
  }).join('');

  grid.innerHTML = comboBar + header + `<div class="kit-list">${body}</div>`;

  // Chip clicks → toggle selection in selectedKitChips. Shift-click = solo play.
  grid.querySelectorAll('.kit-chip:not(.kit-chip-empty)').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const fileName = decodeURIComponent(btn.dataset.file || '');
      if (e.shiftKey) {
        // Shift-click: solo-play this one (existing behavior preserved).
        toggleDrumLoop(btn);
        return;
      }
      if (selectedKitChips.has(fileName)) {
        selectedKitChips.delete(fileName);
      } else {
        selectedKitChips.set(fileName, {
          id: btn.dataset.id,
          fileName,
          source: btn.dataset.source,
          inst: btn.dataset.inst,
          bars: Number(btn.dataset.bars) || 0,
          bpm: Number(btn.dataset.bpm) || 0,
          title: btn.dataset.title,
        });
        // Pre-cache so when they hit Play Selected or Add as Combo, the file
        // is local.
        precacheLoop(fileName);
      }
      renderDrumLoops();
    });
  });

  bindSortHeaderClicks(grid);
  bindComboBarHandlers(grid);
  renderInstrumentFilters();
  if (window.lucide) lucide.createIcons();
}

function bindComboBarHandlers(grid) {
  const playBtn = grid.querySelector('#combo-btn-play');
  const addBtn  = grid.querySelector('#combo-btn-add');
  const clrBtn  = grid.querySelector('#combo-btn-clear');
  if (playBtn) playBtn.addEventListener('click', playSelectedCombo);
  if (addBtn)  addBtn.addEventListener('click', addSelectedAsCombo);
  if (clrBtn)  clrBtn.addEventListener('click', () => {
    selectedKitChips.clear();
    stopCombo();
    renderDrumLoops();
  });
}

// Play every chip currently in selectedKitChips simultaneously. Each loop
// gets its own <audio> with loop=true; they all start at once via Promise.all.
async function playSelectedCombo() {
  const loops = [...selectedKitChips.values()];
  if (!loops.length) return;
  stopCombo();
  comboAudios = loops.map(l => {
    const a = new Audio();
    a.loop = true;
    a.src = l.source === 'loops'
      ? `/api/audio/loop/${l.fileName}`
      : `/api/audio/m4a/${l.fileName}`;
    return a;
  });
  await Promise.all(comboAudios.map(a => a.play().catch(err => console.warn('[combo] play failed', err))));
}

function stopCombo() {
  for (const a of comboAudios) {
    try { a.pause(); a.currentTime = 0; } catch (e) {}
  }
  comboAudios = [];
}

// Add the current selection as a single COMBO entry in the sequence. Then
// clear the selection so the user can build the next combo.
function addSelectedAsCombo() {
  const loops = [...selectedKitChips.values()];
  if (!loops.length) return;
  const rec = {
    seqKey:    `combo_${Date.now()}`,
    kind:      'combo',
    loops:     loops.slice(),
    bpm:       loops[0].bpm,
    bars:      loops[0].bars,
    title:     loops.length === 1 ? loops[0].title : `Combo (${loops.map(l => l.inst).join('+')})`,
    inst:      'combo',
    fileName:  loops[0].fileName,
  };
  loopSequence.push(rec);
  selectedKitChips.clear();
  renderLoopSequence();
  renderDrumLoops();
  // Pre-cache every file in the combo so playback never blocks.
  for (const l of loops) precacheLoop(l.fileName);
}

function bindSortHeaderClicks(grid) {
  grid.querySelectorAll('.lt-sort').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (loopSort.key === key) {
        loopSort.dir = loopSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        loopSort.key = key;
        loopSort.dir = 'asc';
      }
      renderDrumLoops();
    });
  });
}

// Render the instrument filter toggle bar above the loop list. Mirrors the
// FORMAT column filters in the library — click an instrument to scope the
// view to that one (multi-select with OR semantics).
function renderInstrumentFilters() {
  const bar = document.getElementById('loop-inst-filters');
  if (!bar) return;
  const counts = {};
  for (const i of INSTRUMENTS) counts[i] = 0;
  for (const l of drumLoopsAll) {
    // Default missing inst to 'drums' so legacy DO_loop rows still get
    // bucketed correctly (matches the same default applied in renderDrumLoops).
    const inst = l.inst || 'drums';
    if (counts[inst] !== undefined) counts[inst]++;
  }
  bar.innerHTML = INSTRUMENTS.map(i => {
    const active = drumLoopInstFilter.has(i) ? ' active' : '';
    const c = counts[i] || 0;
    return `<button class="loop-inst-btn loop-pill-${i}${active}" data-inst="${i}" ${c === 0 ? 'disabled' : ''}>
      ${i.toUpperCase()} <span class="loop-inst-count">${c}</span>
    </button>`;
  }).join('') + `<button class="loop-inst-clear" id="loop-inst-clear" ${drumLoopInstFilter.size === 0 ? 'disabled' : ''}>All</button>`;
  bar.querySelectorAll('.loop-inst-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = btn.dataset.inst;
      if (drumLoopInstFilter.has(i)) drumLoopInstFilter.delete(i);
      else drumLoopInstFilter.add(i);
      renderDrumLoops();
    });
  });
  const clr = bar.querySelector('#loop-inst-clear');
  if (clr) clr.addEventListener('click', () => {
    drumLoopInstFilter.clear();
    renderDrumLoops();
  });
}

// Toggle a drum loop on or off. Same audio element is used everywhere drum
// loops play (Drum Loops tab AND library-row chips), so clicking a second
// button just swaps the source; clicking the playing button again stops it.
function toggleDrumLoop(btn) {
  const id = btn.dataset.id;
  const PLAYING_SELECTOR = '.dl-loop-btn.playing, .song-drumloop-chip.playing';
  const resetButton = (b) => {
    b.classList.remove('playing');
    if (b.classList.contains('song-drumloop-chip')) {
      // chip-only — restore its original label from data attr
      b.innerHTML = b.dataset.idleLabel || b.innerHTML;
    } else {
      // tab button — restore "L# Nb" label from data
      const lp = b.dataset.loopnum, bars = b.dataset.bars;
      if (lp && bars) b.innerHTML = `L${lp} <span class="dl-bars">${bars}b</span>`;
    }
  };
  if (drumLoopPlayingId === id && drumLoopAudio) {
    drumLoopAudio.pause();
    drumLoopAudio.currentTime = 0;
    drumLoopPlayingId = null;
    resetButton(btn);
    return;
  }
  if (drumLoopAudio) {
    drumLoopAudio.pause();
    document.querySelectorAll(PLAYING_SELECTOR).forEach(resetButton);
  }
  if (!drumLoopAudio) {
    drumLoopAudio = new Audio();
    drumLoopAudio.loop = true;
    drumLoopAudio.addEventListener('ended', () => { drumLoopPlayingId = null; });
  }
  // Loops in the new flat LOOPS/ folder are served via /api/audio/loop/.
  // Legacy DO mixdowns in M4A/ continue to use /api/audio/m4a/. The button
  // carries its source on a data attribute set when rendered.
  const isFlatLoop = btn.dataset.source === 'loops';
  drumLoopAudio.src = isFlatLoop
    ? `/api/audio/loop/${btn.dataset.file}`
    : `/api/audio/m4a/${btn.dataset.file}`;
  drumLoopAudio.play().catch(err => console.warn('[drumloop] play failed', err));
  drumLoopPlayingId = id;
  btn.classList.add('playing');
  btn.innerHTML = '■';
}

// ── Loop sequence construct ──────────────────────────────────────────────
// Build a playable sequence of loops. Mirrors the setlist sidebar UI: an
// ordered list with prev / stop / play / next transport. Auto-advance fires
// the next loop the instant the current one ends (so a 16-bar loop seamlessly
// jumps to the next loop at bar 17). Manual mode just plays the current loop
// on repeat until the user clicks Next.
let loopSequence = [];           // array of loop records ({id, fileName, source, inst, bpm, bars, title})
let loopSeqIdx = -1;             // currently-playing index, -1 = stopped
let loopSeqPlaying = false;

function loopSeqAdd(btn) {
  const fileName = decodeURIComponent(btn.dataset.file || '');
  const rec = {
    id:        btn.dataset.id,
    fileName,
    source:    btn.dataset.source,
    inst:      btn.dataset.inst,
    bars:      Number(btn.dataset.bars) || 0,
    bpm:       Number(btn.dataset.bpm)  || 0,
    title:     btn.dataset.title,
    seqKey:    `${btn.dataset.id}_${Date.now()}`,
  };
  loopSequence.push(rec);
  renderLoopSequence();
  // Pre-cache the file in the background so it's local by the time playback
  // reaches it. Loops in the sequence MUST be cached locally.
  precacheLoop(fileName);
}

function loopSeqRemove(seqKey) {
  const i = loopSequence.findIndex(l => l.seqKey === seqKey);
  if (i < 0) return;
  loopSequence.splice(i, 1);
  if (loopSeqIdx === i) {
    // removed the one playing — stop or advance
    loopSeqStop();
  } else if (loopSeqIdx > i) {
    loopSeqIdx--;
  }
  renderLoopSequence();
}

function loopSeqClear() {
  loopSeqStop();
  loopSequence = [];
  renderLoopSequence();
}

function renderLoopSequence() {
  const list = document.getElementById('loop-sequence-list');
  const count = document.getElementById('loop-seq-count');
  const pos = document.getElementById('loop-seq-pos');
  if (count) count.textContent = String(loopSequence.length);
  if (pos) pos.textContent = loopSequence.length && loopSeqIdx >= 0
    ? `${loopSeqIdx + 1} / ${loopSequence.length}` : '';
  if (!list) return;
  if (loopSequence.length === 0) {
    list.innerHTML = '<div class="empty-state">Click + on a loop to add it to the sequence.</div>';
    return;
  }
  list.innerHTML = loopSequence.map((l, i) => {
    const playing = (i === loopSeqIdx && loopSeqPlaying) ? ' playing' : '';
    // For combos, cache state = AND of all files; for single-loop entries,
    // just this loop's state.
    const files = l.kind === 'combo' ? l.loops.map(x => x.fileName) : [l.fileName];
    const statuses = files.map(f => loopCacheStatus.get(f));
    const allCached = statuses.every(s => s === true);
    const anyLoading = statuses.some(s => s === 'loading');
    const cacheClass = allCached ? ' loop-seq-cached'
                     : anyLoading ? ' loop-seq-caching' : ' loop-seq-uncached';
    const cacheLabel = allCached ? '●' : anyLoading ? '⏳' : '○';
    const cacheTitle = allCached ? 'All loops cached locally'
                     : anyLoading ? 'Caching from Drive…'
                     : 'Not fully cached yet';
    // Combo: show multiple instrument badges.
    let instHtml;
    if (l.kind === 'combo') {
      instHtml = l.loops.map(x => `<span class="loop-seq-inst loop-pill-${escapeHtml(x.inst)}">${escapeHtml(x.inst.toUpperCase())}</span>`).join('');
    } else {
      instHtml = `<span class="loop-seq-inst loop-pill-${escapeHtml(l.inst)}">${escapeHtml((l.inst || '?').toUpperCase())}</span>`;
    }
    return `
      <div class="loop-seq-row${playing}${cacheClass}" data-key="${l.seqKey}" draggable="true">
        <span class="loop-seq-num">${i + 1}</span>
        <span class="loop-seq-insts">${instHtml}</span>
        <span class="loop-seq-title" title="${escapeHtml(l.title || '')}">${escapeHtml(l.title || '')}</span>
        <span class="loop-seq-meta">${l.bpm || '?'} · ${l.bars}<span class="dl-bars">b</span></span>
        <span class="loop-seq-cache" title="${cacheTitle}">${cacheLabel}</span>
        <button class="loop-seq-del" title="Remove">×</button>
      </div>`;
  }).join('');
  // Wire row clicks (jump-to-loop) and delete.
  list.querySelectorAll('.loop-seq-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.loop-seq-del')) return;
      const key = row.dataset.key;
      const i = loopSequence.findIndex(l => l.seqKey === key);
      if (i >= 0) loopSeqPlayFrom(i);
    });
    row.querySelector('.loop-seq-del').addEventListener('click', (e) => {
      e.stopPropagation();
      loopSeqRemove(row.dataset.key);
    });
  });
  if (window.lucide) lucide.createIcons();
}

function loopSeqPlayFrom(i) {
  if (i < 0 || i >= loopSequence.length) return;
  const rec = loopSequence[i];
  loopSeqIdx = i;
  loopSeqPlaying = true;

  if (drumLoopAudio) {
    drumLoopAudio.pause();
    drumLoopPlayingId = null;
  }
  stopCombo();

  const autoAdv = !!document.getElementById('loop-seq-autoadvance')?.checked;

  // Combo entries play multiple audios simultaneously. Auto-advance fires
  // when the FIRST one ends (all loops in a combo share BPM + bars, so they
  // end together).
  const loops = rec.kind === 'combo' ? rec.loops : [rec];
  comboAudios = loops.map(l => {
    const a = new Audio();
    a.loop = !autoAdv;
    a.src = l.source === 'loops'
      ? `/api/audio/loop/${l.fileName}`
      : `/api/audio/m4a/${l.fileName}`;
    return a;
  });
  // Wire 'ended' only on the first audio so auto-advance doesn't double-fire.
  if (comboAudios[0]) comboAudios[0].addEventListener('ended', loopSeqOnEnded);
  Promise.all(comboAudios.map(a => a.play().catch(err => console.warn('[seq] play failed', err))));
  renderLoopSequence();
}

function loopSeqOnEnded() {
  // Only honored when loop=false (auto-advance mode).
  loopSeqNext();
}

function loopSeqNext() {
  if (loopSequence.length === 0) return;
  if (loopSeqIdx + 1 >= loopSequence.length) {
    // wrap to start so the sequence keeps cycling
    loopSeqPlayFrom(0);
  } else {
    loopSeqPlayFrom(loopSeqIdx + 1);
  }
}

function loopSeqPrev() {
  if (loopSequence.length === 0) return;
  if (loopSeqIdx <= 0) loopSeqPlayFrom(loopSequence.length - 1);
  else loopSeqPlayFrom(loopSeqIdx - 1);
}

function loopSeqStop() {
  loopSeqPlaying = false;
  if (drumLoopAudio) {
    drumLoopAudio.pause();
    drumLoopAudio.currentTime = 0;
  }
  stopCombo();
  loopSeqIdx = -1;
  renderLoopSequence();
}

function setupLoopSequenceUI() {
  const play  = document.getElementById('loop-seq-play');
  const stop  = document.getElementById('loop-seq-stop');
  const prev  = document.getElementById('loop-seq-prev');
  const next  = document.getElementById('loop-seq-next');
  const clear = document.getElementById('loop-seq-clear');
  const auto  = document.getElementById('loop-seq-autoadvance');
  if (play)  play.addEventListener('click', () => {
    if (loopSeqPlaying) { loopSeqStop(); return; }
    loopSeqPlayFrom(loopSeqIdx >= 0 ? loopSeqIdx : 0);
  });
  if (stop)  stop.addEventListener('click', loopSeqStop);
  if (prev)  prev.addEventListener('click', loopSeqPrev);
  if (next)  next.addEventListener('click', loopSeqNext);
  if (clear) clear.addEventListener('click', () => {
    if (confirm('Clear the loop sequence?')) loopSeqClear();
  });
  if (auto) auto.addEventListener('change', (e) => {
    if (drumLoopAudio) drumLoopAudio.loop = !e.target.checked;
  });
  renderLoopSequence();
}

// ── Add-from-YouTube queue ────────────────────────────────────────────────
function setupQueueUI() {
  if (!els.btnEnqueue) return;
  els.btnEnqueue.addEventListener('click', enqueueUrl);
  els.ytUrl.addEventListener('keydown', e => { if (e.key === 'Enter') enqueueUrl(); });
  refreshQueue();
  setInterval(refreshQueue, 5000);
}

async function enqueueUrl() {
  const url = (els.ytUrl.value || '').trim();
  if (!url) return;
  els.btnEnqueue.disabled = true;
  try {
    const res = await fetch('/api/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to queue');
    els.ytUrl.value = '';
    refreshQueue();
  } catch (e) {
    if (els.queueStatus) els.queueStatus.innerHTML =
      `<span class="queue-err">${e.message}</span>`;
  } finally {
    els.btnEnqueue.disabled = false;
  }
}

async function refreshQueue() {
  if (!els.queueStatus) return;
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) return;
    renderQueue(await res.json());
  } catch (e) { /* server may be busy; leave last state */ }
}

function renderQueue(q) {
  const el = els.queueStatus;
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

  renderStemProgress(q);
}

// Pick the variant a bare 'play this song' action should use. Default
// preference for live + practice use is the -V-G m4a (vocals + guitar
// dropped — the band's most-used mix). Fallbacks in descending usefulness.
// Used by: library row click, inline play button on each row, sidebar
// setlist song click. Format chips and the variant picker still load
// their explicit variant.
// Pick which variant to play when the user clicks a song row or moves to
// the next setlist song. Honors the user's last explicit choice if possible
// (persisted in localStorage as `bt_last_variant_code`) so switching songs
// keeps the same mode — e.g. always stay in STEMS, or always play -V-G.
function preferredPlayVariant(merged) {
  if (!merged || !merged.variants) return merged && merged.primary;
  const byCode = code => {
    if (code === 'STEMS') return merged.variants.find(v => v.type === 'stems');
    return merged.variants.find(v => v.type === 'm4a' && v.variantCode === code);
  };
  let lastCode = null;
  try { lastCode = localStorage.getItem('bt_last_variant_code'); } catch (e) {}
  if (lastCode) {
    const match = byCode(lastCode);
    if (match) return match;
  }
  return byCode('-V-G') || byCode('-V-G-B') || byCode('-V') ||
         byCode('FULL')  || merged.primary;
}

// Remember the variant code each time the user explicitly loads a song so
// the next preferredPlayVariant() call honors that choice.
function rememberLastVariantCode(v) {
  if (!v) return;
  const code = v.type === 'stems' ? 'STEMS' : v.variantCode;
  if (!code) return;
  try { localStorage.setItem('bt_last_variant_code', code); } catch (e) {}
}

// Stemming progress bar (e.g. "Stemming 5/9").
// /api/queue gives the CURRENT backlog (queued count) + whether one is
// processing, but no fixed total. We derive a denominator client-side: when the
// remaining work rises, that's the size of the current batch (high-water mark);
// as jobs finish, the bar fills toward it. Resets to idle when the queue drains.
let stemBatchTotal = 0;
function renderStemProgress(q) {
  if (!els.stemProgress) return;

  // count songs still to render: queued jobs (setlist folders count their songs)
  // + anything actively processing. Awaiting-metadata items aren't stemmable yet,
  // so they're shown separately, not in the denominator.
  let remaining = 0;
  for (const j of (q.queued || [])) remaining += (j.songs || 1);
  const processing = q.processing ? 1 : 0;
  const toDo = remaining + processing;

  if (toDo === 0) {
    stemBatchTotal = 0;
    els.stemProgress.style.display = 'none';
    return;
  }

  // Grow the batch total if the workload increased (new jobs queued).
  if (toDo > stemBatchTotal) stemBatchTotal = toDo;
  const done = Math.max(0, stemBatchTotal - toDo);
  const pct = stemBatchTotal ? Math.round((done / stemBatchTotal) * 100) : 0;

  els.stemProgress.style.display = 'block';
  els.stemProgressCount.textContent = `${done}/${stemBatchTotal}`;
  els.stemProgressFill.style.width = `${pct}%`;

  if (q.processing) {
    const s = q.processing.song || q.processing.job || 'song';
    const ph = q.processing.phase ? ` · ${q.processing.phase}` : '';
    els.stemProgressNow.textContent = `${s}${ph}`;
  } else {
    els.stemProgressNow.textContent = 'waiting for the Performer to pick up the queue…';
  }
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
    // Dedupe by (type, variantCode) — when multiple files map to the same
    // variant (e.g. several FULL-suffix m4as for one song), show one chip.
    // Prefer a cached entry over an uncached one so the chip lights up.
    const seen = new Map();
    for (const v of variants) {
      const code = `${v.type}:${v.variantCode}`;
      const prev = seen.get(code);
      if (!prev || (v.cached && !prev.cached)) seen.set(code, v);
    }
    const dedupedVariants = [...seen.values()];
    const primary = dedupedVariants[0];
    merged.push({
      id: `merged-${key}`,
      type: 'merged',
      title: primary.title,
      artist: primary.artist,
      practiceBpm: primary.practiceBpm,
      originalBpm: primary.originalBpm,
      key: primary.key,
      duration: primary.duration,
      variants: dedupedVariants,
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
    // Gig-uncached: zero cached variants on this song (and no drum loops, since
    // those are tiny and play instantly anyway). When body.gig-mode is on, CSS
    // hides these rows entirely so the user can't accidentally click a song
    // that would stall mid-song trying to stream from Drive.
    const hasCachedVariant = merged.variants.some(v => v.cached);
    row.className = `song-row ${isActive ? 'active' : ''} ${hasCachedVariant ? '' : 'gig-uncached'}`;
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
      // Play button always plays the preferred variant (-V-G m4a) with
      // autoplay. Row click does the same load WITHOUT autoplay.
      loadSong(preferredPlayVariant(merged), { autoplay: true });
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

    // Format chips: 5 fixed slots (STEMS, -V, -V-G, -V-G-B, DO) that line up
    // column-by-column with the header filter buttons. Missing variants get
    // an invisible placeholder so the columns stay aligned across rows.
    // Extras (Logic, drum loops, unknown variant codes) wrap to a second row.
    const formatCell = document.createElement('div');
    formatCell.className = 'song-format-cell';

    const stemsVariant = merged.variants.find(v => v.type === 'stems');

    const SLOT_CODES = ['STEMS', '-V', '-V-G', '-V-G-B', 'DO'];
    const slotVariant = code => {
      if (code === 'STEMS') return merged.variants.find(v => v.type === 'stems');
      return merged.variants.find(v => v.type !== 'stems' && v.variantCode === code);
    };

    const makeVariantChip = (v) => {
      const chip = document.createElement('button');
      const isStems = v.type === 'stems';
      const cachedCls = v.cached ? ' chip-cached' : '';
      const activeCls = currentSong && currentSong.id === v.id ? ' chip-active' : '';
      chip.className = `format-chip ${isStems ? 'chip-stems' : 'chip-m4a'}${cachedCls}${activeCls}`;
      chip.title = v.cached
        ? `${v.variantLabel} — cached, plays instantly`
        : `${v.variantLabel} — NOT cached; click will fetch from Drive (may spin during gig)`;
      chip.dataset.variantId = v.id;
      // Label only — no leading icon. The chip IS the play button; an extra
      // glyph just steals pixels in the already-narrow Format column. STEMS
      // is identified by the green pill, m4a variants by their code.
      const label = isStems ? 'STEMS' : v.variantCode;
      // Keep a download glyph for uncached m4a (signals 'will spin'); other
      // states render the label only.
      if (!isStems && !v.cached) {
        chip.innerHTML = `<i data-lucide="download" style="width:9px;height:9px;"></i> ${label}`;
      } else {
        chip.textContent = label;
      }
      chip.addEventListener('click', e => {
        e.stopPropagation();
        loadSong(v, { autoplay: true });
      });
      return chip;
    };

    // Library rows used to show 5 variant chips (STEMS / -V / -V-G / -V-G-B /
    // DO) plus drum-loop chips. Every song is now treated as stems and the
    // mixdowns live only on Drive (EZPerformer reads them), so those chips
    // were noise — the green STEMS pill on every row, the Lundefined drum
    // chips for songs whose loops weren't in the cache. All removed.
    // Only the Logic chip stays, since it's a yellow indicator for a real
    // sibling artifact (the .logicx project) the user might want to open.
    const stemsForLogic = merged.variants.find(v => v.type === 'stems');
    if (stemsForLogic && stemsForLogic.logicProjectName && stemsForLogic.folderName) {
      const chip = document.createElement('button');
      chip.className = 'format-chip chip-logic';
      chip.title = `Open ${stemsForLogic.logicProjectName} in a new Logic Pro instance`;
      chip.innerHTML = '<i data-lucide="layers-3" style="width:10px;height:10px;"></i> Logic';
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        chip.disabled = true;
        try {
          const r = await fetch(`/api/song/${encodeURIComponent(stemsForLogic.folderName)}/open-in-logic`, { method: 'POST' });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'failed');
        } catch (err) {
          alert(`Couldn't open in Logic: ${err.message}`);
        } finally {
          setTimeout(() => { chip.disabled = false; }, 1500);
        }
      });
      formatCell.appendChild(chip);
    }

    // Action — Load button removed. Clicking the row loads the song (wired
    // below). Keep the ⋯ menu for song options.
    const actionCell = document.createElement('div');
    actionCell.className = 'col-action';
    actionCell.innerHTML = `<button class="btn-secondary song-menu-btn" title="Song options" style="padding:4px 8px;">⋯</button>`;
    // song_base = the stems folder name (canonical key for the per-song API)
    const stemsVar = merged.variants.find(v => v.type === 'stems');
    const songBase = stemsVar && stemsVar.folderName;
    const menuBtn = actionCell.querySelector('.song-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (songBase) openSongMenu(songBase, merged);
      else alert('This song has no stems folder yet — options apply to stemmed songs.');
    });

    row.appendChild(selectCell);
    row.appendChild(titleCell);
    row.appendChild(artistCell);
    row.appendChild(bpmCell);
    row.appendChild(keyCell);
    row.appendChild(formatCell);
    row.appendChild(actionCell);

    // Row click default: load the preferred variant (-V-G m4a usually) into
    // the player WITHOUT autoplay — the user can hit play, drop it in a
    // setlist, or click a different format chip from there.
    row.addEventListener('click', () => loadSong(preferredPlayVariant(merged)));

    els.songListBody.appendChild(row);
  });
  
  lucide.createIcons();
}

// ── Master volume (full-height right-rail slider) ──────────────────────────
function setupMasterVolume() {
  if (!els.masterVol) return;
  // Restore from localStorage on load so the master ride survives reload.
  try {
    const saved = localStorage.getItem('bt_master_volume');
    if (saved !== null) {
      const sv = parseFloat(saved);
      if (Number.isFinite(sv) && sv >= 0 && sv <= 1) {
        els.masterVol.value = sv;
      }
    }
  } catch (e) {}
  const apply = (persist) => {
    const v = parseFloat(els.masterVol.value);
    currentMasterVolume = v;
    if (masterGainNode && audioCtx) {
      masterGainNode.gain.setValueAtTime(v, audioCtx.currentTime);
    }
    applyMixerVolumes();
    if (els.masterVolPct) els.masterVolPct.textContent = `${Math.round(v * 100)}%`;
    if (persist) {
      try { localStorage.setItem('bt_master_volume', String(v)); } catch (e) {}
    }
  };
  els.masterVol.addEventListener('input', () => apply(true));
  apply(false);   // initialize label + apply without persisting (no change yet)
}

// ── Playhead persistence ────────────────────────────────────────────────
// Save the playback position every couple of seconds while playing AND on
// stop/pause. Keyed by song.id so each track resumes where you left it. On
// load, if a saved time exists for the song being loaded, seek there once
// the audio elements are ready.
let _playheadSaveTimer = null;
function savePlayhead() {
  if (!currentSong) return;
  const elArr = Object.values(audioElements).filter(a => audioHasSrc(a));
  if (!elArr.length) return;
  const t = elArr[0].currentTime;
  if (!Number.isFinite(t) || t < 0.1) return;
  try {
    const raw = localStorage.getItem('bt_playheads') || '{}';
    const map = JSON.parse(raw);
    map[currentSong.id] = t;
    // Cap the map at 200 entries so it doesn't grow forever.
    const keys = Object.keys(map);
    if (keys.length > 200) {
      for (let i = 0; i < keys.length - 200; i++) delete map[keys[i]];
    }
    localStorage.setItem('bt_playheads', JSON.stringify(map));
  } catch (e) {}
}
function restorePlayhead(songId) {
  try {
    const map = JSON.parse(localStorage.getItem('bt_playheads') || '{}');
    return typeof map[songId] === 'number' ? map[songId] : 0;
  } catch (e) { return 0; }
}
function startPlayheadSaver() {
  if (_playheadSaveTimer) return;
  _playheadSaveTimer = setInterval(savePlayhead, 2500);
}
function stopPlayheadSaverAndFlush() {
  if (_playheadSaveTimer) { clearInterval(_playheadSaveTimer); _playheadSaveTimer = null; }
  savePlayhead();
}

// ── Per-song options menu (metadata / re-fetch / delete) ───────────────────
async function openSongMenu(base, merged) {
  // Fetch full metadata
  let meta = {}, artifacts = {};
  try {
    const r = await fetch(`/api/song/${encodeURIComponent(base)}/metadata`);
    if (r.ok) { const d = await r.json(); meta = d.metadata || {}; artifacts = d.artifacts || {}; }
  } catch (e) {}

  const overlay = document.createElement('div');
  overlay.className = 'song-modal-overlay';
  const stemsList = (artifacts.stems || []).join(', ') || 'none';
  const m4aList = (artifacts.m4a || []).join(', ') || 'none';
  const srcSize = (artifacts.sourceBytes != null) ? humanBytes(artifacts.sourceBytes) : 'not present';

  // Render a metadata value: URL-valued fields become clickable links.
  const renderVal = (k, v) => {
    const s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    if (/^https?:\/\//.test(s)) {
      return `<a href="${escapeHtml(s)}" target="_blank" rel="noopener" class="meta-link">${escapeHtml(s)}</a>`;
    }
    return escapeHtml(s);
  };
  const metaRows = Object.entries(meta)
    .filter(([k]) => k !== 'processing')
    .map(([k, v]) => `<tr><td class="mk">${escapeHtml(k)}</td><td class="mv">${renderVal(k, v)}</td></tr>`)
    .join('') +
    `<tr><td class="mk">source.wav size</td><td class="mv">${escapeHtml(srcSize)}</td></tr>`;

  overlay.innerHTML = `
    <div class="song-modal glass-card">
      <div class="song-modal-head">
        <h3>${escapeHtml(meta.title || base)} <span class="song-modal-artist">${escapeHtml(meta.artist || '')}</span></h3>
        <button class="song-modal-close">✕</button>
      </div>

      <div class="song-modal-section">
        <label class="song-modal-label">Source URL — open the current one, or paste a better version and re-fetch:</label>
        <div class="song-modal-url-row">
          <input type="text" class="song-modal-url" value="${escapeHtml(meta.source_url || '')}" placeholder="https://www.youtube.com/watch?v=…">
          <button class="btn-secondary song-url-open" title="Open current URL in a new tab">↗ Open</button>
          <button class="btn-secondary song-refetch-btn">Re-fetch</button>
        </div>
        <div class="song-modal-note"></div>
      </div>

      <div class="song-modal-section">
        <details><summary>All metadata</summary>
          <div class="song-modal-artifacts">stems: ${escapeHtml(stemsList)}<br>m4a: ${escapeHtml(m4aList)}</div>
          <table class="song-modal-table">${metaRows}</table>
        </details>
      </div>

      <div class="song-modal-section">
        <label class="song-modal-label">Re-stem in Logic Pro (triggers Keyboard Maestro macro "simpleStem"):</label>
        <button class="btn-secondary song-logic-btn">↻ Re-stem in Logic</button>
        <div class="song-modal-logic-note"></div>
      </div>

      <div class="song-modal-section song-modal-danger">
        <label class="song-modal-label">Delete permanently (not reversible):</label>
        <button class="btn-secondary song-delete-btn">Delete this song</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.song-modal-close').addEventListener('click', close);

  // Open the current URL in a new tab (whatever is in the field right now)
  overlay.querySelector('.song-url-open').addEventListener('click', () => {
    const u = overlay.querySelector('.song-modal-url').value.trim();
    if (/^https?:\/\//.test(u)) window.open(u, '_blank', 'noopener');
    else alert('No valid URL to open.');
  });

  // Re-fetch
  const note = overlay.querySelector('.song-modal-note');
  overlay.querySelector('.song-refetch-btn').addEventListener('click', async () => {
    const url = overlay.querySelector('.song-modal-url').value.trim();
    if (!/^https?:\/\//.test(url)) { note.textContent = 'Enter a valid YouTube URL.'; return; }
    if (!confirm(`Re-fetch "${meta.title || base}" from the new URL? This deletes the current stems/m4a and re-downloads.`)) return;
    note.textContent = 'Clearing old artifacts and queueing re-fetch…';
    try {
      const r = await fetch(`/api/song/${encodeURIComponent(base)}/refetch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      note.textContent = d.note || 'Queued. The Librarian (mini) will download; then it re-stems.';
      fetchLibrary();
    } catch (e) { note.textContent = `Error: ${e.message}`; }
  });

  // Re-stem in Logic Pro — POST to the server, which sets KBM variables and
  // triggers the "simpleStem" macro. The macro owns the rest (open Logic,
  // run Stem Splitter, bounce m4as into M4A_DIR with the same filenames).
  const logicBtn = overlay.querySelector('.song-logic-btn');
  const logicNote = overlay.querySelector('.song-modal-logic-note');
  logicBtn.addEventListener('click', async () => {
    logicNote.textContent = 'Triggering Keyboard Maestro…';
    try {
      const r = await fetch(`/api/song/${encodeURIComponent(base)}/logic-restem`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      logicNote.textContent = `Macro "${d.macro}" triggered — Logic Pro should open shortly.`;
    } catch (e) { logicNote.textContent = `Error: ${e.message}`; }
  });

  // Delete — two-click confirm: first click arms it, second click within 4s
  // actually deletes. Avoids typing long concert titles while still being
  // deliberate (one stray click can't erase a song).
  const delBtn = overlay.querySelector('.song-delete-btn');
  let armed = false, armTimer = null;
  delBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = 'Click again to confirm delete';
      delBtn.classList.add('armed');
      armTimer = setTimeout(() => {
        armed = false;
        delBtn.textContent = 'Delete this song';
        delBtn.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    try {
      const r = await fetch(`/api/song/${encodeURIComponent(base)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: base })   // server still requires this
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      close();
      fetchLibrary();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
  });
}

// Client Side Search and Filters
function applyFilters() {
  const query = els.search.value.toLowerCase().trim();
  const format = document.querySelector('.filter-btn.active').id;
  const key = els.filterKey.value;
  const bpmRange = els.filterBpm.value;
  
  filteredLibrary = mergedLibrary.filter(song => {
    const hasStems = song.variants.some(v => v.type === 'stems');
    const titleMatch = song.title.toLowerCase().includes(query);
    const artistMatch = song.artist.toLowerCase().includes(query);
    const keyMatchStr = song.key && song.key.toLowerCase().includes(query);
    // "stems" keyword → songs with a full stem set available for live remix.
    const stemsMatch = hasStems && ('stems'.includes(query) && query.length >= 3);
    // BPM: a bare number matches within ±3; "128bpm"/"128 bpm" also accepted.
    let bpmMatch = false;
    const bpmQ = query.replace(/\s*bpm$/, '');
    if (/^\d{2,3}$/.test(bpmQ) && song.practiceBpm) {
      bpmMatch = Math.abs(song.practiceBpm - parseInt(bpmQ, 10)) <= 3;
    }
    const matchesQuery = !query || titleMatch || artistMatch || keyMatchStr || stemsMatch || bpmMatch;

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

    // Format-column variant filters: OR semantics — if any chip is active,
    // require the song to have at least one of the chips' variants.
    let matchesVariantChips = true;
    const activeChips = Object.entries(formatVariantFilters).filter(([, v]) => v).map(([k]) => k);
    if (activeChips.length) {
      matchesVariantChips = activeChips.some(code => {
        if (code === 'STEMS') return song.variants.some(v => v.type === 'stems');
        return song.variants.some(v => v.type === 'm4a' && v.variantCode === code);
      });
    }

    return matchesQuery && matchesFormat && matchesKey && matchesBpm && matchesVariantChips;
  });
  
  els.countLabel.textContent = `Found ${filteredLibrary.length} tracks matching filters`;
  renderLibrary();
}

// Initialize Web Audio graph
function initAudioCtx() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  // Expose for the visualizer (waveform peaks decode reuses this context
  // rather than spinning up its own).
  window.appAudioCtx = audioCtx;
  window.audioElements = audioElements;

  // Probe the OS audio device's output channel count. XR18 selected as the
  // system output reports 18. Anything > 2 unlocks the multi-channel routing
  // UI; <= 2 falls back to plain stereo (everything → channels 0-1).
  outputChannelCount = audioCtx.destination.maxChannelCount || 2;
  if (outputChannelCount > 2) {
    try {
      audioCtx.destination.channelCount = outputChannelCount;
      audioCtx.destination.channelCountMode = 'explicit';
      audioCtx.destination.channelInterpretation = 'discrete';
    } catch (e) {
      // Some browsers reject explicit multi-channel; fall back to stereo.
      console.warn('[audio] destination multi-channel setup rejected:', e.message);
      outputChannelCount = 2;
    }
  }

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;

  // ChannelMerger accumulates every routed signal; one input per output
  // channel. Stem sources connect into specific input indices to land on
  // specific physical channels.
  masterMerger = audioCtx.createChannelMerger(outputChannelCount);

  masterGainNode = audioCtx.createGain();
  if (els.masterVol) currentMasterVolume = parseFloat(els.masterVol.value);
  masterGainNode.gain.setValueAtTime(currentMasterVolume, audioCtx.currentTime);

  // BUG that audited the user's "channels 3-18 are silent" complaint:
  // every intermediate node defaults to channelCount = 2 + interpretation
  // = 'speakers', so an 18-channel signal entering the analyser was being
  // DOWNMIXED to stereo before it ever reached the destination, no matter
  // what destination.channelCount said. Force each intermediate node to
  // pass the full multi-channel signal through:
  if (outputChannelCount > 2) {
    for (const node of [analyserNode, masterGainNode]) {
      try {
        node.channelCount = outputChannelCount;
        node.channelCountMode = 'explicit';
        node.channelInterpretation = 'discrete';
      } catch (e) {
        console.warn('[audio] could not set multi-channel on intermediate:', e.message);
      }
    }
  }
  console.log(`[audio] graph initialized — outputChannelCount=${outputChannelCount}, destination.channelCount=${audioCtx.destination.channelCount}, maxChannelCount=${audioCtx.destination.maxChannelCount}`);

  // Graph: [stem sources] → splitter → masterMerger → analyser → masterGain → destination
  masterMerger.connect(analyserNode);
  analyserNode.connect(masterGainNode);
  masterGainNode.connect(audioCtx.destination);

  Object.keys(audioElements).forEach(chan => {
    const ae = audioElements[chan];
    const source = audioCtx.createMediaElementSource(ae);
    const stripGain = audioCtx.createGain();  // pre-split gain (mute/solo
                                              // applied via ae.volume; this
                                              // is a placeholder for future
                                              // per-strip routing gain).
    const splitter = audioCtx.createChannelSplitter(2);
    source.connect(stripGain);
    stripGain.connect(splitter);
    stripNodes[chan] = { source, stripGain, splitter };
    trackSources[chan] = source;
  });

  loadRoutingMatrix();
  applyRouting();

  initVisualizer(analyserNode);
}

// ── Multi-channel routing helpers ─────────────────────────────────────────

// Routing matrix v2: a flat sorted list of selected output channel indices
// per stem. `routingMatrix[chan] = [0, 1]` means "stereo to Out 1-2".
// `[0, 1, 2, 3, 4, 5]` means "6 channels selected; alternate L/R" — L goes
// to even-positioned entries (0, 2, 4), R goes to odd-positioned (1, 3, 5),
// so the selection [0..5] fans L→1,3,5 and R→2,4,6. Single-channel selection
// sums L+R to mono. Lets the user click any combination of channels and get
// a sensible result.
function loadRoutingMatrix() {
  routingMatrix = {};
  Object.keys(audioElements).forEach(ch => {
    routingMatrix[ch] = [0, 1];
  });
  try {
    const raw = localStorage.getItem(ROUTING_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    Object.keys(audioElements).forEach(ch => {
      if (Array.isArray(stored[ch])) {
        routingMatrix[ch] = stored[ch]
          .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < outputChannelCount)
          .sort((a, b) => a - b);
        if (!routingMatrix[ch].length) routingMatrix[ch] = [0, 1];
      }
    });
  } catch (e) {}
}

function saveRoutingMatrix() {
  try { localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(routingMatrix)); } catch (e) {}
}

function applyRouting() {
  if (!masterMerger || !stripNodes) return;
  Object.values(stripNodes).forEach(s => {
    try { s.splitter.disconnect(); } catch (e) {}
  });
  Object.entries(routingMatrix).forEach(([chan, routes]) => {
    const s = stripNodes[chan];
    if (!s || !routes.length) return;
    const sorted = [...routes].sort((a, b) => a - b);
    if (sorted.length === 1) {
      // Single channel selected → fold L+R into that channel as mono sum.
      const out = sorted[0];
      if (out < outputChannelCount) {
        try { s.splitter.connect(masterMerger, 0, out); } catch (e) {}
        try { s.splitter.connect(masterMerger, 1, out); } catch (e) {}
      }
    } else {
      // ≥2 channels: even-positioned selections receive L, odd-positioned
      // receive R. Selection [0,1,2,3,4,5] → L→0,2,4 / R→1,3,5 — exactly the
      // "three amps per side from 6 AUX channels" pattern.
      sorted.forEach((out, i) => {
        if (out >= outputChannelCount) return;
        try { s.splitter.connect(masterMerger, i % 2 === 0 ? 0 : 1, out); } catch (e) {}
      });
    }
  });
}

function toggleStripChannel(chan, channelIdx) {
  const current = routingMatrix[chan] || [];
  const filtered = current.filter(c => c !== channelIdx);
  if (filtered.length === current.length) filtered.push(channelIdx);
  filtered.sort((a, b) => a - b);
  routingMatrix[chan] = filtered;
  saveRoutingMatrix();
  applyRouting();
  renderRoutingGrids();
}

function presetSpreadToSixAux() {
  Object.keys(audioElements).forEach(ch => {
    routingMatrix[ch] = [0, 1, 2, 3, 4, 5].filter(i => i < outputChannelCount);
  });
  saveRoutingMatrix();
  applyRouting();
  renderRoutingGrids();
}

// ── Sidebar splitter ──────────────────────────────────────────────────────
// Drag the 6px bar between the sidebar and the main content to resize the
// left pane. Width persists in localStorage. Double-click to reset to the
// 760px default. Bounded [280, 1000] so the layout can never break.
const SIDEBAR_WIDTH_KEY = 'simpleStem.sidebarWidth';
const SIDEBAR_WIDTH_DEFAULT = 760;
const SIDEBAR_WIDTH_MIN = 280;
const SIDEBAR_WIDTH_MAX = 1000;

function setupSidebarSplitter() {
  const splitter = document.getElementById('sidebar-splitter');
  if (!splitter) return;
  let saved = SIDEBAR_WIDTH_DEFAULT;
  try { saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || `${SIDEBAR_WIDTH_DEFAULT}`, 10); } catch (e) {}
  applySidebarWidth(saved);

  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.classList.add('splitter-dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    applySidebarWidth(e.clientX);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.classList.remove('splitter-dragging');
    // Persist final width
    const w = parseInt(document.documentElement.style.getPropertyValue('--sidebar-width') || `${SIDEBAR_WIDTH_DEFAULT}`, 10);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch (e) {}
  });
  splitter.addEventListener('dblclick', () => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_WIDTH_DEFAULT)); } catch (e) {}
  });
}

function applySidebarWidth(px) {
  const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, px));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
}

// ── Click track ──────────────────────────────────────────────────────────
// Song-synced metronome. Replaces the old setInterval-driven version that
// drifted from the actual playback timeline. New approach:
//   - rAF poll reads audioElement.currentTime every frame
//   - look-ahead window (200ms) — for each beat in that window we haven't
//     scheduled yet, schedule an oscillator click at the matching
//     AudioContext.currentTime + offset
//   - silent while song is paused; re-syncs after a seek (lastScheduledBeat
//     resets when currentTime jumps backward)
//
// Result: every audible click lands ON one of the vertical beat markers
// drawn on the waveform. Easy for a musician to replace the studio drums
// in their head by playing along with the visual + audible grid.
let clickEnabled = false;
let clickLastScheduledBeat = -1;
let clickLastSongTime = 0;

function setupClickTrack() {
  const btn = document.getElementById('btn-click-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    clickEnabled = !clickEnabled;
    btn.classList.toggle('active', clickEnabled);
    if (clickEnabled) {
      initAudioCtx();
      clickLastScheduledBeat = -1;
      clickLastSongTime = 0;
      clickSchedulerTick();
    }
  });
}

function clickSchedulerTick() {
  if (!clickEnabled) return;
  requestAnimationFrame(clickSchedulerTick);
  if (!audioCtx || !masterGainNode) return;

  // Pick the audio element that's currently driving playback.
  let songTime = null;
  for (const ch of CHANNELS) {
    const ae = audioElements[ch];
    if (ae && ae.src && !ae.paused) { songTime = ae.currentTime; break; }
  }
  if (songTime == null) return;

  // Seek detection: if the song time jumped backwards, reset our
  // 'already-scheduled' cursor so future events fire again.
  if (songTime < clickLastSongTime - 0.1) clickLastScheduledBeat = -1;
  clickLastSongTime = songTime;

  const LOOKAHEAD_SEC = 0.2;

  // Onset-based scheduling: the visualizer detected actual amplitude
  // spikes in the song; each one is a transient (drum hit, vocal
  // attack, etc) and gets a click. Falls back to BPM grid when onsets
  // aren't computed yet or are too sparse to be useful.
  const onsets = window.songOnsetTimes;
  const useOnsets = Array.isArray(onsets) && onsets.length > 16;

  if (useOnsets) {
    // Binary-search for the next onset >= songTime
    let lo = 0, hi = onsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (onsets[mid] < songTime) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < onsets.length && onsets[i] < songTime + LOOKAHEAD_SEC; i++) {
      if (i > clickLastScheduledBeat) {
        const delay = onsets[i] - songTime;
        if (delay >= -0.01) {
          // Treat every 4th onset as a 'downbeat' so the click has rhythmic
          // texture even when the spikes are unevenly spaced.
          fireClickAt(audioCtx.currentTime + Math.max(delay, 0), i % 4 === 0);
        }
        clickLastScheduledBeat = i;
      }
    }
    return;
  }

  // Fallback: BPM grid (original behavior)
  const bpm = (currentSong && currentSong.practiceBpm) || 120;
  const beatSec = 60 / bpm;
  let beatIdx = Math.floor(songTime / beatSec);
  while (beatIdx * beatSec < songTime + LOOKAHEAD_SEC) {
    if (beatIdx > clickLastScheduledBeat) {
      const beatTime = beatIdx * beatSec;
      const delay = beatTime - songTime;
      if (delay >= -0.01) {
        fireClickAt(audioCtx.currentTime + Math.max(delay, 0), beatIdx % 4 === 0);
      }
      clickLastScheduledBeat = beatIdx;
    }
    beatIdx++;
  }
}

function fireClickAt(when, downbeat) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = downbeat ? 1800 : 1200;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(downbeat ? 0.35 : 0.22, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  osc.connect(gain);
  // Route through master gain so the click obeys master volume; lands on
  // outputs 0-1 regardless of stem channel routing so the click always
  // reaches the monitor mix.
  gain.connect(masterGainNode);
  osc.start(when);
  osc.stop(when + 0.08);
}

// ── Format-column variant filters ────────────────────────────────────────
// STEM / -V / -V-G / -V-G-B / DO toggle pills in the FORMAT header.
// Active → solid green. Multi-select with OR (show songs that have any
// of the selected variants). Click an active button to turn it off.
function setupFormatFilters() {
  document.querySelectorAll('.ff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code;
      formatVariantFilters[code] = !formatVariantFilters[code];
      btn.classList.toggle('active', formatVariantFilters[code]);
      filterLibrary();
    });
  });
}

function presetStereoMain() {
  Object.keys(audioElements).forEach(ch => {
    routingMatrix[ch] = [0, 1];
  });
  saveRoutingMatrix();
  applyRouting();
  renderRoutingGrids();
}

// ── Routing UI ────────────────────────────────────────────────────────────
// Injects a routing button into each channel strip (`Out 1-2` / `Outs 1-2,3-4`).
// Click → popover with one checkbox per output pair (1-2 ... 17-18). Toggling
// re-applies routing immediately so the user can hear it.
function setupRoutingUI() {
  // The first user click on the page is what we wait on; AudioContext requires
  // a gesture before it'll show maxChannelCount, so the routing UI doesn't
  // populate until we know how many channels we have. Re-render on each load.
  document.addEventListener('click', maybeInitRoutingUI, { once: false });
}

let routingUIReady = false;
function maybeInitRoutingUI() {
  if (!audioCtx || !masterMerger) return;
  if (!routingUIReady) {
    routingUIReady = true;
    injectStripRoutingButtons();
    renderRoutingButtons();
  }
  // Always re-render the header info — channel count may have changed since
  // last init (e.g. user plugged in the XR18 mid-session). injectMixerHeaderInfo
  // is idempotent and now self-syncs outputChannelCount from the live
  // destination.channelCount.
  injectMixerHeaderInfo();
}

function injectMixerHeaderInfo() {
  const header = document.querySelector('.mixer-header');
  if (!header) return;
  // Always re-render — channel count can change after the initial init if
  // the user plugged in a multi-channel device after the audio context
  // started, or if they hit the re-probe button.
  let info = header.querySelector('.routing-info');
  if (!info) {
    info = document.createElement('div');
    info.className = 'routing-info';
    header.appendChild(info);
  }
  // Re-read the destination channel count live, then sync the module-scope
  // variable so the rest of the routing code (applyRouting, etc.) sees the
  // current truth.
  const liveCount = (audioCtx && audioCtx.destination && audioCtx.destination.channelCount) || outputChannelCount || 2;
  if (liveCount !== outputChannelCount) {
    outputChannelCount = liveCount;
  }
  if (outputChannelCount <= 2) {
    info.innerHTML = `
      <button class="routing-tag stereo-only routing-reprobe" title="Click to re-probe the audio device for available channels">
        Stereo only · device gives ${outputChannelCount} channel${outputChannelCount === 1 ? '' : 's'} · click to re-probe
      </button>
    `;
  } else {
    info.innerHTML = `
      <button class="routing-tag multi routing-reprobe" title="Click to re-probe the audio device for available channels">${outputChannelCount} ch out · re-probe</button>
      <button class="btn-secondary routing-preset-stereo" title="All stems → Out 1-2 only">Preset: Stereo</button>
      <button class="btn-secondary routing-preset-spread" title="Each stem fans to outputs 1-2, 3-4, and 5-6 (three amp aux sends)">Preset: Spread to 6 AUX</button>
    `;
  }
  const ps = info.querySelector('.routing-preset-stereo');
  const pS = info.querySelector('.routing-preset-spread');
  const reprobe = info.querySelector('.routing-reprobe');
  if (ps) ps.addEventListener('click', presetStereoMain);
  if (pS) pS.addEventListener('click', presetSpreadToSixAux);
  if (reprobe) reprobe.addEventListener('click', reprobeAudioDevice);
}

// Force the audio context to re-evaluate the destination's maximum channel
// count, set destination.channelCount accordingly, and re-render the routing
// UI. Use this after plugging in a new audio device (XR18, etc.) so the
// portal picks it up without a full page reload.
async function reprobeAudioDevice() {
  if (!audioCtx) {
    console.warn('[reprobe] no audio context yet — click play once first');
    return;
  }
  try {
    const mx = audioCtx.destination.maxChannelCount || 2;
    // Try to bump the destination channel count to whatever the device says
    // it can do. This is the moment Web Audio normally only sets at graph
    // creation; setting it again here forces the runtime to re-allocate
    // output buffers if the device changed.
    if (mx > 2) {
      try { audioCtx.destination.channelCount = mx; }
      catch (e) { console.warn('[reprobe] destination.channelCount set failed:', e.message); }
    }
    outputChannelCount = audioCtx.destination.channelCount || 2;
    // Re-sync intermediate nodes so they don't downmix to stereo.
    if (outputChannelCount > 2) {
      for (const node of [analyserNode, masterGainNode]) {
        if (!node) continue;
        try {
          node.channelCount = outputChannelCount;
          node.channelCountMode = 'explicit';
          node.channelInterpretation = 'discrete';
        } catch (e) { /* ignore */ }
      }
    }
    // Re-render the badge AND the routing button grids (the latter will
    // show more buttons live if more channels just became available).
    injectMixerHeaderInfo();
    applyRouting();
    renderRoutingGrids();
    console.log(`[reprobe] device now ${outputChannelCount} channels`);
  } catch (e) {
    console.warn('[reprobe] failed:', e.message);
  }
}

function injectStripRoutingButtons() {
  // Always render the 3×6 routing grid so the band can configure stems-to-XR18
  // routing even when the laptop is currently on the built-in 2-ch output.
  // Buttons for channels above outputChannelCount are visibly disabled but
  // remain present — they activate the moment an 18-ch device is plugged in.
  document.querySelectorAll('.channel-strip').forEach(strip => {
    if (strip.querySelector('.strip-routing-grid')) return;
    const chan = stripChannelName(strip);
    if (!chan) return;
    const grid = document.createElement('div');
    grid.className = 'strip-routing-grid';
    grid.dataset.chan = chan;
    // 3 rows × 6 cols = 18 channel buttons. Click each to toggle. Selected
    // buttons appear solid green; unselected are outline. Below the grid a
    // tiny line shows the resolved L/R routing for debugging the alternating
    // rule ("L→1,3,5  R→2,4,6").
    // Output channels 11-16 carry the "natural" stem assignment for the band's
    // XR18 split. Show the SINGLE LETTER instead of the number so each button
    // is one big, glanceable character: V D B G P O. Channels 1-10 and 17-18
    // keep their numbers.
    //   11 → V (Vocals)   12 → D (Drums)   13 → B (Bass)
    //   14 → G (Guitar)   15 → P (Piano)   16 → O (Other)
    // Channels 1-2 are the stereo main L/R pair. Channels 11-16 are the
    // natural per-instrument outs on the XR18 split. All others stay
    // numeric. The single-letter labels render bold via .srg-letter.
    const CHAN_LETTER = {
      1: 'L', 2: 'R',
      11: 'V', 12: 'D', 13: 'B', 14: 'G', 15: 'P', 16: 'O'
    };
    const LETTER_MEANS = {
      L: 'Stereo Left', R: 'Stereo Right',
      V: 'Vocals', D: 'Drums', B: 'Bass',
      G: 'Guitar', P: 'Piano', O: 'Other',
    };
    let html = '';
    for (let i = 0; i < 18; i++) {
      const num = i + 1;
      const letter = CHAN_LETTER[num];
      const label = letter || `${num}`;
      const cls = letter ? 'srg-btn srg-letter' : 'srg-btn';
      const title = `Output channel ${num}${letter ? ' (' + letter + ' = ' + LETTER_MEANS[letter] + ')' : ''}`;
      html += `<button class="${cls}" data-ch="${i}" title="${title}">${label}</button>`;
    }
    grid.innerHTML = `
      <div class="srg-grid">${html}</div>
      <div class="srg-summary" data-chan="${chan}"></div>
    `;
    grid.querySelectorAll('.srg-btn[data-ch]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleStripChannel(chan, parseInt(btn.dataset.ch, 10));
      });
    });
    strip.appendChild(grid);
  });
}

function stripChannelName(strip) {
  for (const ch of Object.keys(audioElements)) {
    if (strip.classList.contains(`${ch}-strip`)) return ch;
  }
  return null;
}

function renderRoutingGrids() {
  document.querySelectorAll('.strip-routing-grid').forEach(grid => {
    const chan = grid.dataset.chan;
    const routes = routingMatrix[chan] || [];
    grid.querySelectorAll('.srg-btn[data-ch]').forEach(btn => {
      const ch = parseInt(btn.dataset.ch, 10);
      btn.classList.toggle('active', routes.includes(ch));
    });
    const sum = grid.querySelector('.srg-summary');
    if (sum) sum.textContent = summarizeRouting(routes);
  });
}

function summarizeRouting(routes) {
  if (!routes || !routes.length) return 'unrouted';
  const sorted = [...routes].sort((a, b) => a - b);
  if (sorted.length === 1) return `mono → Out ${sorted[0] + 1}`;
  const ls = []; const rs = [];
  sorted.forEach((o, i) => (i % 2 === 0 ? ls : rs).push(o + 1));
  return `L→${ls.join(',')}   R→${rs.join(',')}`;
}

// Alias: legacy call sites still use renderRoutingButtons; route them to the
// new grid renderer.
function renderRoutingButtons() { renderRoutingGrids(); }

// Load song into the mixer
function loadSong(song, opts) {
  opts = opts || {};
  initAudioCtx();
  rememberLastVariantCode(song);

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
  // Drum-loop variants are meant to repeat forever — engage loop mode by
  // default. For everything else, reset to non-looping (the user can opt in
  // via the loop button if they want).
  isLooping = !!song.isDrumLoop;
  if (els.btnLoop) els.btnLoop.classList.toggle('active', isLooping);
  
  // Restore master gain to the user's slider level (undoes any prior fade-out
  // without overriding the volume they've set on the right-rail slider).
  currentMasterVolume = els.masterVol ? parseFloat(els.masterVol.value) : 1.0;
  masterGainNode.gain.setValueAtTime(currentMasterVolume, audioCtx.currentTime);

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

  // Expose currentSong for the visualizer (beat-grid uses song.practiceBpm).
  window.currentSong = song;
  // Load this song's MIDI automation so the lane shows its markers and the
  // dispatcher fires events during playback.
  loadAutomationForSong(songBaseOf(song));
  // Kick off server-side precache so subsequent plays of this song are
  // hot. Fire-and-forget; the audio elements still drive the immediate
  // first-play stream. This dramatically reduces the cold-fetch wait for
  // the NEXT song the user clicks if it's already in a setlist.
  const songBaseForPrecache = songBaseOf(song);
  if (songBaseForPrecache) {
    fetch(`/api/precache/stems/${encodeURIComponent(songBaseForPrecache)}`, { method: 'POST' })
      .catch(() => {});
  }
  // Render variant picker (Source: STEMS / -V-G-B / -V-G / DO ...)
  renderVariantPicker(song);
  // Refresh sidebar setlist toggle (+/- depends on whether currentSong is
  // in the active setlist).
  if (typeof renderSidebarSetlist === 'function') renderSidebarSetlist();
  // Recompute waveform peaks for the visualizer. For stems songs we send
  // EVERY stem's URL so the visualizer can decode each one and combine
  // only the currently-audible ones on each render frame (so mute/solo
  // /fader changes are reflected in the envelope). For m4a tracks there's
  // a single source.
  if (typeof window.setWaveformStems === 'function') {
    if (song.type === 'm4a' && song.fileName) {
      window.setWaveformStems({ __m4a__: `/api/audio/m4a/${encodeURIComponent(song.fileName)}` });
    } else if (song.type === 'stems' && song.folderName && song.stems) {
      const sources = {};
      for (const ch of CHANNELS) {
        const fn = song.stems[ch];
        if (fn) sources[ch] = `/api/audio/stems/${song.folderName}/${fn}`;
      }
      if (Object.keys(sources).length) window.setWaveformStems(sources);
    }
  }

  els.trackTitle.textContent = song.title;
  els.trackArtist.textContent = song.artist;
  els.activeBpm.textContent = song.practiceBpm || '--';
  els.activeKey.textContent = song.key || '--';
  if (els.activeKeySignature) {
    els.activeKeySignature.textContent = song.keySignature ? `(${song.keySignature})` : '';
  }
  // Drum pattern pill — metadata.drum_pattern is an opaque string the
  // librarian writes (e.g. "120@96" → BPM 120 on TR-808 pattern 96). Show
  // it next to BPM/Key only when present; otherwise hide the pill entirely.
  const drumPillEl = document.getElementById('active-meta-drum');
  const drumValEl  = document.getElementById('active-drum-value');
  const drumPattern = song.drum_pattern || song.drumPattern || '';
  if (drumPillEl && drumValEl) {
    if (drumPattern) {
      drumValEl.textContent = drumPattern;
      drumPillEl.style.display = '';
    } else {
      drumPillEl.style.display = 'none';
    }
  }
  
  // Set all tracks to non-loop browser-wise to prevent wrap stutter
  Object.values(audioElements).forEach(ae => {
    ae.loop = false;
  });

  // Restore last-saved playhead for this song. Hooks loadedmetadata once on
  // the first track that gets a src so we know its duration is known and
  // currentTime assignment will stick. Falls back to 0 (start) when there's
  // no saved value or the saved time exceeds the loaded duration.
  const restoreTo = restorePlayhead(song.id);
  if (restoreTo > 0) {
    let restored = false;
    Object.values(audioElements).forEach(ae => {
      if (restored || !audioHasSrc(ae)) return;
      const onMeta = () => {
        if (restored) return;
        const target = Math.min(restoreTo, (ae.duration || 0) - 0.5);
        if (target > 0) {
          Object.values(audioElements).forEach(other => {
            if (audioHasSrc(other)) other.currentTime = target;
          });
        }
        restored = true;
        ae.removeEventListener('loadedmetadata', onMeta);
      };
      ae.addEventListener('loadedmetadata', onMeta);
      if (ae.readyState >= 1) onMeta();   // already loaded
    });
  }
  
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
      // Synced Jam Loops pane is disabled — loops are managed in the Loop
      // Library tab now. Keep the section hidden regardless of song.loops.
      els.loopsContainer.style.display = 'none';
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
// Drum-loop chips that used to live here are gone — loops are managed in
// the Loop Library tab where the cache state is explicit.
function renderVariantPicker(currentVariant) {
  // All songs are stems now — the source picker is retired. Keep the function
  // (legacy call sites still invoke it) but force the pane hidden and bail.
  const picker = document.getElementById('variant-picker');
  if (picker) picker.style.display = 'none';
  return;
  // The original variant-rendering logic below is unreachable. Left in place
  // until we're sure no future flow needs to bring it back.
  // eslint-disable-next-line no-unreachable
  const chipsEl = document.getElementById('variant-picker-chips');
  if (!picker || !chipsEl) return;

  let merged = mergedLibrary.find(m => m.variants.some(v => v.id === currentVariant.id));
  if (!merged && currentVariant.parentBase) {
    merged = mergedLibrary.find(m => {
      const sv = m.variants.find(v => v.type === 'stems');
      return sv && sv.folderName === currentVariant.parentBase;
    });
  }
  if (!merged || merged.variants.length <= 1) {
    picker.style.display = 'none';
    return;
  }

  picker.style.display = 'flex';
  chipsEl.innerHTML = '';
  merged.variants.forEach(v => {
    const btn = document.createElement('button');
    const isStems = v.type === 'stems';
    const cachedCls = v.cached ? 'chip-cached' : '';
    btn.className = `variant-chip ${isStems ? 'chip-stems' : 'chip-m4a'} ${cachedCls} ${v.id === currentVariant.id ? 'chip-active' : ''}`;
    const icon = isStems ? 'sliders' : (v.cached ? 'play' : 'download');
    const code = isStems ? 'STEMS' : v.variantCode;
    btn.innerHTML = `<i data-lucide="${icon}" style="width:12px;height:12px;"></i> ${code}`;
    btn.title = v.cached
      ? `${v.variantLabel} — cached, plays instantly`
      : `${v.variantLabel} — NOT cached; click will fetch from Drive`;
    btn.addEventListener('click', () => loadSong(v));
    chipsEl.appendChild(btn);
  });

  lucide.createIcons();
}

// Per-channel inline loop buttons used to sit on each strip (1 2 3 4) and
// triggered Drive-side loop fetches that caused spinning-disk stalls during
// playback. We now DISABLE this row entirely — loops are managed only from
// the Loop Library tab (where the cache-on-add behavior makes spinning
// unavoidable until the file is on local disk). The .channel-loops divs
// stay in the DOM for layout continuity but receive no buttons.
function renderChannelLoopButtons(loops) {
  LOOP_CAPABLE_CHANNELS.forEach(chan => {
    const container = document.querySelector(`.channel-loops[data-channel="${chan}"]`);
    if (container) container.innerHTML = '';
  });
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
  // Auto-save the timeline if the user accumulated actions during this play
  // and didn't hit SAVE ACTIONS. The user explicitly asked for end-of-song
  // auto-save in addition to the manual button.
  if (automationCurrentBase && automationDirty) {
    saveAutomationForSong(automationCurrentBase, automationEvents)
      .catch(err => console.warn('[automation] auto-save on song end failed:', err));
  }
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

    // Gig setlist auto-advance: if we're in setlist-playback mode, jump to
    // the next song in that setlist. Otherwise fall through to the legacy
    // flat-setlist planner (Setlist tab).
    if (gigPlayingSetlistIdx != null) {
      advanceGigSetlistPlayback();
    } else {
      playNextInSetlist();
    }
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
    stopPlayheadSaverAndFlush();
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
    startPlayheadSaver();
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
  // Persist final playhead before audios get torn down + ;src cleared below.
  stopPlayheadSaverAndFlush();

  // Abort any in-flight loop/audio fetches so a slow Drive read doesn't
  // keep blocking the UI after Stop is pressed. See abortInFlightFetches
  // for what gets cancelled.
  abortInFlightFetches();

  Object.values(audioElements).forEach(ae => {
    try {
      ae.pause();
      ae.currentTime = 0;
      // Clearing the src tears down any pending HTTP request the element
      // had open — the browser cancels rather than waits for Drive to
      // finish responding.
      ae.removeAttribute('src');
      ae.load();
    } catch (e) { /* ignore */ }
  });

  // Stop any combo-of-loops playback from the Loop Library sequence.
  stopCombo();
  if (drumLoopAudio) {
    try { drumLoopAudio.pause(); drumLoopAudio.removeAttribute('src'); drumLoopAudio.load(); }
    catch (e) {}
    drumLoopPlayingId = null;
  }

  els.timeline.value = 0;
  els.timelineFill.style.width = '0%';
  els.timeCurrent.textContent = '0:00';

  applyMixerVolumes();
  lucide.createIcons();
}

// AbortController shared by precache + cache-status fetches so a single
// Stop press can cancel everything Drive-bound that's still in flight.
let driveFetchAbort = new AbortController();
function abortInFlightFetches() {
  try { driveFetchAbort.abort(); } catch (e) {}
  driveFetchAbort = new AbortController();
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
  // Master volume is applied as a multiplier on every element's own volume.
  // This rides the same HTMLMediaElement.volume path the per-stem faders use
  // (which is proven to work), so the master control is reliable regardless of
  // Web Audio graph quirks. clamp to [0,1].
  const master = Math.max(0, Math.min(1, currentMasterVolume));

  const m4aMode = currentSong && currentSong.type === 'm4a';
  if (m4aMode) {
    Object.keys(audioElements).forEach(chan => {
      audioElements[chan].volume = (chan === 'drums') ? master : 0;
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

    ae.volume = targetVolume * master;
    
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
   VERSION / SELF-UPDATE
   Shows the running version; if a newer VERSION has synced to disk,
   reveals an Update button that restarts the Performer into it.
   ========================================== */
function setupVersionWatch() {
  if (els.btnUpdate) els.btnUpdate.addEventListener('click', applyUpdate);
  checkVersion();
  setInterval(checkVersion, 30000);   // poll every 30s
}

async function checkVersion() {
  if (!els.versionRunning) return;
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const v = await res.json();
    // Version string already carries its own prefix (V1.MMDDHHMM); don't
    // re-prefix with a lowercase 'v' the way the older YYMMDD:HHMM format did.
    const stamp = String(v.running || '');
    const stampAvail = String(v.available || '');
    els.versionRunning.textContent = stamp;
    document.title = `simpleStem ${stamp}`;
    const brandV = document.getElementById('brand-version');
    if (brandV) brandV.textContent = stamp;
    if (els.btnUpdate) {
      if (v.updateAvailable) {
        els.btnUpdate.style.display = 'inline-flex';
        els.btnUpdate.title = `Update available: ${stamp} → ${stampAvail} (restart to apply)`;
        if (els.updateLabel) els.updateLabel.textContent = `Update → ${stampAvail}`;
      } else {
        els.btnUpdate.style.display = 'none';
      }
    }
  } catch (e) { /* server may be restarting; keep last shown */ }
}

async function applyUpdate() {
  if (!confirm('Restart the Performer to apply the update? Playback will stop briefly.')) return;
  if (els.updateLabel) els.updateLabel.textContent = 'Restarting…';
  els.btnUpdate.disabled = true;
  try {
    await fetch('/api/update', { method: 'POST' });
  } catch (e) { /* the server is going down — expected */ }
  // Poll until the server answers again, then reload into the new version.
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (r.ok) { clearInterval(poll); location.reload(); }
    } catch (e) { /* still down */ }
    if (tries > 40) { clearInterval(poll); els.updateLabel.textContent = 'Restart timed out'; els.btnUpdate.disabled = false; }
  }, 1000);
}

/* ==========================================
   SAVED SETLISTS PANEL (Librarian-maintained)
   Playlist-synced + manual SetLists from /api/setlists.
   ========================================== */

function setupSetlistsPanel() {
  if (els.btnRefreshSetlists) els.btnRefreshSetlists.addEventListener('click', loadSetlistsList);
  if (els.btnSaveSetlist) els.btnSaveSetlist.addEventListener('click', saveCurrentSetlist);
  loadSetlistsList();
}

async function loadSetlistsList() {
  if (!els.setlistsList) return;
  try {
    const res = await fetch('/api/setlists');
    const data = await res.json();
    const lists = (data && data.setlists) || [];
    if (lists.length === 0) {
      els.setlistsList.innerHTML = '<span class="setlists-empty">No saved SetLists yet.</span>';
      return;
    }
    // Cache saved-setlist metadata for the sidebar panel (YTSYNC detection)
    if (typeof _cacheSavedSetlistMeta === 'function') _cacheSavedSetlistMeta(lists);
    els.setlistsList.innerHTML = '';
    lists.forEach(sl => {
      const row = document.createElement('div');
      row.className = 'setlist-chip';
      const isPlaylist = sl.origin === 'playlist';
      const badge = isPlaylist
        ? '<span class="sl-badge sl-yt" title="Synced from a YouTube playlist"><i data-lucide="youtube" style="width:11px;height:11px;"></i> sync</span>'
        : '<span class="sl-badge sl-manual" title="Hand-curated; never auto-changed">manual</span>';
      // Manual setlists get a small × to remove them. Playlist-synced ones don't
      // (deleting one would just re-sync on the next pass — own the source instead).
      const deleteBtn = isPlaylist ? '' :
        '<button class="sl-delete-btn" title="Delete this SetList" aria-label="Delete">×</button>';
      // Gig-readiness badge: how many of this setlist's songs are fully
      // cached locally. All-cached → solid green check. Partial → yellow
      // 'X/N' counter. None → grey 'N' so the user knows to either save
      // it (auto-precache fires on save) or hit the refresh button.
      const total = sl.count;
      const ready = sl.cached_count || 0;
      let cacheBadge;
      if (total === 0) {
        cacheBadge = `<span class="sl-cache sl-cache-empty" title="No songs in this SetList">0</span>`;
      } else if (ready >= total) {
        cacheBadge = `<span class="sl-cache sl-cache-ready" title="All ${total} songs cached locally — gig-safe">✓ ${total}</span>`;
      } else {
        cacheBadge = `<span class="sl-cache sl-cache-partial" title="${ready} of ${total} songs cached; rest will fetch from Drive">${ready}/${total}</span>`;
      }
      row.innerHTML =
        `<button class="sl-load-btn" title="Load &quot;${escapeHtml(sl.title)}&quot; (${total} songs; ${ready} cached) into the planner">` +
        `${badge}<span class="sl-title">${escapeHtml(sl.title)}</span>` +
        `${cacheBadge}` +
        `</button>${deleteBtn}`;
      row.querySelector('.sl-load-btn').addEventListener('click', () => loadSetlistIntoPlanner(sl.slug));
      const delEl = row.querySelector('.sl-delete-btn');
      if (delEl) {
        delEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete SetList "${sl.title}" (${sl.count} songs)? The songs themselves stay in the library.`)) return;
          try {
            const r = await fetch(`/api/setlists/${encodeURIComponent(sl.slug)}`, { method: 'DELETE' });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'failed');
            loadSetlistsList();
          } catch (err) { alert(`Couldn't delete: ${err.message}`); }
        });
      }
      els.setlistsList.appendChild(row);
    });
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    els.setlistsList.innerHTML = `<span class="setlists-empty">Couldn't load SetLists (${escapeHtml(e.message)})</span>`;
  }
}

// Resolve a saved SetList's ordered songs to merged-library entries and load
// them into the existing planner. Songs match by song_base (the canonical key);
// playlist songs not yet rendered are shown as pending and skipped from playback.
async function loadSetlistIntoPlanner(slug) {
  try {
    const res = await fetch(`/api/setlists/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error((await res.json()).error || 'not found');
    const sl = await res.json();

    // Index the merged library by song_base for O(1) lookup.
    const byBase = new Map();
    for (const m of mergedLibrary) {
      const sv = m.variants.find(v => v.type === 'stems') || m.primary;
      if (sv && sv.folderName) byBase.set(sv.folderName, m);
    }

    setlist = [];
    let pending = 0;
    (sl.songs || []).forEach((entry, i) => {
      const base = entry.song_base;
      const merged = base ? byBase.get(base) : null;
      if (merged) {
        const primary = merged.primary;
        setlist.push({ ...primary, setlistItemId: `setlist-${primary.id}-${Date.now()}-${Math.random().toString(36).slice(2,6)}` });
      } else {
        // Not yet stemmed — add a greyed, non-playable placeholder so the set
        // looks complete and fills in as the batch renders.
        pending++;
        setlist.push({
          id: `pending-${slug}-${i}`,
          setlistItemId: `pending-${slug}-${i}-${Date.now()}`,
          title: entry.title || '(pending)',
          artist: entry.artist || '',
          duration: 0,
          pending: true,
          pendingStatus: entry.status || 'queued',
        });
      }
    });

    if (els.setlistName) els.setlistName.value = sl.title || '';
    saveSetlistToLocalStorage();
    renderSetlist();
    updateLibraryCheckboxes();

    if (pending > 0 && els.setlistStatsLabel) {
      els.setlistStatsLabel.textContent += ` · ${pending} pending (stemming)`;
    }

    // Warm the local cache for this setlist's ready songs in the background.
    fetch(`/api/precache/setlist/${encodeURIComponent(slug)}`, { method: 'POST' }).catch(() => {});
  } catch (e) {
    console.warn('loadSetlist failed:', e);
    alert(`Couldn't load SetList: ${e.message}`);
  }
}

// Save the current planner as a MANUAL SetList (server refuses to overwrite a
// playlist-synced one). Stores by song_base so it survives across rescans.
async function saveCurrentSetlist() {
  if (!setlist.length) { alert('Setlist is empty — add songs first.'); return; }
  const title = (els.setlistName && els.setlistName.value.trim()) ||
    prompt('Name this SetList:') || '';
  if (!title.trim()) return;

  // Map each planner item back to its song_base via the merged library.
  const bases = [];
  for (const item of setlist) {
    const merged = mergedLibrary.find(m => m.variants.some(v => v.id === item.id));
    const sv = merged && (merged.variants.find(v => v.type === 'stems') || merged.primary);
    if (sv && sv.folderName) bases.push(sv.folderName);
  }
  if (!bases.length) { alert('These songs have no stem folders to reference yet.'); return; }

  try {
    const res = await fetch('/api/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), songs: bases })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'save failed');
    // Auto-precache: a saved setlist is by definition the songs you intend
    // to play, so warm ~/.bt-cache for all of them in the background. The
    // server returns immediately and copies async; loadSetlistsList polling
    // below picks up the cached_count growing.
    fetch(`/api/precache/setlist/${encodeURIComponent(data.slug)}`, { method: 'POST' })
      .catch(() => { /* best-effort; UI keeps polling */ });
    loadSetlistsList();
    // Re-poll the setlists list a few times so the cached_count counter
    // visibly catches up while precache runs (~30s on a typical setlist).
    let polls = 0;
    const pollTimer = setInterval(() => {
      polls++;
      loadSetlistsList();
      if (polls >= 6) clearInterval(pollTimer);
    }, 10000);
  } catch (e) {
    alert(`Couldn't save: ${e.message}`);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function humanBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
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
  if (typeof renderSidebarSetlist === 'function') renderSidebarSetlist();
}

function removeFromSetlist(songId) {
  setlist = setlist.filter(item => item.id !== songId);
  saveSetlistToLocalStorage();
  renderSetlist();
  updateLibraryCheckboxes();
  if (typeof renderSidebarSetlist === 'function') renderSidebarSetlist();
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
    // Pending (not-yet-stemmed) song: greyed, non-playable placeholder.
    if (item.pending) {
      const card = document.createElement('div');
      card.className = 'setlist-item setlist-item-pending';
      card.dataset.index = index;
      card.innerHTML = `
        <span class="setlist-item-num">${index + 1}.</span>
        <div class="setlist-item-details">
          <span class="setlist-item-title">${escapeHtml(item.title)}</span>
          <span class="setlist-item-artist">${escapeHtml(item.artist || '')}
            <span class="tag tag-pending" style="padding:1px 5px;font-size:8px;">${item.pendingStatus === 'rendering' ? 'rendering…' : 'queued'}</span>
          </span>
        </div>
        <span class="setlist-item-time" title="Not yet stemmed">⏳</span>`;
      container.appendChild(card);
      return;
    }

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

  // Mixer-only collapse: keep the player section visible (title/BPM/key
  // remain) but hide the visualizer, timeline, source picker, and faders.
  // Useful when you've configured the mix and just need a heads-up display.
  const btnCollapseMixer = document.getElementById('btn-collapse-mixer');
  if (btnCollapseMixer) {
    const sect = els.playerHeroSection;
    const sync = () => {
      const collapsed = sect && sect.classList.contains('mixer-collapsed');
      btnCollapseMixer.innerHTML = collapsed
        ? `<i data-lucide="chevrons-down"></i>`
        : `<i data-lucide="chevrons-up"></i>`;
      btnCollapseMixer.title = collapsed ? 'Expand mixer' : 'Collapse mixer (keep title/BPM/key)';
      if (window.lucide) lucide.createIcons();
    };
    btnCollapseMixer.addEventListener('click', () => {
      if (!sect) return;
      sect.classList.toggle('mixer-collapsed');
      localStorage.setItem('bt_mixer_collapsed', sect.classList.contains('mixer-collapsed') ? '1' : '0');
      sync();
    });
    if (localStorage.getItem('bt_mixer_collapsed') === '1' && sect) {
      sect.classList.add('mixer-collapsed');
    }
    sync();
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
    // Reset Faders is the "back to normal" button — also pull every stem's
    // multi-channel routing back to stereo (chans 1+2) so unusual aux
    // spreads from earlier experiments don't keep silencing the main mix.
    if (typeof presetStereoMain === 'function' && outputChannelCount > 2) {
      presetStereoMain();
    }
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

// Wall clock — animated analog SVG (hour/minute/second hands) plus a small
// digital readout next to it. Both sit in #player-top-bar at the top-right
// of the main pane, persistent across idle/active player states.
function startWallClock() {
  const hourHand = document.getElementById('clock-hour');
  const minHand  = document.getElementById('clock-min');
  const secHand  = document.getElementById('clock-sec');
  const digital  = document.getElementById('analog-clock-digital');
  // Legacy text element kept hidden — also update it so anything still
  // reading wall-clock.textContent continues to work.
  const legacyEl = document.getElementById('wall-clock');
  if (!hourHand && !legacyEl) return;
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const tick = () => {
    const d = new Date();
    const s = d.getSeconds();
    const m = d.getMinutes();
    const h = d.getHours() % 12;
    // 360° / 12h = 30°/hr; 360/60 = 6°/min and 6°/sec. Add fractional
    // contributions so the hour/minute hands creep smoothly between ticks.
    const secAngle  = s * 6;
    const minAngle  = m * 6 + s * 0.1;
    const hourAngle = h * 30 + m * 0.5;
    if (secHand)  secHand.style.transform  = `rotate(${secAngle}deg)`;
    if (minHand)  minHand.style.transform  = `rotate(${minAngle}deg)`;
    if (hourHand) hourHand.style.transform = `rotate(${hourAngle}deg)`;
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    const h12  = h === 0 ? 12 : h;
    const mm   = m < 10 ? `0${m}` : `${m}`;
    const text = `${days[d.getDay()]} ${h12}:${mm} ${ampm}`;
    if (digital) digital.textContent = text;
    if (legacyEl) legacyEl.textContent = `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}  ${h12}:${mm} ${ampm}`;
  };
  tick();
  setInterval(tick, 1000); // 1s — animates the seconds hand smoothly
}

// Utility formattings (secs -> MM:SS)
function formatTime(secs) {
  if (isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ── MIDI automation ─────────────────────────────────────────────────────────
// Per-song MIDI events that fire as the playhead crosses their timestamps.
// Events live in the song's metadata.json under .automation. The portal lets
// the user click on the lane below the visualizer to drop new events; a small
// modal lets them pick Program Change / CC, channel, value, etc. At playback
// time a 30Hz polling loop reads the master audio element's currentTime and
// posts any newly-crossed events to /api/midi/send → midi_sidecar.py → wire.
//
// Device → port-name mapping. The sidecar matches by substring (case
// insensitive) against the OS's MIDI output ports. The Helix shows up as
// "HX Stomp" / "Helix" / "Helix Native" on USB-C. Logic Pro receives via
// the IAC Driver bus the user has set up in Audio MIDI Setup. XR18 shows up
// as "XR18" over USB.
const MIDI_PORT_FOR_DEVICE = { helix: 'helix', logic: 'IAC', xr18: 'XR18' };

let automationEvents      = [];   // [{t, device, type, channel, ..., label, fired}]
let automationLastTime    = 0;    // for forward-only event firing
let automationDispatchTimer = null;
let automationEditingIdx  = null; // null = adding; otherwise index into events
let automationCurrentBase = null; // which song's events we're showing
// In-memory edits no longer auto-save. The user explicitly commits via SAVE
// ACTIONS or the song-end auto-save. `automationDirty` tracks whether the
// current in-memory state differs from what's persisted in metadata.json.
let automationDirty       = false;
let automationLastSavedJSON = '[]';  // canonical snapshot to compare against

async function loadAutomationForSong(songBase) {
  automationCurrentBase = songBase;
  automationLastTime = 0;
  if (!songBase) {
    automationEvents = [];
    automationLastSavedJSON = '[]';
    automationDirty = false;
    renderAutomationLane();
    refreshAutomationToolbar();
    return;
  }
  try {
    const r = await fetch(`/api/song/${encodeURIComponent(songBase)}/automation`);
    const d = await r.json();
    const events = d.automation || [];
    automationEvents = events.map(e => ({ ...e, fired: false }));
    automationLastSavedJSON = JSON.stringify(events);
  } catch (e) {
    automationEvents = [];
    automationLastSavedJSON = '[]';
  }
  automationDirty = false;
  renderAutomationLane();
  refreshAutomationToolbar();
}

async function saveAutomationForSong(songBase, events) {
  // Strip the transient `fired` flag before sending.
  const clean = events.map(({ fired, ...rest }) => rest);
  const r = await fetch(`/api/song/${encodeURIComponent(songBase)}/automation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ automation: clean }),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'save failed');
  const d = await r.json();
  const saved = d.automation || [];
  automationEvents = saved.map(e => ({ ...e, fired: false }));
  automationLastSavedJSON = JSON.stringify(saved);
  automationDirty = false;
  renderAutomationLane();
  refreshAutomationToolbar();
}

// Updates the lane toolbar — counter, "● unsaved" dot, button enable states.
// Called whenever the in-memory event list changes.
function refreshAutomationToolbar() {
  const counter = document.getElementById('midi-lane-counter');
  const dirty   = document.getElementById('midi-lane-dirty');
  const saveBtn = document.getElementById('midi-btn-save-actions');
  const clearBtn = document.getElementById('midi-btn-clear-actions');
  if (!counter) return;
  counter.textContent = `${automationEvents.length} action${automationEvents.length === 1 ? '' : 's'}`;
  if (dirty)  dirty.style.display = automationDirty ? '' : 'none';
  if (saveBtn) saveBtn.disabled = !automationCurrentBase || !automationDirty;
  if (clearBtn) clearBtn.disabled = !automationCurrentBase || automationEvents.length === 0;
}

// Mark the in-memory event list as differing from what's on disk. Triggered
// by adds, deletes, drags, and modal commits. Cheap JSON compare so the dot
// reliably clears when the user undoes their changes manually.
function markAutomationDirty() {
  const cleanNow = automationEvents.map(({ fired, ...rest }) => rest);
  const nowJSON = JSON.stringify(cleanNow);
  automationDirty = (nowJSON !== automationLastSavedJSON);
  refreshAutomationToolbar();
}

function songDurationSec() {
  // Try the master audio first (most accurate), fall back to currentSong's
  // duration field. Returns 0 if we don't know yet.
  try {
    const tracks = Object.keys(audioElements || {}).filter(k => audioHasSrc(audioElements[k]));
    if (tracks.length) {
      const d = audioElements[tracks[0]].duration;
      if (d && isFinite(d) && d > 0) return d;
    }
  } catch (e) {}
  if (currentSong && currentSong.duration_sec) return currentSong.duration_sec;
  return 0;
}

// Map stem name → block letter shown on a mute/unmute marker.
const STEM_LETTER = { vocals: 'V', drums: 'D', bass: 'B', guitar: 'G', piano: 'P', other: 'O' };
const LETTER_STEM = Object.fromEntries(Object.entries(STEM_LETTER).map(([k,v]) => [v.toLowerCase(), k]));

// What single letter does this event display on its marker?
//   PC / CC → M (MIDI)
//   mute / unmute → V/D/B/G/P/O for the affected stem
//   fade → F
function eventTypeLetter(e) {
  if (e.type === 'mute' || e.type === 'unmute') return STEM_LETTER[e.stem] || '?';
  if (e.type === 'fade') return 'F';
  return 'M';
}

// CSS class suffix so the marker can be color-coded by type.
function eventClass(e) {
  if (e.type === 'mute')   return 'evt-mute';
  if (e.type === 'unmute') return 'evt-unmute';
  if (e.type === 'fade')   return 'evt-fade';
  return 'evt-midi';
}

// One-line description for the tooltip.
function eventSummary(e) {
  if (e.type === 'pc')      return `MIDI PC ${e.program} ch${e.channel} → ${e.device || '?'}`;
  if (e.type === 'cc')      return `MIDI CC ${e.controller}=${e.value} ch${e.channel} → ${e.device || '?'}`;
  if (e.type === 'mute')    return `MUTE ${e.stem}`;
  if (e.type === 'unmute')  return `UNMUTE ${e.stem}`;
  if (e.type === 'fade')    return `FADE ${e.stem} ${e.from}→${e.to} over ${e.duration}s`;
  return e.type || 'event';
}

function renderAutomationLane() {
  const lane = document.getElementById('midi-lane');
  const markers = document.getElementById('midi-lane-markers');
  if (!lane || !markers) return;
  markers.innerHTML = '';
  const dur = songDurationSec();
  if (!dur) return;
  automationEvents.forEach((e, idx) => {
    const pct = (e.t / dur) * 100;
    if (pct < 0 || pct > 100) return;
    const node = document.createElement('div');
    node.className = `midi-event-marker ${eventClass(e)}` + (e.fired ? ' fired' : '');
    node.style.left = pct + '%';
    node.dataset.idx = String(idx);
    const letter = eventTypeLetter(e);
    const tip = `${e.label ? e.label + ' · ' : ''}${eventSummary(e)} @ ${e.t.toFixed(2)}s`;
    node.innerHTML = `<span class="midi-event-letter">${letter}</span><span class="midi-event-tip">${escapeHtml(tip)}</span>`;
    attachMarkerHandlers(node, idx);
    markers.appendChild(node);
  });
  refreshAutomationToolbar();
}

// Click vs drag detection: track mousedown position + distance moved. A
// click within a few pixels and 250 ms opens the edit modal; anything
// further is a drag that updates the event's `t`. Drag works horizontally
// across the lane and live-snaps to the lane width.
function attachMarkerHandlers(node, idx) {
  let downX = 0, downT = 0, dragging = false, startTime = 0;
  const lane = document.getElementById('midi-lane');
  node.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    downX = ev.clientX;
    downT = Date.now();
    dragging = false;
    startTime = automationEvents[idx]?.t || 0;
    const onMove = (mv) => {
      const dx = mv.clientX - downX;
      if (!dragging && Math.abs(dx) < 3) return;
      dragging = true;
      const dur = songDurationSec();
      const r = lane.getBoundingClientRect();
      const newT = Math.max(0, Math.min(dur, startTime + (dx / r.width) * dur));
      automationEvents[idx].t = Math.round(newT * 100) / 100;
      // Reposition just this marker without re-rendering the whole lane.
      node.style.left = ((automationEvents[idx].t / dur) * 100) + '%';
      const tip = node.querySelector('.midi-event-tip');
      if (tip) tip.textContent = tip.textContent.replace(/@ [\d.]+s$/, `@ ${automationEvents[idx].t.toFixed(2)}s`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) {
        automationEvents.sort((a, b) => a.t - b.t);
        renderAutomationLane();
        markAutomationDirty();
      } else if (Date.now() - downT < 250) {
        openMidiModal(idx);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function currentPlayheadSec() {
  try {
    const tracks = Object.keys(audioElements || {}).filter(k => audioHasSrc(audioElements[k]));
    if (tracks.length) return audioElements[tracks[0]].currentTime || 0;
  } catch (e) {}
  // Fall back to slider position scaled by known duration
  const dur = songDurationSec();
  const pct = parseFloat(document.getElementById('player-timeline').value) || 0;
  return (pct / 100) * dur;
}

function openMidiModal(idx) {
  const modal = document.getElementById('midi-modal');
  if (!modal) return;
  automationEditingIdx = (idx === null || idx === undefined) ? null : idx;
  let e;
  if (automationEditingIdx === null) {
    e = {
      t: currentPlayheadSec(),
      device: 'helix', type: 'pc', channel: 4,
      program: 0, controller: 7, value: 100, label: '',
    };
    document.getElementById('midi-modal-title').textContent = 'Add MIDI Event';
    document.getElementById('midi-btn-delete').style.display = 'none';
  } else {
    e = automationEvents[automationEditingIdx];
    document.getElementById('midi-modal-title').textContent = 'Edit MIDI Event';
    document.getElementById('midi-btn-delete').style.display = 'inline-block';
  }
  document.getElementById('midi-f-time').value     = Number(e.t || 0).toFixed(2);
  document.getElementById('midi-f-device').value   = e.device || 'helix';
  document.getElementById('midi-f-type').value     = e.type   || 'pc';
  document.getElementById('midi-f-channel').value  = e.channel || 4;
  document.getElementById('midi-f-program').value  = e.program ?? 0;
  document.getElementById('midi-f-controller').value = e.controller ?? 7;
  document.getElementById('midi-f-value').value    = e.value ?? 100;
  document.getElementById('midi-f-label').value    = e.label || '';
  const stemSel = document.getElementById('midi-f-stem');
  if (stemSel) stemSel.value = e.stem || 'vocals';
  midiModalTypeChanged();
  modal.style.display = 'flex';
  document.getElementById('midi-modal-status').textContent = '';
  document.getElementById('midi-modal-status').className = 'midi-modal-status';
}

function closeMidiModal() {
  const m = document.getElementById('midi-modal');
  if (m) m.style.display = 'none';
  automationEditingIdx = null;
}

function midiModalTypeChanged() {
  const t = document.getElementById('midi-f-type').value;
  const isStem = (t === 'mute' || t === 'unmute');
  const isNote = (t === 'note_on' || t === 'note_off');
  document.querySelectorAll('.midi-row-pc').forEach(n => n.style.display = t === 'pc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-cc').forEach(n => n.style.display = t === 'cc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-cc-preset').forEach(n => n.style.display = t === 'cc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-note').forEach(n => n.style.display = isNote ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-stem').forEach(n => n.style.display = isStem ? 'grid' : 'none');
  // MIDI-only fields hide for stem actions (no wire involved).
  document.querySelectorAll('.midi-row').forEach(row => {
    const lbl = row.querySelector('label')?.textContent;
    if (!lbl) return;
    if (isStem && (lbl === 'Device' || lbl === 'Channel')) row.style.display = 'none';
    else if (!isStem && lbl === 'Device') row.style.display = 'grid';
    else if (!isStem && lbl === 'Channel') row.style.display = 'grid';
  });
  // Label suggestion: prefill for stem actions so the user doesn't have to.
  if (isStem) {
    const labelEl = document.getElementById('midi-f-label');
    const stem = document.getElementById('midi-f-stem')?.value || 'vocals';
    if (!labelEl.value || /^(mute|unmute) /.test(labelEl.value)) {
      labelEl.value = `${t} ${stem}`;
    }
  }
}

function readMidiModalForm() {
  const type = document.getElementById('midi-f-type').value;
  const out = {
    t: parseFloat(document.getElementById('midi-f-time').value) || 0,
    type,
    label: document.getElementById('midi-f-label').value.trim(),
  };
  if (type === 'pc' || type === 'cc' || type === 'note_on' || type === 'note_off') {
    out.device  = document.getElementById('midi-f-device').value;
    out.channel = parseInt(document.getElementById('midi-f-channel').value, 10) || 1;
    if (type === 'pc') {
      out.program = parseInt(document.getElementById('midi-f-program').value, 10) || 0;
    } else if (type === 'cc') {
      out.controller = parseInt(document.getElementById('midi-f-controller').value, 10) || 0;
      out.value      = parseInt(document.getElementById('midi-f-value').value, 10) || 0;
    } else {
      out.note     = parseInt(document.getElementById('midi-f-note').value, 10) || 60;
      out.velocity = parseInt(document.getElementById('midi-f-velocity').value, 10) || 100;
    }
  } else if (type === 'mute' || type === 'unmute') {
    out.stem = document.getElementById('midi-f-stem').value;
  }
  return out;
}

// Keyboard shortcut: while a song is loaded, V/D/B/G/P/O record a stem
// mute/unmute event at the current playhead. Events accumulate in memory
// only — the user commits with SAVE ACTIONS, or playback's `ended` handler
// auto-saves when the song reaches the end.
//
// Toggle logic: look at the most recent event for the same stem at or
// before the current playhead. If the most recent is mute, the new event
// is unmute; otherwise mute.
function recordStemToggleAtPlayhead(stem) {
  if (!automationCurrentBase) return;
  const t = currentPlayheadSec();
  let lastType = null;
  for (const e of automationEvents) {
    if ((e.type === 'mute' || e.type === 'unmute') && e.stem === stem && e.t <= t + 0.01) {
      lastType = e.type;
    }
  }
  const next = (lastType === 'mute') ? 'unmute' : 'mute';
  const ev = { t, type: next, stem, label: `${next} ${stem}`, fired: true };
  automationEvents.push(ev);
  automationEvents.sort((a, b) => a.t - b.t);
  renderAutomationLane();
  markAutomationDirty();
  // Fire immediately so the audible state matches the dropped marker.
  fireAutomationEvent(ev).catch(()=>{});
}

function setupStemHotkeys() {
  const map = { v: 'vocals', d: 'drums', b: 'bass', g: 'guitar', p: 'piano', o: 'other' };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Don't fire when typing in an input/select/textarea/contenteditable.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
                tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    const stem = map[e.key.toLowerCase()];
    if (!stem) return;
    if (!automationCurrentBase) return;   // no song loaded → ignore
    e.preventDefault();
    recordStemToggleAtPlayhead(stem);
  });
}

// Single entry point used by the dispatcher. Routes by type:
//   pc / cc    → MIDI sidecar (out over wire to Helix/Logic/XR18)
//   mute       → flip mixerState.muted[stem] on, repaint mute button
//   unmute     → flip mixerState.muted[stem] off, repaint
//   fade       → stub for now; ramps come later
async function fireAutomationEvent(e) {
  if (e.type === 'mute' || e.type === 'unmute') {
    const stem = e.stem;
    if (!stem || !(stem in (mixerState.muted || {}))) return;
    const want = (e.type === 'mute');
    if (mixerState.muted[stem] !== want) {
      mixerState.muted[stem] = want;
      if (typeof applyMixerVolumes === 'function') applyMixerVolumes();
      if (typeof saveMixerState === 'function') saveMixerState();
      const btn = document.getElementById(`mute-${stem}`);
      if (btn) btn.classList.toggle('active', want);
    }
    return;
  }
  if (e.type === 'pc' || e.type === 'cc') {
    return sendMidiNow(e);
  }
  // 'fade' is not yet implemented — ramps come in a future iteration.
}

async function sendMidiNow(event) {
  // Translate device key → port substring the sidecar can match.
  const portNeedle = MIDI_PORT_FOR_DEVICE[event.device] || event.device || '';
  const body = { port: portNeedle, type: event.type, channel: event.channel };
  if (event.type === 'pc') body.program = event.program;
  else if (event.type === 'cc') { body.controller = event.controller; body.value = event.value; }
  const r = await fetch('/api/midi/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function setupMidiUI() {
  const lane = document.getElementById('midi-lane');
  if (!lane) return;
  lane.addEventListener('click', (e) => {
    if (e.target.closest('.midi-event-marker')) return;
    const r = lane.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    const dur = songDurationSec();
    if (!dur) return;
    const t = Math.max(0, Math.min(dur, pct * dur));
    openMidiModal(null);
    document.getElementById('midi-f-time').value = t.toFixed(2);
  });

  document.getElementById('midi-f-type').addEventListener('change', midiModalTypeChanged);
  // CC quick-pick: when the user selects a common controller from the
  // preset dropdown, write it into the Controller field. They can still
  // edit it afterward.
  const ccPreset = document.getElementById('midi-f-cc-preset');
  if (ccPreset) {
    ccPreset.addEventListener('change', () => {
      if (!ccPreset.value) return;
      document.getElementById('midi-f-controller').value = ccPreset.value;
      // Auto-fill a label from the preset's display text.
      const labelEl = document.getElementById('midi-f-label');
      const text = ccPreset.options[ccPreset.selectedIndex].textContent;
      if (!labelEl.value) labelEl.value = text.split('—').slice(1).join('—').trim() || `CC ${ccPreset.value}`;
    });
  }
  document.getElementById('midi-btn-cancel').addEventListener('click', closeMidiModal);
  document.querySelector('#midi-modal .midi-modal-backdrop').addEventListener('click', closeMidiModal);

  // Modal "Save" commits the event into the IN-MEMORY list only. The
  // user explicitly persists via the SAVE ACTIONS button on the lane
  // toolbar, or the song-end auto-save handles it. This matches how the
  // user described the workflow: build up the timeline live, then commit.
  document.getElementById('midi-btn-save').addEventListener('click', () => {
    if (!automationCurrentBase) {
      const s = document.getElementById('midi-modal-status');
      s.textContent = 'No song loaded.';
      s.className = 'midi-modal-status error';
      return;
    }
    const ev = readMidiModalForm();
    if (automationEditingIdx === null) automationEvents.push(ev);
    else automationEvents[automationEditingIdx] = ev;
    automationEvents.sort((a, b) => a.t - b.t);
    renderAutomationLane();
    markAutomationDirty();
    closeMidiModal();
  });

  document.getElementById('midi-btn-delete').addEventListener('click', () => {
    if (automationEditingIdx === null) return;
    automationEvents.splice(automationEditingIdx, 1);
    renderAutomationLane();
    markAutomationDirty();
    closeMidiModal();
  });

  // Lane toolbar — SAVE ACTIONS commits in-memory events to metadata.json;
  // CLEAR ACTIONS wipes them (and saves the empty list so the wipe sticks).
  document.getElementById('midi-btn-save-actions').addEventListener('click', async () => {
    if (!automationCurrentBase) return;
    try {
      await saveAutomationForSong(automationCurrentBase, automationEvents);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  });
  document.getElementById('midi-btn-clear-actions').addEventListener('click', async () => {
    if (!automationCurrentBase) return;
    if (!confirm(`Clear all ${automationEvents.length} action(s) on this song's timeline?`)) return;
    automationEvents = [];
    renderAutomationLane();
    markAutomationDirty();
    try {
      await saveAutomationForSong(automationCurrentBase, []);
    } catch (err) {
      alert(`Clear-save failed: ${err.message}. Local state cleared but disk still has old events.`);
    }
  });

  document.getElementById('midi-btn-test').addEventListener('click', async () => {
    const ev = readMidiModalForm();
    const s = document.getElementById('midi-modal-status');
    try {
      const r = await sendMidiNow(ev);
      if (r.ok) {
        s.textContent = `sent to ${r.sent_to}`;
        s.className = 'midi-modal-status ok';
      } else {
        s.textContent = `error: ${r.error || 'unknown'}` +
          (r.available ? ` (ports: ${r.available.join(', ') || 'none'})` : '');
        s.className = 'midi-modal-status error';
      }
    } catch (err) {
      s.textContent = `send failed: ${err.message}`;
      s.className = 'midi-modal-status error';
    }
  });

  // Playhead-driven dispatcher. 30 Hz is enough for tight cueing without
  // hammering the sidecar. Re-renders the lane only when an event fires (so
  // the marker turns green). Seek-back resets `fired` flags for events past
  // the new position so they fire again when crossed.
  automationDispatchTimer = setInterval(() => {
    if (!automationEvents.length) return;
    let masterAe = null;
    try {
      const tracks = Object.keys(audioElements || {}).filter(k => audioHasSrc(audioElements[k]));
      if (tracks.length) masterAe = audioElements[tracks[0]];
    } catch (e) {}
    if (!masterAe || masterAe.paused) return;
    const now = masterAe.currentTime;
    if (now + 0.05 < automationLastTime) {
      automationEvents.forEach(e => { if (e.t >= now) e.fired = false; });
      renderAutomationLane();
    }
    let anyFired = false;
    for (const e of automationEvents) {
      if (!e.fired && e.t > automationLastTime && e.t <= now) {
        fireAutomationEvent(e).catch(err => console.warn('[automation] fire failed:', err));
        e.fired = true;
        anyFired = true;
      }
    }
    automationLastTime = now;
    if (anyFired) renderAutomationLane();
  }, 33);
}
