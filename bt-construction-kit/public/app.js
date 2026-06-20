// Backing Track Construction Kit - Client Application Engine

// State management
let songLibrary = [];   // raw entries from server (one per file/folder)
let mergedLibrary = []; // grouped: one entry per song with .variants array

// Library checkboxes feed into this Set. Each checked row's stems-folder
// name (song_base) goes in; clicking the green + button in the active
// gig-sidebar setlist commits every entry to the setlist at once, then
// the Set + checkboxes are cleared. Pattern: check 10 AC/DC songs at the
// top of a practice gig, click +, all 10 join the setlist + precache.
const batchSelectedBases = new Set();
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
  soloed:  { vocals: false, drums: false, bass: false, guitar: false, piano: false, other: false },
  // Per-strip boost in dB. 0 (off), 5, or 10. Mutually exclusive — selecting
  // +5 turns off +10 and vice versa, clicking the same selection again turns
  // boost off. Riding stripGain so it stays consistent with the LOOPER path.
  boost:   { vocals: 0, drums: 0, bass: 0, guitar: 0, piano: 0, other: 0 },
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
  btnGoBeginning: document.getElementById('btn-go-beginning'),
  btnGoNext: document.getElementById('btn-go-next'),
  btnLoop: document.getElementById('btn-loop-toggle'),
  speedSlider: document.getElementById('speed-slider'),
  speedDisplay: document.getElementById('speed-display'),
  speedPresets: document.querySelectorAll('.preset-btn'),
  
  // Mixer
  mixerContainer: document.getElementById('mixer-container'),
  // btnResetMixer removed when the Reset Faders button was deleted.
  
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
  // Flip the user-gesture flag on the FIRST real input. Web Audio needs a
  // gesture before audioCtx.destination.maxChannelCount reports the actual
  // device channel count (XR18 → 18, not 2). loadSong checks this flag and
  // defers initAudioCtx() until after the first gesture, so auto-restore on
  // boot doesn't trap us in a frozen 2-channel context.
  const markGesture = () => { window.__hadUserGesture = true; };
  ['pointerdown','keydown','touchstart'].forEach(ev =>
    window.addEventListener(ev, markGesture, { once: true, capture: true })
  );
  fetchLibrary();
  setupEventListeners();
  setupDrumMachineButton();
  setupUrlLoopPanel();
  setupSamplerPanel();
  setupClipQuickModalOnce();
  loadSetlistFromLocalStorage();
  loadMixerState();
  startWallClock();
  startCacheStatusPoll();
  setupQueueUI();
  setupSetlistsPanel();
  setupVersionWatch();
  setupMasterVolume();
  setupVizModeToggle();
  // Kick the visualizer's render loop now — DON'T wait for initAudioCtx
  // (which is deferred until first user gesture). Without this the canvas
  // stays the HTML default 300x150 with zero pixels drawn until the user
  // clicks play. Passing null for the analyser is fine; the analyser is
  // only used for live-FFT mode which we don't currently render — peaks
  // come from setWaveformStems() decoding the per-stem audio files.
  try { initVisualizer(null); } catch (e) { console.warn('[viz] eager init failed:', e); }
  try { setupSectionDividerKeyboard(); } catch (e) { console.warn('[section] kbd setup failed:', e); }
  setupTabs();
  setupAiSetlistBuilder();
  setupDrumLoopsTab();
  setupLoopSequenceUI();
  setupGigMode();
  setupRollups();
  setupGigSidebar();
  setupRoutingUI();
  setupFormatFilters();
  setupClickTrack();
  loadPitchState();
  setupPitchKnobs();
  try { setupMidiUI(); } catch (e) { console.warn('[midi] setup failed:', e); }
  try { setupStemHotkeys(); } catch (e) { console.warn('[hotkeys] setup failed:', e); }
  // Section LOOPER button — toggle the section-loop on/off
  const looperBtn = document.getElementById('btn-section-looper');
  if (looperBtn) looperBtn.addEventListener('click', toggleSectionLooper);

  // Count-in toggle. State is per-song; flips immediately and saves to
  // metadata.json so the next play of this song honors it.
  const countInBtn = document.getElementById('btn-count-in-toggle');
  if (countInBtn) countInBtn.addEventListener('click', async () => {
    if (!automationCurrentBase) return;
    automationCountIn = !automationCountIn;
    refreshCountInButton();
    markAutomationDirty();
    try {
      await saveAutomationForSong(automationCurrentBase, automationEvents);
    } catch (e) {
      console.warn('[count-in] save failed:', e);
    }
  });
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

const GIG_ACTIVE_SLUG_KEY     = 'simpleStem.activeGigSlug';
const ACTIVE_SETLIST_IDX_KEY  = 'simpleStem.activeSetlistIdx';
const LAST_SONG_BASE_KEY      = 'simpleStem.lastSongBase';

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
const RECENTS_GIG_SLUG         = '__recents__';
const FAVORITES_GIG_SLUG       = '__favorites__';
// Per-singer + RoundRobin pseudo-gigs. Each one is a single read-only setlist
// filtered from mergedLibrary by singer_lead. RoundRobin alternates singers
// so any one of them gets to step away briefly without dead air.
const BILL_GIG_SLUG  = '__bill_songs__';
const MATT_GIG_SLUG  = '__matt_songs__';
const DAN_GIG_SLUG   = '__dan_songs__';
const JD_GIG_SLUG    = '__jd_songs__';
const ROUND_ROBIN_GIG_SLUG = '__round_robin__';
const SINGER_GIG_MAP = {
  [BILL_GIG_SLUG]: 'Bill',
  [MATT_GIG_SLUG]: 'Matt',
  [DAN_GIG_SLUG]:  'Dan',
  [JD_GIG_SLUG]:   'JD',
};
const SYNTHETIC_GIG_SLUGS = new Set([
  YOUTUBE_SYNC_GIG_SLUG,
  MANUAL_SETLISTS_GIG_SLUG,
  RECENTS_GIG_SLUG,
  FAVORITES_GIG_SLUG,
  BILL_GIG_SLUG,
  MATT_GIG_SLUG,
  DAN_GIG_SLUG,
  JD_GIG_SLUG,
  ROUND_ROBIN_GIG_SLUG,
]);

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
  // Recents + Favorites pseudo-gigs — always offered. Songs you've loaded
  // recently land in Recents (cap 50); songs starred via the title-row
  // star button land in Favorites (cap 50).
  options.push(`<option value="${RECENTS_GIG_SLUG}">⟲ Recents (last 50)</option>`);
  options.push(`<option value="${FAVORITES_GIG_SLUG}">★ Favorites</option>`);
  // Per-singer pseudo-gigs (Bill / Matt / Dan / JD) + RoundRobin alternation.
  // Counts come from mergedLibrary's stems variants when it's ready; before
  // the library lands we still offer the option so the picker is stable.
  const singerCount = (who) => {
    if (!Array.isArray(mergedLibrary)) return null;
    let n = 0;
    for (const m of mergedLibrary) {
      const v = m.variants.find(x => x.type === 'stems');
      if (v && (v.singer_lead || '').toLowerCase() === who.toLowerCase()) n++;
    }
    return n;
  };
  const sgLabel = (who, slug) => {
    const n = singerCount(who);
    return `<option value="${slug}">🎤 ${who} Songs${n != null ? ' (' + n + ')' : ''}</option>`;
  };
  options.push(sgLabel('Bill', BILL_GIG_SLUG));
  options.push(sgLabel('Matt', MATT_GIG_SLUG));
  options.push(sgLabel('Dan',  DAN_GIG_SLUG));
  options.push(sgLabel('JD',   JD_GIG_SLUG));
  options.push(`<option value="${ROUND_ROBIN_GIG_SLUG}">🎙 RoundRobin (singer-alternated)</option>`);
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
    if (s === RECENTS_GIG_SLUG || s === FAVORITES_GIG_SLUG) return true;
    if (s in SINGER_GIG_MAP || s === ROUND_ROBIN_GIG_SLUG) return true;
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

// Recents pseudo-gig: a single setlist whose songs are the last 50
// the user loaded. Read-only — the source of truth is /api/recents on
// the Performer; editing the songs in the sidebar here would be lost
// on the next page reload. Newest first.
async function loadRecentsGig() {
  let entries = [];
  try {
    const r = await fetch('/api/recents');
    if (r.ok) entries = (await r.json()).entries || [];
  } catch (e) {}
  const songs = entries.map(e => ({ song_base: e.base, title: '', at: e.at }));
  return {
    slug: RECENTS_GIG_SLUG, title: 'Recents (last 50)',
    readOnly: true, synthetic: true, syntheticKind: 'recents',
    setlists: [{ title: 'Recently played', songs, origin: 'recents' }],
  };
}

// Per-singer pseudo-gig builder. Filters mergedLibrary's stems variants by
// singer_lead (case-insensitive). Read-only — no SETLISTS file backs it.
function loadSingerGig(slug, who) {
  const songs = [];
  if (Array.isArray(mergedLibrary)) {
    for (const m of mergedLibrary) {
      const v = m.variants.find(x => x.type === 'stems');
      if (!v) continue;
      if ((v.singer_lead || '').toLowerCase() === who.toLowerCase()) {
        songs.push({ song_base: v.folderName, title: m.title, artist: m.artist });
      }
    }
  }
  songs.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return {
    slug, title: `${who} Songs`,
    readOnly: true, synthetic: true, syntheticKind: 'singer',
    setlists: [{ title: `Lead: ${who}`, songs, origin: 'singer' }],
  };
}

// RoundRobin pseudo-gig: interleaves Bill/Matt/Dan/JD songs so any one of them
// can step away briefly without leaving dead air. Each singer's list is
// shuffled, then we round-robin through the queues until all are drained.
function loadRoundRobinGig() {
  const buckets = { Bill: [], Matt: [], Dan: [], JD: [] };
  if (Array.isArray(mergedLibrary)) {
    for (const m of mergedLibrary) {
      const v = m.variants.find(x => x.type === 'stems');
      if (!v) continue;
      const lead = (v.singer_lead || '').trim();
      const cap = lead && lead[0].toUpperCase() + lead.slice(1).toLowerCase();
      if (buckets[cap]) {
        buckets[cap].push({ song_base: v.folderName, title: m.title, artist: m.artist });
      }
    }
  }
  // Shuffle each bucket independently (Fisher-Yates).
  for (const k of Object.keys(buckets)) {
    const arr = buckets[k];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  const order = ['Bill', 'Matt', 'Dan', 'JD'];
  const songs = [];
  let any = true;
  while (any) {
    any = false;
    for (const who of order) {
      if (buckets[who].length) {
        songs.push(buckets[who].shift());
        any = true;
      }
    }
  }
  return {
    slug: ROUND_ROBIN_GIG_SLUG, title: 'RoundRobin',
    readOnly: true, synthetic: true, syntheticKind: 'round_robin',
    setlists: [{ title: 'Bill → Matt → Dan → JD …', songs, origin: 'round_robin' }],
  };
}

// Favorites pseudo-gig: every song with meta.favorite=true, newest-
// favorited first, capped at 50.
async function loadFavoritesGig() {
  let entries = [];
  try {
    const r = await fetch('/api/favorites');
    if (r.ok) entries = (await r.json()).entries || [];
  } catch (e) {}
  const songs = entries.map(e => ({ song_base: e.base, title: e.title || '', artist: e.artist || '' }));
  return {
    slug: FAVORITES_GIG_SLUG, title: 'Favorites',
    readOnly: true, synthetic: true, syntheticKind: 'favorites',
    setlists: [{ title: 'Starred songs', songs, origin: 'favorites' }],
  };
}

async function loadActiveGig(slug) {
  if (!slug) { activeGig = null; renderGigSidebar(); return; }
  // Synthetic gigs (YouTube Sync, Manual Setlists) — built client-side from
  // the SETLISTS/ folder. They live in JS only; no GIGS/<slug>.json.
  if (SYNTHETIC_GIG_SLUGS.has(slug)) {
    try {
      if (slug === YOUTUBE_SYNC_GIG_SLUG) {
        activeGig = await loadYoutubeSyncGig();
      } else if (slug === MANUAL_SETLISTS_GIG_SLUG) {
        activeGig = await loadManualSetlistsGig();
      } else if (slug === RECENTS_GIG_SLUG) {
        activeGig = await loadRecentsGig();
      } else if (slug === FAVORITES_GIG_SLUG) {
        activeGig = await loadFavoritesGig();
      } else if (slug in SINGER_GIG_MAP) {
        activeGig = loadSingerGig(slug, SINGER_GIG_MAP[slug]);
      } else if (slug === ROUND_ROBIN_GIG_SLUG) {
        activeGig = loadRoundRobinGig();
      }
      if (!Array.isArray(activeGig.setlists) || !activeGig.setlists.length) {
        const placeholderTitle =
          slug === YOUTUBE_SYNC_GIG_SLUG    ? '(no playlist setlists yet)' :
          slug === MANUAL_SETLISTS_GIG_SLUG ? '(no manual setlists yet — save one from the planner)' :
          slug === RECENTS_GIG_SLUG         ? '(no recently played songs yet)' :
          slug === FAVORITES_GIG_SLUG       ? '(no favorites yet — click ★ next to a song to add)' :
          (slug in SINGER_GIG_MAP)          ? `(no ${SINGER_GIG_MAP[slug]} songs yet — set Singer in the library row)` :
          slug === ROUND_ROBIN_GIG_SLUG     ? '(no singer-tagged songs yet — set Singer in the library rows)' :
                                              '(empty)';
        activeGig.setlists = [{ title: placeholderTitle, songs: [] }];
      }
      // Restore the previously-active setlist if we remember one.
      try {
        const savedIdx = parseInt(localStorage.getItem(ACTIVE_SETLIST_IDX_KEY), 10);
        if (Number.isInteger(savedIdx) && savedIdx >= 0 && savedIdx < activeGig.setlists.length) {
          activeSetlistIdx = savedIdx;
        }
      } catch (e) {}
      activeSetlistIdx = Math.min(activeSetlistIdx, activeGig.setlists.length - 1);
      openSetlistIdxs = new Set([activeSetlistIdx]);
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
  // Synthetic pseudo-gigs (YouTube Sync, Manual Setlists) don't have a
  // corresponding GIGS/<slug>.json file — the gig-precache endpoint 404s
  // for them. Fall back to per-setlist precache instead.
  if (activeGig.synthetic) {
    for (const sl of activeGig.setlists || []) {
      if (sl.slug) {
        fetch(`/api/precache/setlist/${encodeURIComponent(sl.slug)}`, { method: 'POST' })
          .catch(() => {});
      }
    }
    return;
  }
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
  activeSetlistIdx = setlistIdx;   // selecting from a setlist updates active
  // Remember which setlist + song was last loaded so the next app start
  // can resume here. Stored alongside the active-gig slug.
  try {
    localStorage.setItem(ACTIVE_SETLIST_IDX_KEY, String(setlistIdx));
    localStorage.setItem(LAST_SONG_BASE_KEY, entry.song_base);
  } catch (e) {}
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
  // Profiling: regression Q1a flagged this as a freeze candidate. Logs the
  // wall-clock cost so we can see if a particular gig is slow. Look in
  // DevTools console for [perf] renderGigSidebar Xms — if it's >100 ms we
  // need to chunk renderOneGigSetlist into requestIdleCallback.
  const __perfT0 = performance.now();
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
  const slCount = activeGig.setlists.length;
  // Chunk threshold: 3+ setlists yield to the browser between each so the
  // tab doesn't hang during the gig-switch animation. For 1-2 setlists it's
  // faster to render synchronously.
  if (slCount <= 2) {
    activeGig.setlists.forEach((sl, idx) => {
      setlistsEl.appendChild(renderOneGigSetlist(sl, idx));
    });
    if (window.lucide) lucide.createIcons();
    const dt = performance.now() - __perfT0;
    if (dt > 50) console.warn(`[perf] renderGigSidebar (sync ${slCount} setlists) ${dt.toFixed(1)}ms`);
    else console.log(`[perf] renderGigSidebar ${dt.toFixed(1)}ms`);
  } else {
    // Chunked: append the first setlist synchronously (so the user sees
    // SOMETHING immediately), then defer the rest via requestIdleCallback
    // (falling back to setTimeout(0) on Safari).
    const yieldFn = window.requestIdleCallback ||
                    ((cb) => setTimeout(() => cb({ timeRemaining: () => 50 }), 0));
    let i = 0;
    setlistsEl.appendChild(renderOneGigSetlist(activeGig.setlists[0], 0));
    i = 1;
    const renderRest = () => {
      yieldFn(() => {
        for (; i < slCount; i++) {
          setlistsEl.appendChild(renderOneGigSetlist(activeGig.setlists[i], i));
        }
        if (window.lucide) lucide.createIcons();
        const dt = performance.now() - __perfT0;
        console.log(`[perf] renderGigSidebar (chunked ${slCount} setlists) ${dt.toFixed(1)}ms`);
      });
    };
    renderRest();
    // Run lucide once for the synchronously-appended first setlist so its
    // icons don't visibly pop in late.
    if (window.lucide) lucide.createIcons();
  }
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
      try { localStorage.setItem(ACTIVE_SETLIST_IDX_KEY, String(idx)); } catch (e) {}
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
  head.querySelector('.gig-setlist-del').addEventListener('click', async e => {
    e.stopPropagation();
    if (activeGig.setlists.length <= 1) {
      alert("Can't delete the only setlist in the gig.");
      return;
    }
    if (!confirm(`Remove "${sl.title}" from the gig?`)) return;
    // Manual pseudo-gig: the setlist is a standalone SETLISTS/<slug>.json
    // file on disk. Removing it from the in-memory array isn't enough —
    // we also have to DELETE the file, otherwise the next /api/setlists
    // read re-resurrects it on the next page load.
    if (activeGig.synthetic && activeGig.syntheticKind === 'manual' && sl.slug) {
      try {
        const r = await fetch(`/api/setlists/${encodeURIComponent(sl.slug)}`, { method: 'DELETE' });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          alert(`Couldn't delete "${sl.title}": ${d.error || r.status}`);
          return;
        }
      } catch (err) {
        alert(`Couldn't delete "${sl.title}": ${err.message}`);
        return;
      }
    }
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
    // setlist_sync.py can hand us entries with a null song_base when a
    // YouTube playlist row didn't match any STEMS folder. Without this
    // fallback, switching to the YouTube Sync gig crashes renderGigSidebar
    // with "Cannot read properties of null (reading 'replace')".
    const fallbackName = (s.song_base || s.title || '(unmatched)').replace(/_/g, ' ');
    const title = (merged && merged.title) || fallbackName;
    const artist = (merged && merged.artist) || '';
    const row = document.createElement('div');
    row.className = 'sls-row';
    if (isPlayingThisSetlist && gigPlayingSongIdx === songIdx) row.classList.add('playing');
    row.draggable = true;
    row.dataset.setlistIdx = String(idx);
    row.dataset.songIdx = String(songIdx);
    // Sidebar setlist rows are pure: grip + title + delete. The favorite
    // star lives on the library row and on the active-track title; showing
    // it here too was redundant and ate horizontal space we need for the
    // title itself.
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

  // Ghost preview slots — only on the ACTIVE setlist. Two sources:
  //   1. the currently-loaded song (legacy single-add behavior)
  //   2. every batch-selected library row (new multi-add behavior — user
  //      checks boxes on AC/DC / Led Zep / etc., they ALL appear here as
  //      ghosts, clicking + on any one commits the whole batch).
  // The bright green + is on every ghost; clicking ANY commits everything.
  if (idx === activeSetlistIdx) {
    const pendingBases = new Set();
    if (currentSong) {
      const previewBase = songBaseOf(currentSong);
      if (previewBase && !sl.songs.some(s => s.song_base === previewBase)) {
        pendingBases.add(previewBase);
      }
    }
    for (const b of batchSelectedBases) {
      if (!sl.songs.some(s => s.song_base === b)) pendingBases.add(b);
    }

    const commitAll = () => {
      for (const b of pendingBases) sl.songs.push({ song_base: b });
      // Clear the batch set so the checkboxes uncheck and ghosts disappear.
      batchSelectedBases.clear();
      renderGigSidebar();
      // Also re-render the library so the checkboxes visually reset.
      if (typeof renderSongList === 'function') renderSongList();
      scheduleGigSave();
    };

    for (const base of pendingBases) {
      const merged = mergedLibrary.find(m => {
        const sv = m.variants.find(v => v.type === 'stems');
        return sv && sv.folderName === base;
      });
      const title = (merged && merged.title) || base.replace(/_/g, ' ');
      const artist = (merged && merged.artist) || '';
      const ghost = document.createElement('div');
      ghost.className = 'sls-row sls-ghost';
      ghost.innerHTML = `
        <span class="sls-grip" style="visibility:hidden;">⋮⋮</span>
        <span class="sls-title sls-ghost-title" title="Click + to add ${pendingBases.size} song(s) to this setlist">${escapeHtml(title)}</span>
        <span class="sls-artist sls-ghost-artist">${escapeHtml(artist)}</span>
        <button class="sls-add-ghost" title="Add ALL ${pendingBases.size} pending song(s) to this setlist"><i data-lucide="plus"></i>${pendingBases.size > 1 ? `<sup style="font-size:9px;margin-left:2px;">${pendingBases.size}</sup>` : ''}</button>
      `;
      ghost.querySelector('.sls-add-ghost').addEventListener('click', e => {
        e.stopPropagation();
        commitAll();
      });
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
      e.dataTransfer.setData('application/x-simplestem-song', JSON.stringify(payload));
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
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-simplestem-song')); }
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
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('application/x-simplestem-song');
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
  const allFiles = filenames || drumLoopsAll.map(l => l.fileName).filter(Boolean);
  if (!allFiles.length) return;
  try {
    // Chunk so the request body never gets close to the 5 MB server cap.
    // 1000 file paths × ~60 bytes ≈ 60 KB per request — comfortably under.
    const CHUNK = 1000;
    for (let i = 0; i < allFiles.length; i += CHUNK) {
      const files = allFiles.slice(i, i + CHUNK);
      const res = await fetch('/api/loop-cache-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const [f, cached] of Object.entries(data.status || {})) {
        loopCacheStatus.set(f, !!cached);
      }
    }
    renderDrumLoops();
    renderLoopSequence();
  } catch (e) {
    // cache hydration is best-effort
  }
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
  // Profiling: regression Q1a flagged drum-loops tab switching as a freeze
  // candidate. Logs the wall-clock cost. With 176 songs × ~10 loops, the
  // chip body string can hit ~600 KB of HTML.
  const __perfT0 = performance.now();
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
  const dt = performance.now() - __perfT0;
  if (dt > 100) console.warn(`[perf] renderDrumLoops ${dt.toFixed(1)}ms (${groupRows.length} song rows)`);
  else console.log(`[perf] renderDrumLoops ${dt.toFixed(1)}ms (${groupRows.length} song rows)`);
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
  // STEMS-first. The portal is the stage mixer; the -V / -V-G / -V-G-B / DO
  // m4a variants are EZPerformer-only artifacts and should not auto-load
  // here. Previously the "last variant code" preference would stick on an
  // m4a code and force later songs into m4a backing-track mode, hiding the
  // stem mixer for songs that actually had stems. Now STEMS wins whenever
  // it exists; lastCode is only honored for songs that don't have STEMS.
  const stems = byCode('STEMS');
  if (stems) return stems;
  let lastCode = null;
  try { lastCode = localStorage.getItem('bt_last_variant_code'); } catch (e) {}
  if (lastCode && lastCode !== 'STEMS') {
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

    // First-time library load → try to restore the last-loaded song. This
    // runs once per page load; subsequent library refreshes (queue runner
    // pings) don't re-trigger it.
    if (!window._restoredLastSong) {
      window._restoredLastSong = true;
      try {
        const lastBase = localStorage.getItem(LAST_SONG_BASE_KEY);
        if (lastBase) {
          const merged = mergedLibrary.find(m => {
            const sv = m.variants.find(v => v.type === 'stems');
            return sv && sv.folderName === lastBase;
          });
          if (merged) {
            const v = preferredPlayVariant(merged);
            if (v) loadSong(v, { autoplay: false });
          }
        }
      } catch (e) { console.warn('[restore] last song failed:', e); }
    }
    
    renderStats(data.stats);
    applyLibrarySort();
    renderLibrary();
    setupLibrarySortHandlers();
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
    console.error('[fetchLibrary]', err);
    // The catch handler used to call lucide.createIcons() unconditionally.
    // If Lucide failed to load (was a CDN script pre-bundling), that call
    // threw on top of the original error and the operator saw a blank
    // page instead of the diagnostic message. Guard the icon refresh and
    // include the underlying error text so future failures are debuggable
    // without DevTools.
    els.songListBody.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle" class="text-red" style="width: 48px; height: 48px;"></i>
        <h2>Error Loading Library</h2>
        <p>Couldn't reach the construction-kit server (port 3000). Make sure performer.sh is running.</p>
        <pre style="font-size:11px;opacity:0.7;margin-top:8px;max-width:80%;white-space:pre-wrap;">${escapeHtml(String(err && err.message || err))}</pre>
      </div>
    `;
    try { if (window.lucide) lucide.createIcons(); } catch (e) {}
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
  
  // Render Key Signature counts (read-only, sorted by count desc). Used to
  // be clickable filter pills, but the count is what's useful — clicking
  // duplicates what the Key dropdown already does and just adds noise.
  const statsCard = document.querySelector('.tempo-dist-card');
  const keys = Object.keys(stats.keyDistribution).sort(
    (a, b) => (stats.keyDistribution[b] || 0) - (stats.keyDistribution[a] || 0) || a.localeCompare(b)
  );
  // Replace any previously-rendered key block.
  document.querySelectorAll('.lib-stat-block').forEach(el => el.remove());
  if (keys.length > 0 && statsCard) {
    const block = document.createElement('div');
    block.className = 'lib-stat-block lib-stat-keys';
    const h = document.createElement('h4');
    h.className = 'sub-title';
    h.innerHTML = '<i data-lucide="key" style="width:12px;display:inline;vertical-align:middle;margin-right:4px;"></i> Songs by Key';
    block.appendChild(h);
    const list = document.createElement('div');
    list.className = 'lib-stat-rows';
    keys.forEach(k => {
      const row = document.createElement('div');
      row.className = 'lib-stat-row';
      row.innerHTML = `<span class="lib-stat-name">${escapeHtml(k)}</span><span class="lib-stat-count">${stats.keyDistribution[k]}</span>`;
      list.appendChild(row);
    });
    block.appendChild(list);
    statsCard.appendChild(block);
  }
  // Singer counts (Bill / Matt / Dan / JD / All / (unassigned)). Read-only.
  if (statsCard && stats.singerDistribution) {
    const block = document.createElement('div');
    block.className = 'lib-stat-block lib-stat-singers';
    const h = document.createElement('h4');
    h.className = 'sub-title';
    h.innerHTML = '<i data-lucide="mic" style="width:12px;display:inline;vertical-align:middle;margin-right:4px;"></i> Songs by Singer';
    block.appendChild(h);
    const list = document.createElement('div');
    list.className = 'lib-stat-rows';
    const order = ['Bill', 'Matt', 'Dan', 'JD', 'All'];
    const seen = new Set();
    const drop = (name, label) => {
      const n = stats.singerDistribution[name] || 0;
      if (!n) return;
      const row = document.createElement('div');
      row.className = 'lib-stat-row';
      row.innerHTML = `<span class="lib-stat-name">${escapeHtml(label || name)}</span><span class="lib-stat-count">${n}</span>`;
      list.appendChild(row);
      seen.add(name);
    };
    order.forEach(name => drop(name));
    // Anything not in the canonical order (e.g. "(unassigned)" or freeform) gets dropped after.
    Object.keys(stats.singerDistribution)
      .filter(k => !seen.has(k))
      .sort((a, b) => stats.singerDistribution[b] - stats.singerDistribution[a])
      .forEach(k => drop(k));
    block.appendChild(list);
    statsCard.appendChild(block);
  }
  lucide.createIcons();
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

// Library column sort. Tracks the active sort key (title / artist /
// duration / bpm / key / singer / drum) and direction. Clicking a header
// the first time sorts ascending; clicking it again flips to descending;
// clicking a third time clears the sort and returns to the default
// (alphabetical by title). The sort applies to filteredLibrary so it
// works alongside search + key/tempo filters.
let librarySortKey = null;       // null = default (title ASC)
let librarySortDir = 'asc';      // 'asc' | 'desc'

function librarySortValue(m, key) {
  const stems = m.variants && m.variants.find(v => v.type === 'stems');
  switch (key) {
    case 'title':    return (m.title || '').toLowerCase();
    case 'artist':   return (m.artist || '').toLowerCase();
    case 'duration': return (typeof m.duration === 'number' && Number.isFinite(m.duration)) ? m.duration : -1;
    case 'bpm':      return (typeof m.practiceBpm === 'number' && m.practiceBpm > 0) ? m.practiceBpm : -1;
    case 'key':      return (m.key || '').toLowerCase();
    case 'singer':   return (stems && stems.singer_lead || '').toLowerCase();
    case 'drum':     return (stems && stems.drum_pattern || '').toLowerCase();
    default:         return (m.title || '').toLowerCase();
  }
}
function applyLibrarySort() {
  if (!librarySortKey) {
    filteredLibrary.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return;
  }
  const dir = librarySortDir === 'desc' ? -1 : 1;
  filteredLibrary.sort((a, b) => {
    const va = librarySortValue(a, librarySortKey);
    const vb = librarySortValue(b, librarySortKey);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}
function updateSortHeaderIndicators() {
  document.querySelectorAll('.song-table-header [data-sort]').forEach(el => {
    el.classList.remove('sort-asc', 'sort-desc');
    if (librarySortKey && el.dataset.sort === librarySortKey) {
      el.classList.add(librarySortDir === 'desc' ? 'sort-desc' : 'sort-asc');
    }
  });
}
function setupLibrarySortHandlers() {
  document.querySelectorAll('.song-table-header [data-sort]').forEach(el => {
    if (el._sortBound) return;
    el._sortBound = true;
    el.addEventListener('click', () => {
      const key = el.dataset.sort;
      if (librarySortKey !== key) {
        librarySortKey = key;
        librarySortDir = 'asc';
      } else if (librarySortDir === 'asc') {
        librarySortDir = 'desc';
      } else {
        librarySortKey = null;
        librarySortDir = 'asc';
      }
      applyLibrarySort();
      updateSortHeaderIndicators();
      renderLibrary();
    });
  });
  updateSortHeaderIndicators();
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

    // Library row checkbox doubles as both:
    //   (a) the legacy Setlist Planner toggle (right-side pane) AND
    //   (b) a batch-add selector for the active gig sidebar setlist.
    // The active gig sidebar renders a ghost row for each batch-selected
    // song; clicking the green + on ANY of those ghost rows commits the
    // whole batch.
    const selectCell = document.createElement('div');
    selectCell.className = 'song-select-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'song-checkbox';
    const stemsVarForBatch = merged.variants.find(v => v.type === 'stems');
    const songBaseForBatch = stemsVarForBatch && stemsVarForBatch.folderName;
    // Checkbox is pure batch-select marker. Decoupled from the legacy
    // `setlist` array (which had its own UI pane that is now gone, but
    // the variable is still used internally by various restore paths).
    // Checked iff the song's base is in the batch selection set.
    checkbox.checked = !!(songBaseForBatch && batchSelectedBases.has(songBaseForBatch));
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (!songBaseForBatch) return;   // unstemmed song can't be batched
      if (checkbox.checked) batchSelectedBases.add(songBaseForBatch);
      else batchSelectedBases.delete(songBaseForBatch);
      // Re-render the gig sidebar so ghost rows reflect the new batch.
      // Click any of the green + buttons on those ghosts to commit them
      // all into the active setlist and clear the checkboxes.
      if (typeof renderGigSidebar === 'function') renderGigSidebar();
    });
    selectCell.appendChild(checkbox);

    // Title  (play button on the left starts STEMS variant immediately)
    const titleCell = document.createElement('div');
    titleCell.className = 'song-title-cell';
    // Favorite star: pulls the flag off the stems variant; click toggles.
    const stemsVarForStar = merged.variants.find(v => v.type === 'stems');
    const isFav = !!(stemsVarForStar && stemsVarForStar.favorite);
    const favStarHTML = stemsVarForStar
      ? `<button class="song-fav-star${isFav ? ' on' : ''}" title="${isFav ? 'Favorite — click to unstar' : 'Click to favorite'}">${isFav ? '★' : '☆'}</button>`
      : '';
    titleCell.innerHTML = `
      <button class="play-row-btn" title="Play stems"><i data-lucide="play"></i></button>
      ${favStarHTML}
      <span>${escapeHtml(merged.title)}${isFav ? ' <span class="song-fav-inline" title="Favorite">★</span>' : ''}</span>
    `;
    const favBtn = titleCell.querySelector('.song-fav-star');
    if (favBtn && stemsVarForStar) {
      favBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newVal = !isFav;
        favBtn.classList.toggle('on', newVal);
        favBtn.textContent = newVal ? '★' : '☆';
        try {
          await fetch(`/api/song/${encodeURIComponent(stemsVarForStar.folderName)}/favorite`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorite: newVal }),
          });
          // Reflect on the in-memory variant so subsequent renders match.
          stemsVarForStar.favorite = newVal;
          if (newVal) stemsVarForStar.favorited_at = new Date().toISOString();
        } catch (err) {
          console.warn('[favorite] save failed:', err);
        }
      });
    }
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

    // Duration cell — mm:ss from the primary variant's duration field.
    // Falls back to '--' when the metadata didn't carry a duration.
    const durationCell = document.createElement('div');
    durationCell.className = 'song-duration-cell';
    const durSec = merged.duration;
    if (typeof durSec === 'number' && Number.isFinite(durSec) && durSec > 0) {
      const mm = Math.floor(durSec / 60);
      const ss = Math.round(durSec - mm * 60);
      durationCell.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
    } else {
      durationCell.textContent = '--';
    }

    // Singer cell — opens a pulldown on click to edit singer_lead locally.
    // Reads stems variant's singer_lead (populated by mpb_sync.py or
    // edited here via PATCH /api/song/:base/singer).
    const singerCell = document.createElement('div');
    singerCell.className = 'song-singer-cell';
    const stemsVarForSinger = merged.variants.find(v => v.type === 'stems');
    const SINGER_CHOICES = ['', 'Bill', 'Matt', 'Dan', 'JD', 'All'];
    const currentSinger = (stemsVarForSinger && stemsVarForSinger.singer_lead) || '';
    if (stemsVarForSinger && stemsVarForSinger.folderName) {
      const sel = document.createElement('select');
      sel.className = 'singer-select';
      sel.title = 'Lead singer for this song (saved locally to metadata.json; the next mpb_sync may overwrite this if the sheet says otherwise)';
      SINGER_CHOICES.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name || '—';
        if (name === currentSinger) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('click', e => e.stopPropagation());
      sel.addEventListener('change', async () => {
        const newSinger = sel.value;
        try {
          await fetch(`/api/song/${encodeURIComponent(stemsVarForSinger.folderName)}/singer`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ singer_lead: newSinger }),
          });
          stemsVarForSinger.singer_lead = newSinger || null;
          // Refresh the gig picker so the "🎤 Bill Songs (N)" counts update
          // immediately. paintGigPicker reads mergedLibrary fresh on each
          // call. If we're currently inside a singer pseudo-gig, also
          // reload it so the song shows up / disappears.
          try {
            const picker = document.getElementById('gig-picker');
            const activeSlug = picker && picker.value;
            const gigs = readCache(GIGS_CACHE_KEY) || [];
            const cachedSetlists = readCache(SETLISTS_CACHE_KEY) || [];
            paintGigPicker(
              gigs,
              cachedSetlists.filter(s => s.origin === 'playlist'),
              cachedSetlists.filter(s => (s.origin || 'manual') === 'manual'),
            );
            if (picker) picker.value = activeSlug;
            if (activeSlug in SINGER_GIG_MAP || activeSlug === ROUND_ROBIN_GIG_SLUG) {
              await loadActiveGig(activeSlug);
            }
          } catch (e) {
            console.warn('[singer] picker refresh failed:', e);
          }
        } catch (err) {
          console.warn('[singer] save failed:', err);
        }
      });
      singerCell.appendChild(sel);
    } else {
      singerCell.textContent = '--';
    }

    // Action — Load button removed. Clicking the row loads the song (wired
    // below). Keep the ⋯ menu for song options.
    const actionCell = document.createElement('div');
    actionCell.className = 'col-action';
    actionCell.innerHTML = `<button class="btn-secondary song-menu-btn" title="Song options" style="padding:4px 8px;">⋯</button>`;
    // song_base = the stems folder name (canonical key for the per-song API).
    // For m4a-only rows (orphaned variants with no stems folder yet) we fall
    // back to the m4a-derived "stripped" base name -- the same name a STEMS
    // folder would have if it existed, which is also the prefix the server's
    // DELETE endpoint uses to find and remove the matching m4a files. This
    // lets the user delete orphaned m4a sets (e.g. duplicate Harvest Moon
    // uploads with no stems) through the ⋯ menu instead of being stuck.
    const stemsVar = merged.variants.find(v => v.type === 'stems');
    let songBase = stemsVar && stemsVar.folderName;
    if (!songBase) {
      const m4aVar = merged.variants.find(v => v.type === 'm4a' && v.fileName);
      if (m4aVar) {
        let stripped = m4aVar.fileName.replace(/\.m4a$/i, '');
        for (const suf of ['_-V-G-B', '_-V-G', '_-V-B', '_-V', '_DO']) {
          if (stripped.endsWith(suf)) { stripped = stripped.slice(0, -suf.length); break; }
        }
        songBase = stripped;
      }
    }
    const menuBtn = actionCell.querySelector('.song-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (songBase) openSongMenu(songBase, merged);
      else alert('This song has no playable files — cannot open options.');
    });

    // Drum machine pattern cell — opaque string from the band sheet
    // (e.g. "120@96", "95UduHop", "ACTUAL"). Just displayed as text; the
    // band reads it as their cue to set the drum machine pattern.
    const drumCell = document.createElement('div');
    drumCell.className = 'song-drum-cell';
    const stemsForDrum = merged.variants.find(v => v.type === 'stems');
    const drumPattern = stemsForDrum && stemsForDrum.drum_pattern;
    drumCell.textContent = drumPattern || '—';
    if (drumPattern) drumCell.title = `Drum pattern: ${drumPattern}`;

    row.appendChild(selectCell);
    row.appendChild(titleCell);
    row.appendChild(artistCell);
    row.appendChild(durationCell);
    row.appendChild(bpmCell);
    row.appendChild(keyCell);
    row.appendChild(singerCell);
    row.appendChild(drumCell);
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
  applyLibrarySort();
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
  //  (or, with pitch shift active: masterGain → pitchShifter → destination)
  masterMerger.connect(analyserNode);
  analyserNode.connect(masterGainNode);
  masterGainNode.connect(audioCtx.destination);
  // Wire the pitch shifter once the master path exists. setupPitchShifter
  // is a no-op if Tone.js failed to load or if we're on multi-channel out
  // (where pitch shift would downmix the per-stem XR18 routing to stereo).
  setupPitchShifter();

  Object.keys(audioElements).forEach(chan => {
    const ae = audioElements[chan];
    const source = audioCtx.createMediaElementSource(ae);
    const stripGain = audioCtx.createGain();  // pre-split gain (fader value
                                              // × master; set by
                                              // applyMixerVolumes).
    // mediaMute sits between MediaElementSource and stripGain so the
    // LOOPER can silence the original audio WITHOUT disconnecting the
    // graph. Chrome stops advancing currentTime on a captured
    // MediaElement when its source has no output destination, which
    // froze the playhead UI during LOOPER. Keeping the connection but
    // setting mediaMute.gain to 0 silences the audio path while leaving
    // the element happily ticking.
    const mediaMute = audioCtx.createGain();
    mediaMute.gain.value = 1;
    const splitter = audioCtx.createChannelSplitter(2);
    source.connect(mediaMute);
    mediaMute.connect(stripGain);
    stripGain.connect(splitter);
    stripNodes[chan] = { source, mediaMute, stripGain, splitter };
    trackSources[chan] = source;
  });

  loadRoutingMatrix();
  applyRouting();

  // Expose audio-graph internals on window for DevTools probing. Lets us
  // read stripGain values, master gain, loop buffer count, etc. live
  // from the console without sprinkling more console.log statements.
  window.audioCtx        = audioCtx;
  window.stripNodes      = stripNodes;
  window.masterGainNode  = masterGainNode;
  window.audioElements   = audioElements;
  window.loopBufferSources = loopBufferSources;

  initVisualizer(analyserNode);
}

// ── Pitch shift (master bus) ──────────────────────────────────────────────
// Tone.PitchShift inserted between masterGain and destination so the entire
// mixed signal shifts together while tempo stays constant. Two knobs in the
// mixer header drive it:
//   COARSE: -12..+12 semitones (whole half-steps)
//   FINE:   -50..+50 cents (fractions of a half-step)
// Total = pitchSemis + pitchCents/100, fed to pitchShifter.pitch.
//
// CAVEAT: Tone.PitchShift is stereo. When the laptop is on multi-channel
// output (XR18, 18-ch), inserting the shifter would downmix the per-stem
// channel routing back to stereo and break the band's monitor mix. The
// shifter is therefore SKIPPED in that case — the knobs still hold/save
// their value but the audio graph stays masterGain → destination.

let pitchShifter = null;
// SEMI is now quantized to half-steps from -3 to +3 (13 positions). FINE
// stays as integer cents -50..+50 for fine tuning between half-steps.
const SEMI_MIN = -3;
const SEMI_MAX = 3;
const SEMI_STEP = 0.5;
let pitchSemis = 0;   // -3..+3, step 0.5
let pitchCents = 0;   // -50..+50
let pitchSaveTimer = null;
// loadPitchState used to seed from localStorage; pitch is now per-song, so
// this is a no-op kept only because the boot sequence still calls it. The
// real load happens in loadAutomationForSong from the server response.
function loadPitchState() { /* no-op: pitch is per-song; see loadAutomationForSong */ }

function savePitchState() {
  // Pitch is a per-SESSION control now; nothing persists. No-op.
}

function applyPitchToShifter() {
  // playbackRate-based pitch shift. Couples tempo to pitch (~6%/semitone)
  // but works reliably without stalling the media decoder, unlike Tone.js
  // PitchShift between MediaElementSource and stripGain.
  const total = pitchSemis + pitchCents / 100;
  const rate = Math.pow(2, total / 12);
  for (const ae of Object.values(audioElements || {})) {
    try {
      ae.preservesPitch = false;
      ae.mozPreservesPitch = false;
      ae.webkitPreservesPitch = false;
      ae.playbackRate = rate;
    } catch (e) {}
  }
}

// Visualizer mode toggle — flips the waveform between SUM (single combined
// trace) and STEMS (six stacked lanes V/D/B/G/P/O, top→bottom). The choice
// persists across sessions in localStorage. The actual rendering switch
// lives in visualizer.js draw(); this just owns the button + the
// window.__vizMode global the renderer reads.
const VIZ_MODE_KEY = 'simpleStem.vizMode';
function setupVizModeToggle() {
  const btn = document.getElementById('viz-mode-toggle');
  if (!btn) return;
  let mode;
  try { mode = localStorage.getItem(VIZ_MODE_KEY) || 'sum'; } catch (e) { mode = 'sum'; }
  if (mode !== 'sum' && mode !== 'stems') mode = 'sum';
  window.__vizMode = mode;
  btn.textContent = mode.toUpperCase();
  btn.classList.toggle('viz-mode-stems', mode === 'stems');
  btn.addEventListener('click', () => {
    const next = window.__vizMode === 'stems' ? 'sum' : 'stems';
    window.__vizMode = next;
    btn.textContent = next.toUpperCase();
    btn.classList.toggle('viz-mode-stems', next === 'stems');
    try { localStorage.setItem(VIZ_MODE_KEY, next); } catch (e) {}
  });
}

function setupPitchShifter() {
  // Disabled. Tone.PitchShift between MediaElementSource and stripGain
  // stalls the decoder; the working pitch path is playbackRate (see
  // applyPitchToShifter). The knobs change rate directly; no Web Audio
  // graph rewiring needed. Kept as a callable stub so existing init code
  // doesn't crash.
  console.log('[pitch] shifter disabled — knobs change playbackRate directly');
}

function updatePitchKnobUI(which) {
  const val = which === 'coarse' ? pitchSemis : pitchCents;
  const max = which === 'coarse' ? SEMI_MAX : 50;
  const knob = document.getElementById(`knob-${which}`);
  const valEl = document.getElementById(`val-${which}`);
  if (knob) {
    const indicator = knob.querySelector('.pitch-knob-indicator');
    if (indicator) {
      // Map [-max..+max] linearly to [-135°..+135°] of rotation.
      const rot = (val / max) * 135;
      indicator.style.transform = `rotate(${rot}deg)`;
    }
  }
  if (valEl) {
    let label;
    if (which === 'coarse') {
      // Half-step display: integers as-is, halves as "½".
      const sign = val > 0 ? '+' : (val < 0 ? '-' : '');
      const mag = Math.abs(val);
      const whole = Math.floor(mag);
      const half = (mag - whole) >= 0.25;
      if (val === 0) label = '0';
      else if (whole === 0) label = `${sign}½`;
      else if (half)        label = `${sign}${whole}½`;
      else                  label = `${sign}${whole}`;
    } else {
      label = val > 0 ? `+${val}` : `${val}`;
    }
    valEl.textContent = label;
    valEl.classList.toggle('nonzero', val !== 0);
  }
}

function setPitch(which, value) {
  if (which === 'coarse') {
    // Snap to nearest half-step in [-3..+3]. This is the only legal grid
    // for the SEMI knob now — no in-between values.
    const snapped = Math.round(value / SEMI_STEP) * SEMI_STEP;
    pitchSemis = Math.max(SEMI_MIN, Math.min(SEMI_MAX, snapped));
  } else {
    pitchCents = Math.max(-50, Math.min(50, Math.round(value)));
  }
  updatePitchKnobUI(which);
  applyPitchToShifter();
  savePitchState();
}

function renderSemiKnobMarks() {
  // Draws 13 tick marks around the SEMI knob — one per legal stop in the
  // [-3, +3] half-step quantization. Index 0..12 maps to values -3, -2.5,
  // -2, -1.5, -1, -0.5, 0, +0.5, +1, +1.5, +2, +2.5, +3. Whole-step ticks
  // render as full digits (-3..+3); half-step ticks render as a short dash.
  // The center tick at value 0 is highlighted.
  const marksHost = document.querySelector('#knob-coarse .semi-knob-marks');
  if (!marksHost) return;
  if (marksHost.childElementCount > 0) return; // already rendered
  const TOTAL = 13;
  const ARC_DEG = 270;
  const RADIUS_PX = 26;
  for (let i = 0; i < TOTAL; i++) {
    const t = i / (TOTAL - 1);
    const deg = -ARC_DEG / 2 + t * ARC_DEG;
    const value = SEMI_MIN + i * SEMI_STEP;        // -3, -2.5, -2, ..., +3
    const isWhole = Number.isInteger(value);
    const isZero  = value === 0;
    const span = document.createElement('span');
    span.className = 'semi-knob-mark'
      + (isWhole ? ' whole' : ' half')
      + (isZero  ? ' zero'  : '');
    if (isWhole) {
      span.textContent = value > 0 ? `+${value}` : `${value}`;
    } else {
      span.textContent = '·';
    }
    span.style.transform = `rotate(${deg}deg) translateY(-${RADIUS_PX}px) rotate(${-deg}deg)`;
    marksHost.appendChild(span);
  }
}

function setupPitchKnobs() {
  renderSemiKnobMarks();

  ['coarse', 'fine'].forEach(which => {
    const knob = document.getElementById(`knob-${which}`);
    if (!knob) return;
    let startY = 0, startVal = 0;
    // Drag sensitivity. COARSE is now 13 positions (-3..+3 in 0.5 steps);
    // 24 px per 0.5-step gives a 144-px sweep for the full range — same
    // total arm motion as the old -12..+12-by-1 design. FINE stays 1 cent/px.
    const PIXELS_PER_STEP = which === 'coarse' ? 24 : 1;
    const VALUE_PER_STEP  = which === 'coarse' ? SEMI_STEP : 1;

    const onMove = e => {
      const y = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      const dy = startY - y; // dragging up = positive
      const steps = Math.round(dy / PIXELS_PER_STEP);
      setPitch(which, startVal + steps * VALUE_PER_STEP);
    };
    const onUp = () => {
      knob.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    const onDown = e => {
      e.preventDefault();
      startY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      startVal = which === 'coarse' ? pitchSemis : pitchCents;
      knob.classList.add('dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
    };
    knob.addEventListener('mousedown', onDown);
    knob.addEventListener('touchstart', onDown, { passive: false });
    knob.addEventListener('dblclick', () => setPitch(which, 0));
    knob.addEventListener('wheel', e => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = which === 'coarse' ? SEMI_STEP : 1;
      const cur = which === 'coarse' ? pitchSemis : pitchCents;
      setPitch(which, cur + dir * step);
    }, { passive: false });
    knob.addEventListener('keydown', e => {
      const cur = which === 'coarse' ? pitchSemis : pitchCents;
      const step = which === 'coarse' ? SEMI_STEP : 1;
      if (e.key === 'ArrowUp')   { e.preventDefault(); setPitch(which, cur + step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setPitch(which, cur - step); }
      if (e.key === '0')         { e.preventDefault(); setPitch(which, 0); }
    });
  });

  // -/+ stepper buttons above each knob — one half-step (semi) or one cent
  // (fine) per click. Press-and-hold not implemented; for runs of more than
  // a few units, drag the knob face instead.
  document.querySelectorAll('.pitch-step-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const which = btn.dataset.knob;
      const dir = parseInt(btn.dataset.dir, 10) || 0;
      const step = which === 'coarse' ? SEMI_STEP : 1;
      const cur = which === 'coarse' ? pitchSemis : pitchCents;
      setPitch(which, cur + dir * step);
    });
  });

  // RESET button — zeroes both knobs in one click.
  const resetBtn = document.getElementById('btn-pitch-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', e => {
      e.preventDefault();
      setPitch('coarse', 0);
      setPitch('fine', 0);
    });
  }

  updatePitchKnobUI('coarse');
  updatePitchKnobUI('fine');
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
  // Default routing: each stem goes to L (0) + R (1) PLUS its "home"
  // instrument channel on the XR18 split. So the V button is pre-lit on
  // Vocals, D on Drums, etc., communicating which stem each strip is.
  // (Home channels are 0-indexed: V=10, D=11, B=12, G=13, P=14, O=15.)
  const HOME_CHAN = {
    vocals: 10,  // V (ch 11)
    drums:  11,  // D (ch 12)
    bass:   12,  // B (ch 13)
    guitar: 13,  // G (ch 14)
    piano:  14,  // P (ch 15)
    other:  15,  // O (ch 16)
  };
  routingMatrix = {};
  Object.keys(audioElements).forEach(ch => {
    const home = HOME_CHAN[ch];
    routingMatrix[ch] = home !== undefined ? [0, 1, home] : [0, 1];
  });
  try {
    const raw = localStorage.getItem(ROUTING_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    Object.keys(audioElements).forEach(ch => {
      if (Array.isArray(stored[ch])) {
        const arr = stored[ch]
          .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < 18)
          .sort((a, b) => a - b);
        // Migration for sessions saved before the home-channel default.
        // If the stored routing doesn't already include the home channel,
        // add it so the per-stem button (V on Vocals, D on Drums, etc.)
        // is pre-lit regardless of what was saved earlier.
        const home = HOME_CHAN[ch];
        if (home !== undefined && !arr.includes(home)) arr.push(home);
        arr.sort((a, b) => a - b);
        if (arr.length) {
          routingMatrix[ch] = arr;
        } else {
          routingMatrix[ch] = home !== undefined ? [0, 1, home] : [0, 1];
        }
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
  // Iterate every stem strip (not just routingMatrix entries) so that a
  // strip with no matrix entry at all (e.g. piano dropped from a stale
  // saved matrix) still gets the L+R fallback below.
  Object.keys(stripNodes).forEach(chan => {
    const s = stripNodes[chan];
    if (!s) return;
    const routes = routingMatrix[chan] || [];
    const sorted = [...routes].sort((a, b) => a - b);
    // Filter out output indices that don't exist on the current device.
    // When every route is out of range (e.g. a strip whose only target is
    // an XR18 channel while we're in stereo-only mode), fall back to L+R
    // so the stem still produces audible output. Without this fallback,
    // the splitter never connects to anything and the stem is silent
    // even though its meter shows signal.
    const inRange = sorted.filter(out => out < outputChannelCount);
    const fallback = !inRange.length;
    const effective = fallback ? [0, 1] : inRange;
    if (fallback) {
      // Self-heal so the UI matches what we actually routed.
      routingMatrix[chan] = [0, 1];
      console.warn(`[routing] ${chan}: all routes were out of range; fell back to L+R and persisted.`);
    }
    if (effective.length === 1) {
      const out = effective[0];
      try { s.splitter.connect(masterMerger, 0, out); } catch (e) {}
      try { s.splitter.connect(masterMerger, 1, out); } catch (e) {}
    } else {
      effective.forEach((out, i) => {
        try { s.splitter.connect(masterMerger, i % 2 === 0 ? 0 : 1, out); } catch (e) {}
      });
    }
  });
  // Persist any self-heals from the loop above, then re-render the UI
  // so the buttons match what is actually playing.
  try { saveRoutingMatrix(); } catch (e) {}
  try { renderRoutingButtons(); } catch (e) {}
}

// DevTools helper: print a per-stem dump of routingMatrix, mute/solo
// state, stripGain value, and whether the splitter has any connections.
// Call from console as window.debugRouting().
window.debugRouting = function () {
  const out = [];
  Object.keys(stripNodes || {}).forEach(chan => {
    const s = stripNodes[chan];
    out.push({
      chan,
      routes:      (routingMatrix[chan] || []).join(',') || '(empty)',
      muted:       !!(mixerState && mixerState.muted   && mixerState.muted[chan]),
      soloed:      !!(mixerState && mixerState.soloed  && mixerState.soloed[chan]),
      fader:       mixerState && mixerState.volumes && +mixerState.volumes[chan]?.toFixed?.(3),
      boost:       (mixerState && mixerState.boost    && mixerState.boost[chan]) || 0,
      stripGain:   s && s.stripGain && +s.stripGain.gain.value.toFixed(3),
      mediaMute:   s && s.mediaMute && +s.mediaMute.gain.value.toFixed(3),
    });
  });
  console.table(out);
  console.log('outputChannelCount =', outputChannelCount, 'masterGain =', masterGainNode?.gain?.value);
  return out;
};

function toggleStripChannel(chan, channelIdx) {
  const current = routingMatrix[chan] || [];
  const filtered = current.filter(c => c !== channelIdx);
  if (filtered.length === current.length) filtered.push(channelIdx);
  filtered.sort((a, b) => a - b);
  routingMatrix[chan] = filtered;
  saveRoutingMatrix();
  // Only rebuild THIS stem's splitter connections. The previous
  // applyRouting() rebuild touched all six stems on every click, which
  // caused an audible ~1s stutter on the others. Per-stem rebuild affects
  // only the changed stem.
  applyRoutingForStem(chan);
  renderRoutingGrids();
}

function applyRoutingForStem(chan) {
  const s = stripNodes && stripNodes[chan];
  if (!s || !masterMerger) return;
  try { s.splitter.disconnect(); } catch (e) {}
  const routes = routingMatrix[chan] || [];
  const sorted = [...routes].sort((a, b) => a - b);
  // Filter out any output indices that don't exist on the current device.
  // Without this, a stem whose ONLY routes are XR18 channels (e.g. Piano's
  // home channel 14 = XR18 ch15) goes silent in stereo-only mode.
  const inRange = sorted.filter(out => out < outputChannelCount);
  const fallback = !inRange.length;
  const effective = fallback ? [0, 1] : inRange;
  // Self-heal: when the fallback fires, also write the corrected routing
  // back into routingMatrix so the UI buttons reflect what is actually
  // playing, and the saved matrix stops being broken on the next reload.
  if (fallback) {
    routingMatrix[chan] = [0, 1];
    try { saveRoutingMatrix(); } catch (e) {}
    try { renderRoutingButtons(); } catch (e) {}
    console.warn(`[routing] ${chan}: all routes were out of range; fell back to L+R and persisted.`);
  }
  if (effective.length === 1) {
    const out = effective[0];
    try { s.splitter.connect(masterMerger, 0, out); } catch (e) {}
    try { s.splitter.connect(masterMerger, 1, out); } catch (e) {}
  } else {
    effective.forEach((out, i) => {
      try { s.splitter.connect(masterMerger, i % 2 === 0 ? 0 : 1, out); } catch (e) {}
    });
  }
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
let clickIdleSince = 0;
// Number of clicks fired since the last toggle-on. Click track auto-disables
// after 4 — short pre-roll counter, not a continuous metronome.
let clickBeatsFired = 0;
const CLICK_MAX_BEATS = 4;

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
      clickBeatsFired = 0;
      clickSchedulerTick();
    }
  });
}

// Where the first downbeat occurs in seconds. Anchors the BPM grid so
// clicks align with the actual beat instead of t=0 (which is usually intro
// silence or anacrusis). Computed once per song from the first onset; if
// onsets aren't ready yet, falls back to 0.
function getBeatOffsetSec() {
  if (typeof clickBeatOffsetOverride === 'number') return clickBeatOffsetOverride;
  const onsets = window.songOnsetTimes;
  if (Array.isArray(onsets) && onsets.length) {
    // Skip very-early micro-spikes (< 50 ms) — they're usually fade-in
    // artifacts, not the real first beat.
    for (const t of onsets) { if (t >= 0.05) return t; }
  }
  return 0;
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
  if (songTime == null) {
    // No song playing → start the inactivity countdown. If 5 s elapses
    // without playback the click track auto-disables so it can't sit in
    // a RAF loop forever after a stray button press.
    if (!clickIdleSince) clickIdleSince = Date.now();
    else if (Date.now() - clickIdleSince > 5000) {
      clickEnabled = false;
      clickIdleSince = 0;
      const btn = document.getElementById('btn-click-toggle');
      if (btn) btn.classList.remove('active');
      console.warn('[click] auto-disabled after 5s with no playback');
    }
    return;
  }
  clickIdleSince = 0;

  // Seek detection: if the song time jumped backwards, reset our
  // 'already-scheduled' cursor so future events fire again.
  if (songTime < clickLastSongTime - 0.1) clickLastScheduledBeat = -1;
  clickLastSongTime = songTime;

  const LOOKAHEAD_SEC = 0.2;
  const bpm = (currentSong && currentSong.practiceBpm) || 120;
  const beatSec = 60 / bpm;
  const offset = getBeatOffsetSec();

  // BPM grid anchored to the first real downbeat. Each click lands at
  // offset + N * beatSec — so the BEATS stay BPM-locked but the GRID is
  // aligned to where the song actually starts playing in time. Every 4th
  // beat is treated as a downbeat (higher-pitched click).
  let beatIdx = Math.max(0, Math.floor((songTime - offset) / beatSec));
  while (offset + beatIdx * beatSec < songTime + LOOKAHEAD_SEC) {
    if (beatIdx > clickLastScheduledBeat) {
      const beatTime = offset + beatIdx * beatSec;
      const delay = beatTime - songTime;
      if (delay >= -0.01) {
        fireClickAt(audioCtx.currentTime + Math.max(delay, 0), beatIdx % 4 === 0);
        clickBeatsFired++;
        // After 4 beats, auto-disable. Schedules a small grace so the 4th
        // click is heard before the scheduler stops requesting frames.
        if (clickBeatsFired >= CLICK_MAX_BEATS) {
          setTimeout(() => {
            clickEnabled = false;
            const btn = document.getElementById('btn-click-toggle');
            if (btn) btn.classList.remove('active');
          }, Math.max(0, delay * 1000) + 80);
        }
      }
      clickLastScheduledBeat = beatIdx;
    }
    beatIdx++;
  }
}
// Optional user override for the beat offset — settable via a future "tap
// first beat" button. null means: auto-detect from onsets.
let clickBeatOffsetOverride = null;

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
  // Inject positional buttons IMMEDIATELY so they're visible before the
  // first play. AudioContext is still gated on a click (browser policy),
  // but the routing DOM doesn't need audio — buttons reflect localStorage
  // state and only show as "disabled" for channels beyond what the active
  // output device supports (defaults to 2 until we know more). On the first
  // user click we revisit to sync outputChannelCount + re-render.
  loadRoutingMatrix();
  injectStripRoutingButtons();
  renderRoutingButtons();
  document.addEventListener('click', maybeInitRoutingUI, { once: false });
}

let routingUIReady = false;
function maybeInitRoutingUI() {
  if (!audioCtx || !masterMerger) return;
  if (!routingUIReady) {
    routingUIReady = true;
    // Buttons may already exist from boot-time inject; re-render to sync
    // their disabled state to the now-known outputChannelCount.
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
  // Pre-show readiness UX: until the user has run the Sound Check (or pressed
  // Play, which has the same gesture-activated side effect), the browser
  // hasn't told us the real device channel count. Show an inviting "Run
  // Sound Check" button instead of the cryptic "click to reload" banner —
  // clicking it (a) supplies the user gesture, (b) builds the audio graph,
  // (c) probes the actual max channels, and (d) plays a quick test tone on
  // every XR18 output so the FOH engineer can see audio land on every channel.
  if (!audioCtx) {
    info.innerHTML = `
      <button class="routing-tag soundcheck-cta routing-soundcheck" title="Activate the audio device, detect channel count, and play a brief test tone on each output. Do this before the first song so the band knows the rig is hot.">
        🔊 Run Sound Check
      </button>
    `;
  } else if (outputChannelCount <= 2) {
    const stamp = window.__soundCheckStamp ? ` · checked ${window.__soundCheckStamp}` : '';
    info.innerHTML = `
      <button class="routing-tag stereo-only routing-reprobe" title="Stereo only — XR18 not detected. Make sure it's selected in macOS Sound, then reload.">
        Stereo only · ${outputChannelCount} ch${stamp} · click to reload &amp; re-detect
      </button>
      <button class="btn-secondary routing-soundcheck" title="Re-run the sound check now">Sound Check</button>
    `;
  } else {
    // XR18 (or any multi-channel device) is live. Loud green badge so the
    // band can see at a glance that they ARE routed to the XR18, not the
    // laptop speakers.
    const deviceName = outputChannelCount === 18 ? 'XR18' : `${outputChannelCount}-ch device`;
    const stamp = window.__soundCheckStamp ? ` · checked ${window.__soundCheckStamp}` : '';
    info.innerHTML = `
      <button class="routing-tag multi-active routing-reprobe" title="Switched device? Click to reload the page so Web Audio re-detects the channel count.">
        ● ${deviceName} ACTIVE · ${outputChannelCount} ch out${stamp}
      </button>
      <button class="btn-secondary routing-soundcheck" title="Re-run the sound check — plays a brief test tone on every XR18 output.">Sound Check</button>
      <button class="btn-secondary routing-preset-stereo" title="All stems → Out 1-2 only">Preset: Stereo</button>
      <button class="btn-secondary routing-preset-spread" title="Each stem fans to outputs 1-2, 3-4, and 5-6 (three amp aux sends)">Preset: Spread to 6 AUX</button>
    `;
  }
  const ps = info.querySelector('.routing-preset-stereo');
  const pS = info.querySelector('.routing-preset-spread');
  const reprobe = info.querySelector('.routing-reprobe');
  const sc = info.querySelector('.routing-soundcheck');
  if (ps) ps.addEventListener('click', presetStereoMain);
  if (pS) pS.addEventListener('click', presetSpreadToSixAux);
  if (reprobe) reprobe.addEventListener('click', reprobeAudioDevice);
  if (sc) sc.addEventListener('click', runSoundCheck);
}

// Pre-show readiness check.
// 1. Supplies the user-gesture browsers require before they will report the
//    real device channel count.
// 2. Creates the AudioContext (initAudioCtx is gated on the gesture flag).
// 3. Probes destination.maxChannelCount. If the XR18 is selected as system
//    output, this is the moment we learn 18 not 2.
// 4. Plays a brief 440 Hz sine tone on every output channel in sequence, so
//    the FOH engineer can confirm signal lands on every XR18 input. Each
//    tone is short (~180 ms) and quiet (~-12 dBFS).
// 5. Updates the badge to "✓ N channels verified at HH:MM" so the band can
//    see at a glance that the rig is hot before downbeat.
let soundCheckInProgress = false;
async function runSoundCheck() {
  if (soundCheckInProgress) return;
  soundCheckInProgress = true;
  window.__hadUserGesture = true;          // we're inside a click handler
  try {
    initAudioCtx();
    if (audioCtx && audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {}
    }
    if (!audioCtx) {
      alert('Sound Check: could not create AudioContext. Try reloading the page.');
      return;
    }
    // After gesture + resume, re-read max channel count and adopt it.
    const detected = audioCtx.destination.maxChannelCount || 2;
    if (detected !== outputChannelCount) outputChannelCount = detected;
    if (audioCtx.destination.channelCount !== detected) {
      try {
        audioCtx.destination.channelCount = detected;
        audioCtx.destination.channelCountMode = 'explicit';
        audioCtx.destination.channelInterpretation = 'discrete';
      } catch (e) { console.warn('[soundcheck] destination channel set rejected:', e.message); }
    }
    // Banner — temporarily replaces the routing tag while the test runs.
    const tag = document.querySelector('.routing-tag');
    if (tag) {
      tag.textContent = `🔊 Sound check… 0/${detected}`;
      tag.classList.add('soundcheck-running');
    }

    // Build a dedicated test-tone subgraph: osc → gain → merger → destination.
    // We don't reuse stripNodes because the song graph may not exist yet on a
    // cold launch and we want this to work whether or not a song is loaded.
    const merger = audioCtx.createChannelMerger(detected);
    try {
      merger.channelCount = detected;
      merger.channelCountMode = 'explicit';
      merger.channelInterpretation = 'discrete';
    } catch (e) {}
    merger.connect(audioCtx.destination);

    const TONE_HZ = 440;
    const TONE_MS = 180;
    const GAP_MS  = 80;
    const GAIN    = 0.25;   // ~-12 dBFS, comfortable on headphones too
    for (let ch = 0; ch < detected; ch++) {
      const osc = audioCtx.createOscillator();
      const g   = audioCtx.createGain();
      osc.frequency.value = TONE_HZ;
      g.gain.setValueAtTime(0, audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(GAIN, audioCtx.currentTime + 0.01);
      g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + TONE_MS / 1000);
      osc.connect(g);
      g.connect(merger, 0, ch);   // mono signal → input #ch of the merger
      osc.start();
      osc.stop(audioCtx.currentTime + TONE_MS / 1000 + 0.02);
      if (tag) tag.textContent = `🔊 Sound check… ${ch + 1}/${detected}`;
      // Light up the matching strip button (if present) so the user sees
      // which channel is currently sounding. Bright class fades naturally
      // via CSS transition.
      document.querySelectorAll(`.pos-btn[data-ch="${ch}"]`).forEach(b =>
        b.classList.add('soundcheck-flash')
      );
      await new Promise(r => setTimeout(r, TONE_MS + GAP_MS));
      document.querySelectorAll(`.pos-btn[data-ch="${ch}"]`).forEach(b =>
        b.classList.remove('soundcheck-flash')
      );
    }
    try { merger.disconnect(); } catch (e) {}

    if (tag) tag.classList.remove('soundcheck-running');
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    window.__soundCheckStamp = `${hh}:${mm}`;
    // Re-render the header info — picks up the new outputChannelCount, the
    // checked-at stamp, and (if the song graph already exists) re-syncs the
    // routing strip enabled/disabled states.
    try { maybeInitRoutingUI(); } catch (e) {}
    injectMixerHeaderInfo();
    // Re-render routing strips so disabled XR18-channel buttons un-grey.
    try { injectStripRoutingButtons(); renderRoutingButtons(); } catch (e) {}
    if (detected <= 2) {
      alert(`Sound Check finished. Only ${detected} channels detected.\n` +
            `If the XR18 is plugged in, select it as macOS system output and click "click to reload".`);
    }
  } finally {
    soundCheckInProgress = false;
  }
}

// Force the audio context to re-evaluate the destination's maximum channel
// count, set destination.channelCount accordingly, and re-render the routing
// UI. Use this after plugging in a new audio device (XR18, etc.) so the
// portal picks it up without a full page reload.
async function reprobeAudioDevice() {
  // Hard truth about Web Audio: destination.maxChannelCount is captured
  // when the AudioContext is created, and it cannot be changed afterward.
  // No amount of resetting node.channelCount changes what the underlying
  // OS routing reports. The ONLY way to pick up an XR18 (or any multi-
  // channel device) you plugged in mid-session is to:
  //   1. Set the device as your macOS system output (System Settings → Sound)
  //   2. Create a fresh AudioContext, which only happens on page load
  //
  // So this button now:
  //   - Confirms the user has the device selected as system output
  //   - Reloads the page (creating a fresh AudioContext that probes the
  //     now-selected device for its real max channel count)
  //
  // The portal's state (active gig, last song, mixer state) is persisted
  // in localStorage, so reload is fully lossless.
  const cur = audioCtx ? (audioCtx.destination.maxChannelCount || 2) : 'unknown';
  const ok = confirm(
    `This page sees the audio device as ${cur}-channel.\n\n` +
    `Web Audio reads the channel count once when the page loads — it can't be re-detected on the fly. If you've just plugged in your XR18 (or switched system output), you need to reload.\n\n` +
    `1. Make sure XR18 is selected in macOS System Settings → Sound → Output\n` +
    `2. Click OK to reload\n\n` +
    `The portal's state will restore automatically.`
  );
  if (ok) location.reload();
}

function injectStripRoutingButtons() {
  // Positional routing layout: each named output channel sits at the position
  // around the fader-container that mirrors its location in the band's
  // hologram-style stem image.
  //
  //         V (top: Vocals — front/center)
  //    O  ┌─────┐  P    (corners: Other / Piano)
  //    L  │fader│  R    (sides: Stereo L/R)
  //    G  └─────┘  B    (corners: Guitar / Bass)
  //         D            (bottom: Drums)
  //         [M][S]
  //         [3-10, 17-18]  (remaining numeric XR18 outputs)
  //
  // Channel indices are 0-based to match routingMatrix; the channel NUMBER
  // shown to the user is ch+1. Buttons above outputChannelCount are visibly
  // disabled but remain present for when an XR18 is plugged in mid-session.
  // Build the layout via nested flex containers — each row's role is
  // established by its parent flex direction + child ordering, no CSS grid
  // template area resolution needed. Bulletproof against per-strip CSS
  // overrides (e.g. inline display: flex set elsewhere).
  const LEFT_BUTTONS = [
    { ch: 15, pos: 'O', label: 'Other (ch 16)' },
    { ch: 0,  pos: 'L', label: 'Stereo Left (ch 1)' },
    { ch: 13, pos: 'G', label: 'Guitar (ch 14)' },
  ];
  const RIGHT_BUTTONS = [
    { ch: 14, pos: 'P', label: 'Piano (ch 15)' },
    { ch: 1,  pos: 'R', label: 'Stereo Right (ch 2)' },
    { ch: 12, pos: 'B', label: 'Bass (ch 13)' },
  ];
  const TOP_BUTTON    = { ch: 10, pos: 'V', label: 'Vocals (ch 11)' };
  const BOTTOM_BUTTON = { ch: 11, pos: 'D', label: 'Drums (ch 12)' };
  const NUMERIC       = [2, 3, 4, 5, 6, 7, 8, 9, 16, 17];

  const makeBtn = (chan, ch, pos, label, extraClass = '') => {
    const btn = document.createElement('button');
    btn.className = `pos-btn pos-${pos}${extraClass ? ' ' + extraClass : ''}`;
    btn.dataset.ch = ch;
    btn.textContent = pos;
    btn.title = `Route ${chan} stem to ${label}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleStripChannel(chan, ch);
    });
    return btn;
  };

  document.querySelectorAll('.channel-strip').forEach(strip => {
    if (strip.querySelector('.pos-middle-row')) return;
    const chan = stripChannelName(strip);
    if (!chan) return;
    const fader = strip.querySelector('.fader-container');
    if (!fader) return;

    // Force strip to flex-column regardless of any inline display override
    // (e.g. the `c.style.display = 'flex'` set elsewhere when a stems song
    // loads — we want column flow here, not row).
    strip.style.display = 'flex';
    strip.style.flexDirection = 'column';

    // M/S row belongs UNDER the D button (Bill's spec), not inside the
    // fader-container. Pull it out so we can re-append after bottomRow.
    const channelButtons = fader.querySelector('.channel-buttons');
    if (channelButtons) channelButtons.remove();

    const topRow = document.createElement('div');
    topRow.className = 'pos-top-row';
    topRow.appendChild(makeBtn(chan, TOP_BUTTON.ch, TOP_BUTTON.pos, TOP_BUTTON.label));

    const middleRow = document.createElement('div');
    middleRow.className = 'pos-middle-row';
    const leftCol = document.createElement('div');
    leftCol.className = 'pos-side-left';
    LEFT_BUTTONS.forEach(b => leftCol.appendChild(makeBtn(chan, b.ch, b.pos, b.label)));
    const rightCol = document.createElement('div');
    rightCol.className = 'pos-side-right';
    RIGHT_BUTTONS.forEach(b => rightCol.appendChild(makeBtn(chan, b.ch, b.pos, b.label)));
    middleRow.appendChild(leftCol);
    middleRow.appendChild(fader);  // moves fader-container INTO middle row
    middleRow.appendChild(rightCol);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'pos-bottom-row';
    // Boost buttons flank the D button: gentle (+5 / +10) for live mix
    // shaping, extreme (+20 / +50) as diagnostic probes -- "what's actually
    // in this stem if I crank it through the noise floor?" +20 dB ≈ 10x,
    // +50 dB ≈ 316x, which WILL clip anything with real content but lets
    // the operator hear faint bleed (e.g. Demucs leaks). Mutually exclusive
    // 5-state latch (off → +N → off; selecting any one turns the others off).
    const makeBoost = (db) => {
      const b = document.createElement('button');
      b.className = `boost-btn boost-${db}` + (db >= 20 ? ' boost-extreme' : '');
      b.textContent = `+${db}`;
      const isExtreme = db >= 20;
      b.title = isExtreme
        ? `Boost this strip by +${db} dB (~${db === 20 ? '10x' : '316x'} gain). DIAGNOSTIC -- will clip real signal. Use to hear faint bleed.`
        : `Boost this strip by +${db} dB. Click again to disable; mutually exclusive with other boost buttons.`;
      b.addEventListener('click', e => {
        e.stopPropagation();
        const cur = mixerState.boost[chan] || 0;
        mixerState.boost[chan] = (cur === db) ? 0 : db;
        strip.querySelectorAll('.boost-btn').forEach(btn => {
          const bdb = parseInt(btn.className.match(/boost-(\d+)/)[1], 10);
          btn.classList.toggle('latched', mixerState.boost[chan] === bdb);
        });
        applyMixerVolumes();
      });
      return b;
    };
    bottomRow.appendChild(makeBoost(5));
    bottomRow.appendChild(makeBoost(10));
    bottomRow.appendChild(makeBtn(chan, BOTTOM_BUTTON.ch, BOTTOM_BUTTON.pos, BOTTOM_BUTTON.label));
    bottomRow.appendChild(makeBoost(20));
    bottomRow.appendChild(makeBoost(50));

    const numericRow = document.createElement('div');
    numericRow.className = 'pos-numeric-row';
    NUMERIC.forEach(ch => {
      numericRow.appendChild(makeBtn(chan, ch, ch + 1, `Output ${ch + 1}`, 'pos-numeric'));
    });

    strip.insertBefore(topRow, strip.firstChild);
    strip.appendChild(middleRow);
    strip.appendChild(bottomRow);
    if (channelButtons) strip.appendChild(channelButtons);
    strip.appendChild(numericRow);
  });
}

function stripChannelName(strip) {
  for (const ch of Object.keys(audioElements)) {
    if (strip.classList.contains(`${ch}-strip`)) return ch;
  }
  return null;
}

function renderRoutingGrids() {
  document.querySelectorAll('.channel-strip').forEach(strip => {
    const chan = stripChannelName(strip);
    if (!chan) return;
    const routes = routingMatrix[chan] || [];
    strip.querySelectorAll('.pos-btn[data-ch]').forEach(btn => {
      const ch = parseInt(btn.dataset.ch, 10);
      btn.classList.toggle('active', routes.includes(ch));
      btn.disabled = ch >= outputChannelCount;
    });
  });
}

// Alias: legacy call sites still use renderRoutingButtons; route them to the
// new positional renderer. (summarizeRouting was removed with the old
// .strip-routing-grid — the positional layout encodes the routing visually.)
function renderRoutingButtons() { renderRoutingGrids(); }

// Load song into the mixer
function loadSong(song, opts) {
  opts = opts || {};
  // Defer AudioContext creation until the FIRST user gesture has actually
  // happened. Browsers freeze destination.maxChannelCount at ctx-creation
  // time, AND they only see the true device channel count after a user
  // gesture has activated audio output. If we create the ctx during boot
  // auto-restore (no user gesture yet), the XR18 reports as 2-ch stereo
  // and stays that way forever — until the user finally clicks something,
  // which used to require a page reload. By deferring init to here-with-
  // gesture (or to togglePlayPause), the FIRST play click finds the XR18.
  const userGestureSeen = !!(window.__hadUserGesture) || !!opts.autoplay;
  if (userGestureSeen) initAudioCtx();
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

  // Drop the drum machine if it was engaged for the previous song.
  // Otherwise a song-switch would leave the old pattern looping forever.
  if (drumMachineActive) disengageDrumMachine();

  // Reset playback speed to 1.0× on every song load. Carrying a slowed
  // tempo across songs in a setlist is rarely what the operator wants
  // (they slowed Song A for a rehearsal pass, then Song B starts in
  // slo-mo without warning). Mirrors the LOOPER reset above.
  setPlaybackSpeed(1.0);
  if (els.speedSlider) els.speedSlider.value = '1';

  // Restore master gain to the user's slider level (undoes any prior fade-out
  // without overriding the volume they've set on the right-rail slider).
  currentMasterVolume = els.masterVol ? parseFloat(els.masterVol.value) : 1.0;
  // Guarded: when called from auto-restore before any user gesture, audioCtx
  // is intentionally still null (see deferred-init note above). togglePlayPause
  // will set the master gain properly on first play.
  if (audioCtx && masterGainNode) {
    masterGainNode.gain.setValueAtTime(currentMasterVolume, audioCtx.currentTime);
  }

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
  // Remember which song was last loaded so the next app start can resume.
  const _songBaseForRestore = songBaseOf(song);
  if (_songBaseForRestore) {
    try { localStorage.setItem(LAST_SONG_BASE_KEY, _songBaseForRestore); } catch (e) {}
  }
  // Load this song's MIDI automation so the lane shows its markers and the
  // dispatcher fires events during playback.
  loadAutomationForSong(_songBaseForRestore);
  // Kick off server-side precache so subsequent plays of this song are
  // hot. Fire-and-forget; the audio elements still drive the immediate
  // first-play stream. This dramatically reduces the cold-fetch wait for
  // the NEXT song the user clicks if it's already in a setlist.
  const songBaseForPrecache = songBaseOf(song);
  if (songBaseForPrecache) {
    fetch(`/api/precache/stems/${encodeURIComponent(songBaseForPrecache)}`, { method: 'POST' })
      .catch(() => {});
    // Log to Recents so the synthetic __recents__ pseudo-gig shows the
    // last 50 things you actually loaded. Performer-side; survives reloads.
    fetch('/api/recents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: songBaseForPrecache }),
    }).catch(() => {});
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
  // Player-pane favorite star — find the stems variant for this song so we
  // can read/write the favorite flag without needing to look up by folder
  // again on every click.
  try {
    const starBtn = document.getElementById('active-track-star');
    if (starBtn) {
      const merged = mergedLibrary.find(m => m.variants.some(v => v.id === song.id));
      const stemsVar = merged && merged.variants.find(v => v.type === 'stems');
      if (stemsVar && stemsVar.folderName) {
        const isFav = !!stemsVar.favorite;
        starBtn.style.display = '';
        starBtn.textContent = isFav ? '★' : '☆';
        starBtn.classList.toggle('on', isFav);
        starBtn.title = isFav ? 'Favorite — click to unstar' : 'Click to favorite';
        starBtn.onclick = async (e) => {
          e.stopPropagation();
          const newVal = !stemsVar.favorite;
          stemsVar.favorite = newVal;
          starBtn.textContent = newVal ? '★' : '☆';
          starBtn.classList.toggle('on', newVal);
          starBtn.title = newVal ? 'Favorite — click to unstar' : 'Click to favorite';
          try {
            await fetch(`/api/song/${encodeURIComponent(stemsVar.folderName)}/favorite`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ favorite: newVal }),
            });
          } catch (err) { console.warn('[favorite] player-pane save failed:', err); }
          if (typeof renderLibrary === 'function') renderLibrary();
          if (typeof renderGigSidebar === 'function') renderGigSidebar();
        };
      } else {
        starBtn.style.display = 'none';
      }
    }
  } catch (e) {}
  els.activeBpm.textContent = song.practiceBpm || '--';
  els.activeKey.textContent = song.key || '--';
  if (els.activeKeySignature) {
    els.activeKeySignature.textContent = song.keySignature ? `(${song.keySignature})` : '';
  }
  // Drum Machine button — ALWAYS visible now. Asks the server to pick the
  // right DRUM_MACHINE/*.m4a for this song: prefers metadata.drum_pattern,
  // falls back to the 110@<bpm> metronome series. Stash the chosen URL on
  // window so the click handler can play it without re-querying. Cache
  // alternates too for the right-click override menu.
  const drumPillEl = document.getElementById('active-meta-drum');
  const drumValEl  = document.getElementById('active-drum-value');
  const drumPattern = song.drum_pattern || song.drumPattern || '';
  if (drumPillEl && drumValEl) {
    drumPillEl.style.display = '';
    drumValEl.textContent = drumPattern || (song.practiceBpm ? `≈${song.practiceBpm}` : '--');
    refreshDrumMachinePick(drumPattern, song.practiceBpm).catch(e =>
      console.warn('[drum-machine] pick failed:', e));
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
  
  // Any active LOOPER from the previous song must stop NOW — otherwise its
  // AudioBufferSourceNodes keep looping on top of the new song's audio.
  stopLooperIfActive();

  if (song.type === 'stems') {
    els.trackType.textContent = 'STEMS';
    els.trackType.className = 'badge';
    els.mixerContainer.style.display = 'block';
    
    document.querySelectorAll('.channel-strip').forEach(c => c.style.display = 'grid');
    
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
      const _so = document.querySelector('.stretch-outro-card');
      if (_so) { _so.style.opacity = '1'; _so.style.pointerEvents = 'auto'; }
      renderLoopButtons(song.loops);
    } else {
      els.loopsContainer.style.display = 'none';
      const _so2 = document.querySelector('.stretch-outro-card');
      if (_so2) { _so2.style.opacity = '0.5'; _so2.style.pointerEvents = 'none'; }
      if (els.stretchToggle) els.stretchToggle.checked = false;
      stretchActive = false;
      toggleStretchState();
    }
  } else {
    // M4A Track
    els.trackType.textContent = 'M4A BACKING TRACK';
    els.trackType.className = 'badge m4a-badge';
    
    els.mixerContainer.style.display = 'none';
    els.loopsContainer.style.display = 'none';
    // Outro Jam Stretch DOM was removed (task #139, replaced by LOOPER) —
    // guard every read so a missing element doesn't crash loadSong.
    const _strCard = document.querySelector('.stretch-outro-card');
    if (_strCard) { _strCard.style.opacity = '0.5'; _strCard.style.pointerEvents = 'none'; }
    if (els.stretchToggle) els.stretchToggle.checked = false;
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
  
  // Track which section's clickIn pre-roll we've already scheduled so we
  // don't re-fire the same one every 100ms.
  let lastClickInSectionIdx = -1;
  syncInterval = setInterval(() => {
    if (!isPlaying) return;

    let masterTime = masterAe.currentTime;

    // Section-attached click pre-roll: when the playhead approaches the
    // start of a section whose clickIn flag is true, fire 4 beats of click
    // timed to land exactly at the section boundary. Skips the FIRST
    // section because that case is handled by togglePlayPause's
    // pre-roll (4 silent clicks before audio starts).
    if (audioCtx && Array.isArray(automationSections) && automationSections.length > 1) {
      const bpm = (currentSong && currentSong.practiceBpm) || 120;
      const beatSec = 60 / bpm;
      const window = 4 * beatSec + 0.15;
      // section[i].startT = i==0 ? 0 : automationSections[i-1].t. Walk only
      // mid-song sections (i >= 1).
      const sorted = automationSections.slice().sort((a, b) => a.t - b.t);
      for (let i = 1; i < sorted.length; i++) {
        if (!sorted[i] || !sorted[i].clickIn) continue;
        const startT = sorted[i - 1].t;
        const dt = startT - masterTime;
        if (dt >= 0 && dt < window && lastClickInSectionIdx !== i) {
          // Schedule 4 clicks landing on startT - 4*beatSec ... startT.
          // audioCtx time of the first click = current ctx time + (dt - 4*beatSec).
          const startCtxT = audioCtx.currentTime + (dt - 4 * beatSec);
          for (let k = 0; k < 4; k++) {
            try { fireClickAt(Math.max(audioCtx.currentTime, startCtxT + k * beatSec), true); }
            catch (e) {}
          }
          lastClickInSectionIdx = i;
          break;
        }
      }
      // Reset the "already scheduled" guard when the playhead moves well
      // past or before any pending section start so subsequent crossings
      // re-fire (covers seek + LOOPER wrap).
      if (lastClickInSectionIdx >= 0) {
        const sec = sorted[lastClickInSectionIdx];
        const startT = sorted[lastClickInSectionIdx - 1]?.t || 0;
        if (sec && (masterTime > startT + 1 || masterTime < startT - 8)) {
          lastClickInSectionIdx = -1;
        }
      }
    }

    // Section LOOPER: while seamless AudioBuffer loop is playing, the
    // MediaElement is silenced but still advances. Rewind it 50ms early
    // so the timeline UI follows the loop. The audio is sample-accurate
    // via the AudioBufferSourceNode; this rewind only affects the
    // displayed playhead + automation event dispatch.
    if (sectionLooperActive && sectionLooperRange) {
      const { startT, endT } = sectionLooperRange;
      if (masterTime >= endT - 0.05) {
        for (const chan of activeTracks) {
          const ae = audioElements[chan];
          if (!ae) continue;
          try {
            ae.currentTime = startT;
            if (ae.paused) ae.play().catch(() => {});
          } catch (e) {}
        }
        automationLastTime = startT;
        automationEvents.forEach(e => { if (e.t >= startT) e.fired = false; });
        masterTime = startT;
      }
    }

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
let countInInProgress = false;

async function togglePlayPause() {
  if (!currentSong) return;
  // Re-entry guard: while a count-in pre-roll is awaiting, ignore further
  // toggle requests. Without this, rapid Play presses pile up overlapping
  // pre-rolls and freeze the UI.
  if (countInInProgress) {
    console.warn('[togglePlayPause] count-in in progress; ignoring re-entry');
    return;
  }

  try { initAudioCtx(); } catch (e) { console.warn('[audioCtx] init failed:', e); }
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (e) {}
  }

  // Mutual exclusion: pressing Play disengages the drum machine if it's
  // running. Drum machine and backing track never coexist.
  if (drumMachineActive) {
    disengageDrumMachine();
  }

  let activeElements = Object.values(audioElements).filter(ae => audioHasSrc(ae));

  if (isPlaying) {
    activeElements.forEach(ae => ae.pause());
    isPlaying = false;
    els.btnPlay.innerHTML = `<i data-lucide="play"></i>`;
    clearInterval(syncInterval);
    stopBeatingVisualizer();
    stopPlayheadSaverAndFlush();
    // Stop the seamless-loop BufferSources too. Pausing the MediaElement
    // alone wasn't enough — the BufferSources run on the AudioContext's
    // own clock and kept playing the loop until the user loaded a new
    // song. Now: hit Stop, LOOPER stops with it (and disengages so the
    // green pill UI also reflects the new state).
    try { stopLooperIfActive(); } catch (e) { console.warn('[stop] looper teardown failed:', e); }
    applyMixerVolumes();
    lucide.createIcons();
    return;
  }

  if (activeElements.length === 0) {
    // stopAudio() (called by engageDrumMachine) clears every audio element's
    // src. When the operator hits Play after a drum-machine session, we
    // need to reload the current song into the elements before starting.
    // loadSong with autoplay:true handles both rehydration and start.
    if (currentSong) {
      console.log('[togglePlayPause] sources empty after stop; reloading currentSong with autoplay');
      loadSong(currentSong, { autoplay: true });
      return;
    }
    console.warn('[togglePlayPause] no active audio elements; nothing to play');
    return;
  }

  const masterAe0 = activeElements[0];
  const isFreshStart = masterAe0.currentTime < 1.5;

  // Count-in TRUE PRE-ROLL — aligned to the song's first detected onset.
  //
  // Old algorithm: 4 clicks ending at t=audio-start, audio starts on what
  // would be beat 5. That works ONLY when the audio file's downbeat is at
  // currentTime=0. Real songs start with a silent runup or an anacrusis,
  // so when the count finished, the players hit silence instead of the
  // downbeat -- and they stopped trusting the count-in.
  //
  // New algorithm: detect when the first real downbeat happens (via
  // getBeatOffsetSec(), which walks window.songOnsetTimes -- the same
  // onset table the visual click grid uses, so they always agree). Then
  // project the 4 count clicks BACKWARDS from that moment so beat-1 of
  // the song hits exactly where the count would call "five". Three cases:
  //
  //   firstDownbeat == 0      → audio waits 4 beats (original behavior)
  //   firstDownbeat <  4 beats → audio starts after a short pre-roll;
  //                              click 1 fires before audio.play()
  //   firstDownbeat ≥ 4 beats → audio starts NOW (intro silence covers
  //                              the count); the 4 clicks fire during
  //                              the intro and land right before downbeat.
  //
  // Section-aware: fires if either the legacy song-level automationCountIn
  // is set OR the first section has clickIn=true.
  const firstSectionClickIn = !!(automationSections && automationSections[0] && automationSections[0].clickIn);
  if ((automationCountIn || firstSectionClickIn) && isFreshStart && audioCtx) {
    countInInProgress = true;
    els.btnPlay.innerHTML = `<i data-lucide="hash"></i>`;
    els.btnPlay.disabled = true;
    try {
      const bpm = (currentSong && currentSong.practiceBpm) || 120;
      const beatSec = 60 / bpm;
      const songFirstBeat = getBeatOffsetSec();     // seconds into audio
      const countDur      = 4 * beatSec;
      // How long to delay audio.play() so we have room for all 4 clicks
      // before the first audible downbeat. Zero when the song's intro is
      // already at least 4 beats of silence.
      const preRollSec    = Math.max(0, countDur - songFirstBeat);
      const audioStartCtx = audioCtx.currentTime + 0.04 + preRollSec;
      const firstDownbeatCtx = audioStartCtx + songFirstBeat;

      console.log(`[count-in] bpm=${bpm}, beatSec=${beatSec.toFixed(3)}, ` +
        `songFirstBeat=${songFirstBeat.toFixed(3)}s, preRoll=${preRollSec.toFixed(3)}s, ` +
        `audio starts in ${(audioStartCtx - audioCtx.currentTime).toFixed(3)}s, ` +
        `downbeat hits in ${(firstDownbeatCtx - audioCtx.currentTime).toFixed(3)}s`);

      // Clicks 1..4 land one beat apart, with click 4 exactly one beat
      // before the song's first downbeat. So the player counts
      // "1-2-3-4" and the song says "[1]" right on the next beat.
      for (let i = 1; i <= 4; i++) {
        const t = firstDownbeatCtx - i * beatSec;
        if (t < audioCtx.currentTime) continue;   // skip clicks already in the past
        try { fireClickAt(t, true); }
        catch (e) { console.warn('[count-in] fireClickAt failed:', e); }
      }
      let waitMs = (audioStartCtx - audioCtx.currentTime) * 1000;
      // Sanity-cap to 8 seconds (= 30 BPM × 4) so a NaN or runaway value
      // can't permanently freeze the UI. Anything under 30 BPM is unusual.
      waitMs = Math.max(0, Math.min(8000, isFinite(waitMs) ? waitMs : 0));
      await new Promise(r => setTimeout(r, waitMs));
    } catch (e) {
      console.warn('[count-in] pre-roll failed:', e);
    } finally {
      countInInProgress = false;
      els.btnPlay.disabled = false;
      lucide.createIcons();
    }
  }

  // Play-clip pre-roll. Bill: "If the clip is dropped at the beginning
  // of the visualizer, play the clip before starting the playback of
  // the backing track." Any play-clip event anchored at t <= 0.05
  // counts as a pre-roll: it fires in parallel with any other pre-roll
  // clips, the backing track waits for the longest to end, then plays
  // normally. Fired flag is set so the regular dispatcher doesn't
  // double-fire them once the playhead crosses t=0.
  if (isFreshStart && Array.isArray(automationEvents)) {
    const prerollClips = automationEvents.filter(e =>
      e && e.type === 'play-clip' && typeof e.t === 'number' && e.t <= 0.05);
    if (prerollClips.length) {
      countInInProgress = true;
      els.btnPlay.disabled = true;
      els.btnPlay.innerHTML = `<i data-lucide="hash"></i>`;
      try { initAudioCtx(); } catch (e) {}
      try {
        const promises = prerollClips.map(ev => new Promise(resolve => {
          ev.fired = true;
          const boostDb = Number(ev.boost) || 0;
          const boostGain = Math.pow(10, boostDb / 20);
          const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(ev.clip || ''));
          a.preload = 'auto';
          a.crossOrigin = 'anonymous';
          a.volume = 1.0;
          if (audioCtx && masterGainNode) {
            try {
              const src = audioCtx.createMediaElementSource(a);
              if (boostGain !== 1.0) {
                const g = audioCtx.createGain();
                g.gain.value = boostGain;
                src.connect(g).connect(masterGainNode);
              } else {
                src.connect(masterGainNode);
              }
            } catch (er) { console.warn('[preroll-clip] wire failed:', er); }
          }
          const done = () => { try { a.removeAttribute('src'); } catch(e) {} resolve(); };
          a.addEventListener('ended', done);
          a.addEventListener('error', done);
          a.play().catch(done);
          // Hard cap so a corrupt file doesn't hang the song forever.
          setTimeout(done, 60000);
        }));
        await Promise.all(promises);
      } catch (e) {
        console.warn('[preroll-clip] pre-roll failed:', e);
      } finally {
        countInInProgress = false;
        els.btnPlay.disabled = false;
        lucide.createIcons();
      }
    }
  }

  const masterTime = masterAe0.currentTime;
  activeElements.forEach(ae => {
    ae.currentTime = masterTime;
    ae.play().catch(err => console.warn('[audio.play] rejected:', err, 'src=', ae.src));
  });
  isPlaying = true;
  els.btnPlay.innerHTML = `<i data-lucide="pause"></i>`;

  startSyncLoop();
  startBeatingVisualizer(currentSong.practiceBpm || 100);
  startPlayheadSaver();

  applyMixerVolumes();
  lucide.createIcons();
}

// ─── Drum Machine button ──────────────────────────────────────────
//
// Top-of-screen Drum / pattern chip is always live. On load we ask the
// server which file under DRUM_MACHINE/ to use for this song:
//   - explicit metadata.drum_pattern → that file (source='exact')
//   - else 110@<bpm> metronome series, nearest match (source='metronome-*')
// Click toggles between backing track and drum loop. While the drum loop
// is engaged the backing track is paused and the drum element plays on
// loop through a dedicated source -> master-gain chain so the mixer's
// master volume + the master mute behaviour still apply.
// Right-click opens an override picker with nearby 110@N patterns.
let drumMachineEl    = null;     // <audio> for the pattern, lazily created
let drumMachineSrc   = null;     // MediaElementSource feeding masterMerger
let drumMachineActive = false;
let drumMachineUrl   = null;     // currently-selected URL (set by refresh)
let drumMachineFile  = null;     // currently-selected filename
let drumMachineAlternates = [];  // alternates for the right-click menu

function ensureDrumMachineEl() {
  if (drumMachineEl) return drumMachineEl;
  drumMachineEl = new Audio();
  drumMachineEl.preload = 'auto';
  drumMachineEl.loop = true;
  drumMachineEl.crossOrigin = 'anonymous';
  // Wire into the master bus AFTER the user gesture creates audioCtx.
  // wireDrumMachineIntoMaster is called from togglePlayPause's gesture
  // path AND from engageDrumMachine, whichever fires first.
  return drumMachineEl;
}

function wireDrumMachineIntoMaster() {
  if (!audioCtx || !masterGainNode || !drumMachineEl || drumMachineSrc) return;
  try {
    drumMachineSrc = audioCtx.createMediaElementSource(drumMachineEl);
    drumMachineSrc.connect(masterGainNode);
  } catch (e) { console.warn('[drum-machine] wireToMaster failed:', e); }
}

async function refreshDrumMachinePick(drumPattern, bpm) {
  const q = new URLSearchParams();
  if (drumPattern) q.set('drum_pattern', drumPattern);
  if (bpm) q.set('bpm', String(bpm));
  let resp;
  try {
    resp = await fetch('/api/drum-machine/pick?' + q.toString()).then(r => r.json());
  } catch (e) {
    drumMachineUrl = null; drumMachineFile = null; drumMachineAlternates = [];
    updateDrumChipLabel(null, '?');
    return;
  }
  drumMachineUrl   = resp.url;
  drumMachineFile  = resp.file;
  drumMachineAlternates = resp.alternates || [];
  // Label: pattern name or fallback to the picked file stem
  // Label = the FILE we're actually going to play, not the requested name.
  // Tag tells the operator which kind of fallback (if any) happened:
  //   (none) = explicit exact match
  //   ≈      = closest pattern in the SAME song-BPM family (preferred fallback)
  //   ⏱      = exact metronome (110@bpm) match
  //   m≈     = closest metronome (110@N) — last resort before "any file"
  const fileLabel = (resp.file || '').replace(/\.m4a$/i, '');
  const tag = resp.source === 'exact'           ? ''
            : resp.source === 'family-near'     ? ' ≈'
            : resp.source === 'metronome-exact' ? ' ⏱'
            : resp.source === 'metronome-near'  ? ' m≈'
            : '';
  updateDrumChipLabel(fileLabel + tag);
  // If the drum machine is currently playing, swap to the new file in place.
  if (drumMachineActive && drumMachineEl && drumMachineUrl) {
    drumMachineEl.src = drumMachineUrl;
    drumMachineEl.play().catch(() => {});
  }
}

function updateDrumChipLabel(label, fallback) {
  const v = document.getElementById('active-drum-value');
  if (v) v.textContent = label || fallback || '--';
}

function engageDrumMachine() {
  if (drumMachineActive || !drumMachineUrl) return;
  initAudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const el = ensureDrumMachineEl();
  wireDrumMachineIntoMaster();
  // FULL STOP of the backing track. Players asked for this at the gig:
  // when they call for "just the drum machine", the backing track shouldn't
  // be lurking paused -- it should be off. Pressing Play after disengaging
  // the drum machine starts the song fresh from the top (or last saved
  // playhead). This is intentional friction so a stem doesn't sneak back
  // in mid-rehearsal.
  if (isPlaying || Object.values(audioElements).some(audioHasSrc)) {
    stopAudio();
  }
  el.src = drumMachineUrl;
  el.currentTime = 0;
  el.play().catch(e => console.warn('[drum-machine] play failed:', e));
  drumMachineActive = true;
  const pill = document.getElementById('active-meta-drum');
  if (pill) pill.classList.add('active');
  const banner = document.getElementById('drum-machine-banner');
  if (banner) banner.classList.add('show');
  if (window.lucide) lucide.createIcons();
}

function disengageDrumMachine() {
  if (!drumMachineActive) return;
  try { drumMachineEl && drumMachineEl.pause(); } catch (e) {}
  if (drumMachineEl) drumMachineEl.currentTime = 0;
  drumMachineActive = false;
  const pill = document.getElementById('active-meta-drum');
  if (pill) pill.classList.remove('active');
  const banner = document.getElementById('drum-machine-banner');
  if (banner) banner.classList.remove('show');
  // Backing track stays STOPPED. The operator presses Play (or spacebar)
  // to start it again — explicit gesture, no surprise resume.
}

function toggleDrumMachine() {
  if (drumMachineActive) disengageDrumMachine();
  else engageDrumMachine();
}

// Right-click context menu: list nearby 110@<bpm> alternates so the
// operator can override the auto-pick mid-rehearsal without leaving
// the player. Click an entry to swap.
let _drumCtxMenuEl = null;
function showDrumContextMenu(x, y) {
  if (!drumMachineAlternates || drumMachineAlternates.length === 0) return;
  hideDrumContextMenu();
  const menu = document.createElement('div');
  menu.className = 'drum-machine-menu';
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;
  menu.innerHTML = drumMachineAlternates.map(f => {
    const isCurrent = (f === drumMachineFile);
    return `<button class="drum-menu-item${isCurrent ? ' current' : ''}" data-file="${f}">${escapeHtml(f.replace(/\.m4a$/i, ''))}</button>`;
  }).join('');
  document.body.appendChild(menu);
  _drumCtxMenuEl = menu;
  menu.querySelectorAll('.drum-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.file;
      drumMachineFile = f;
      drumMachineUrl  = `/api/audio/drum-machine/${encodeURIComponent(f)}`;
      updateDrumChipLabel(f.replace(/\.m4a$/i, ''));
      if (drumMachineActive && drumMachineEl) {
        drumMachineEl.src = drumMachineUrl;
        drumMachineEl.play().catch(() => {});
      }
      hideDrumContextMenu();
    });
  });
  setTimeout(() => {
    document.addEventListener('click', hideDrumContextMenu, { once: true });
  }, 0);
}
function hideDrumContextMenu() {
  if (_drumCtxMenuEl) { _drumCtxMenuEl.remove(); _drumCtxMenuEl = null; }
}

// Wire the button once the DOM is up. Tolerant of multiple boot passes.
function setupDrumMachineButton() {
  const pill = document.getElementById('active-meta-drum');
  if (!pill || pill.dataset.drumWired === '1') return;
  pill.dataset.drumWired = '1';
  pill.style.cursor = 'pointer';
  pill.addEventListener('click', (e) => {
    e.preventDefault();
    toggleDrumMachine();
  });
  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showDrumContextMenu(e.clientX, e.clientY);
  });
}

// ─── Snip a loop from a URL ───────────────────────────────────────
//
// Two-step flow:
//   1. Fetch -- yt-dlp grabs a 60s scratch capture starting at the t=
//      anchor in the URL (or at start_sec). File is saved as raw_*.m4a
//      under CUSTOM_LOOPS/ and surfaced in an inline trim editor.
//   2. Trim -- the editor shows an audio scrubber with draggable IN/OUT
//      handles, a numeric readout, and Preview / Loop / Stop / Save.
//      Save calls /api/custom-loops/trim which copy-codec-cuts via ffmpeg
//      into CUSTOM_LOOPS/<name>.m4a and (by default) deletes the raw.
function setupUrlLoopPanel() {
  const urlEl       = document.getElementById('loop-url');
  const startEl     = document.getElementById('loop-start');
  const captureDurEl= document.getElementById('loop-capture-dur');
  const btnFetch    = document.getElementById('btn-loop-from-url');
  const status      = document.getElementById('loop-url-status');
  const list        = document.getElementById('custom-loops-list');

  const editor     = document.getElementById('loop-trim-editor');
  const fnameEl    = document.getElementById('loop-trim-fname');
  const discardBtn = document.getElementById('btn-loop-discard');
  const timeline   = document.getElementById('loop-trim-timeline');
  const rangeEl    = document.getElementById('loop-trim-range');
  const playheadEl = document.getElementById('loop-trim-playhead');
  const inHandle   = document.getElementById('loop-trim-in');
  const outHandle  = document.getElementById('loop-trim-out');
  const inSecBox   = document.getElementById('loop-trim-in-sec');
  const outSecBox  = document.getElementById('loop-trim-out-sec');
  const durEl      = document.getElementById('loop-trim-dur');
  const btnPlay    = document.getElementById('btn-trim-play');
  const btnPreview = document.getElementById('btn-trim-preview');
  const btnLoop    = document.getElementById('btn-trim-loop');
  const btnStop    = document.getElementById('btn-trim-stop');
  const btnSetIn   = document.getElementById('btn-set-in');
  const btnSetOut  = document.getElementById('btn-set-out');
  const trimNameEl = document.getElementById('loop-trim-name');
  const btnSave    = document.getElementById('btn-trim-save');
  const trimStatus = document.getElementById('loop-trim-status');
  const waveform   = document.getElementById('loop-trim-waveform');
  const savedWrap  = document.getElementById('loop-trim-saved');
  const savedRow   = document.getElementById('loop-trim-saved-row');
  const scrollEl   = document.getElementById('loop-trim-scroll');
  const zoomEl     = document.getElementById('loop-trim-zoom');
  const zoomValEl  = document.getElementById('loop-trim-zoom-val');

  if (!urlEl || !btnFetch || !list || !editor) return;

  function setStatus(text, cls)   { if (status)     { status.textContent = text; status.className = 'url-loop-status ' + (cls || ''); } }
  function setTrimStatus(text, cls) { if (trimStatus) { trimStatus.textContent = text; trimStatus.className = 'url-loop-status ' + (cls || ''); } }

  // ── Step 1: URL auto-parse + Fetch ────────────────────────────────
  urlEl.addEventListener('input', () => {
    // Accept t=<spec> (YouTube + most others) AND start=<seconds>
    // (some podcast / Vimeo links). #t=<spec> too. First match wins.
    const tm = urlEl.value.match(/[?&#]t=([0-9hms]+)|[?&]start=(\d+)/i);
    if (!tm) return;
    let secs;
    if (tm[2]) {
      secs = Number(tm[2]);
    } else {
      const t = tm[1];
      if (/^\d+$/.test(t)) secs = Number(t);
      else {
        const hm = t.match(/(\d+)h/i);
        const mm = t.match(/(\d+)m/i);
        const sm = t.match(/(\d+)s/i);
        secs = (hm ? +hm[1] : 0) * 3600 + (mm ? +mm[1] : 0) * 60 + (sm ? +sm[1] : 0);
      }
    }
    if (!startEl.value && Number.isFinite(secs)) startEl.value = String(secs);
  });

  // Enter in the URL field triggers Fetch -- the primary entry point.
  // Same for the start/duration boxes so the operator can tab through
  // them and hit return.
  [urlEl, startEl, captureDurEl].forEach(el => {
    if (!el) return;
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); btnFetch.click(); }
    });
  });

  btnFetch.addEventListener('click', async () => {
    const url = (urlEl.value || '').trim();
    if (!url) { setStatus('Need a URL.', 'err'); return; }
    // Blank duration -> 0 -> server treats as "fetch the WHOLE audio
    // from start_sec to end of video". Was defaulting to 60s which
    // capped the capture at 60 seconds even on a 3+ minute source.
    const captureDur = Number(captureDurEl.value) || 0;
    const body = { url, duration_sec: captureDur };
    if (startEl.value) body.start_sec = Number(startEl.value);

    btnFetch.disabled = true;
    setStatus('Submitting…', 'loading');
    try {
      const r = await fetch('/api/loops/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setStatus('✗ ' + (d.error || 'submit failed'), 'err'); btnFetch.disabled = false; return; }
      if (d.alreadyExists) { setStatus(`Loaded existing ${d.file}.`, 'ok'); openTrimEditor(d.file); btnFetch.disabled = false; return; }
      setStatus(`Downloading ${d.file}…`, 'loading');
      pollUrlLoopJob(d.job_id, (resp) => {
        btnFetch.disabled = false;
        if (resp.status === 'done') {
          setStatus(`✓ Captured ${resp.file}. Trim + name below.`, 'ok');
          openTrimEditor(resp.file);
        }
      });
    } catch (e) {
      setStatus('✗ ' + e.message, 'err');
      btnFetch.disabled = false;
    }
  });

  function pollUrlLoopJob(jobId, onDone) {
    const timer = setInterval(async () => {
      let d;
      try { d = await fetch('/api/loops/from-url/poll/' + encodeURIComponent(jobId)).then(r => r.json()); }
      catch (e) { return; }
      if (d.status === 'done' || d.status === 'error') {
        clearInterval(timer);
        if (d.status === 'error') setStatus('✗ ' + (d.error || 'download failed'), 'err');
        onDone && onDone(d);
      } else {
        setStatus(d.message || `Downloading… (${jobId.slice(-4)})`, 'loading');
      }
    }, 1500);
  }

  // ── Step 2: trim editor ───────────────────────────────────────────
  // State per open editor.
  let trimSrcFile = null;     // raw_*.m4a in CUSTOM_LOOPS/
  let trimAudio   = null;     // Audio element for preview
  let trimDuration = 0;        // captured length (sec)
  let trimIn  = 0;
  let trimOut = 0;
  let trimMode = null;         // 'preview' | 'loop' | null
  let trimRAF  = 0;

  // List of sample filenames the operator has just saved FROM the current
  // raw capture. Used to render quick-replay buttons under the timeline
  // so they can A/B against the slice they're currently marking. Reset
  // each time a new raw is opened.
  let savedFromThisRaw = [];

  function openTrimEditor(file) {
    trimSrcFile = file;
    fnameEl.textContent = file;
    editor.style.display = '';
    setTrimStatus('Loading audio…');
    savedFromThisRaw = [];
    renderSavedFromThisRaw();
    // Reset zoom + cached audio so the new file starts fit-to-screen
    // with no leftover channel data from the previous capture.
    cachedChannel = null;
    trimZoom = 1;
    if (zoomEl) zoomEl.value = '1';
    applyTrimZoom();
    // Tear down any previous preview audio first.
    if (trimAudio) { try { trimAudio.pause(); } catch (e) {} }
    trimAudio = new Audio('/api/audio/custom-loop/' + encodeURIComponent(file));
    trimAudio.preload = 'auto';
    trimAudio.addEventListener('loadedmetadata', () => {
      trimDuration = trimAudio.duration || 0;
      trimIn = 0; trimOut = trimDuration;
      updateHandles();
      updateNumeric();
      setTrimStatus(`Loaded (${trimDuration.toFixed(1)}s). Drag to scrub, I/O to mark, Space to play/pause.`);
    });
    // 'durationchange' fires after loadedmetadata on some browsers
    // (and is the source of truth if duration is updated later via
    // the byte-range fetch). Mirror the same setup here.
    trimAudio.addEventListener('durationchange', () => {
      if (!isFinite(trimAudio.duration) || trimAudio.duration <= 0) return;
      const dur = trimAudio.duration;
      if (Math.abs(dur - trimDuration) < 0.05) return;
      trimDuration = dur;
      if (trimOut === 0 || trimOut > dur) trimOut = dur;
      if (trimIn  > dur) trimIn = 0;
      updateHandles(); updateNumeric();
    });
    trimAudio.addEventListener('error', () => {
      console.warn('[trim] audio.error', trimAudio.error);
      setTrimStatus('✗ failed to load audio (check the file is valid)', 'err');
    });
    trimAudio.addEventListener('timeupdate', () => {
      if (!trimDuration) return;
      const pct = (trimAudio.currentTime / trimDuration) * 100;
      playheadEl.style.left = pct + '%';
      // While zoomed in, keep the playhead within the visible window of
      // the scroll container by panning when it nears either edge.
      if (trimZoom > 1) scrollToKeepPlayheadVisible();
      // Loop mode: bounce back to IN when we cross OUT
      if (trimMode === 'loop' && trimAudio.currentTime >= trimOut - 0.02) {
        trimAudio.currentTime = trimIn;
      }
      // Preview mode: stop when we cross OUT
      if (trimMode === 'preview' && trimAudio.currentTime >= trimOut - 0.02) {
        trimAudio.pause();
        trimMode = null;
      }
    });
    trimNameEl.value = '';
    trimNameEl.focus();
    decodeAndDrawWaveform(file).catch(e => console.warn('[trim wave] decode failed:', e));
  }

  // Cached channel data for the currently-open raw capture so we can
  // recompute peaks at higher resolution when the operator zooms in.
  // Cleared each time a new file opens. Null when nothing decoded yet.
  let cachedChannel = null;

  // Trim editor zoom (1x .. 20x). At 1x the timeline fills the scroll
  // container; at higher values the timeline expands horizontally and
  // the container scrolls. IN/OUT/playhead are positioned by percentage
  // so they stay correct under any zoom.
  let trimZoom = 1;
  function applyTrimZoom() {
    if (!timeline || !scrollEl) return;
    timeline.style.width = `${100 * trimZoom}%`;
    if (zoomValEl) zoomValEl.textContent = `${trimZoom.toFixed(trimZoom >= 10 ? 0 : 1)}×`;
    // Re-render the waveform at the new (wider) canvas size so it stays
    // sharp -- but only if we have the channel data cached.
    if (cachedChannel) renderWaveformPeaks(cachedChannel);
    // Scroll so the IN handle is visible (a touch left of center).
    scrollToKeepInVisible();
  }
  function scrollToKeepInVisible() {
    if (!scrollEl || !trimDuration) return;
    const inPx = (trimIn / trimDuration) * timeline.getBoundingClientRect().width;
    const visW = scrollEl.clientWidth;
    // Target: IN sits 25% from the left edge of the visible area.
    const target = Math.max(0, inPx - visW * 0.25);
    scrollEl.scrollLeft = target;
  }
  function scrollToKeepPlayheadVisible() {
    if (!scrollEl || !trimAudio || !trimDuration) return;
    const phPx = (trimAudio.currentTime / trimDuration) * timeline.getBoundingClientRect().width;
    const visW = scrollEl.clientWidth;
    const left = scrollEl.scrollLeft;
    if (phPx < left + 20 || phPx > left + visW - 20) {
      scrollEl.scrollLeft = Math.max(0, phPx - visW * 0.5);
    }
  }
  if (zoomEl) {
    zoomEl.addEventListener('input', () => {
      trimZoom = Number(zoomEl.value) || 1;
      applyTrimZoom();
    });
  }

  // Decode the raw audio once, compute amplitude peaks, paint them onto
  // the waveform canvas as a centered mirror bar graph. Lets the operator
  // SEE where transients are without having to listen for them. Cancels
  // any older decode in flight when the editor is reopened with a
  // different file.
  let waveformRequestId = 0;
  function renderWaveformPeaks(channel) {
    if (!waveform || !channel) return;
    const ctx2d = waveform.getContext('2d');
    const rect = waveform.getBoundingClientRect();
    waveform.width  = Math.max(200, Math.round(rect.width  * (window.devicePixelRatio || 1)));
    waveform.height = Math.max(36,  Math.round(rect.height * (window.devicePixelRatio || 1)));
    const bucketCount = Math.min(4000, Math.max(300, waveform.width));
    const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
    const peaks = new Float32Array(bucketCount);
    let max = 0;
    for (let i = 0; i < bucketCount; i++) {
      let bucketMax = 0;
      const start = i * samplesPerBucket;
      const end = Math.min(channel.length, start + samplesPerBucket);
      for (let j = start; j < end; j++) {
        const v = Math.abs(channel[j]);
        if (v > bucketMax) bucketMax = v;
      }
      peaks[i] = bucketMax;
      if (bucketMax > max) max = bucketMax;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = waveform.width, h = waveform.height;
    ctx2d.clearRect(0, 0, w, h);
    const bucketW = w / peaks.length;
    const half = h / 2;
    ctx2d.fillStyle = 'rgba(160, 200, 255, 0.62)';
    for (let i = 0; i < peaks.length; i++) {
      const n = max > 0 ? peaks[i] / max : 0;
      const barH = Math.max(1 * dpr, n * h * 0.92);
      const x = i * bucketW;
      ctx2d.fillRect(x, half - barH / 2, Math.max(0.8, bucketW - 0.3), barH);
    }
  }
  async function decodeAndDrawWaveform(file) {
    if (!waveform) return;
    const myId = ++waveformRequestId;
    const ctx2d = waveform.getContext('2d');
    const rect = waveform.getBoundingClientRect();
    waveform.width  = Math.max(200, Math.round(rect.width  * (window.devicePixelRatio || 1)));
    waveform.height = Math.max(36,  Math.round(rect.height * (window.devicePixelRatio || 1)));
    ctx2d.clearRect(0, 0, waveform.width, waveform.height);

    let ac;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const resp = await fetch('/api/audio/custom-loop/' + encodeURIComponent(file));
      if (!resp.ok) throw new Error('fetch ' + resp.status);
      const buf = await resp.arrayBuffer();
      if (myId !== waveformRequestId) { try { ac.close(); } catch (e) {} return; }
      const audioBuf = await ac.decodeAudioData(buf);
      if (myId !== waveformRequestId) { try { ac.close(); } catch (e) {} return; }
      const channel = audioBuf.getChannelData(0);
      // Copy so we can drop the AudioContext + ArrayBuffer; cachedChannel
      // is used later by the zoom slider to re-render peaks.
      cachedChannel = channel.slice();
      renderWaveformPeaks(cachedChannel);
    } catch (e) {
      console.warn('[trim wave] decode failed:', e);
    } finally {
      try { ac && ac.close(); } catch (e) {}
    }
  }

  function renderSavedFromThisRaw() {
    if (!savedWrap || !savedRow) return;
    if (!savedFromThisRaw.length) {
      savedWrap.style.display = 'none';
      savedRow.innerHTML = '';
      return;
    }
    savedWrap.style.display = '';
    savedRow.innerHTML = savedFromThisRaw.map(f => `
      <button class="loop-trim-saved-chip" data-file="${escapeHtml(f)}" title="Replay ${escapeHtml(f)}">
        <i data-lucide="play"></i> ${escapeHtml(f.replace(/\.m4a$/i, ''))}
      </button>
    `).join('');
    if (window.lucide) lucide.createIcons();
    savedRow.querySelectorAll('.loop-trim-saved-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const f = btn.dataset.file;
        if (window._customLoopAudio) { try { window._customLoopAudio.pause(); } catch (e) {} }
        const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(f));
        a.volume = 0.85;
        a.play().catch(() => {});
        window._customLoopAudio = a;
      });
    });
  }

  function closeTrimEditor() {
    if (trimAudio) { try { trimAudio.pause(); } catch (e) {} trimAudio = null; }
    editor.style.display = 'none';
    trimSrcFile = null; trimMode = null;
    cancelAnimationFrame(trimRAF);
  }

  discardBtn.addEventListener('click', async () => {
    if (!trimSrcFile) { closeTrimEditor(); return; }
    if (!confirm(`Discard the raw capture ${trimSrcFile}?`)) return;
    await fetch('/api/custom-loops/' + encodeURIComponent(trimSrcFile), { method: 'DELETE' });
    closeTrimEditor();
    setStatus(`Discarded.`, '');
    refreshCustomLoopsList();
  });

  function updateHandles() {
    if (!trimDuration) return;
    const inPct  = (trimIn  / trimDuration) * 100;
    const outPct = (trimOut / trimDuration) * 100;
    inHandle.style.left  = inPct  + '%';
    outHandle.style.left = outPct + '%';
    rangeEl.style.left   = inPct + '%';
    rangeEl.style.width  = (outPct - inPct) + '%';
  }
  function updateNumeric() {
    inSecBox.value  = trimIn.toFixed(2);
    outSecBox.value = trimOut.toFixed(2);
    durEl.textContent = (trimOut - trimIn).toFixed(2) + 's';
  }

  // Drag handles by x-position over the timeline.
  function attachDrag(handle, setter) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const rect = timeline.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        setter(pct * trimDuration);
        updateHandles(); updateNumeric();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  // While Loop mode is engaged, any IN/OUT change must immediately
  // affect playback. If the playhead is outside the new window, snap
  // it back to IN so the operator hears the new region right away.
  function enforceLoopBounds() {
    if (trimMode !== 'loop' || !trimAudio) return;
    const t = trimAudio.currentTime;
    if (t < trimIn - 0.01 || t > trimOut - 0.01) {
      trimAudio.currentTime = trimIn;
    }
  }
  attachDrag(inHandle,  (v) => { trimIn  = Math.min(v, trimOut - 0.05); enforceLoopBounds(); });
  attachDrag(outHandle, (v) => { trimOut = Math.max(v, trimIn  + 0.05); enforceLoopBounds(); });

  inSecBox.addEventListener('input', () => {
    const v = Number(inSecBox.value);
    if (Number.isFinite(v)) {
      trimIn = Math.max(0, Math.min(v, trimOut - 0.05));
      updateHandles(); updateNumeric(); enforceLoopBounds();
    }
  });
  outSecBox.addEventListener('input', () => {
    const v = Number(outSecBox.value);
    if (Number.isFinite(v)) {
      trimOut = Math.max(trimIn + 0.05, Math.min(v, trimDuration));
      updateHandles(); updateNumeric(); enforceLoopBounds();
    }
  });

  // Drag-scrub the playhead along the timeline. pointerdown anywhere
  // that isn't an IN/OUT handle starts a drag; pointermove updates the
  // audio.currentTime continuously so the operator hears the audio
  // follow the cursor; pointerup ends. Works for both a single click
  // (seek) and a held drag (scrub).
  function scrubFrom(clientX) {
    if (!trimAudio) { console.warn('[trim scrub] no audio'); return; }
    if (!trimDuration) {
      // duration was never set. Try to derive from the audio element so a
      // late-loading file still scrubs.
      if (trimAudio.duration && isFinite(trimAudio.duration)) {
        trimDuration = trimAudio.duration;
      } else {
        console.warn('[trim scrub] duration unknown; can\'t scrub yet');
        return;
      }
    }
    const rect = timeline.getBoundingClientRect();
    if (!rect.width) { console.warn('[trim scrub] timeline rect has zero width'); return; }
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    trimAudio.currentTime = pct * trimDuration;
  }
  let scrubbing = false;
  timeline.addEventListener('pointerdown', (e) => {
    if (e.target === inHandle || e.target === outHandle) return;
    if (e.target.closest && e.target.closest('.loop-trim-handle')) return;
    e.preventDefault();
    scrubbing = true;
    try { timeline.setPointerCapture && timeline.setPointerCapture(e.pointerId); }
    catch (er) { console.warn('[trim scrub] setPointerCapture failed:', er); }
    scrubFrom(e.clientX);
  });
  timeline.addEventListener('pointermove', (e) => {
    if (!scrubbing) return;
    scrubFrom(e.clientX);
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { timeline.releasePointerCapture && timeline.releasePointerCapture(e.pointerId); } catch (er) {}
  };
  timeline.addEventListener('pointerup',     endScrub);
  timeline.addEventListener('pointercancel', endScrub);

  // Free-play: no IN/OUT constraint. Operator uses this to scan through
  // the capture looking for samples. Plays from wherever the playhead
  // currently is, all the way to the end of the capture.
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (!trimAudio) return;
      trimMode = null;            // no auto-stop on OUT
      trimAudio.play().catch(() => {});
    });
  }
  btnPreview.addEventListener('click', () => {
    if (!trimAudio) return;
    trimMode = 'preview';
    trimAudio.currentTime = trimIn;
    trimAudio.play().catch(() => {});
  });
  btnLoop.addEventListener('click', () => {
    if (!trimAudio) return;
    trimMode = 'loop';
    trimAudio.currentTime = trimIn;
    trimAudio.play().catch(() => {});
  });
  btnStop.addEventListener('click', () => {
    trimMode = null;
    if (!trimAudio) { console.warn('[trim stop] no audio element'); return; }
    try { trimAudio.pause(); }
    catch (e) { console.warn('[trim stop] pause failed:', e); }
  });

  // Set IN / Set OUT at the current playhead. Useful for free-play
  // scanning -- play, hear the sample start, hit "IN here", let it
  // play through the sample, hit "OUT here" to grab the end.
  if (btnSetIn) {
    btnSetIn.addEventListener('click', () => {
      if (!trimAudio || !trimDuration) return;
      trimIn = Math.max(0, Math.min(trimAudio.currentTime, trimOut - 0.05));
      updateHandles(); updateNumeric(); enforceLoopBounds();
    });
  }
  if (btnSetOut) {
    btnSetOut.addEventListener('click', () => {
      if (!trimAudio || !trimDuration) return;
      trimOut = Math.max(trimIn + 0.05, Math.min(trimAudio.currentTime, trimDuration));
      updateHandles(); updateNumeric(); enforceLoopBounds();
    });
  }
  // Keyboard shortcuts while the trim editor is actually on-screen.
  // Earlier this only checked editor.style.display, which stayed at ''
  // after the first openTrimEditor even if the Drum Loops tab was no
  // longer the active tab. That hijacked Space + main-player keys.
  // offsetParent is null when ANY ancestor is display:none (tab pane
  // hidden, panel closed, etc.) so it's the correct visibility test.
  //   Space — toggle play / pause from the current playhead position
  //   I     — Set IN at current playhead
  //   O     — Set OUT at current playhead
  //   P     — Preview IN→OUT
  //   L     — Loop IN→OUT
  //   S     — Stop
  window.addEventListener('keydown', (ev) => {
    if (!editor || !editor.offsetParent) return;     // editor not laid out
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const k = ev.key.toLowerCase();
    if (ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      if (!trimAudio) return;
      if (trimAudio.paused) {
        trimMode = null;
        trimAudio.play().catch(() => {});
      } else {
        trimAudio.pause();
      }
      return;
    }
    if (k === 'i' && btnSetIn)   { ev.preventDefault(); btnSetIn.click();   return; }
    if (k === 'o' && btnSetOut)  { ev.preventDefault(); btnSetOut.click();  return; }
    if (k === 'p' && btnPreview) { ev.preventDefault(); btnPreview.click(); return; }
    if (k === 'l' && btnLoop)    { ev.preventDefault(); btnLoop.click();    return; }
    if (k === 's' && btnStop)    { ev.preventDefault(); btnStop.click();    return; }
  });

  // Enter in the name field saves -- same gesture as clicking Save.
  if (trimNameEl) {
    trimNameEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); btnSave.click(); }
    });
  }

  btnSave.addEventListener('click', async () => {
    if (!trimSrcFile) { setTrimStatus('Nothing to save.', 'err'); return; }
    const name = (trimNameEl.value || '').trim();
    if (!name) { setTrimStatus('Name required.', 'err'); trimNameEl.focus(); return; }
    btnSave.disabled = true;
    setTrimStatus('Trimming with ffmpeg…', 'loading');
    try {
      const r = await fetch('/api/custom-loops/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: trimSrcFile,
          start_sec: trimIn,
          end_sec:   trimOut,
          name,
          // KEEP the raw capture. The operator stays in the editor and
          // scans forward for the next sample in the same audio. The
          // raw is removed only by the × Discard button at top-right.
          deleteSource: false,
        }),
      });
      const d = await r.json();
      if (!r.ok) { setTrimStatus('✗ ' + (d.error || 'trim failed'), 'err'); btnSave.disabled = false; return; }
      const savedOut = trimOut;
      refreshCustomLoopsList();
      savedFromThisRaw.push(d.file);
      renderSavedFromThisRaw();
      // Advance for the next sample: IN jumps to where the just-saved
      // OUT was; OUT stays at the end of the capture so the user has
      // a wide window to scan. Name field clears and refocuses for the
      // next entry. Playhead jumps to the new IN so the operator can
      // hit Play and listen forward from there.
      trimIn  = Math.min(savedOut, trimDuration - 0.05);
      trimOut = trimDuration;
      updateHandles(); updateNumeric();
      if (trimAudio) trimAudio.currentTime = trimIn;
      trimNameEl.value = '';
      trimNameEl.focus();
      setTrimStatus(`✓ Saved ${d.file} (${d.duration_sec.toFixed(1)}s). Find the next sample, or × to discard the raw.`, 'ok');
      btnSave.disabled = false;
    } catch (e) {
      setTrimStatus('✗ ' + e.message, 'err');
      btnSave.disabled = false;
    }
  });

  // ── Saved loops list ──────────────────────────────────────────────
  async function refreshCustomLoopsList() {
    let d;
    try { d = await fetch('/api/custom-loops/list').then(r => r.json()); }
    catch (e) { return; }
    // Tell the Sampler panel (and anything else listening) to refresh too.
    try { window.dispatchEvent(new Event('custom-loops-changed')); } catch (e) {}
    const loops = d.loops || [];
    if (!loops.length) {
      list.innerHTML = '<li class="url-loop-empty">No snippets yet.</li>';
      return;
    }
    // Every saved sample gets an Edit (scissors) button -- click it to
    // reopen the file in the trim editor with the waveform + IN/OUT
    // markers, so any sample can be re-trimmed or used as the source
    // for a new derivative sample. Raw scratch files (raw_*) get a
    // faint orange tint to remind the operator they're still a working
    // capture and can be discarded.
    list.innerHTML = loops.map(l => {
      const isRaw = l.file.startsWith('raw_');
      return `
        <li class="url-loop-row-item${isRaw ? ' raw' : ''}" data-file="${escapeHtml(l.file)}">
          <button class="url-loop-play" title="Play"><i data-lucide="play"></i></button>
          <span class="url-loop-fname">${escapeHtml(l.file)}</span>
          <span class="url-loop-size">${(l.size / 1024).toFixed(0)} KB</span>
          <button class="url-loop-edit" title="Open in trim editor"><i data-lucide="scissors"></i></button>
          <button class="url-loop-del"  title="Delete"><i data-lucide="trash-2"></i></button>
        </li>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
    list.querySelectorAll('.url-loop-row-item').forEach(row => {
      const file = row.dataset.file;
      row.querySelector('.url-loop-play').addEventListener('click', (e) => { e.stopPropagation(); playCustomLoop(file); });
      const editBtn = row.querySelector('.url-loop-edit');
      if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); openTrimEditor(file); });
      row.querySelector('.url-loop-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        // Raw scratch captures (raw_*.m4a) delete without confirmation --
        // they're throwaway by definition. Anything else (a named clip
        // the operator chose to save) prompts.
        const isRaw = file.startsWith('raw_');
        if (!isRaw && !confirm(`Delete ${file}?`)) return;
        await fetch('/api/custom-loops/' + encodeURIComponent(file), { method: 'DELETE' });
        refreshCustomLoopsList();
      });
      // Clicking anywhere ELSE on the row brings the file into the
      // wave-capture trim editor. Lets the operator one-click a raw
      // capture back open without aiming at the scissors button.
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => openTrimEditor(file));
    });
  }

  function playCustomLoop(file) {
    // Always one-shot. Bill: "If I play a clip, it loops. I do not want
    // it to loop. I want the clip to always play once." Clip auditions
    // are for "does this sample sound right" -- never for jamming over.
    if (window._customLoopAudio) {
      try { window._customLoopAudio.pause(); } catch (e) {}
    }
    const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(file));
    a.loop = false;
    a.volume = 0.85;
    a.addEventListener('ended', () => setStatus(`Played ${file}.`, ''));
    a.play().catch(e => console.warn('[custom-loop] play failed:', e));
    window._customLoopAudio = a;
    setStatus(`▶ ${file}`, 'ok');
    // Click ▶ again to stop early.
    const row = list.querySelector(`[data-file="${CSS.escape(file)}"] .url-loop-play`);
    if (row) {
      row.addEventListener('click', function once() {
        a.pause();
        setStatus(`Stopped ${file}.`, '');
        row.removeEventListener('click', once);
      }, { once: true });
    }
  }

  refreshCustomLoopsList();
}

// ─── Sampler panel ─────────────────────────────────────────────────
//
// Lives in the Drum Loops tab next to the Loop Library. Lets the
// operator turn CUSTOM_LOOPS samples into items inside the currently-
// loaded song's ActionSequences. One song can have many sequences
// (e.g. "Political satire", "Crowd participation"). Each sequence
// holds 0+ items; an item is one sample with:
//   - anchor t (current playhead at time of add, or 0)
//   - kind: 'play-sample'
//   - spec: { loopFile, mode }
//   - trigger: 'auto' (fires when playhead crosses t) or 'manual'
//     (only fires when the operator presses the button at gig time)
//
// Real-time play UI (chips on the main visualizer, armed/disarmed
// toggles) will land in the next iteration. This panel is the
// OFFLINE prep surface.
function setupSamplerPanel() {
  const panel    = document.getElementById('sampler-panel');
  if (!panel) return;
  const targetEl = document.getElementById('sampler-target');
  const asPicker = document.getElementById('sampler-as-picker');
  const asNewBtn = document.getElementById('sampler-as-new');
  const asRenBtn = document.getElementById('sampler-as-rename');
  const asArmEl  = document.getElementById('sampler-as-armed');
  const sampList = document.getElementById('sampler-list');
  const itemsList= document.getElementById('sampler-items-list');

  // Local state. Loaded per song.
  let samplerSong = null;          // currentSong reference at time of load
  let actionSequences = [];        // [{id, label, armed, items: [...]}]
  let activeSeqIdx = -1;
  let saveTimer = null;

  function scheduleSave() {
    if (!samplerSong) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveActionSequences, 350);
  }

  async function saveActionSequences() {
    if (!samplerSong) return;
    const base = songBaseOf(samplerSong);
    if (!base) return;
    try {
      await fetch(`/api/song/${encodeURIComponent(base)}/action-sequences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionSequences }),
      });
    } catch (e) { console.warn('[sampler] save failed:', e); }
  }

  // Pull the song's actionSequences from the server. Creates a default
  // sequence if the song has none yet so the picker is never empty.
  async function loadForCurrentSong() {
    samplerSong = currentSong || null;
    if (!samplerSong) {
      targetEl.textContent = 'no song loaded';
      actionSequences = []; activeSeqIdx = -1;
      renderSeqPicker(); renderItems();
      return;
    }
    targetEl.textContent = (samplerSong.title || samplerSong.folderName || 'song');
    const base = songBaseOf(samplerSong);
    if (!base) return;
    try {
      const d = await fetch(`/api/song/${encodeURIComponent(base)}/action-sequences`).then(r => r.json());
      actionSequences = Array.isArray(d.actionSequences) ? d.actionSequences : [];
    } catch (e) {
      console.warn('[sampler] load failed:', e);
      actionSequences = [];
    }
    if (!actionSequences.length) {
      actionSequences.push({
        id: 'as_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
        label: 'Default',
        armed: true,
        items: [],
      });
    }
    activeSeqIdx = 0;
    renderSeqPicker(); renderItems();
  }

  function renderSeqPicker() {
    asPicker.innerHTML = actionSequences.map((s, i) =>
      `<option value="${i}">${escapeHtml(s.label || '(untitled)')}</option>`).join('');
    asPicker.value = String(activeSeqIdx);
    const cur = actionSequences[activeSeqIdx];
    asArmEl.checked = cur ? cur.armed !== false : true;
  }

  function renderItems() {
    if (!itemsList) return;
    const cur = actionSequences[activeSeqIdx];
    if (!cur || !cur.items.length) {
      itemsList.innerHTML = '<li class="empty-state">No items yet. Pick a sample on the left and hit + Add.</li>';
      return;
    }
    itemsList.innerHTML = cur.items.map((it, i) => {
      const tlabel = (typeof it.t === 'number') ? formatTime(it.t) : 'manual';
      const fname = (it.spec && it.spec.loopFile) || '?';
      return `
        <li class="sampler-item" data-i="${i}">
          <span class="sampler-item-t">${tlabel}</span>
          <span class="sampler-item-label">${escapeHtml(it.label || fname)}</span>
          <span class="sampler-item-file">${escapeHtml(fname)}</span>
          <span class="sampler-item-mode">${escapeHtml(it.spec && it.spec.mode || 'overlay')}</span>
          <span class="sampler-item-trigger">${it.trigger === 'manual' ? 'M' : 'A'}</span>
          <button class="sampler-item-del" title="Remove"><i data-lucide="x"></i></button>
        </li>
      `;
    }).join('');
    if (window.lucide) lucide.createIcons();
    itemsList.querySelectorAll('.sampler-item').forEach(li => {
      const i = Number(li.dataset.i);
      li.querySelector('.sampler-item-del').addEventListener('click', () => {
        cur.items.splice(i, 1);
        renderItems(); scheduleSave();
      });
    });
  }

  async function refreshSampleList() {
    let d;
    try { d = await fetch('/api/custom-loops/list').then(r => r.json()); }
    catch (e) { return; }
    const loops = (d.loops || []).filter(l => !l.file.startsWith('raw_'));
    if (!loops.length) {
      sampList.innerHTML = '<div class="empty-state">No samples yet. Snip one above.</div>';
      return;
    }
    sampList.innerHTML = loops.map(l => `
      <div class="sampler-row" data-file="${escapeHtml(l.file)}">
        <button class="sampler-play"  title="Audition"><i data-lucide="play"></i></button>
        <span class="sampler-fname">${escapeHtml(l.file.replace(/\.m4a$/i, ''))}</span>
        <button class="sampler-add"   title="Add to current sequence at playhead"><i data-lucide="plus"></i></button>
      </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
    sampList.querySelectorAll('.sampler-row').forEach(row => {
      const file = row.dataset.file;
      row.querySelector('.sampler-play').addEventListener('click', () => auditionSample(file));
      row.querySelector('.sampler-add').addEventListener('click', () => addSampleToActiveSequence(file));
    });
  }

  function auditionSample(file) {
    if (window._samplerAuditionAudio) {
      try { window._samplerAuditionAudio.pause(); } catch (e) {}
    }
    const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(file));
    a.volume = 0.85;
    a.play().catch(e => console.warn('[sampler audition] play failed:', e));
    window._samplerAuditionAudio = a;
  }

  function addSampleToActiveSequence(file) {
    if (!samplerSong) { alert('Load a song first.'); return; }
    if (activeSeqIdx < 0 || !actionSequences[activeSeqIdx]) { alert('Pick or create an ActionSequence first.'); return; }
    const cur = actionSequences[activeSeqIdx];

    // Default anchor = current playhead in active audio elements (rounded
    // to 0.1s for readability). 0 if no song is playing yet.
    let t = 0;
    try {
      const ae = Object.values(audioElements).find(a => audioHasSrc(a));
      if (ae) t = Math.max(0, Math.round((ae.currentTime || 0) * 10) / 10);
    } catch (e) {}

    const label = prompt(`Label for "${file}" (e.g. "fake quote", optional)?`, '') || '';
    const trigger = confirm('Auto-fire when the playhead crosses this time?\nOK = auto, Cancel = manual button only') ? 'auto' : 'manual';

    cur.items.push({
      id: 'it_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      t: trigger === 'auto' ? t : undefined,
      kind: 'play-sample',
      label: label.trim(),
      spec: { loopFile: file, mode: 'overlay' },
      trigger,
    });
    renderItems(); scheduleSave();
  }

  // Wire ActionSequence picker + add/rename + armed toggle
  asPicker.addEventListener('change', () => {
    activeSeqIdx = Number(asPicker.value);
    renderSeqPicker(); renderItems();
  });
  asNewBtn.addEventListener('click', () => {
    if (!samplerSong) { alert('Load a song first.'); return; }
    const label = prompt('Name for the new ActionSequence (e.g. "Political satire"):', '') || '';
    if (!label.trim()) return;
    actionSequences.push({
      id: 'as_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      label: label.trim(),
      armed: true,
      items: [],
    });
    activeSeqIdx = actionSequences.length - 1;
    renderSeqPicker(); renderItems(); scheduleSave();
  });
  asRenBtn.addEventListener('click', () => {
    const cur = actionSequences[activeSeqIdx];
    if (!cur) return;
    const next = prompt('Rename ActionSequence:', cur.label || '');
    if (next === null) return;
    cur.label = next.trim() || cur.label;
    renderSeqPicker(); scheduleSave();
  });
  asArmEl.addEventListener('change', () => {
    const cur = actionSequences[activeSeqIdx];
    if (!cur) return;
    cur.armed = asArmEl.checked;
    scheduleSave();
  });

  // Hook song-load -> reload sequences. The drum-machine pill already
  // listens for song load via refreshDrumMachinePick; piggyback on a
  // simple observer: poll currentSong every 500ms and reload when its
  // id changes. Cheap and avoids wiring into the loadSong path.
  let lastSongId = null;
  setInterval(() => {
    const id = currentSong && currentSong.id;
    if (id !== lastSongId) {
      lastSongId = id;
      loadForCurrentSong();
    }
  }, 500);

  refreshSampleList();
  // Refresh the sample list when the snip panel saves a new file. The
  // snip panel calls refreshCustomLoopsList() after each save; mirror
  // that into this panel via a window-level event so both update.
  window.addEventListener('custom-loops-changed', refreshSampleList);
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
// Master UNSOLO button: visible ONLY when at least one strip is soloed.
// Styled to match a pressed per-strip Solo button (same yellow palette
// as .solo-btn.active) so the operator sees it as part of the solo
// group. Clicking it drops every solo at once.
function updateClearAllSolosBtn() {
  const btn = document.getElementById('btn-clear-all-solos');
  if (!btn) return;
  const anyActive = mixerState && mixerState.soloed && Object.values(mixerState.soloed).some(Boolean);
  btn.style.display = anyActive ? '' : 'none';
  btn.title = 'Click to drop every solo at once';
}

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

    // stripGain is the single source of truth for the audible level.
    // ae.volume is INTENTIONALLY left at its default 1.0 — Chrome
    // double-attenuates (applies element.volume AND any downstream
    // gain node) for captured MediaElement audio, so writing fader x
    // master to ae.volume here was making the normal-playback path
    // (fader x master)^2 quiet relative to the LOOPER's BufferSource
    // path (which doesn't go through ae). LOOPER then sounded amplified
    // even though it was just at the correct level.
    if (ae.volume !== 1) { try { ae.volume = 1; } catch (e) {} }
    // Per-strip boost multiplier: +5 dB ≈ 1.778x, +10 dB ≈ 3.162x. The
    // boost is applied on top of the fader x master product so engaging
    // a boost lifts the channel without changing fader position or the
    // recorded automation values.
    const boostDb = (mixerState.boost && mixerState.boost[chan]) || 0;
    const boostMul = boostDb ? Math.pow(10, boostDb / 20) : 1;
    if (stripNodes && stripNodes[chan] && stripNodes[chan].stripGain) {
      stripNodes[chan].stripGain.gain.value = targetVolume * master * boostMul;
    }

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
        ? '<span class="sl-badge sl-yt" title="Synced from a YouTube playlist"><i data-lucide="rss" style="width:11px;height:11px;"></i> sync</span>'
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
  // Setlist song selections are session-only — clear any persisted picks on
  // boot so library-row checkboxes start unchecked. (Songs land in `setlist`
  // when the user checks library rows to batch-add; persisting that across
  // restarts left ghost selections on every startup.) Name + start time are
  // still restored — those are config, not selections.
  localStorage.removeItem('bt_construction_setlist');
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
  // The Outro Jam Stretch UI was replaced by the section LOOPER (task #139)
  // and its DOM elements (stretchCyclesContainer, stretchInfo) were removed.
  // This function is still called from loadSong's m4a/stems branches — make
  // it a graceful no-op when the elements are gone. Without these guards,
  // every song load on boot logs
  //   [restore] last song failed: TypeError: Cannot read properties of null
  //                                 (reading 'style') at toggleStretchState
  // and the auto-restore path silently aborts.
  if (!els.stretchCyclesContainer || !els.stretchInfo) return;
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
  // ⏮ Beginning: seek every active stem to 0 (keep play/pause state).
  if (els.btnGoBeginning) {
    els.btnGoBeginning.addEventListener('click', () => {
      // If a count-in is mid-flight, abort it cleanly so the back button
      // doesn't end up racing the awaited audio start.
      if (countInInProgress) {
        countInInProgress = false;
        if (els.btnPlay) els.btnPlay.disabled = false;
      }
      Object.keys(audioElements || {}).forEach(chan => {
        const ae = audioElements[chan];
        if (audioHasSrc(ae)) { try { ae.currentTime = 0; } catch (e) {} }
      });
      els.timeline.value = 0;
      els.timelineFill.style.width = '0%';
      els.timeCurrent.textContent = '0:00';
      automationLastTime = 0;
      automationEvents.forEach(e => { e.fired = false; });
      renderAutomationLane();
    });
  }
  // ⏭ Next song: advance through the currently active gig setlist. If no
  // setlist is playing, advances within the active gig sidebar setlist.
  if (els.btnGoNext) {
    els.btnGoNext.addEventListener('click', () => {
      if (typeof gigSetlistJump === 'function' && activeGig &&
          activeGig.setlists && activeGig.setlists[activeSetlistIdx]) {
        gigSetlistJump(activeSetlistIdx, +1);
      }
    });
  }
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
  if (els.stretchToggle) els.stretchToggle.addEventListener('change', (e) => {
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

  // Setlist Controls — these legacy DOM nodes were removed when the
  // Setlist tab was replaced with the AI Setlist Builder. Guard each
  // attach so the boot path doesn't crash on a null reference.
  if (els.btnClearSetlist) els.btnClearSetlist.addEventListener('click', clearSetlist);
  if (els.setlistStartTime) els.setlistStartTime.addEventListener('change', () => {
    saveSetlistStartTime();
    calculateSetlistTimes();
  });
  if (els.setlistName) els.setlistName.addEventListener('input', saveSetlistName);
  
  // Mixer faders
  CHANNELS.forEach(chan => {
    const fader = document.getElementById(`fader-${chan}`);
    // `input` fires continuously during a drag — apply the audible change
    // and update mixerState/UI, but DON'T record an automation event yet.
    fader.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      mixerState.volumes[chan] = vol;
      document.getElementById(`val-${chan}`).textContent = `${Math.round(vol * 100)}%`;
      applyMixerVolumes();
      saveMixerState();
    });
    // `change` fires once when the user releases the slider (or types a new
    // value). THIS is when we record a single fade event capturing the
    // final value — so a 20%→80% drag becomes one V8 marker, not six.
    fader.addEventListener('change', (e) => {
      if (!automationCurrentBase) return;
      const vol = parseFloat(e.target.value);
      const lvl = Math.max(0, Math.min(10, Math.round(vol * 10)));
      recordFadeEvent(chan, lvl);
    });

    const muteBtn = document.getElementById(`mute-${chan}`);
    muteBtn.addEventListener('click', () => {
      mixerState.muted[chan] = !mixerState.muted[chan];
      muteBtn.classList.toggle('active', mixerState.muted[chan]);
      applyMixerVolumes();
      saveMixerState();
      // Record a fade event capturing the new state: muted = level 0,
      // unmuted = restore to current fader level.
      if (automationCurrentBase) {
        if (mixerState.muted[chan]) {
          recordFadeEvent(chan, 0);
        } else {
          const lvl = Math.max(1, Math.min(10, Math.round((mixerState.volumes[chan] || 0.8) * 10)));
          recordFadeEvent(chan, lvl);
        }
      }
    });

    const soloBtn = document.getElementById(`solo-${chan}`);
    soloBtn.addEventListener('click', () => {
      mixerState.soloed[chan] = !mixerState.soloed[chan];
      soloBtn.classList.toggle('active', mixerState.soloed[chan]);
      applyMixerVolumes();
      saveMixerState();
      updateClearAllSolosBtn();
    });
  });

  // Master SOLO clear: one-click "drop every solo." Enabled only while
  // at least one strip is soloed; otherwise greyed out. Lives in the
  // mixer-header row next to the collapse arrow so it sits with the
  // mixer-level (not strip-level) controls.
  const clearSolosBtn = document.getElementById('btn-clear-all-solos');
  if (clearSolosBtn) {
    clearSolosBtn.addEventListener('click', () => {
      let cleared = 0;
      Object.keys(mixerState.soloed).forEach(chan => {
        if (mixerState.soloed[chan]) cleared++;
        mixerState.soloed[chan] = false;
        const b = document.getElementById(`solo-${chan}`);
        if (b) b.classList.remove('active');
      });
      if (cleared) {
        applyMixerVolumes();
        saveMixerState();
      }
      updateClearAllSolosBtn();
    });
    updateClearAllSolosBtn();
  }
  
  // Reset Faders button removed per Bill — kept null-guard in case any other
  // call site still references btnResetMixer (none currently). Faders stay
  // wherever the user puts them, persisted in mixerState.

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
  // Reset the LOOPER on every song load. Otherwise the loop range from the
  // previous song carries over into the new one — the button looks active
  // and the sync loop tries to wrap the playhead at the old endT, even if
  // the new song has no sections defined at all.
  sectionLooperActive = false;
  sectionLooperRange = null;
  const looperBtn = document.getElementById('btn-section-looper');
  const looperLabel = document.getElementById('looper-section-text');
  if (looperBtn) looperBtn.classList.remove('active');
  if (looperLabel) looperLabel.textContent = 'no section';
  if (!songBase) {
    automationEvents = [];
    automationSections = [];
    automationCountIn = false;
    automationLastSavedJSON = '[]';
    automationDirty = false;
    renderAutomationLane();
    refreshAutomationToolbar();
    refreshCountInButton();
    return;
  }
  try {
    const r = await fetch(`/api/song/${encodeURIComponent(songBase)}/automation`);
    const d = await r.json();
    const events = d.automation || [];
    automationEvents = events.map(e => ({ ...e, fired: false }));
    automationSections = Array.isArray(d.sections) ? d.sections.slice() : [];
    automationSectionCandidates = Array.isArray(d.sectionCandidates) ? d.sectionCandidates.slice() : [];
    automationCountIn = !!d.countIn;
    automationLastSavedJSON = JSON.stringify({ a: events, s: automationSections, c: automationCountIn });
    // Auto-accept candidates: if this song has zero saved sections AND the
    // backfill produced candidate timestamps, materialize them as draft
    // sections so the user can immediately try them as loops. Colors rotate
    // 1..9 (Intro/Verse/Chorus/Bridge/…) so adjacent bands look distinct
    // out of the gate. The dirty flag is set below so SAVE persists them
    // and the toolbar indicator shows the unsaved-changes dot.
    var _autoAccepted = false;
    if (automationSections.length === 0 && automationSectionCandidates.length > 0) {
      let colorIdx = 1;
      for (const t of automationSectionCandidates) {
        automationSections.push({ t, color: colorIdx });
        colorIdx = (colorIdx % 9) + 1;
      }
      automationSections.sort((a, b) => a.t - b.t);
      _autoAccepted = true;
    }
    // Pitch is no longer per-song — it's a session-only effect. Don't
    // reset the knobs on song change; the user's current pitch carries
    // over until they hit RESET.
  } catch (e) {
    automationEvents = [];
    automationSections = [];
    automationSectionCandidates = [];
    automationCountIn = false;
    automationLastSavedJSON = '[]';
    var _autoAccepted = false;
  }
  refreshCountInButton();
  // Dirty iff auto-accept populated sections that aren't on the server yet.
  // Otherwise the freshly-loaded state matches the saved snapshot.
  automationDirty = !!_autoAccepted;
  renderAutomationLane();
  refreshAutomationToolbar();
}

async function saveAutomationForSong(songBase, events) {
  // Strip the transient `fired` flag before sending.
  const clean = events.map(({ fired, ...rest }) => rest);
  const r = await fetch(`/api/song/${encodeURIComponent(songBase)}/automation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ automation: clean, sections: automationSections, countIn: automationCountIn }),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'save failed');
  const d = await r.json();
  const saved = d.automation || [];
  const savedSections = Array.isArray(d.sections) ? d.sections : automationSections;
  const savedCountIn = !!d.countIn;
  automationEvents = saved.map(e => ({ ...e, fired: false }));
  automationSections = savedSections;
  automationCountIn = savedCountIn;
  automationLastSavedJSON = JSON.stringify({ a: saved, s: savedSections, c: savedCountIn });
  automationDirty = false;
  renderAutomationLane();
  refreshAutomationToolbar();
  refreshCountInButton();
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
  // CLEAR is always available when a song is loaded — even with 0 visible
  // actions, the user might want to wipe sections (or just be sure).
  if (clearBtn) clearBtn.disabled = !automationCurrentBase;
}

// Mark the in-memory event list as differing from what's on disk. Triggered
// by adds, deletes, drags, and modal commits. Cheap JSON compare so the dot
// reliably clears when the user undoes their changes manually.
function markAutomationDirty() {
  const cleanNow = automationEvents.map(({ fired, ...rest }) => rest);
  const nowJSON = JSON.stringify({ a: cleanNow, s: automationSections, c: automationCountIn });
  automationDirty = (nowJSON !== automationLastSavedJSON);
  refreshAutomationToolbar();
}

// Reflect the current automationCountIn value on the toggle button (active
// class + tooltip).
function refreshCountInButton() {
  const btn = document.getElementById('btn-count-in-toggle');
  if (!btn) return;
  btn.classList.toggle('active', !!automationCountIn);
  btn.title = automationCountIn
    ? 'Count-in: ON — Play triggers 4 clicks before audio starts. Click to disable.'
    : 'Count-in: OFF — Play starts audio immediately. Click to enable for this song.';
}

// Play 4 clicks at the song's BPM, then resolve. Each click is a downbeat
// pitch (1800 Hz) for an obvious "1-2-3-4" pre-roll. Uses the same
// fireClickAt + audioCtx that the click track does.
function playCountIn() {
  return new Promise((resolve) => {
    if (!audioCtx) initAudioCtx();
    if (!audioCtx) { resolve(); return; }
    const bpm = (currentSong && currentSong.practiceBpm) || 120;
    const beatSec = 60 / bpm;
    const start = audioCtx.currentTime + 0.05;
    for (let i = 0; i < 4; i++) fireClickAt(start + i * beatSec, true);
    // Resolve right BEFORE the 4th-beat onset so audio can start
    // synchronously with what the player perceives as beat 1.
    const totalMs = 4 * beatSec * 1000;
    setTimeout(resolve, totalMs + 50);
  });
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

// Marker labels.
//   Fade      → "<L><level>"     e.g. V0 (mute), V4 (40%), V10 (100%)
//   Mute (legacy)   → "<L>0"     (treated as level 0)
//   Unmute (legacy) → "<L>10"    (treated as level 10)
//   PC        → "M<ch>P<prog>"   e.g. M4P12
//   CC        → "M<ch>C<ctrl>"   e.g. M4C7
//   Note On   → "M<ch>N<note>"   e.g. M4N60
//   Note Off  → "M<ch>n<note>"   e.g. M4n60  (lowercase n = off)
function eventMarkerLabel(e) {
  if (e.type === 'init')   return 'I';
  if (e.type === 'mute')   return `${STEM_LETTER[e.stem] || '?'}0`;
  if (e.type === 'unmute') return `${STEM_LETTER[e.stem] || '?'}10`;
  if (e.type === 'fade') {
    const lvl = (typeof e.level === 'number') ? e.level
              : (typeof e.value === 'number') ? Math.round(e.value * 10)
              : '?';
    return `${STEM_LETTER[e.stem] || '?'}${lvl}`;
  }
  const ch = e.channel || 1;
  if (e.type === 'pc')       return `M${ch}P${e.program ?? '?'}`;
  if (e.type === 'cc')       return `M${ch}C${e.controller ?? '?'}`;
  if (e.type === 'note_on')  return `M${ch}N${e.note ?? '?'}`;
  if (e.type === 'note_off') return `M${ch}n${e.note ?? '?'}`;
  return e.type || '?';
}

// CSS class suffix so the marker can be color-coded by type. For fade
// events the color depends on the level (0 = red, 10 = green, in-between
// = yellow/amber).
function eventClass(e) {
  if (e.type === 'init')   return 'evt-init';
  if (e.type === 'mute')   return 'evt-mute';
  if (e.type === 'unmute') return 'evt-unmute';
  if (e.type === 'fade') {
    const lvl = (typeof e.level === 'number') ? e.level : 5;
    if (lvl <= 0) return 'evt-mute';
    if (lvl >= 10) return 'evt-unmute';
    return 'evt-fade-mid';
  }
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

// Index of the currently-selected marker, or null. Used by the Delete key
// handler so the user can point-and-delete an action.
let automationSelectedIdx = null;

// Max rows that the pane can stack vertically. Markers whose horizontal
// span overlaps with a marker in the same row are pushed to the next row.
const AUTOMATION_MAX_ROWS = 5;
const AUTOMATION_ROW_HEIGHT = 14;   // px — matches .midi-event-marker height
const AUTOMATION_ROW_GAP    = 2;    // px between rows
const AUTOMATION_MARKER_MIN_GAP_PX = 4;  // markers closer than this stack

function renderAutomationLane() {
  const lane = document.getElementById('midi-lane');
  const markers = document.getElementById('midi-lane-markers');
  const bands   = document.getElementById('midi-lane-bands');
  if (!lane || !markers) return;
  markers.innerHTML = '';
  if (bands) bands.innerHTML = '';
  const dur = songDurationSec();
  if (!dur) { refreshAutomationToolbar(); return; }

  // Section bands overlay the FULL visualizer canvas (their own container).
  // Markers stack at the lane's bottom anchor.
  if (bands) {
    renderSectionBands(bands, dur);
    renderSectionCandidateHints(bands, dur);
  }

  // Pass 1 — compute each event's x position (px) so we can detect
  // horizontal collisions for row assignment.
  const laneWidth = lane.clientWidth || 1;
  const positioned = automationEvents.map((e, idx) => {
    const pct = (e.t / dur) * 100;
    const xpx = (e.t / dur) * laneWidth;
    return { idx, e, pct, xpx };
  }).filter(p => p.pct >= 0 && p.pct <= 100);

  // Pass 2 — assign each event a row by checking which row last had a
  // marker that's already past (with a small min-gap). Walking events in
  // time order keeps row assignment stable.
  const rowLastX = new Array(AUTOMATION_MAX_ROWS).fill(-Infinity);
  positioned.forEach(p => {
    let row = 0;
    for (; row < AUTOMATION_MAX_ROWS; row++) {
      if (p.xpx - rowLastX[row] > AUTOMATION_MARKER_MIN_GAP_PX) break;
    }
    if (row >= AUTOMATION_MAX_ROWS) row = AUTOMATION_MAX_ROWS - 1; // overflow → last row
    p.row = row;
    rowLastX[row] = p.xpx;
  });

  // Pass 3 — paint.
  positioned.forEach(p => {
    const { idx, e, pct, row } = p;
    const node = document.createElement('div');
    let cls = `midi-event-marker ${eventClass(e)}`;
    if (e.fired) cls += ' fired';
    if (idx === automationSelectedIdx) cls += ' selected';
    node.className = cls;
    node.style.left = pct + '%';
    node.style.top = (row * (AUTOMATION_ROW_HEIGHT + AUTOMATION_ROW_GAP) + 2) + 'px';
    node.dataset.idx = String(idx);
    node.dataset.row = String(row);
    const label = eventMarkerLabel(e);
    const tip = `${e.label ? e.label + ' · ' : ''}${eventSummary(e)} @ ${e.t.toFixed(2)}s`;
    node.title = tip;
    node.innerHTML = `<span class="midi-event-letter">${escapeHtml(label)}</span>`;
    attachMarkerHandlers(node, idx);
    markers.appendChild(node);
  });
  refreshAutomationToolbar();
}

// Color palette for section markers, keyed 1..9.
const SECTION_COLORS = {
  1: { name: 'Intro',  bg: 'rgba(46, 204, 113, 0.18)' },    // light green
  2: { name: 'Verse',  bg: 'rgba(79, 156, 240, 0.18)' },    // light blue
  3: { name: 'Chorus', bg: 'rgba(231, 76, 60, 0.18)' },     // light red
  4: { name: 'Bridge', bg: 'rgba(155, 89, 182, 0.18)' },    // light purple
  5: { name: 'Solo',   bg: 'rgba(243, 156, 18, 0.18)' },    // light orange
  6: { name: 'Pre',    bg: 'rgba(241, 196, 15, 0.18)' },    // light yellow
  7: { name: 'Outro',  bg: 'rgba(26, 188, 156, 0.18)' },    // light teal
  8: { name: 'Break',  bg: 'rgba(149, 165, 166, 0.18)' },   // light gray
  9: { name: 'Tag',    bg: 'rgba(236, 64, 122, 0.18)' },    // light pink
};

// Render section bands + their labels + the draggable black dividers at
// each section's t (which marks the END of that section). The first
// section runs from 0 to its t; subsequent sections run from the prior
// section's t to their own.
function renderSectionBands(container, dur) {
  const sections = (automationSections || []).slice().sort((a, b) => a.t - b.t);
  if (!sections.length) return;
  let prevT = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const color = SECTION_COLORS[s.color];
    if (!color) { prevT = s.t; continue; }
    const startPct = (prevT / dur) * 100;
    const endPct   = (s.t   / dur) * 100;
    const widthPct = endPct - startPct;
    // Colored band with the section name centered inside.
    const band = document.createElement('div');
    band.className = 'automation-section-band';
    band.style.left  = startPct + '%';
    band.style.width = widthPct + '%';
    band.style.background = color.bg;
    const clickInBadge = s.clickIn ? ' <span class="section-click-in-badge" title="4-beat click pre-roll before this section">♩♩♩♩</span>' : '';
    band.title = `${color.name} (#${s.color}) — ${prevT.toFixed(1)}s → ${s.t.toFixed(1)}s${s.clickIn ? ' · click 4 beats in' : ''}`;
    band.innerHTML = `<span class="automation-section-label" data-section-idx="${i}" title="Click to change section type / click-in">${escapeHtml(color.name)}${clickInBadge}</span>`;
    container.appendChild(band);
    // Click the label to open the picker. Use mousedown so the click
    // doesn't bubble to the lane (which would drop a new event).
    const labelEl = band.querySelector('.automation-section-label');
    if (labelEl) labelEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openSectionPicker(i, labelEl);
    });
    // Black draggable divider at the END of this section.
    const divider = document.createElement('div');
    divider.className = 'automation-section-divider';
    divider.style.left = endPct + '%';
    divider.dataset.idx = String(i);
    divider.title = `${color.name} ends at ${s.t.toFixed(2)}s — drag to retime`;
    attachSectionDividerHandlers(divider, i);
    container.appendChild(divider);
    prevT = s.t;
  }
}

// Render faint vertical tick marks for each sectionCandidate timestamp.
// They show where section_detect.py thinks the boundaries are — so the
// user can SEE the candidates before placing their own sections, and
// drop a 1-9 key right on top of one.
function renderSectionCandidateHints(container, dur) {
  if (!Array.isArray(automationSectionCandidates) || !automationSectionCandidates.length) return;
  for (const t of automationSectionCandidates) {
    if (t < 0 || t > dur) continue;
    const pct = (t / dur) * 100;
    const hint = document.createElement('div');
    hint.className = 'automation-section-hint';
    hint.style.left = pct + '%';
    hint.title = `Candidate boundary @ ${t.toFixed(2)}s — multi-stem energy change detected`;
    container.appendChild(hint);
  }
}

// Removes the divider at `i` so the PREVIOUS section absorbs what was
// the following section (per user spec). End-of-list divider: just drop.
function deleteSectionDividerAt(i) {
  if (i < 0 || i >= automationSections.length) return;
  if (i + 1 < automationSections.length) {
    automationSections[i].t = automationSections[i + 1].t;
    automationSections.splice(i + 1, 1);
  } else {
    automationSections.splice(i, 1);
  }
  selectedSectionDividerIdx = null;
  renderAutomationLane();
  markAutomationDirty();
}

// Drag a section's end-position divider horizontally to retime it.
// Behavior per user spec:
//   - Click selects the divider (sticky orange highlight)
//   - Drag moves it (snaps to nearest sectionCandidate within ±2 s)
//   - Delete / Backspace removes the selected divider; previous section
//     extends through what was the following one
//   - Right-click also deletes for muscle memory from earlier rounds
//   - Click anywhere off a divider deselects
function attachSectionDividerHandlers(node, idx) {
  let downX = 0, dragging = false, startTime = 0;
  const overlay = document.getElementById('automation-overlay');

  node.title = 'Drag to move (snaps to candidates). Hover + press Delete to remove.';

  // Hover → track which divider is "armed" so the global Delete handler
  // knows which one to remove. mouseenter/leave fire even when the
  // divider's hit box overlaps siblings, unlike :hover-only CSS rules.
  node.addEventListener('mouseenter', () => { hoveredSectionDividerIdx = idx; });
  node.addEventListener('mouseleave', () => {
    if (hoveredSectionDividerIdx === idx) hoveredSectionDividerIdx = null;
  });

  // Right-click also deletes — kept for muscle memory from earlier rounds.
  node.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    deleteSectionDividerAt(idx);
  });

  node.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    downX = ev.clientX;
    dragging = false;
    startTime = automationSections[idx]?.t || 0;
    const onMove = (mv) => {
      const dx = mv.clientX - downX;
      if (!dragging && Math.abs(dx) < 3) return;
      dragging = true;
      const dur = songDurationSec();
      const r = overlay.getBoundingClientRect();
      const newT = Math.max(0, Math.min(dur, startTime + (dx / r.width) * dur));
      automationSections[idx].t = Math.round(newT * 100) / 100;
      // Live reposition without rebuilding all DOM — bands re-anchor on mouseup.
      node.style.left = ((automationSections[idx].t / dur) * 100) + '%';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) {
        // Snap to the nearest sectionCandidate within ±2 s if one exists,
        // otherwise fall back to BPM-grid + onset snap.
        const snappedT = snapSectionToCandidate(automationSections[idx].t);
        automationSections[idx].t = snappedT;
        // Slide-over-merge: if the dragged divider landed within 0.4 s of
        // ANOTHER divider, that's a "remove the underlying one" gesture.
        // Per user spec: "If sliding a separator over the top of an
        // existing separator, this is the same as removing the underlying
        // separator." Look for the closest other section and, if it's
        // within the merge window, drop it. The dragged one wins (keeps
        // its color/label).
        const MERGE_WINDOW = 0.4;
        const myTime = automationSections[idx].t;
        for (let j = automationSections.length - 1; j >= 0; j--) {
          if (j === idx) continue;
          if (Math.abs(automationSections[j].t - myTime) < MERGE_WINDOW) {
            automationSections.splice(j, 1);
            if (j < idx) idx--;        // index shifts left
          }
        }
        automationSections.sort((a, b) => a.t - b.t);
        renderAutomationLane();
        markAutomationDirty();
        // If the LOOPER is currently engaged and the moved divider was a
        // bound of the looped section (either its start divider or its
        // end divider), re-engage with the new bounds. Otherwise the
        // user is dragging boundaries on a different section and the
        // loop is unrelated.
        if (sectionLooperActive && sectionLooperRange) {
          const playheadT = currentPlayheadSec();
          const newRange = findSectionAt(playheadT);
          if (newRange && (
            Math.abs(newRange.startT - sectionLooperRange.startT) > 0.001 ||
            Math.abs(newRange.endT   - sectionLooperRange.endT)   > 0.001
          )) {
            sectionLooperRange = newRange;
            const label = document.getElementById('looper-section-text');
            if (label) {
              const colorName = SECTION_COLORS[newRange.color]?.name || 'section';
              label.textContent = `${colorName}  ${newRange.startT.toFixed(1)}s → ${newRange.endT.toFixed(1)}s · automation recording paused`;
            }
            // Re-setup with the new bounds — generation counter in
            // setupSeamlessLoop guarantees the OLD buffer sources are
            // aborted, AND the latest tearDown call would have killed
            // them anyway. We don't tearDown explicitly here because
            // setupSeamlessLoop's generation bump + fresh wiring is
            // enough; the previous gen's sources stop at next event tick.
            tearDownSeamlessLoop();
            setupSeamlessLoop(newRange.startT, newRange.endT).catch(err =>
              console.warn('[loop] re-setup after divider drag failed:', err)
            );
          }
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// Per-song section markers ({t, color: 1..9}). Loaded alongside automation
// events and persisted in the same metadata.json save.
let automationSections = [];

// Hover-tracked deletion for section dividers.
//   Mouse enters a divider → highlight + remember idx
//   Mouse leaves          → unhighlight + forget
//   Delete / Backspace    → if a divider is currently hovered, remove it
//                           (previous section extends through what was
//                            the following section)
// Click + drag on the divider still moves it.
let hoveredSectionDividerIdx = null;

function setupSectionDividerKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (hoveredSectionDividerIdx == null) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
                tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    e.preventDefault();
    deleteSectionDividerAt(hoveredSectionDividerIdx);
    hoveredSectionDividerIdx = null;
  });
}

// Read-only array of timestamps where section_detect.py found multi-stem
// energy changes (likely real musical section boundaries). Used to snap
// user-placed section markers and rendered as faint vertical hint ticks
// on the lane so the user can see where the algorithm thinks boundaries
// are before they place their own.
let automationSectionCandidates = [];

// Per-song count-in flag. When true, pressing Play first plays 4 clicks at
// the song's BPM, then starts audio (and turns off the click track if it
// was on). Stored alongside automation in metadata.json so the count-in is
// remembered across sessions.
let automationCountIn = false;

// LOOPER state. When `sectionLooperActive` is true, audio plays through a
// per-stem Web Audio AudioBufferSourceNode with `loop=true` — sample-
// accurate looping with NO decoder gap. The MediaElement keeps advancing
// (its audio path is disconnected from stripGain so it's silent) so the
// existing timeline / automation sync code keeps working.
let sectionLooperActive = false;
let sectionLooperRange  = null;
let loopBufferSources   = {};   // chan → AudioBufferSourceNode
let loopStartedAtCtxT   = 0;
let loopInitialOffset   = 0;

// Find the section that contains time `t` — returns {startT, endT, color}.
// If `t` is between two section boundaries, this is the band running from
// the prior section's end to the next section's end. If no sections exist,
// returns null. If t is past the last section, the range extends to song end.
function findSectionAt(t) {
  const sections = (automationSections || []).slice().sort((a, b) => a.t - b.t);
  if (!sections.length) return null;
  let prevT = 0;
  for (const s of sections) {
    if (t >= prevT && t < s.t) return { startT: prevT, endT: s.t, color: s.color };
    prevT = s.t;
  }
  const dur = songDurationSec();
  return dur ? { startT: prevT, endT: dur, color: null } : null;
}

function toggleSectionLooper() {
  const btn = document.getElementById('btn-section-looper');
  const label = document.getElementById('looper-section-text');
  if (!sectionLooperActive) {
    const t = currentPlayheadSec();
    const range = findSectionAt(t);
    if (!range) {
      if (label) label.textContent = 'no section here';
      return;
    }
    sectionLooperRange = range;
    sectionLooperActive = true;
    if (btn) btn.classList.add('active');
    if (label) {
      const colorName = SECTION_COLORS[range.color]?.name || 'section';
      label.textContent = `${colorName}  ${range.startT.toFixed(1)}s → ${range.endT.toFixed(1)}s · automation recording paused`;
      label.classList.add('looper-active-label');
    }
    setupSeamlessLoop(range.startT, range.endT).catch(err =>
      console.warn('[loop] seamless setup failed (will fall back to seek):', err)
    );
  } else {
    sectionLooperActive = false;
    sectionLooperRange = null;
    if (btn) btn.classList.remove('active');
    if (label) {
      label.textContent = 'play through';
      label.classList.remove('looper-active-label', 'looper-recording-disabled');
    }
    tearDownSeamlessLoop();
  }
}

// Stored so we can restore the volumes the user had before LOOPER engaged.
let loopSavedAEVolumes = {};
// Monotonic counter — every setup invocation captures the current value,
// every tearDown bumps it. If a setup finds the counter changed under
// its feet, it was aborted (user toggled the LOOPER while async work
// was in flight) and must clean up any sources it already created.
let loopGeneration = 0;
// EVERY BufferSourceNode the LOOPER has ever created lives here until it's
// stopped + disconnected. tearDown walks this set as the source of truth
// so orphan sources from cancelled-mid-decode setups can't keep playing.
const allLoopBufferSources = new Set();

async function setupSeamlessLoop(startT, endT) {
  if (!audioCtx) return;
  const myGen = ++loopGeneration;
  // Decode all 6 stems IN PARALLEL. The old code awaited each one
  // sequentially — for ~300 ms decode × 6 stems that was the "2 second
  // silence at engage" the user reported. Parallel decode collapses
  // that to ~300 ms, plus the actual buffer-source wiring is now
  // synchronous so all six stems start at the SAME audioCtx instant
  // (no perceptible lead-in stagger).
  const channels = Object.keys(audioElements);
  const decoded = await Promise.all(channels.map(async (chan) => {
    const ae = audioElements[chan];
    if (!ae || !ae.src) return null;
    const nodes = stripNodes[chan];
    if (!nodes) return null;
    try {
      const resp = await fetch(ae.src);
      if (myGen !== loopGeneration) return null;       // aborted mid-flight
      const arr = await resp.arrayBuffer();
      if (myGen !== loopGeneration) return null;
      const fullBuffer = await audioCtx.decodeAudioData(arr);
      if (myGen !== loopGeneration) return null;
      const sr = fullBuffer.sampleRate;
      const startSample = Math.max(0, Math.floor(startT * sr));
      const endSample = Math.min(fullBuffer.length, Math.floor(endT * sr));
      const loopLen = endSample - startSample;
      if (loopLen <= 0) return null;
      return { chan, ae, nodes, fullBuffer, startSample, loopLen, sr };
    } catch (e) {
      console.warn(`[loop] decode failed for ${chan}:`, e.message);
      return null;
    }
  }));

  // If we were aborted between dispatch and now, do nothing — tearDown
  // already ran (or is about to). Don't create sources we can't track.
  if (myGen !== loopGeneration) return;

  const sources = {};
  for (const item of decoded.filter(Boolean)) {
    const { chan, ae, nodes, fullBuffer, startSample, loopLen, sr } = item;
    const buf = audioCtx.createBuffer(fullBuffer.numberOfChannels, loopLen, sr);
    for (let ch = 0; ch < fullBuffer.numberOfChannels; ch++) {
      buf.getChannelData(ch).set(
        fullBuffer.getChannelData(ch).subarray(startSample, startSample + loopLen)
      );
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = loopLen / sr;
    // Silence the MediaElement path via mediaMute (NOT a disconnect)
    // so Chrome keeps advancing currentTime — which the sync loop reads
    // to animate the playhead. The BufferSource feeds stripGain in
    // parallel; mediaMute=0 means the MediaElement audio adds nothing.
    if (nodes.mediaMute) nodes.mediaMute.gain.value = 0;
    src.connect(nodes.stripGain);
    const offset = Math.max(0, Math.min(loopLen / sr, ae.currentTime - startT));
    src.start(0, offset);
    sources[chan] = src;
    allLoopBufferSources.add(src);
  }

  // One last abort check — tearDown could have fired during the sync
  // wiring above (it's fast but not zero-latency on slow devices).
  if (myGen !== loopGeneration) {
    for (const src of Object.values(sources)) {
      try { src.stop(); src.disconnect(); } catch (e) {}
      allLoopBufferSources.delete(src);
    }
    return;
  }

  loopBufferSources = sources;
  loopStartedAtCtxT = audioCtx.currentTime;
  const firstChan = Object.keys(sources)[0];
  loopInitialOffset = firstChan
    ? Math.max(0, audioElements[firstChan].currentTime - startT)
    : 0;
  console.log(`[loop] engaged gen=${myGen}: ${Object.keys(sources).length} stems, ` +
              `region ${startT.toFixed(2)}s → ${endT.toFixed(2)}s`);
}

function tearDownSeamlessLoop() {
  // Bump the generation so any in-flight setupSeamlessLoop bails out
  // before it creates buffer sources we can't track.
  loopGeneration++;

  // Compute the audible position WITHIN the section so we can hand the
  // playhead off to the MediaElement after teardown.
  let handoffT = null;
  if (audioCtx && sectionLooperRange && loopBufferSources && Object.keys(loopBufferSources).length > 0) {
    const sectionLen = sectionLooperRange.endT - sectionLooperRange.startT;
    if (sectionLen > 0) {
      const elapsed = audioCtx.currentTime - loopStartedAtCtxT;
      const offsetInSection = ((loopInitialOffset + elapsed) % sectionLen + sectionLen) % sectionLen;
      handoffT = sectionLooperRange.startT + offsetInSection;
    }
  }

  // Stop + disconnect EVERY BufferSource the LOOPER ever made.
  for (const src of allLoopBufferSources) {
    try { src.stop(); } catch (e) {}
    try { src.disconnect(); } catch (e) {}
  }
  allLoopBufferSources.clear();

  // Un-mute the MediaElement path on every strip so regular playback is
  // audible again. We never disconnected source → mediaMute → stripGain
  // (that's what froze the playhead), so there's nothing to reconnect —
  // just lift the mute.
  for (const chan of Object.keys(audioElements)) {
    const nodes = stripNodes && stripNodes[chan];
    if (nodes && nodes.mediaMute) {
      try { nodes.mediaMute.gain.value = 1; } catch (e) {}
    }
  }

  // Restore per-stem MediaElement.volume values we saved at engage time
  // (in case anything reads them — the audible path doesn't, but other
  // code might).
  for (const [chan, vol] of Object.entries(loopSavedAEVolumes)) {
    const ae = audioElements[chan];
    if (ae && typeof vol === 'number') {
      try { ae.volume = vol; } catch (e) {}
    }
  }

  // Snap MediaElements to the audible handoff position so the timeline
  // UI and the audio agree.
  if (handoffT !== null && Number.isFinite(handoffT)) {
    for (const ae of Object.values(audioElements)) {
      if (!ae || !audioHasSrc(ae)) continue;
      try { ae.currentTime = handoffT; } catch (e) {}
    }
  }

  loopSavedAEVolumes = {};
  loopBufferSources = {};
  loopStartedAtCtxT = 0;
  loopInitialOffset = 0;
}

// Public helper: any code path that swaps the playing song should call this
// FIRST so the AudioBufferSourceNodes carrying the previous song's loop don't
// keep playing on top of the new song.
function stopLooperIfActive() {
  if (sectionLooperActive) {
    sectionLooperActive = false;
    sectionLooperRange = null;
    const btn = document.getElementById('btn-section-looper');
    const label = document.getElementById('looper-section-text');
    if (btn) btn.classList.remove('active');
    if (label) label.textContent = 'no section';
  }
  tearDownSeamlessLoop();
}

// Click → select (Delete removes it); double-click → edit modal; drag →
// retime. Single-click within ~3px and 250ms is a click; otherwise a drag.
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
      node.style.left = ((automationEvents[idx].t / dur) * 100) + '%';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) {
        automationEvents.sort((a, b) => a.t - b.t);
        automationSelectedIdx = null;
        renderAutomationLane();
        markAutomationDirty();
      } else if (Date.now() - downT < 250) {
        // Short click → select (Delete key removes it).
        automationSelectedIdx = idx;
        renderAutomationLane();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  // Double-click → open edit modal for fine-grained edits.
  node.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    openMidiModal(idx);
  });
}

// Delete-key removes the currently selected marker. Wired in setupMidiUI.
function deleteSelectedMarker() {
  if (automationSelectedIdx == null) return;
  if (automationSelectedIdx < 0 || automationSelectedIdx >= automationEvents.length) return;
  automationEvents.splice(automationSelectedIdx, 1);
  automationSelectedIdx = null;
  renderAutomationLane();
  markAutomationDirty();
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
    // Default action: last type the user picked + last params they used
    // for THAT type, so the dialog opens already showing "what I just
    // did, again." User spec: "click MIDI and the default should be
    // Program Change if that was the last action. Further, if the
    // program change message was last set to MIDI channel 4 and Program
    // #6, then that should be the default."
    const lastType   = loadLastActionType();
    const lastByType = loadLastByType();
    const lastChByDev = loadChannelByDevice();
    const defaults   = lastByType[lastType] || {};
    const device     = defaults.device || 'helix';
    e = Object.assign(
      {
        t: currentPlayheadSec(),
        device, type: lastType,
        channel: lastChByDev[device] || defaults.channel || 4,
        program: 0, controller: 7, value: 100, label: '',
      },
      defaults,
      { t: currentPlayheadSec(), label: '' }   // time + label always fresh
    );
    document.getElementById('midi-modal-title').textContent = 'Add Action';
    document.getElementById('midi-btn-delete').style.display = 'none';
  } else {
    e = automationEvents[automationEditingIdx];
    document.getElementById('midi-modal-title').textContent = 'Edit Action';
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
  const clipSel = document.getElementById('midi-f-clip');
  if (clipSel) {
    // populatePlayClipPicker is async; pre-stash the saved value so it
    // is restored when the list arrives.
    if (e.clip) clipSel.value = e.clip;
    populatePlayClipPicker().then(() => {
      if (e.clip) clipSel.value = e.clip;
    });
  }
  const clipBoostSel = document.getElementById('midi-f-clip-boost');
  if (clipBoostSel) clipBoostSel.value = String(e.boost != null ? e.boost : 0);
  midiModalTypeChanged();
  modal.style.display = 'flex';
  document.getElementById('midi-modal-status').textContent = '';
  document.getElementById('midi-modal-status').className = 'midi-modal-status';
  // Fresh watermark so the label-as-shorthand auto-sync starts clean,
  // then prime the field with the current shorthand.
  if (typeof window.__resetShorthandWatermark === 'function') window.__resetShorthandWatermark();
  if (typeof window.__updateShorthandPreview === 'function') window.__updateShorthandPreview();
}

function closeMidiModal() {
  const m = document.getElementById('midi-modal');
  if (m) m.style.display = 'none';
  automationEditingIdx = null;
}

// ─── + CLIP quick-drop modal ───────────────────────────────────────
// Lightweight alternative to openMidiModal for the common case of
// "drop a Play Clip action at the playhead." Picks the clip + an
// anchor mode (start-at-playhead vs end-at-playhead) and writes a
// {type:'play-clip', t, clip, label} event into automationEvents.
async function openClipQuickModal() {
  const modal = document.getElementById('clip-quick-modal');
  if (!modal) return;
  const sel    = document.getElementById('clip-quick-file');
  const labelEl= document.getElementById('clip-quick-label');
  const boostEl= document.getElementById('clip-quick-boost');
  const statusEl = document.getElementById('clip-quick-status');
  document.getElementById('clip-anchor-start').checked = true;
  labelEl.value = '';
  if (boostEl) boostEl.value = '0';
  statusEl.textContent = '';
  statusEl.className = 'midi-modal-status';
  // Pull the clip list. Skip raw_*.m4a scratch captures.
  try {
    const d = await fetch('/api/custom-loops/list').then(r => r.json());
    const clips = (d.loops || []).filter(l => !l.file.startsWith('raw_'));
    sel.innerHTML = clips.length
      ? clips.map(c => `<option value="${escapeHtml(c.file)}">${escapeHtml(c.file.replace(/\.m4a$/i, ''))}</option>`).join('')
      : '<option value="">(no clips yet — snip one first)</option>';
  } catch (e) {
    console.warn('[clip-quick] list failed:', e);
    sel.innerHTML = '<option value="">(failed to load clip list)</option>';
  }
  modal.style.display = 'flex';
  sel.focus();
}
function closeClipQuickModal() {
  const m = document.getElementById('clip-quick-modal');
  if (m) m.style.display = 'none';
}
// Resolve the duration of a CUSTOM_LOOPS file by loading its metadata
// in a transient Audio element. Used by "Clip ends at playhead" so we
// can place the event at (playhead - clip duration).
function getClipDuration(file) {
  return new Promise((resolve, reject) => {
    const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(file));
    a.addEventListener('loadedmetadata', () => {
      if (isFinite(a.duration) && a.duration > 0) resolve(a.duration);
      else reject(new Error('duration not finite'));
    });
    a.addEventListener('error', () => reject(new Error('audio load error')));
  });
}
async function dropPlayClipAtPlayhead() {
  const sel    = document.getElementById('clip-quick-file');
  const file   = sel.value;
  const status = document.getElementById('clip-quick-status');
  if (!file) { status.textContent = 'Pick a clip first.'; status.className = 'midi-modal-status error'; return; }
  const anchor = document.querySelector('input[name="clip-quick-anchor"]:checked')?.value || 'start';
  let t = currentPlayheadSec();
  if (anchor === 'end') {
    try {
      const dur = await getClipDuration(file);
      t = Math.max(0, t - dur);
    } catch (e) {
      console.warn('[clip-quick] duration lookup failed; falling back to playhead:', e);
    }
  }
  const labelRaw = (document.getElementById('clip-quick-label').value || '').trim();
  const boostEl  = document.getElementById('clip-quick-boost');
  const boost    = boostEl ? (Number(boostEl.value) || 0) : 0;
  const boostTag = boost ? ` (+${boost}dB)` : '';
  const label = labelRaw
    || `clip ${file.replace(/\.m4a$/i, '')}${anchor === 'end' ? ' (ends here)' : ''}${boostTag}`;
  // Push the event into the in-memory timeline + persist on next save.
  if (typeof automationEvents === 'undefined') return;
  const ev = { t: Math.round(t * 1000) / 1000, type: 'play-clip', clip: file, label, boost };
  automationEvents.push(ev);
  automationEvents.sort((a, b) => a.t - b.t);
  if (typeof renderAutomationLane === 'function') renderAutomationLane();
  if (typeof markAutomationDirty === 'function') markAutomationDirty();
  closeClipQuickModal();
}
// Wire close handlers + Save once the DOM is ready. Idempotent.
function setupClipQuickModalOnce() {
  const modal = document.getElementById('clip-quick-modal');
  if (!modal || modal.dataset.wired === '1') return;
  modal.dataset.wired = '1';
  modal.querySelectorAll('[data-close-clip-modal]').forEach(el =>
    el.addEventListener('click', closeClipQuickModal));
  const saveBtn = document.getElementById('clip-quick-save');
  if (saveBtn) saveBtn.addEventListener('click', dropPlayClipAtPlayhead);
}

function midiModalTypeChanged() {
  const t = document.getElementById('midi-f-type').value;
  const isStem = (t === 'mute' || t === 'unmute');
  const isNote = (t === 'note_on' || t === 'note_off');
  const isClip = (t === 'play-clip');
  document.querySelectorAll('.midi-row-pc').forEach(n => n.style.display = t === 'pc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-cc').forEach(n => n.style.display = t === 'cc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-cc-preset').forEach(n => n.style.display = t === 'cc' ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-note').forEach(n => n.style.display = isNote ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-stem').forEach(n => n.style.display = isStem ? 'grid' : 'none');
  document.querySelectorAll('.midi-row-clip').forEach(n => n.style.display = isClip ? 'grid' : 'none');
  // MIDI-only fields (Device + Channel) only apply to MIDI types.
  document.querySelectorAll('.midi-row').forEach(row => {
    const lbl = row.querySelector('label')?.textContent;
    if (!lbl) return;
    const midiOnly = (lbl === 'Device' || lbl === 'Channel');
    if (midiOnly) row.style.display = (isStem || isClip) ? 'none' : 'grid';
  });
  if (isStem) {
    const labelEl = document.getElementById('midi-f-label');
    const stem = document.getElementById('midi-f-stem')?.value || 'vocals';
    if (!labelEl.value || /^(mute|unmute) /.test(labelEl.value)) {
      labelEl.value = `${t} ${stem}`;
    }
  }
  if (isClip) {
    // Refresh the clip dropdown every time the user picks Play Clip.
    populatePlayClipPicker();
    const labelEl = document.getElementById('midi-f-label');
    const fname = document.getElementById('midi-f-clip')?.value || '';
    if (fname && (!labelEl.value || /\bclip\b/i.test(labelEl.value))) {
      labelEl.value = `clip ${fname.replace(/\.m4a$/i, '')}`;
    }
  }
}

// Populate the Play Clip dropdown with every CUSTOM_LOOPS sample on disk
// (skipping raw_*.m4a scratch files). Idempotent -- safe to call on
// every modal open or type-change.
async function populatePlayClipPicker() {
  const sel = document.getElementById('midi-f-clip');
  if (!sel) return;
  const currentVal = sel.value;
  try {
    const d = await fetch('/api/custom-loops/list').then(r => r.json());
    const clips = (d.loops || []).filter(l => !l.file.startsWith('raw_'));
    sel.innerHTML = '<option value="">(no clip selected)</option>' + clips.map(c => {
      const nice = c.file.replace(/\.m4a$/i, '');
      return `<option value="${escapeHtml(c.file)}">${escapeHtml(nice)}</option>`;
    }).join('');
    if (currentVal) sel.value = currentVal;
  } catch (e) { console.warn('[play-clip picker] list failed:', e); }
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
  } else if (type === 'play-clip') {
    out.clip = document.getElementById('midi-f-clip').value || '';
    const boostEl = document.getElementById('midi-f-clip-boost');
    out.boost = boostEl ? Number(boostEl.value) || 0 : 0;
  }
  return out;
}

// Keyboard shortcut: while a song is loaded, V/D/B/G/P/O record a fade
// event at the current playhead. Toggles between mute (level 0) and the
// stem's current fader level. Events accumulate in memory only — the user
// commits with SAVE ACTIONS, or playback's `ended` handler auto-saves when
// the song reaches the end.
function recordStemToggleAtPlayhead(stem) {
  if (!automationCurrentBase) return;
  const t = currentPlayheadSec();
  // Look at the most recent fade event for this stem before now.
  let lastLevel = null;
  for (const e of automationEvents) {
    if (e.stem !== stem || e.t > t + 0.01) continue;
    if (e.type === 'fade')   lastLevel = (typeof e.level === 'number') ? e.level : null;
    else if (e.type === 'mute')   lastLevel = 0;
    else if (e.type === 'unmute') lastLevel = 10;
  }
  // Toggle: if last was muted (or no history), next is current fader value.
  // Otherwise next is mute. This is the V0 ↔ V<currentFader> toggle.
  const curVol = mixerState.volumes?.[stem] ?? 0.8;
  const curLevel = Math.max(0, Math.min(10, Math.round(curVol * 10)));
  const nextLevel = (lastLevel === 0 || lastLevel == null) ? Math.max(1, curLevel) : 0;
  recordFadeEvent(stem, nextLevel, t);
}

// Append a fade event to the in-memory timeline AND apply it immediately.
// Used by the keyboard shortcut, by fader-drag recording, and by mute
// button presses while a song is loaded.
function recordFadeEvent(stem, level, atTime) {
  if (!automationCurrentBase) return;
  // Recording lock during section LOOPER: while a section is looping the
  // playhead is pinned to startT (the underlying MediaElement is silenced),
  // so any fader move while looping would land EVERY event at the loop
  // start — and as soon as the loop wraps, the dispatcher would refire its
  // own automation events on top of yours. Per user spec (regression Q2c)
  // we just refuse to record while looping and surface a visible banner.
  if (sectionLooperActive) {
    const lbl = document.getElementById('looper-section-text');
    if (lbl) {
      // Briefly flash a warning. The label restores itself when the looper
      // disengages (toggleSectionLooper rewrites it).
      lbl.classList.add('looper-recording-disabled');
      lbl.dataset.lastWarn = String(Date.now());
      setTimeout(() => {
        if (Date.now() - Number(lbl.dataset.lastWarn || 0) >= 1400) {
          lbl.classList.remove('looper-recording-disabled');
        }
      }, 1500);
    }
    return;
  }
  const t = (typeof atTime === 'number') ? atTime : currentPlayheadSec();
  const ev = { t, type: 'fade', stem, level: Math.max(0, Math.min(10, level)), fired: true };
  // Dedup window: collapse multiple fader landings within the SAME SECOND
  // into one event holding the FINAL value. Two fader moves > 1s apart on
  // the same stem stay as two distinct envelope points. Per user spec:
  // "ramp consolidated to 1 event if fades are in the same second."
  const NEAR = 1.0;
  const recent = automationEvents.findLast?.(e => e.type === 'fade' && e.stem === stem && Math.abs(e.t - t) < NEAR);
  if (recent) {
    recent.level = ev.level;
  } else {
    automationEvents.push(ev);
    automationEvents.sort((a, b) => a.t - b.t);
  }
  renderAutomationLane();
  markAutomationDirty();
  // Apply audibly. Use the same handler the dispatcher uses so the gain
  // node, mute button, and fader slider all stay in sync.
  fireAutomationEvent(ev).catch(()=>{});
}

function setupStemHotkeys() {
  const stemMap = { v: 'vocals', d: 'drums', b: 'bass', g: 'guitar', p: 'piano', o: 'other' };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Don't fire when typing in an input/select/textarea/contenteditable.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
                tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    // Spacebar — transport play/pause. Works regardless of whether a song
    // is loaded yet; the play button handles the no-song case itself.
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      const btn = document.getElementById('btn-play-pause');
      if (btn) btn.click();
      return;
    }
    if (!automationCurrentBase) return;   // no song loaded → ignore everything below
    const k = e.key;
    // Stem mute/unmute toggle: V/D/B/G/P/O
    const stem = stemMap[k.toLowerCase()];
    if (stem) {
      e.preventDefault();
      recordStemToggleAtPlayhead(stem);
      return;
    }
    // Section boundary: 1..9 → drops a section marker at the current
    // playhead with the corresponding color. The colored band fills from
    // the previous section's t (or 0) to this section's t.
    if (k >= '1' && k <= '9') {
      e.preventDefault();
      recordSectionAtPlayhead(parseInt(k, 10));
      return;
    }
    // M → open the MIDI event modal pre-filled at the current playhead.
    // (Replaces the empty-lane-click trigger which conflicted with the
    // section divider grab.)
    if (k.toLowerCase() === 'm') {
      e.preventDefault();
      openMidiModal(null);
      const timeEl = document.getElementById('midi-f-time');
      if (timeEl) timeEl.value = currentPlayheadSec().toFixed(2);
    }
  });
}

// Open the picker popup near `anchor` to change section `idx`'s color/label.
// Renders all 9 SECTION_COLORS as a small grid; clicking one updates the
// section, closes the picker, and triggers a re-render + dirty flag.
function openSectionPicker(idx, anchor) {
  const picker = document.getElementById('section-picker');
  const grid = document.getElementById('section-picker-grid');
  if (!picker || !grid) return;
  grid.innerHTML = '';
  const current = automationSections[idx]?.color;
  for (let k = 1; k <= 9; k++) {
    const c = SECTION_COLORS[k];
    if (!c) continue;
    const cell = document.createElement('button');
    cell.className = 'section-picker-cell' + (k === current ? ' active' : '');
    cell.style.background = c.bg.replace(/,\s*0\.18\s*\)/, ',0.65)');  // brighter for the picker
    cell.innerHTML = `<span class="section-picker-num">${k}</span><span class="section-picker-name">${escapeHtml(c.name)}</span>`;
    cell.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (automationSections[idx]) {
        automationSections[idx].color = k;
        renderAutomationLane();
        markAutomationDirty();
      }
      closeSectionPicker();
    });
    grid.appendChild(cell);
  }
  // Click-in toggle: 4-beat pre-roll click before this section starts.
  // For section 0 (starts at t=0) that's a silent pre-roll before audio.
  // For mid-song sections it fires as the playhead approaches.
  const clickInRow = document.createElement('div');
  clickInRow.className = 'section-picker-clickin-row';
  const isOn = !!automationSections[idx]?.clickIn;
  clickInRow.innerHTML =
    `<button class="section-picker-clickin-btn${isOn ? ' active' : ''}" type="button">` +
    `<span class="section-picker-clickin-icon">♩♩♩♩</span>` +
    `<span class="section-picker-clickin-label">Click 4 beats in</span>` +
    `<span class="section-picker-clickin-state">${isOn ? 'ON' : 'OFF'}</span>` +
    `</button>`;
  clickInRow.querySelector('button').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!automationSections[idx]) return;
    automationSections[idx].clickIn = !automationSections[idx].clickIn;
    renderAutomationLane();
    markAutomationDirty();
    closeSectionPicker();
  });
  grid.appendChild(clickInRow);
  // Position near the anchor (clicked label). Use viewport coords.
  const r = anchor.getBoundingClientRect();
  picker.style.display = 'block';
  // Defer placement so we can read the picker's own dimensions.
  requestAnimationFrame(() => {
    const pr = picker.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    let top  = r.bottom + 6;
    left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left));
    if (top + pr.height + 8 > window.innerHeight) top = r.top - pr.height - 6;
    picker.style.left = `${left}px`;
    picker.style.top  = `${top}px`;
  });
}

function closeSectionPicker() {
  const picker = document.getElementById('section-picker');
  if (picker) picker.style.display = 'none';
}

// Backdrop click closes the picker (added once at boot).
document.addEventListener('click', (ev) => {
  const picker = document.getElementById('section-picker');
  if (!picker || picker.style.display === 'none') return;
  if (!picker.contains(ev.target)) closeSectionPicker();
}, true);

// Snap a time value to the nearest beat. Two-pass approach:
//
//   Pass 1 — BPM math:     beat = offset + N × (60/BPM). Gives a regular grid
//                          aligned to the song's first downbeat.
//   Pass 2 — Onset refine: search `window.songOnsetTimes` (peaks detected by
//                          the visualizer, dominated by drum hits) for an
//                          actual onset within ±100 ms of the grid beat.
//                          Use the onset's exact time if found — this
//                          accounts for slight BPM drift and avoids "off by
//                          a tick" snap when the song isn't perfectly to
//                          a metronome.
//
// Returns `t` rounded to 0.01s if BPM is missing.
function snapTimeToBeat(t) {
  const bpm = currentSong && currentSong.practiceBpm;
  if (!bpm) return Math.round(t * 100) / 100;
  const beatSec = 60 / bpm;
  const offset = (typeof getBeatOffsetSec === 'function') ? getBeatOffsetSec() : 0;
  const beatNum = Math.max(0, Math.round((t - offset) / beatSec));
  const gridT = offset + beatNum * beatSec;

  // Pass 2: snap to the nearest detected onset if one sits close to gridT.
  const WINDOW = 0.1;  // ±100 ms
  const onsets = window.songOnsetTimes;
  if (Array.isArray(onsets) && onsets.length) {
    let best = null, bestDist = WINDOW;
    for (const ot of onsets) {
      const d = Math.abs(ot - gridT);
      if (d < bestDist) { bestDist = d; best = ot; }
      else if (ot - gridT > WINDOW) break;
    }
    if (best !== null) return Math.max(0, Math.round(best * 100) / 100);
  }
  return Math.max(0, Math.round(gridT * 100) / 100);
}

// Section-specific snap. First tries to land on a sectionCandidate
// (multi-stem novelty peak from section_detect.py) within ±2 s of the
// user's target; if none is in range, falls back to the regular
// snapTimeToBeat (BPM-grid + onset refine). This gives section
// boundaries musical accuracy even when the user clicks fuzzy.
function snapSectionToCandidate(t) {
  const CANDIDATE_WINDOW = 2.0;
  if (Array.isArray(automationSectionCandidates) && automationSectionCandidates.length) {
    let best = null, bestDist = CANDIDATE_WINDOW;
    for (const ct of automationSectionCandidates) {
      const d = Math.abs(ct - t);
      if (d < bestDist) { bestDist = d; best = ct; }
      else if (ct - t > CANDIDATE_WINDOW) break;
    }
    if (best !== null) {
      // Round to centiseconds — candidates are stored 2 decimals already.
      return Math.max(0, Math.round(best * 100) / 100);
    }
  }
  return snapTimeToBeat(t);
}

// Append a section marker at the current playhead. If a section already
// exists very close to now, overwrite its color rather than adding a new
// one (so the user can fix a fat-finger key press). The boundary is
// quantized to the nearest beat so loop wraps stay rhythmic.
function recordSectionAtPlayhead(color) {
  if (!automationCurrentBase) return;
  if (!SECTION_COLORS[color]) return;
  const rawT = currentPlayheadSec();
  const t = snapSectionToCandidate(rawT);
  const NEAR = 0.3;
  const existing = automationSections.find(s => Math.abs(s.t - t) < NEAR);
  if (existing) {
    existing.color = color;
  } else {
    automationSections.push({ t, color });
    automationSections.sort((a, b) => a.t - b.t);
  }
  renderAutomationLane();
  markAutomationDirty();
}

// Single entry point used by the dispatcher. Routes by type:
//   pc / cc    → MIDI sidecar (out over wire to Helix/Logic/XR18)
//   mute       → flip mixerState.muted[stem] on, repaint mute button
//   unmute     → flip mixerState.muted[stem] off, repaint
//   fade       → stub for now; ramps come later
async function fireAutomationEvent(e) {
  // INIT — apply the captured initial state to every stem in one shot.
  if (e.type === 'init' && e.state && typeof e.state === 'object') {
    for (const [stem, level] of Object.entries(e.state)) {
      applyFadeToStem(stem, level);
    }
    return;
  }
  // Legacy mute/unmute: treat as fade to 0 or 10.
  if (e.type === 'mute' || e.type === 'unmute') {
    return applyFadeToStem(e.stem, e.type === 'mute' ? 0 : 10);
  }
  // Modern fade event: level is 0..10 inclusive (0 = muted, 10 = 100%).
  if (e.type === 'fade') {
    const lvl = (typeof e.level === 'number') ? e.level
              : (typeof e.value === 'number') ? Math.round(e.value * 10) : 0;
    return applyFadeToStem(e.stem, lvl);
  }
  if (e.type === 'pc' || e.type === 'cc' || e.type === 'note_on' || e.type === 'note_off') {
    return sendMidiNow(e);
  }
  if (e.type === 'play-clip') {
    return firePlayClip(e);
  }
}

// Play a CUSTOM_LOOPS sample in parallel with the backing track. Each
// firing gets its own Audio element wired into the master gain bus so
// it inherits the master volume + obeys master mute. We don't loop
// (one-shot for now); the element self-destructs when it ends so an
// armful of fires doesn't accumulate stale nodes.
function firePlayClip(e) {
  const file = e && e.clip;
  if (!file) { console.warn('[play-clip] no clip selected'); return; }
  // Boost in dB → linear gain. 0 dB = 1.0, +5 dB ≈ 1.78, +10 dB ≈ 3.16,
  // +20 dB = 10.0. Web Audio gain has no hard ceiling but the audio
  // device's headroom does, so a soft hot clip will clip at the top.
  const boostDb = (e && Number(e.boost)) || 0;
  const boostGain = Math.pow(10, boostDb / 20);
  try {
    if (!audioCtx) initAudioCtx();
    const a = new Audio('/api/audio/custom-loop/' + encodeURIComponent(file));
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.volume = 1.0;
    if (audioCtx && masterGainNode) {
      try {
        const src = audioCtx.createMediaElementSource(a);
        if (boostGain !== 1.0) {
          const g = audioCtx.createGain();
          g.gain.value = boostGain;
          src.connect(g).connect(masterGainNode);
        } else {
          src.connect(masterGainNode);
        }
      } catch (er) {
        // createMediaElementSource throws if the element is already
        // wired; fall back to direct element output.
        console.warn('[play-clip] createMediaElementSource failed:', er);
      }
    }
    a.addEventListener('ended', () => {
      try { a.removeAttribute('src'); a.load(); } catch (er) {}
    });
    a.play().catch(er => console.warn('[play-clip] play failed:', er));
  } catch (er) { console.warn('[play-clip] fire failed:', er); }
}

// Apply a fade level to a stem: level 0 = mute on + fader 0, level n in
// 1..10 = mute off + fader at n*10%. Updates mixerState, the visible
// mute/fader controls, and triggers applyMixerVolumes so the audio
// hardware/Web Audio gain nodes follow.
function applyFadeToStem(stem, level) {
  if (!stem || !mixerState.muted || !(stem in mixerState.muted)) return;
  level = Math.max(0, Math.min(10, Math.round(level)));
  const wantMute = (level === 0);
  const vol = wantMute ? 0 : (level / 10);
  if (mixerState.muted[stem] !== wantMute) {
    mixerState.muted[stem] = wantMute;
    const btn = document.getElementById(`mute-${stem}`);
    if (btn) btn.classList.toggle('active', wantMute);
  }
  // Only set fader if we're unmuting (or fading to a specific value).
  // For mute, we don't reset the user's prior fader position.
  if (!wantMute) {
    mixerState.volumes[stem] = vol;
    const fader = document.getElementById(`fader-${stem}`);
    const val = document.getElementById(`val-${stem}`);
    if (fader) fader.value = vol;
    if (val) val.textContent = `${Math.round(vol * 100)}%`;
  }
  if (typeof applyMixerVolumes === 'function') applyMixerVolumes();
  if (typeof saveMixerState === 'function') saveMixerState();
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

// ── Action-row constants (hoisted to module scope, NOT inside setupMidiUI) ─
// Previously these were declared mid-function which made setupMidiActionRow
// crash with "Cannot access RECENT_SLOTS before initialization" because the
// row's render runs before the line that introduces the const. Top-level
// declarations dodge the temporal-dead-zone entirely.
const RECENT_KEY   = 'simpleStem.midiRecentUses.v1';
const RECENT_SLOTS = 5;
// Remember what the user picked last time so the dialog opens with their
// most recent choices instead of starting from scratch. Keyed by action
// type so PC and CC each keep their own "last values."
const LAST_TYPE_KEY    = 'simpleStem.midiLastType.v1';
const LAST_BY_TYPE_KEY = 'simpleStem.midiLastByType.v1';
const CH_BY_DEVICE_KEY = 'simpleStem.midiChannelByDevice.v1';

function loadLastActionType() {
  try { return localStorage.getItem(LAST_TYPE_KEY) || 'pc'; } catch (e) { return 'pc'; }
}
function saveLastActionType(t) {
  try { localStorage.setItem(LAST_TYPE_KEY, t); } catch (e) {}
}
function loadLastByType() {
  try {
    const raw = localStorage.getItem(LAST_BY_TYPE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveLastByType(m) {
  try { localStorage.setItem(LAST_BY_TYPE_KEY, JSON.stringify(m)); } catch (e) {}
}
function loadChannelByDevice() {
  try {
    const raw = localStorage.getItem(CH_BY_DEVICE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveChannelByDevice(m) {
  try { localStorage.setItem(CH_BY_DEVICE_KEY, JSON.stringify(m)); } catch (e) {}
}
// Bump these stores after a successful Save.
function recordActionDefaults(a) {
  if (!a || !a.type) return;
  saveLastActionType(a.type);
  const m = loadLastByType();
  m[a.type] = Object.assign({}, a);
  delete m[a.type].t;       // time is per-event, not a default
  delete m[a.type].label;   // label is per-event, not a default
  delete m[a.type].fired;
  saveLastByType(m);
  if (a.device && a.channel != null) {
    const c = loadChannelByDevice();
    c[a.device] = a.channel;
    saveChannelByDevice(c);
  }
}

function setupMidiUI() {
  setupMidiActionRow();
  const lane = document.getElementById('midi-lane');
  if (!lane) return;
  lane.addEventListener('click', (e) => {
    if (e.target.closest('.midi-event-marker')) return;
    if (e.target.closest('.automation-section-divider')) return;
    // Empty-lane click no longer opens the MIDI modal — the cross-hair
    // cursor was getting in the way of grabbing section dividers and
    // section labels. Use the 'M' keyboard shortcut instead.
    automationSelectedIdx = null;
    renderAutomationLane();
  });

  // Delete key removes the selected marker. Skip if a text input is focused.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' ||
                tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (automationSelectedIdx == null) return;
    e.preventDefault();
    deleteSelectedMarker();
  });

  // Re-render the lane whenever the active audio element learns its
  // duration. Without this the lane stays empty until the playback loop
  // happens to repaint (i.e. user presses play). With it, markers paint
  // as soon as the first stem's `loadedmetadata` fires.
  Object.values(audioElements || {}).forEach(ae => {
    ae.addEventListener('loadedmetadata', () => renderAutomationLane());
    ae.addEventListener('durationchange', () => renderAutomationLane());
  });

  document.getElementById('midi-f-type').addEventListener('change', () => {
    midiModalTypeChanged();
    // Switch in the remembered defaults for the newly-picked type so the
    // form mirrors what the user did the LAST time they used this type.
    const newType = document.getElementById('midi-f-type').value;
    const lastByType = loadLastByType();
    const d = lastByType[newType];
    if (d) {
      if (d.device  != null) document.getElementById('midi-f-device').value  = d.device;
      if (d.channel != null) document.getElementById('midi-f-channel').value = d.channel;
      if (d.program != null && document.getElementById('midi-f-program'))
        document.getElementById('midi-f-program').value = d.program;
      if (d.controller != null && document.getElementById('midi-f-controller'))
        document.getElementById('midi-f-controller').value = d.controller;
      if (d.value != null && document.getElementById('midi-f-value'))
        document.getElementById('midi-f-value').value = d.value;
      if (d.note != null && document.getElementById('midi-f-note'))
        document.getElementById('midi-f-note').value = d.note;
      if (d.velocity != null && document.getElementById('midi-f-velocity'))
        document.getElementById('midi-f-velocity').value = d.velocity;
      if (d.stem != null && document.getElementById('midi-f-stem'))
        document.getElementById('midi-f-stem').value = d.stem;
    }
    updateShorthandPreview();
  });
  // When the user picks a different device, reload the channel they last
  // used WITH THAT device — so "I always send to my Helix on ch4 and my
  // XR18 on ch5" stays sticky.
  document.getElementById('midi-f-device').addEventListener('change', () => {
    const dev = document.getElementById('midi-f-device').value;
    const m = loadChannelByDevice();
    if (m[dev] != null) document.getElementById('midi-f-channel').value = m[dev];
    updateShorthandPreview();
  });
  // Live shorthand preview — refresh whenever any modal input changes.
  // Covers channel/program/controller/value/note/velocity/stem.
  const previewFields = [
    'midi-f-channel', 'midi-f-program', 'midi-f-controller',
    'midi-f-value', 'midi-f-note', 'midi-f-velocity', 'midi-f-stem',
    'midi-f-device',
  ];
  for (const id of previewFields) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input',  updateShorthandPreview);
    el.addEventListener('change', updateShorthandPreview);
  }
  // CC quick-pick: when the user selects a common controller from the
  // preset dropdown, write it into the Controller field. They can still
  // edit it afterward.
  const ccPreset = document.getElementById('midi-f-cc-preset');
  if (ccPreset) {
    ccPreset.addEventListener('change', () => {
      if (!ccPreset.value) return;
      document.getElementById('midi-f-controller').value = ccPreset.value;
      // Don't auto-fill the label anymore — the user wanted the shorthand
      // (e.g. M4C121=0) to be the saved value when label is left blank.
      updateShorthandPreview();
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
    // The Label field already carries the shorthand by default (the form
    // syncs as the user types), so usually .label is non-empty. If the
    // user blanked it on purpose, fall back to the shorthand so the
    // timeline chip still reads something.
    if (!ev.label) ev.label = actionShorthand(ev);
    if (automationEditingIdx === null) automationEvents.push(ev);
    else automationEvents[automationEditingIdx] = ev;
    automationEvents.sort((a, b) => a.t - b.t);
    // Bump the usage counter so the most-used actions float up into the
    // quick-fire row beside +Action.
    recordRecentUse(ev);
    // Remember per-type defaults + per-device channel so the next open
    // of this dialog starts where we left off.
    recordActionDefaults(ev);
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

  // INIT — snapshot the current mixer state as a single 'init' event at t=0
  // and CLEAR every other automation event on the timeline. This is the
  // "fresh start with the song-opening mix" the user wanted: tweak faders
  // to taste, hit INIT, song starts with that mix every time. A block 'I'
  // marker renders at the left edge to indicate the saved initial state.
  const initBtn = document.getElementById('midi-btn-init-state');
  if (initBtn) {
    initBtn.addEventListener('click', () => {
      if (!automationCurrentBase) return;
      // INIT wipes the timeline's automation events (V0, D6, M4P12, etc.)
      // and replaces them with a single 'init' event holding the current
      // mixer snapshot. Section markers (Intro/Verse/Chorus/etc.) are
      // PRESERVED — they describe song structure, independent of automation.
      const hasEvents = automationEvents.length > 0;
      if (hasEvents) {
        if (!confirm(`INIT will clear all ${automationEvents.length} action(s) on the timeline (section markers stay) and replace them with the current mixer state. Continue?`)) return;
      }
      const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
      const state = {};
      for (const stem of STEMS) {
        if (!(stem in (mixerState.volumes || {}))) continue;
        const vol = mixerState.volumes[stem];
        const muted = mixerState.muted[stem];
        state[stem] = muted ? 0 : Math.max(0, Math.min(10, Math.round(vol * 10)));
      }
      automationEvents = [{ t: 0, type: 'init', state, fired: false }];
      automationSelectedIdx = null;
      renderAutomationLane();
      markAutomationDirty();
    });
  }

  // ── MIDI action row: +Action + frequency-tracked recent-actions slots ──
  // Replaces the crosshair-cursor "click anywhere on the lane to add" UX
  // AND the static 5-slot manual presets. Every time the user saves an
  // action through the modal, we increment a usage counter keyed by the
  // action's signature; the top 5 most-used actions are then shown as
  // quick-fire buttons to the right of +Action. Single click drops the
  // action at the playhead and fires it live through the sidecar.
  // (RECENT_KEY / RECENT_SLOTS hoisted to module scope above setupMidiUI
  // so this row renders even though setupMidiActionRow() runs first.)

  function loadRecentMap() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  }
  function saveRecentMap(m) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(m)); } catch (e) {}
  }
  // Stable signature so e.g. "PC ch4 prog3 on helix" tallies the same
  // every time. The user's custom label is NOT part of the signature
  // (two labels for the same MIDI payload share a counter).
  function actionSignature(a) {
    const parts = [a.type || 'x'];
    if (a.device) parts.push(a.device);
    if (a.channel != null) parts.push('c' + a.channel);
    if (a.program != null) parts.push('p' + a.program);
    if (a.controller != null) parts.push('cc' + a.controller);
    if (a.value != null) parts.push('v' + a.value);
    if (a.note != null) parts.push('n' + a.note);
    if (a.velocity != null) parts.push('vel' + a.velocity);
    if (a.stem) parts.push(a.stem);
    return parts.join(':');
  }
  // Shorthand the user can read at a glance. Format follows Bill's
  // example "M4P12" (MIDI channel 4, Program 12).
  function actionShorthand(a) {
    if (!a) return '';
    if (a.type === 'pc') return `M${a.channel}P${a.program}`;
    if (a.type === 'cc') return `M${a.channel}C${a.controller}=${a.value}`;
    if (a.type === 'note_on')  return `M${a.channel}N+${a.note}v${a.velocity}`;
    if (a.type === 'note_off') return `M${a.channel}N-${a.note}`;
    if (a.type === 'mute')     return `${(a.stem||'?')[0].toUpperCase()}-mute`;
    if (a.type === 'unmute')   return `${(a.stem||'?')[0].toUpperCase()}-on`;
    if (a.type === 'fade')     return `${(a.stem||'?')[0].toUpperCase()}${a.level}`;
    return a.type || '?';
  }
  // Bump the usage counter when an action lands in the timeline.
  // Stored entry: { sig, count, lastUsed, sample: the action itself }
  function recordRecentUse(a) {
    if (!a || !a.type) return;
    const sig = actionSignature(a);
    const m = loadRecentMap();
    const prev = m[sig] || { sig, count: 0, sample: null };
    m[sig] = {
      sig,
      count: prev.count + 1,
      lastUsed: Date.now(),
      sample: a,    // keep the most recent invocation as the canonical form
    };
    saveRecentMap(m);
    renderRecentSlots();
  }
  // Pick the top-RECENT_SLOTS most-used (ties broken by recency). Empty
  // slots are NOT shown — slots only materialize once you've used an
  // action at least once.
  function topRecentActions() {
    const m = loadRecentMap();
    return Object.values(m)
      .filter(e => e.sample)
      .sort((a, b) => (b.count - a.count) || (b.lastUsed - a.lastUsed))
      .slice(0, RECENT_SLOTS);
  }
  function renderRecentSlots() {
    const host = document.getElementById('midi-preset-slots');
    if (!host) return;
    const top = topRecentActions();
    host.innerHTML = '';
    if (!top.length) {
      const hint = document.createElement('span');
      hint.className = 'midi-recent-hint';
      hint.textContent = '↑ your most-used actions will appear here';
      host.appendChild(hint);
      return;
    }
    top.forEach(({ sample, count }) => {
      const a = sample;
      const sh = actionShorthand(a);
      const btn = document.createElement('button');
      btn.className = 'midi-preset-slot';
      // Bottom line:
      //   - Use the custom label IF the user actually typed something
      //     different from the auto-shorthand.
      //   - Otherwise show just the use count (·N), no duplicate of the
      //     shorthand on the line above.
      const isCustom = a.label && a.label !== sh;
      const bottom = isCustom
        ? `${escapeHtml(a.label)}${count > 1 ? ` ·${count}` : ''}`
        : (count > 1 ? `·${count}` : '');
      btn.innerHTML = `<span class="midi-preset-lingo">${escapeHtml(sh)}</span>` +
                      (bottom ? `<span class="midi-preset-human">${bottom}</span>` : '');
      btn.title = `Click: drop ${sh} at the playhead.\nRight-click: forget this action.`;
      btn.addEventListener('click', () => fireRecentAtPlayhead(a));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const m = loadRecentMap();
        delete m[actionSignature(a)];
        saveRecentMap(m);
        renderRecentSlots();
      });
      host.appendChild(btn);
    });
  }
  function fireRecentAtPlayhead(a) {
    if (!automationCurrentBase) { alert('Load a song first.'); return; }
    const t = currentPlayheadSec();
    const ev = Object.assign({}, a, {
      t,
      label: a.label || actionShorthand(a),
      fired: true,
    });
    automationEvents.push(ev);
    try { fireAutomationEvent(ev); } catch (e) { console.warn('[recent] fire failed:', e); }
    automationEvents.sort((a, b) => a.t - b.t);
    renderAutomationLane();
    markAutomationDirty();
    recordRecentUse(a);   // bump count so winners keep winning
  }

  function setupMidiActionRow() {
    const addBtn = document.getElementById('midi-btn-add-event');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (!automationCurrentBase) { alert('Load a song first.'); return; }
        openMidiModal(null);
        const timeEl = document.getElementById('midi-f-time');
        if (timeEl) timeEl.value = currentPlayheadSec().toFixed(2);
        // Re-render shorthand preview from current field values.
        updateShorthandPreview();
      });
    }
    // + CLIP button: quick-drop a Play Clip action without going through
    // the full Action editor. Opens a focused modal that asks only for
    // the clip and anchor mode (start-at-playhead or end-at-playhead).
    const clipBtn = document.getElementById('midi-btn-add-clip');
    if (clipBtn) {
      clipBtn.addEventListener('click', () => {
        if (!automationCurrentBase) { alert('Load a song first.'); return; }
        openClipQuickModal();
      });
    }
    renderRecentSlots();
  }
  // Exposed so other code (modal save) can refresh the row.
  window.__renderRecentSlots = renderRecentSlots;
  window.__recordRecentUse   = recordRecentUse;
  window.__actionShorthand   = actionShorthand;

  // Per user spec: the shorthand is now the DEFAULT VALUE of the Label
  // field — it tracks the form as you type. The user can overwrite the
  // label with anything they want, and we only re-sync when the label is
  // empty or still matches the previously-derived shorthand. This keeps
  // a user-typed "Big Lead Patch" from being clobbered when they nudge
  // the channel after typing.
  let _lastAutoShorthand = '';
  function updateShorthandPreview() {
    const labelEl = document.getElementById('midi-f-label');
    if (!labelEl) return;
    try {
      const a = readMidiModalForm();
      const sh = actionShorthand(a) || '';
      if (!labelEl.value || labelEl.value === _lastAutoShorthand) {
        labelEl.value = sh;
      }
      _lastAutoShorthand = sh;
    } catch (e) { /* ignore */ }
  }
  // Reset the auto-sync watermark when the modal opens so the first
  // re-sync after edit takes hold cleanly.
  window.__resetShorthandWatermark = () => { _lastAutoShorthand = ''; };
  window.__updateShorthandPreview = updateShorthandPreview;

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
  // ACCEPT — drop a section marker at every auto-detected candidate that
  // isn't already covered by a saved section. Quick way to rough-in all
  // the boundaries for a song; the user can then relabel/move/delete with
  // existing UI. Color rotates 1..9 (Intro/Verse/Chorus/Bridge/…) so
  // adjacent sections are visually distinct.
  document.getElementById('midi-btn-accept-candidates').addEventListener('click', () => {
    if (!automationCurrentBase) return;
    const cands = automationSectionCandidates || [];
    if (!cands.length) {
      alert("This song has no auto-detected section candidates yet.\n\n" +
            "Run ./backfill_section_detect.sh --go on the Performer to compute them for the existing library.");
      return;
    }
    const NEAR = 0.5;
    let added = 0;
    let colorIdx = (automationSections.length % 9) + 1;
    for (const t of cands) {
      if (automationSections.some(s => Math.abs(s.t - t) < NEAR)) continue;
      automationSections.push({ t, color: colorIdx });
      colorIdx = (colorIdx % 9) + 1;
      added++;
    }
    if (added === 0) { alert('Every candidate is already covered by a section.'); return; }
    automationSections.sort((a, b) => a.t - b.t);
    renderAutomationLane();
    markAutomationDirty();
  });

  // NEXT ▶ — jump to the next song in the library that has zero saved
  // sections, so you can work through the catalog without manually picking.
  // Uses the existing /api/song/:base/automation endpoint to peek at each
  // candidate before loading audio — cheap, no autoplay.
  document.getElementById('midi-btn-next-unsectioned').addEventListener('click', async () => {
    if (!mergedLibrary || !mergedLibrary.length) { alert('Library still loading.'); return; }
    // Build an ordered list of stems-having songs, starting AFTER the current.
    const stemsRows = mergedLibrary
      .map(m => m.variants.find(v => v.type === 'stems'))
      .filter(Boolean);
    const curBase = automationCurrentBase;
    const startIdx = curBase ? stemsRows.findIndex(v => v.folderName === curBase) : -1;
    const ordered = [
      ...stemsRows.slice(startIdx + 1),
      ...stemsRows.slice(0, Math.max(0, startIdx + 1)),
    ];
    for (const v of ordered) {
      try {
        const r = await fetch(`/api/song/${encodeURIComponent(v.folderName)}/automation?_=${Date.now()}`);
        const d = await r.json();
        const has = Array.isArray(d.sections) && d.sections.length > 0;
        if (!has) {
          loadSong(v, { autoplay: false });
          return;
        }
      } catch (e) { /* keep walking */ }
    }
    alert('Every song in the library already has at least one section marker.');
  });

  document.getElementById('midi-btn-clear-actions').addEventListener('click', async () => {
    if (!automationCurrentBase) return;
    // CLEAR wipes ACTION events only. Section markers (Intro/Verse/Chorus/
    // etc.) are intentionally preserved — they're structural cues for the
    // players, not transient automation, and the user wants them sticky
    // across CLEAR and INIT.
    if (automationEvents.length === 0) return;
    if (!confirm(`Clear all ${automationEvents.length} action(s) on this song's timeline? (Section markers will be kept.)`)) return;
    automationEvents = [];
    renderAutomationLane();
    markAutomationDirty();
    try {
      // saveAutomationForSong reads the current automationSections at send
      // time, so they ride along untouched.
      await saveAutomationForSong(automationCurrentBase, []);
    } catch (err) {
      alert(`Clear-save failed: ${err.message}. Local state cleared but disk still has old data.`);
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

// ──────────────────────────────────────────────────────────────────────────
// AI Setlist Builder (v3 — multi-bot)
//
// Operator types or dictates a gig description, picks which chatbots
// to query via checkboxes (Claude / ChatGPT / Gemini / DeepSeek /
// Perplexity / Grok 3 — all on by default, persisted to localStorage),
// then clicks Generate. The server writes the prompt to disk and kicks
// off a Keyboard Maestro macro that drives each selected bot's web UI
// in Chrome. The browser polls every 4 s and renders each bot's reply
// in its own card as it lands. Each card has its own Save button so
// the operator can pick whichever flow they like best.
//
// Manual-paste fallback: each pending bot card carries a textarea +
// Submit button. If the operator doesn't have a macro for that bot
// (or it's misbehaving), they can run the chat themselves, paste the
// reply into the textarea, hit Submit. The portal writes it to the
// per-bot response file and the next poll picks it up like a macro
// would have.
async function setupAiSetlistBuilder() {
  const promptEl    = document.getElementById('ai-setlist-prompt');
  const goBtn       = document.getElementById('btn-ai-setlist-generate');
  const micBtn      = document.getElementById('btn-ai-setlist-mic');
  const statusEl    = document.getElementById('ai-setlist-status');
  const checkboxesEl= document.getElementById('ai-bot-checkboxes');
  const resultsEl   = document.getElementById('ai-setlist-results');
  if (!promptEl || !goBtn || !checkboxesEl || !resultsEl) return;

  // ── Chatbot checkboxes ────────────────────────────────────────────
  // Fetch the supported bot list from the server (single source of
  // truth) and render checkboxes. Selection persists to localStorage.
  const BOTS_KEY = 'simpleStem.aiSetlistBots';
  let bots = [];
  try {
    const r = await fetch('/api/setlist/ai-bots');
    const d = await r.json();
    bots = d.bots || [];
  } catch (e) { console.warn('[ai-setlist] bot list fetch failed:', e); }
  if (!bots.length) {
    bots = [
      { id: 'claude',     name: 'Claude' },
      { id: 'chatgpt',    name: 'ChatGPT' },
      { id: 'gemini',     name: 'Gemini' },
      { id: 'deepseek',   name: 'DeepSeek' },
      { id: 'perplexity', name: 'Perplexity' },
      { id: 'grok',       name: 'Grok 3' },
    ];
  }
  // Load saved selection; default to all selected.
  let selected;
  try {
    const raw = localStorage.getItem(BOTS_KEY);
    selected = raw ? JSON.parse(raw) : null;
  } catch (e) { selected = null; }
  if (!Array.isArray(selected) || !selected.length) selected = bots.map(b => b.id);
  checkboxesEl.innerHTML = bots.map(b => `
    <label class="ai-bot-checkbox">
      <input type="checkbox" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''}>
      <span class="ai-bot-name">${escapeHtml(b.name)}</span>
    </label>
  `).join('');
  checkboxesEl.addEventListener('change', () => {
    const chosen = Array.from(checkboxesEl.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
    try { localStorage.setItem(BOTS_KEY, JSON.stringify(chosen)); } catch (e) {}
  });
  function readSelectedBots() {
    return Array.from(checkboxesEl.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
  }

  let pollTimer = null;
  let currentJobBots = [];

  // ── Voice input + microphone panel ─────────────────────────────────
  // Two parallel mic captures, same pattern HOLODECK uses:
  //
  //   (a) navigator.mediaDevices.getUserMedia → AudioContext → AnalyserNode
  //       drives the VU meter, RMS/peak readouts, AudioCtx state, stream
  //       state — proves the system is HEARING the operator even when the
  //       speech engine is misbehaving.
  //
  //   (b) Web Speech API SpeechRecognition handles the actual transcription;
  //       interim results stream into the "Heard" line live, final results
  //       commit into the prompt textarea.
  //
  // Mic device picker writes to its own localStorage key (aiSetlistMicId)
  // so the operator can use a different mic here than HOLODECK uses.
  const panelEl   = document.getElementById('aism-panel');
  const stateEl   = document.getElementById('aism-state');
  const micSelect = document.getElementById('aism-mic-select');
  const vuEl      = document.getElementById('aism-vu');
  const vuDbEl    = document.getElementById('aism-vu-db');
  const rmsEl     = document.getElementById('aism-rms');
  const peakRawEl = document.getElementById('aism-peak');
  const streamEl  = document.getElementById('aism-stream');
  const actxEl    = document.getElementById('aism-actx');
  const heardEl   = document.getElementById('aism-heard');
  const AISM_KEY  = 'aiSetlistMicId';
  const AISM_VU_SEGMENTS = 20;

  if (vuEl && !vuEl.children.length) {
    vuEl.innerHTML = Array.from({ length: AISM_VU_SEGMENTS },
      (_, i) => `<span class="aism-vu-seg" data-i="${i}"></span>`).join('');
  }
  // Populate the mic dropdown at boot. Labels are anonymous ("microphone
  // 1", etc) until the operator grants mic permission once; clicking
  // Speak the first time will re-populate with real device names.
  populateAismMicList().catch(() => {});

  async function populateAismMicList() {
    if (!micSelect) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      let saved = '';
      try { saved = localStorage.getItem(AISM_KEY) || ''; } catch (e) {}
      micSelect.innerHTML = '<option value="">(default)</option>' + mics.map((d, i) => {
        const label = (d.label || `microphone ${i + 1}`).replace(/[<>"&]/g, '');
        const selected = d.deviceId === saved ? ' selected' : '';
        return `<option value="${d.deviceId}"${selected}>${label}</option>`;
      }).join('');
    } catch (e) { console.warn('[ai-setlist mic] enumerateDevices failed:', e); }
  }

  let micRecognition = null;
  let micActive      = false;
  let micStream      = null;
  let micAudioCtx    = null;
  let micAnalyser    = null;
  let micRAF         = 0;
  let micRestartReq  = false;
  let committedLen   = 0;
  let _diagFrame     = 0;

  function setAismState(text, cls) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.className = 'aism-state ' + (cls || '');
  }
  function setAismVU(level) {
    if (!vuEl) return;
    const segs = vuEl.querySelectorAll('.aism-vu-seg');
    const lit = Math.round(level * AISM_VU_SEGMENTS);
    segs.forEach((s, i) => s.classList.toggle('lit', i < lit));
    if (vuDbEl) {
      const db = level > 0.001 ? Math.max(-40, Math.min(0, 20 * Math.log10(level))).toFixed(0) : null;
      vuDbEl.textContent = db === null ? '-∞' : (db + ' dB');
    }
  }
  function drawAismMeter() {
    if (!micAnalyser) return;
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    micAnalyser.getByteTimeDomainData(data);
    let sum = 0, peakRaw = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
      const av = Math.abs(data[i] - 128);
      if (av > peakRaw) peakRaw = av;
    }
    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(1, rms * 4);
    setAismVU(level);
    // Slow the numeric readouts so they're legible (~4 Hz).
    if ((_diagFrame++ & 15) === 0) {
      if (rmsEl)     rmsEl.textContent = rms.toFixed(3);
      if (peakRawEl) peakRawEl.textContent = String(peakRaw);
      if (actxEl)    actxEl.textContent = micAudioCtx ? micAudioCtx.state : '—';
      if (streamEl && micStream) {
        const t = micStream.getAudioTracks()[0];
        streamEl.textContent = t
          ? `${t.readyState} · ${(t.label || '(no label)').slice(0, 32)}${t.muted ? ' · OS-muted' : ''}`
          : 'no track';
      }
    }
    micRAF = requestAnimationFrame(drawAismMeter);
  }

  async function startAismMic() {
    if (micActive) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus('Voice recognition not supported in this browser.', 'err');
      return;
    }
    // Chrome enforces ONE active SpeechRecognition per page. If HOLODECK
    // is currently listening, the new SR call immediately ends (onstart
    // → onaudiostart → onaudioend → onend with null error). Stop HOLODECK
    // first to free the engine.
    try {
      if (window.HOLODECK && typeof window.HOLODECK.stop === 'function') {
        console.log('[aism] stopping HOLODECK to free the Web Speech engine');
        window.HOLODECK.stop();
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) { console.warn('[aism] HOLODECK.stop() failed:', e); }
    setAismState('● requesting mic…', 'on');

    // Picker drives the VU meter via { deviceId: { exact: X } }. Without
    // `exact`, Chrome treats the deviceId as a soft preference and silently
    // falls back to its own chosen default (often the first audio device,
    // which on this rig is the XR18 — silent when powered off).
    //
    // `exact` does NOT affect Web Speech. SR is independently hard-bound
    // to Chrome's per-site default mic, configured at
    // chrome://settings/content/microphone. So the picker controls VU,
    // Chrome's per-site setting controls SR — two separate dials.
    let savedMic = '';
    try { savedMic = localStorage.getItem(AISM_KEY) || ''; } catch (e) {}
    const constraints = savedMic
      ? { audio: { deviceId: { exact: savedMic } } }
      : { audio: true };
    console.log('[aism] requesting mic with constraints:', JSON.stringify(constraints));
    try {
      micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('[ai-setlist mic] getUserMedia failed:', e);
      setAismState('✗ mic blocked', 'err');
      setStatus('Microphone permission denied or device unavailable.', 'err');
      return;
    }
    populateAismMicList();

    try {
      micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (micAudioCtx.state === 'suspended') {
        try { await micAudioCtx.resume(); } catch (e) {}
      }
      const src = micAudioCtx.createMediaStreamSource(micStream);
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.5;
      src.connect(micAnalyser);
      drawAismMeter();
    } catch (e) { console.warn('[ai-setlist mic] meter init failed:', e); }

    // Speech recognition. Interim results stream into the "Heard" line
    // live so the operator sees what the engine thinks they're saying.
    // Only final results commit into the prompt textarea.
    //
    // Diagnostics: every lifecycle event logs to the console with the
    // [aism] tag, and the state badge reflects what stage the engine is
    // in. If VU is moving but text isn't appearing, the badge will say
    // why -- e.g. "✗ not-allowed", "✗ network", or "● running (no result yet)".
    committedLen = promptEl.value.length;
    let lastRecogError = null;
    let resultsSeen    = 0;
    micRecognition = new SR();
    micRecognition.continuous     = true;
    micRecognition.interimResults = true;
    micRecognition.lang           = 'en-US';
    micRecognition.onstart      = () => { console.log('[aism] recog onstart');      setAismState('● running (no result yet)', 'on'); };
    micRecognition.onaudiostart = () => { console.log('[aism] recog onaudiostart'); };
    micRecognition.onspeechstart= () => { console.log('[aism] recog onspeechstart');setAismState('● hearing speech', 'on'); };
    micRecognition.onspeechend  = () => { console.log('[aism] recog onspeechend'); };
    micRecognition.onaudioend   = () => { console.log('[aism] recog onaudioend'); };
    micRecognition.onnomatch    = () => { console.log('[aism] recog onnomatch'); };
    micRecognition.onresult = (ev) => {
      resultsSeen++;
      console.log('[aism] recog onresult', resultsSeen, 'results so far');
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const txt = (r[0].transcript || '').trim();
        if (r.isFinal) {
          const sep = promptEl.value.length && !promptEl.value.endsWith(' ') ? ' ' : '';
          promptEl.value = promptEl.value + sep + txt;
          committedLen = promptEl.value.length;
          if (heardEl) {
            heardEl.textContent = txt;
            heardEl.classList.remove('interim');
          }
          setAismState('✓ committed phrase', 'on');
        } else {
          const sep = committedLen && promptEl.value[committedLen - 1] !== ' ' ? ' ' : '';
          promptEl.value = promptEl.value.slice(0, committedLen) + sep + txt;
          if (heardEl) {
            heardEl.textContent = txt + ' …';
            heardEl.classList.add('interim');
          }
          setAismState('● hearing speech', 'on');
        }
      }
      promptEl.scrollTop = promptEl.scrollHeight;
    };
    // Reset the no-speech counter every time real speech is heard, so
    // a brief silent stretch doesn't accumulate into the "stop trying"
    // threshold. onspeechstart is the trustworthy signal here.
    const _origSpeechStart = micRecognition.onspeechstart;
    micRecognition.onspeechstart = (ev) => {
      noSpeechStreak = 0;
      if (typeof _origSpeechStart === 'function') _origSpeechStart(ev);
    };
    let noSpeechStreak = 0;
    micRecognition.onerror = (ev) => {
      lastRecogError = ev.error || 'unknown';
      console.warn('[aism] recog onerror:', lastRecogError, ev);
      if (lastRecogError === 'no-speech') {
        noSpeechStreak++;
        if (noSpeechStreak === 1) {
          // First no-speech is normal — Web Speech fires it after every
          // silent stretch, even mid-session. Don't alarm the operator.
          setAismState('● listening (waiting for speech)', 'on');
        } else if (noSpeechStreak >= 3) {
          // Three in a row strongly implies SR is bound to a silent mic.
          // Web Speech ignores the picker — it uses Chrome's per-site
          // default. The fix is at chrome://settings/content/microphone.
          setAismState('✗ no speech — open chrome://settings/content/microphone and set the right mic', 'err');
          micRestartReq = false;
        }
      } else {
        setAismState('✗ ' + lastRecogError, 'err');
      }
    };
    micRecognition.onend = () => {
      console.log('[aism] recog onend (last error:', lastRecogError, ')');
      const PERMANENT = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
      if (PERMANENT.has(lastRecogError)) {
        console.warn('[aism] permanent recognition error, not restarting:', lastRecogError);
        setAismState('✗ ' + lastRecogError + ' (mic stopped)', 'err');
        return;
      }
      if (micActive && micRestartReq) {
        // Back off slightly on no-speech to avoid log spam, otherwise
        // restart quickly.
        const delay = lastRecogError === 'no-speech' ? 500 : 200;
        setTimeout(() => {
          try { micRecognition && micRecognition.start(); }
          catch (e) { console.warn('[aism] restart failed:', e); }
        }, delay);
      }
    };
    try {
      micRecognition.start();
      console.log('[aism] recog.start() called (continuous=true interim=true lang=en-US)');
    }
    catch (e) {
      console.warn('[aism] recog.start() threw:', e);
      setAismState('✗ start threw: ' + e.message, 'err');
    }

    micActive = true;
    micRestartReq = true;
    micBtn.classList.add('active');
    const lab = micBtn.querySelector('.ai-mic-label');
    if (lab) lab.textContent = 'Listening…';
    setAismState('● listening', 'on');
  }

  function stopAismMic() {
    micActive = false;
    micRestartReq = false;
    try { micRecognition && micRecognition.stop(); } catch (e) {}
    try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { micAudioCtx && micAudioCtx.close(); } catch (e) {}
    cancelAnimationFrame(micRAF);
    micRecognition = null;
    micStream      = null;
    micAudioCtx    = null;
    micAnalyser    = null;
    setAismVU(0);
    if (micBtn) {
      micBtn.classList.remove('active');
      const lab = micBtn.querySelector('.ai-mic-label');
      if (lab) lab.textContent = 'Speak';
    }
    setAismState('○ stopped', '');
  }

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (micActive) stopAismMic();
      else startAismMic();
    });
  }

  if (micSelect) {
    micSelect.addEventListener('change', async (e) => {
      const deviceId = e.target.value;
      try { localStorage.setItem(AISM_KEY, deviceId); } catch (er) {}
      if (micActive) {
        stopAismMic();
        await new Promise(r => setTimeout(r, 150));
        startAismMic();
      }
    });
  }

  // ── Generate (fires off one KBM job per selected bot) ──────────────
  goBtn.addEventListener('click', async () => {
    const description = (promptEl.value || '').trim();
    if (!description) {
      setStatus('Type or dictate a description first.', 'err');
      return;
    }
    const chosen = readSelectedBots();
    if (!chosen.length) {
      setStatus('Select at least one chatbot to query.', 'err');
      return;
    }
    cancelPolling();
    goBtn.disabled = true;
    setStatus(`Submitting to ${chosen.length} bot(s) via the KBM bridge…`, 'loading');
    currentJobBots = chosen.slice();
    // Don't render cards yet — wait until we have a jobId so the paste
    // fallback in each pending card actually points somewhere.
    try {
      const r = await fetch('/api/setlist/ai-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, bots: chosen }),
      });
      const d = await r.json();
      if (!r.ok) {
        setStatus('✗ ' + (d.error || 'submit failed'), 'err');
        goBtn.disabled = false;
        return;
      }
      const jobId = d.job_id;
      setStatus(`Job ${jobId} submitted to ${chosen.length} bot(s) (library ${d.library_size} songs). Waiting…`, 'loading');
      attachJobToCards(jobId);
      pollTimer = setInterval(() => pollOnce(jobId), 4000);
      pollOnce(jobId);
    } catch (e) {
      setStatus('✗ ' + e.message, 'err');
      goBtn.disabled = false;
    }
  });

  async function pollOnce(jobId) {
    try {
      const r = await fetch('/api/setlist/ai-generate/poll/' + encodeURIComponent(jobId));
      const d = await r.json();
      // d = { overall: 'pending'|'partial'|'ready', elapsed_sec, library_size, bots: { id: {status, ...} } }
      renderResults(d, currentJobBots, jobId);
      if (d.overall === 'ready' || d.overall === 'failed') {
        cancelPolling();
        goBtn.disabled = false;
        const readyCount = Object.values(d.bots || {}).filter(b => b.status === 'ready').length;
        setStatus(`✓ ${readyCount}/${currentJobBots.length} bot(s) returned a setlist in ${d.elapsed_sec}s. Pick the one you like.`, readyCount ? 'ok' : 'err');
      } else if (d.overall === 'partial') {
        const readyCount = Object.values(d.bots || {}).filter(b => b.status === 'ready').length;
        setStatus(`${readyCount}/${currentJobBots.length} ready (${d.elapsed_sec}s) — still waiting on others…`, 'loading');
      } else {
        setStatus(`Waiting for replies… (${d.elapsed_sec}s)`, 'loading');
      }
    } catch (e) {
      console.warn('[ai-setlist poll]', e);
    }
  }
  function cancelPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // ── Render the per-bot result cards ────────────────────────────────
  // `botStatusMap` may be null (initial pending render) or the server's
  // poll payload. `botIds` is the list of bots we asked for; we always
  // render a card per bot so the order stays stable.
  function renderResults(d, botIds, jobId) {
    if (!botIds || !botIds.length) {
      resultsEl.style.display = 'none';
      resultsEl.innerHTML = '';
      return;
    }
    const botMap = (d && d.bots) || {};
    const elapsed = d ? d.elapsed_sec : 0;
    const byId = Object.fromEntries(bots.map(b => [b.id, b]));
    resultsEl.style.display = '';
    resultsEl.innerHTML = botIds.map(id => {
      const meta = byId[id] || { id, name: id };
      const state = botMap[id] || { status: 'pending' };
      return renderBotCard(meta, state, elapsed, jobId);
    }).join('');
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
    // Wire each card
    botIds.forEach(id => {
      const state = botMap[id] || { status: 'pending' };
      wireBotCard(id, state, jobId);
    });
  }

  function renderBotCard(meta, state, elapsed, jobId) {
    const status = state.status || 'pending';
    let badge = '<span class="ai-bot-badge pending"><i data-lucide="loader"></i> Waiting</span>';
    if (status === 'ready') badge = '<span class="ai-bot-badge ok"><i data-lucide="check-circle"></i> Ready</span>';
    else if (status === 'error') badge = '<span class="ai-bot-badge err"><i data-lucide="alert-triangle"></i> Failed</span>';

    let body = '';
    if (status === 'pending') {
      body = `
        <div class="ai-bot-pending">
          <p class="ai-bot-pending-msg">${jobId ? `Waiting for ${escapeHtml(meta.name)} to reply (${elapsed}s elapsed)…` : 'Will start when you click Generate.'}</p>
          ${jobId ? `
            <details class="ai-bot-paste-fallback">
              <summary>Or paste the reply yourself</summary>
              <textarea class="ai-bot-paste" data-bot="${meta.id}" rows="6" placeholder="Paste the chatbot's full reply (JSON block included) and click Submit."></textarea>
              <button class="btn-secondary ai-bot-paste-btn" data-bot="${meta.id}" type="button">Submit pasted reply</button>
              <span class="ai-bot-paste-status" data-bot="${meta.id}"></span>
            </details>` : ''}
        </div>`;
    } else if (status === 'error') {
      body = `
        <div class="ai-bot-error">
          <p class="ai-bot-error-msg">${escapeHtml(state.error || 'Reply could not be parsed.')}</p>
          ${state.raw ? `<details><summary>Raw reply (first 800 chars)</summary><pre class="ai-bot-raw">${escapeHtml(state.raw)}</pre></details>` : ''}
          ${jobId ? `
            <details class="ai-bot-paste-fallback" open>
              <summary>Paste a corrected reply</summary>
              <textarea class="ai-bot-paste" data-bot="${meta.id}" rows="6" placeholder="Paste the JSON-bearing reply and click Submit."></textarea>
              <button class="btn-secondary ai-bot-paste-btn" data-bot="${meta.id}" type="button">Submit pasted reply</button>
              <span class="ai-bot-paste-status" data-bot="${meta.id}"></span>
            </details>` : ''}
        </div>`;
    } else {
      // ready
      const setlist = state.setlist || [];
      const rationale = (state.rationale || '') + (state.dropped_unknown_count
        ? ` (Note: dropped ${state.dropped_unknown_count} song(s) the AI proposed that aren't in the library.)`
        : '');
      body = `
        <div class="ai-bot-summary">≈ ${state.total_minutes || 0} min total · ${setlist.length} songs</div>
        <div class="ai-setlist-rationale-card">
          <div class="ai-rationale-label"><i data-lucide="book-open-text"></i> Flow rationale</div>
          <p class="ai-setlist-rationale">${escapeHtml(rationale)}</p>
        </div>
        <div class="ai-setlist-table-wrap">
          <table class="ai-setlist-table">
            <thead>
              <tr>
                <th>Time</th><th>Song</th><th>Artist</th><th>Singer</th>
                <th>Key</th><th>BPM</th><th>Dur</th>
              </tr>
            </thead>
            <tbody>
              ${setlist.map(s => `
                <tr>
                  <td class="ai-col-time">${escapeHtml(s.time || '')}</td>
                  <td class="ai-col-title">${escapeHtml(s.title || '')}</td>
                  <td class="ai-col-artist">${escapeHtml(s.artist || '')}</td>
                  <td class="ai-col-singer">${escapeHtml(s.singer || '')}</td>
                  <td class="ai-col-key">${escapeHtml(s.key || '')}</td>
                  <td class="ai-col-bpm">${s.bpm != null ? s.bpm : '—'}</td>
                  <td class="ai-col-dur">${s.duration_min != null ? s.duration_min : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="ai-setlist-save">
          <input type="text" class="ai-setlist-save-name" data-bot="${meta.id}" placeholder="Save as… (e.g. '${escapeHtml(meta.name)} — Stand Up for Science')" maxlength="80">
          <button class="btn-secondary ai-setlist-savebtn" data-bot="${meta.id}" type="button">
            <i data-lucide="save"></i> Save ${escapeHtml(meta.name)}'s setlist
          </button>
          <span class="ai-setlist-save-status" data-bot="${meta.id}"></span>
        </div>`;
    }
    return `
      <section class="ai-bot-card ${status}" data-bot="${meta.id}">
        <header class="ai-bot-card-head">
          <h3>${escapeHtml(meta.name)}</h3>
          ${badge}
        </header>
        ${body}
      </section>`;
  }

  function attachJobToCards(jobId) {
    // After generate, re-render so cards know which jobId to send
    // paste requests to. We call renderResults again with no payload,
    // which just rebuilds pending cards but now with jobId wired in.
    renderResults(null, currentJobBots, jobId);
  }

  function wireBotCard(botId, state, jobId) {
    if (state.status === 'ready') {
      const saveBtn  = resultsEl.querySelector(`.ai-setlist-savebtn[data-bot="${botId}"]`);
      const nameEl2  = resultsEl.querySelector(`.ai-setlist-save-name[data-bot="${botId}"]`);
      const statusEl2= resultsEl.querySelector(`.ai-setlist-save-status[data-bot="${botId}"]`);
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const songs = (state.setlist || []).map(s => s.song_base).filter(Boolean);
          if (!songs.length) {
            statusEl2.textContent = 'Nothing to save.';
            statusEl2.className = 'ai-setlist-save-status err';
            return;
          }
          const botName = (bots.find(b => b.id === botId) || {}).name || botId;
          const title = (nameEl2.value || '').trim() || `${botName} setlist ${new Date().toLocaleDateString()}`;
          saveBtn.disabled = true;
          statusEl2.textContent = 'Saving…';
          statusEl2.className = 'ai-setlist-save-status loading';
          try {
            const r = await fetch('/api/setlists', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title, songs }),
            });
            const d = await r.json();
            if (!r.ok) {
              statusEl2.textContent = '✗ ' + (d.error || 'failed');
              statusEl2.className = 'ai-setlist-save-status err';
              return;
            }
            statusEl2.textContent = `✓ Saved as "${title}" — open Manual Setlists to play.`;
            statusEl2.className = 'ai-setlist-save-status ok';
            try { refreshGigList(); } catch (e) {}
          } catch (e) {
            statusEl2.textContent = '✗ ' + e.message;
            statusEl2.className = 'ai-setlist-save-status err';
          } finally {
            saveBtn.disabled = false;
          }
        });
      }
    }
    // Manual paste fallback wiring (present for pending + error states)
    if (jobId && (state.status === 'pending' || state.status === 'error')) {
      const pasteBtn   = resultsEl.querySelector(`.ai-bot-paste-btn[data-bot="${botId}"]`);
      const pasteArea  = resultsEl.querySelector(`.ai-bot-paste[data-bot="${botId}"]`);
      const pasteStatus= resultsEl.querySelector(`.ai-bot-paste-status[data-bot="${botId}"]`);
      if (pasteBtn && pasteArea) {
        pasteBtn.addEventListener('click', async () => {
          const text = (pasteArea.value || '').trim();
          if (!text) {
            pasteStatus.textContent = 'Paste the reply first.';
            return;
          }
          pasteBtn.disabled = true;
          pasteStatus.textContent = 'Submitting…';
          try {
            const r = await fetch(`/api/setlist/ai-generate/paste/${encodeURIComponent(jobId)}/${encodeURIComponent(botId)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text }),
            });
            const d = await r.json();
            if (!r.ok) {
              pasteStatus.textContent = '✗ ' + (d.error || 'submit failed');
              return;
            }
            pasteStatus.textContent = '✓ Got it — refreshing on next poll.';
            // Trigger an immediate poll so the card flips to ready right away
            pollOnce(jobId);
          } catch (e) {
            pasteStatus.textContent = '✗ ' + e.message;
          } finally {
            pasteBtn.disabled = false;
          }
        });
      }
    }
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'ai-setlist-status ' + (cls || '');
  }
}
