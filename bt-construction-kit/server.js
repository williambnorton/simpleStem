const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Boot-trace journal (initialized FIRST so it captures every later step,
// including readDiskVersion() which itself touches Drive) ─────────────────
// Append-only post-mortem log. Every potentially-blocking boot step writes a
// line BEFORE the call, so if the process hangs (e.g. Drive Stream stalls on
// fs.existsSync with no internet) the trace records exactly which phase we
// died in. Located on LOCAL disk (~/.simpleStem-catalog/) so writes never
// themselves touch Drive.
const BOOT_TRACE_PATH = path.join(os.homedir(), '.simpleStem-catalog', 'boot-trace.log');
const BOOT_T0 = Date.now();
const BOOT_PID = process.pid;
try { fs.mkdirSync(path.dirname(BOOT_TRACE_PATH), { recursive: true }); } catch (e) {}
try {
  if (fs.existsSync(BOOT_TRACE_PATH)) fs.renameSync(BOOT_TRACE_PATH, BOOT_TRACE_PATH + '.prev');
} catch (e) { /* ignore */ }
function bootTrace(phase, kind, msg) {
  try {
    const dt = Date.now() - BOOT_T0;
    const line = `${new Date().toISOString()} pid=${BOOT_PID} +${dt}ms ${kind} ${phase}${msg ? ' ' + msg : ''}\n`;
    fs.appendFileSync(BOOT_TRACE_PATH, line);
  } catch (e) { /* never let tracing crash the boot */ }
}
// bootPhase wraps a function with ENTER/EXIT and a 5 s watchdog that emits
// STILL_IN lines while async I/O is pending. Synchronous hangs that freeze
// the event loop won't fire STILL_IN, but the ENTER line is still on disk
// — that's enough to identify the offending phase post-mortem.
function bootPhase(name, fn) {
  bootTrace(name, 'ENTER');
  const t0 = Date.now();
  let resolved = false;
  const watchdog = setInterval(() => {
    if (!resolved) bootTrace(name, 'STILL_IN', `elapsed=${Date.now() - t0}ms`);
  }, 5000);
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        v => { resolved = true; clearInterval(watchdog); bootTrace(name, 'EXIT', `duration=${Date.now() - t0}ms`); return v; },
        e => { resolved = true; clearInterval(watchdog); bootTrace(name, 'ERROR', `duration=${Date.now() - t0}ms msg=${e && e.message}`); throw e; }
      );
    }
    resolved = true; clearInterval(watchdog);
    bootTrace(name, 'EXIT', `duration=${Date.now() - t0}ms`);
    return result;
  } catch (e) {
    resolved = true; clearInterval(watchdog);
    bootTrace(name, 'ERROR', `duration=${Date.now() - t0}ms msg=${e && e.message}`);
    throw e;
  }
}
bootTrace('boot', 'ENTER', `node=${process.version} pid=${BOOT_PID}`);

// ── Version / self-update ───────────────────────────────────────────────────
// VERSION (at the simpleStem root) is the single source of truth. The running
// process captures its version at boot (BOOT_VERSION). Because the repo lives on
// Google Drive, editing code on the mini eventually syncs the new VERSION to the
// laptop's disk — at which point readDiskVersion() != BOOT_VERSION means an
// update is staged and the server should be restarted to run it.
function SIMPLE_STEM_ROOT_FOR_VERSION() {
  return process.env.SIMPLE_STEM_ROOT || path.join(os.homedir(), 'ClaudeDrive', 'simpleStem');
}
// Version is a BUILD TIMESTAMP in local time, formatted V1.MMDDHHMM (8 digits
// after the dot — month, day, hour, minute) derived from the newest
// modification time across the code files. No manual bumping: when Drive
// syncs a newer file to this machine, the on-disk version advances, and the
// running process (which captured its version at boot) sees the diff.
function CODE_FILES() {
  const root = SIMPLE_STEM_ROOT_FOR_VERSION();
  return [
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'public', 'app.js'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'public', 'styles.css'),
    path.join(root, 'performer.sh'),
    path.join(root, 'queue_runner.sh'),
    path.join(root, 'stem.sh'),
  ];
}
function fmtVersion(d) {
  const p = n => String(n).padStart(2, '0');
  return `V1.${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
function readDiskVersion() {
  let newest = 0;
  for (const f of CODE_FILES()) {
    try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch (e) {}
  }
  return newest ? fmtVersion(new Date(newest)) : 'unknown';
}
bootTrace('readDiskVersion', 'ENTER');
const BOOT_VERSION = readDiskVersion();
bootTrace('readDiskVersion', 'EXIT', `version=${BOOT_VERSION}`);

const CACHE_FILE = path.join(__dirname, 'durations.json');
let durationCache = {};

if (fs.existsSync(CACHE_FILE)) {
  try {
    durationCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error('Error reading duration cache:', e);
  }
}

function getAudioDuration(filePath) {
  if (durationCache[filePath]) {
    return durationCache[filePath];
  }
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const stdout = execSync(cmd, { encoding: 'utf8' });
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration) && duration > 0) {
      durationCache[filePath] = duration;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(durationCache, null, 2), 'utf8');
      return duration;
    }
  } catch (err) {
    // Graceful fallback
  }
  return null;
}

app.use(cors());
app.use(express.json());

// Identity — am I running on the Performer or the Librarian? The two
// machines run different daemons + have different operator workflows,
// so visiting `/` should default to the right dashboard:
//   - Performer (laptop, 36GB, drives XR18): main simpleStem app (mixer,
//     library, gigs) — i.e. index.html.
//   - Librarian (mini, 8GB, 24/7 ingest+catalog): the Librarian view —
//     librarian.html.
// The operator can still toggle to the other view by clicking the brand
// chip's [Performer | Librarian] words. Override via SIMPLESTEM_IDENTITY
// env var for testing / dual-role machines.
const MACHINE_IDENTITY = (() => {
  if (process.env.SIMPLESTEM_IDENTITY) return process.env.SIMPLESTEM_IDENTITY.toLowerCase();
  const hn = os.hostname().toLowerCase();
  // Fuzzy substring matches so casing, misspellings, hostnames like
  // "MyLibrarian-Mini" or "Bill's-Performer.local" all resolve cleanly.
  // "brari" disambiguates librarian; "erform" disambiguates performer.
  // Bill 2026-06-28: "the hostname matching should be fuzzy — contains
  // 'erform' vs 'brari'."
  if (hn.includes('brari'))  return 'librarian';
  if (hn.includes('erform')) return 'performer';
  // Fall back to performer — historically the laptop has been the only
  // machine running this server, and dropping a librarian onto an
  // unknown host would be more confusing than dropping a performer.
  return 'performer';
})();
console.log(`[identity] machine = ${MACHINE_IDENTITY} (hostname: ${os.hostname()})`);

// Identity-aware root — MUST be registered before express.static, which
// would otherwise serve index.html for every `/` regardless of machine.
// The toggle widget in either page (?view=librarian / ?view=performer)
// short-circuits this default when the operator wants the other view.
app.get('/', (req, res, next) => {
  const wantView = (req.query.view || '').toLowerCase();
  const target = (wantView === 'librarian' || wantView === 'performer')
    ? wantView
    : MACHINE_IDENTITY;
  if (target === 'librarian') {
    return res.sendFile(path.join(__dirname, 'public', 'librarian.html'));
  }
  // 'performer' or anything else → main app.
  return next();   // let express.static pick up /index.html
});

// Small endpoint the client uses to learn which machine it's talking to,
// so the brand chip can light up the correct half of the toggle.
app.get('/api/identity', (req, res) => {
  // homeUser: the basename of $HOME (usually "wbn"). Used by the
  // Librarian click-to-copy feature to expand "~/…" paths to absolute
  // "/Users/<user>/…" so pasting into Finder/iTerm/rsync always works.
  const homeUser = path.basename(os.homedir() || '');
  res.json({ machine: MACHINE_IDENTITY, hostname: os.hostname(), homeUser });
});

// ─── KEEP-ALIVE BUSTER (2026-06-28) ───────────────────────────────────────
// Bill hit a recurring "no stems responded after 3s" failure that the
// diagnostic traced to Chrome's keep-alive connection pool. When an
// audio fetch is aborted mid-stream (which happens whenever a user
// clicks a new song before the previous one finishes loading), Node
// reports EPIPE on the server side. The TCP connection enters a
// half-closed state. Chrome doesn't realize this — it reuses the
// socket for the next request, writes the request, then waits forever
// for a response that's never coming.
//
// Net effect: one EPIPE'd fetch can wedge Chrome's per-origin pool of
// 6 connections. Subsequent fetches (audio, heartbeat, prefetcher all)
// queue behind dead sockets. From the user's POV the server "stops
// responding" even though curl proves it's fine.
//
// Connection: close is HARMFUL on /api/audio/* paths. Chrome's <audio>
// element issues a Range request, gets the response, and then internally
// tries to reuse the socket for streaming buffer reads. With
// Connection: close the socket closes immediately and Chrome's media
// element stalls at networkState=2/readyState=0 for >3s — the exact
// 2026-06-28 gig failure mode. Verified 2026-06-29: fetch() reads the
// full 6.5MB in 27ms with Connection: close set, but <audio> stalls.
//
// We keep Connection: close ONLY on /api/health (where it's harmless;
// the heartbeat is short fetches) so wedged-socket recovery on that
// path remains, but the audio path stays default keep-alive.
app.use((req, res, next) => {
  const p = req.path || '';
  if (p === '/api/health') {
    res.setHeader('Connection', 'close');
  }
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Paths to the media directories
// Root: ~/ClaudeDrive/simpleStem (browses the local filesystem, not the cloud).
// Derived from the home dir so it works on both Macs; override with
// SIMPLE_STEM_ROOT=/path if Drive is mounted somewhere non-default.
const SIMPLE_STEM_ROOT = process.env.SIMPLE_STEM_ROOT || path.join(os.homedir(), 'ClaudeDrive', 'simpleStem');
const STEMS_DIR = `${SIMPLE_STEM_ROOT}/STEMS`;
// M4A_DIR retired 2026-06-27 — six stems only, mixed client-side. The
// constant resolves to a path that is intentionally never created; every
// `fs.existsSync(M4A_DIR)` check downstream becomes false, every walk
// finds nothing, every cleanup loop is empty. Leaving the const defined
// (instead of deleting outright) keeps the remaining ten-or-so reference
// sites compiling without a sweeping refactor.
const M4A_DIR = `${SIMPLE_STEM_ROOT}/.M4A.retired-2026-06-27`;
// Flat per-instrument loop folder. Filenames follow
//   <inst>_<bpm-padded-3>_<song-slug>_<bars>bars.m4a
// e.g. drums_120_mary_janes_last_dance_18bars.m4a
// Sortable alphabetically = sortable by (inst, BPM, song). Migrated from
// the older per-song STEMS/<song>/*_loop*.wav layout by migrate_loops.sh
// and produced directly by stem.sh going forward.
const LOOPS_DIR = `${SIMPLE_STEM_ROOT}/LOOPS`;
// Drum-machine library: BPM@PATTERN.m4a files used by the top-of-screen
// drum machine button. metronome patterns follow the 110@<bpm> convention
// (110-series drum-machine settings) so we can synthesize a fallback when
// a song has no explicit drum_pattern.
const DRUM_MACHINE_DIR = `${SIMPLE_STEM_ROOT}/DRUM_MACHINE`;
// Backing-track alternative to the six-stem mix — a curator's folder of
// hand-picked stereo m4a files. Naming is unconstrained (Bill's history:
// "Wicked Game-Chris Isaak.m4a", "100@135 Flagpole Sitta.m4a",
// "BillWithers-AintNoSunshine-2ch.m4a", "Already Gone-Eagles-Project.m4a").
// The server fuzzy-matches each file to a STEMS folder by normalized
// title+artist and exposes the pairing via /api/backing-tracks/pick/:base.
const BACKING_TRACKS_DIR = `${SIMPLE_STEM_ROOT}/BACKING_TRACKS`;
const INCOMING_DIR = `${SIMPLE_STEM_ROOT}/INCOMING_WEBLOC`;
const QUEUE_DIR = `${SIMPLE_STEM_ROOT}/STEM_QUEUE`;
const SETLISTS_DIR = `${SIMPLE_STEM_ROOT}/SETLISTS`;
const GIGS_DIR     = `${SIMPLE_STEM_ROOT}/GIGS`;
// Local mirrors so reads work without Drive being reachable. The hot
// path (request handlers) reads from these; the Drive copies are the
// canonical store + cross-machine sync surface. Writes go to BOTH so
// either side stays current.
const SETLISTS_LOCAL_MIRROR = path.join(os.homedir(), '.simpleStem-catalog', 'SETLISTS');
const GIGS_LOCAL_MIRROR     = path.join(os.homedir(), '.simpleStem-catalog', 'GIGS');
try { fs.mkdirSync(SETLISTS_LOCAL_MIRROR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(GIGS_LOCAL_MIRROR,     { recursive: true }); } catch (e) {}
bootTrace('config', 'EXIT', `root=${SIMPLE_STEM_ROOT} version=${BOOT_VERSION}`);
// Drive-side authoritative catalog (Librarian writes; Performer reads).
// When present + fresh, the portal uses this as the library source instead
// of walking STEMS/ and M4A/ directories, which avoids Drive stalls.
const CATALOG_DRIVE_PATH = `${SIMPLE_STEM_ROOT}/CATALOG.json`;
// Local-disk mirror — copied from CATALOG_DRIVE_PATH whenever it changes
// (fs.watch). Library serving reads ONLY this path so Drive never sits in
// the request hot path.
const CATALOG_LOCAL_MIRROR = path.join(os.homedir(), '.simpleStem-catalog', 'CATALOG.json');

// Comprehensive list of known artists in this library for intelligent parsing
const KNOWN_ARTISTS = [
  'Beatles', 'The Beatles', 'Grateful Dead', 'Tom Petty', 'Tom and Stevie', 'Joe Jackson', 
  'Neil Young', 'Cat Stevens', 'Aerosmith', 'Lynyrd Skynyrd', 'Lynryd Skynryd', 'Eagles', 
  'The Eagles', 'Don Henley', 'Led Zeppelin', 'Eddie Money', 'Cake', 'Black Crowes', 
  'Black Crows', 'ACDC', 'AC_DC', 'AC/DC', 'Jackson Browne', 'Steely Dan', 'David Bowie', 
  'Green Day', 'The Faces', 'Faces', 'Violent Femmes', 'Jimi Hendrix', 'Bill Withers', 
  'Bob Dylan', 'Grand Funk Railroad', 'Bad Company', 'Paul McCartney and Wings', 'Paul McCartney',
  'Rolling Stones', 'The Rolling Stones', 'Tears for Fears', 'Pink Floyd', 'Boz Scaggs', 
  'Journey', 'Zombies', 'The Zombies', 'Santana', 'Allman Brothers', 'Allman Bros', 
  'Alman Brothers', 'Chris Isaak', 'Chis Issak', 'Johnny Nash', 'Gil Scott-Heron', 
  'Talking Heads', 'The Beat', 'Pretenders', 'The Pretenders', 'Gary Numan', 'Chicago', 
  'Amy Winehouse', 'Modern English', 'Commodores', 'Simple Minds', 'Burt Bacharach', 
  'Cheap Trick', 'The Who', 'Van Morrison', 'Cream', 'Soft Cell', 'Pat Benatar', 
  'Pete Seeger', 'Johnny Cash', 'Blind Melon', 'Elvis', 'Til Tuesday', 'George Harrison', 
  'Harvey Danger', 'NEEDTOBREATHE', 'Alannah Myles', 'Dolly Parton', 'CCR', 'Jimmy Eat World', 
  'Bob seager', 'Billie Joe Armstrong', 'Bob Marley', 'The Band', 'Matt'
];

/**
 * Intelligent parser to extract song metadata (Title, Artist, BPM, Key)
 * from a filename or folder name.
 */
function parseSongMetadata(rawName, isFolder = false) {
  // Clean up extensions and leading/trailing spaces
  let name = rawName.replace(/\.(m4a|wav|mp3)$/i, '').trim();

  let practiceBpm = null;
  let originalBpm = null;
  let key = null;

  // 0. Strip iTunes / Logic-export track-number prefixes BEFORE BPM extraction
  //    so the digits don't get caught as BPM. Patterns seen:
  //      "1 01 Whole Lotta Love..."        → "Whole Lotta Love..." (disc 1, track 01)
  //      "1_01_Whole_Lotta_Love..."        → same, underscore form
  //      "01 Whole Lotta Love..."          → "Whole Lotta Love..."
  //      "01_Whole_Lotta_Love..."          → same
  //    Conservative — only strips digit-only leading tokens, not anything else.
  name = name.replace(/^\d{1,2}[_\s]+\d{1,2}[_\s]+/, '')   // disc + track
             .replace(/^\d{1,2}[_\s]+/, '')                  // track only
             .trim();

  // 1. Extract Key if specified (e.g. "Doctor My Eyes in D" or "Easy in G")
  const keyMatch = name.match(/\bin\s+([A-G][b#]?m?)\b/i);
  if (keyMatch) {
    key = keyMatch[1];
    name = name.replace(/\bin\s+[A-G][b#]?m?\b/i, '').trim();
  }

  // 2. Extract BPMs of format "120@88" or similar
  const bpmAtMatch = name.match(/(\d+)\s*@\s*(\d+)/);
  if (bpmAtMatch) {
    practiceBpm = parseInt(bpmAtMatch[1]);
    originalBpm = parseInt(bpmAtMatch[2]);
    name = name.replace(/\d+\s*@\s*\d+/, '').trim();
  } else {
    // Check for single BPM at the end of the filename
    const singleBpmMatch = name.match(/\b(\d{2,3})\b(?!.*\b\d{2,3}\b)/);
    if (singleBpmMatch) {
      practiceBpm = parseInt(singleBpmMatch[1]);
      name = name.replace(/\b\d{2,3}\b/, '').trim();
    }
  }

  // Clean double spaces and lingering characters
  name = name.replace(/\s+/g, ' ').trim();

  // 3. Separate Title and Artist
  let title = name;
  let artist = 'Unknown Artist';

  // Check for explicit hyphen separator (common in M4A files: "Title-Artist")
  if (name.includes('-')) {
    const parts = name.split('-');
    title = parts[0].trim();
    artist = parts[1].trim();
  } else if (name.includes('_')) {
    // For folders, try to match known artists first, otherwise split by last underscore
    const nameWithSpaces = name.replace(/_/g, ' ');
    let matchedArtist = null;

    for (const art of KNOWN_ARTISTS) {
      const regex = new RegExp(`\\b${art}\\b`, 'i');
      if (regex.test(nameWithSpaces)) {
        matchedArtist = art;
        break;
      }
    }

    if (matchedArtist) {
      artist = matchedArtist;
      // Extract title by removing the artist from the name
      const regex = new RegExp(`_?${artist.replace(/\s+/g, '_')}_?`, 'i');
      title = name.replace(regex, '').replace(/_/g, ' ').trim();
    } else {
      // Fallback: split by the last underscore segment
      const parts = name.split('_');
      if (parts.length > 1) {
        artist = parts[parts.length - 1];
        title = parts.slice(0, -1).join(' ');
      }
      title = title.replace(/_/g, ' ').trim();
    }
  } else {
    // If no separator, scan against known artists list
    for (const art of KNOWN_ARTISTS) {
      const regex = new RegExp(`\\b${art}\\b`, 'i');
      if (regex.test(name)) {
        artist = art;
        title = name.replace(regex, '').trim();
        break;
      }
    }
  }

  // Final polishing
  title = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  artist = artist.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  // Clean trailing hyphens or commas from Title
  title = title.replace(/^[,\-\s]+|[,\-\s]+$/g, '');

  return {
    title: title || rawName,
    artist: artist,
    practiceBpm,
    originalBpm,
    key
  };
}

/**
 * Scan the STEMS directory and return metadata of available stems and loops.
 */
// Slug used to match a song to its loops in LOOPS/. The migrate_loops.sh
// script applies the same transform when naming files, so server-side
// matching is by-equality on this slug.
function songSlugForLoops(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Scan the flat LOOPS/ folder. Returns Map<songSlug, Array<loopRecord>>.
// loopRecord:
//   { fileName, inst, bpm, songSlug, bars }
// inst ∈ {drums, bass, drumsbass, guitar, piano}
// Filenames not matching the convention are ignored (harmless).
async function scanLoops() {
  const bySlug = new Map();
  if (!fs.existsSync(LOOPS_DIR)) return bySlug;
  let dirents;
  try {
    dirents = await fsp.readdir(LOOPS_DIR);
  } catch (e) {
    console.warn(`[scan-loops] could not read ${LOOPS_DIR}:`, e.message);
    return bySlug;
  }
  const re = /^([a-z]+)_(\d{1,4})_(.+)_(\d+)bars\.m4a$/;
  for (const f of dirents) {
    if (/ \(\d+\)\.m4a$/i.test(f)) continue;
    const m = f.match(re);
    if (!m) continue;
    const rec = {
      fileName: f,
      inst: m[1],
      bpm: parseInt(m[2], 10),
      songSlug: m[3],
      bars: parseInt(m[4], 10),
    };
    if (!bySlug.has(rec.songSlug)) bySlug.set(rec.songSlug, []);
    bySlug.get(rec.songSlug).push(rec);
  }
  return bySlug;
}

async function scanStems() {
  if (!fs.existsSync(STEMS_DIR)) {
    console.warn(`Stems directory not found: ${STEMS_DIR}`);
    return [];
  }

  const results = [];
  // Async readdir + per-entry stat so Drive stalls don't lock up the
  // event loop. Each await yields, letting audio-stream requests and
  // other handlers interleave between filesystem calls.
  const dirents = await fsp.readdir(STEMS_DIR, { withFileTypes: true });
  const folders = dirents
    .filter(d => d.isDirectory() && !/ \(\d+\)$/.test(d.name))
    .map(d => d.name);

  for (const folder of folders) {
    const folderPath = path.join(STEMS_DIR, folder);
    let filesInFolder;
    try {
      filesInFolder = await fsp.readdir(folderPath);
    } catch (e) {
      console.warn(`[scan] could not read ${folderPath}:`, e.message);
      continue;
    }

    // Identify standard stems. Prefer m4a over wav so the cache + Drive sync
    // burden stays small (m4a is ~1/6 the size and the browser plays it
    // natively). Falls back to wav for songs ingested before the m4a stem
    // step landed in stem.sh.
    const pickStem = (name) => {
      if (filesInFolder.includes(`${name}.m4a`)) return `${name}.m4a`;
      if (filesInFolder.includes(`${name}.wav`)) return `${name}.wav`;
      return null;
    };
    const stems = {
      vocals: pickStem('vocals'),
      drums:  pickStem('drums'),
      bass:   pickStem('bass'),
      guitar: pickStem('guitar'),
      piano:  pickStem('piano'),
      other:  pickStem('other'),
      rhythm: pickStem('bass+drums'),
      source: pickStem('source'),
    };

    // Logic Pro project bundle (.logicx is a directory). When present, the
    // library row surfaces a yellow 'Logic' chip that opens it in a fresh
    // Logic instance so you can re-mix / re-route stems to different XR18
    // outputs without disturbing whatever Logic is already doing.
    const logicProjectName = filesInFolder.find(f => f.toLowerCase().endsWith('.logicx')) || null;

    // Find loop files (e.g. drums_loop1_83bars.m4a; legacy .wav also accepted)
    const loops = [];
    const loopFiles = filesInFolder.filter(f => f.toLowerCase().includes('loop') && /\.(m4a|wav)$/i.test(f));

    // Parse loop metadata
    for (const loopFile of loopFiles) {
      // Pattern: [stem]_loop[num]_[bars]bars.(m4a|wav)
      const match = loopFile.match(/^([a-z+]+)_loop(\d+)_(\d+)bars\.(m4a|wav)$/i);
      if (match) {
        loops.push({
          fileName: loopFile,
          type: match[1].toLowerCase(), // 'drums', 'bass', 'drumsbass', etc.
          loopNum: parseInt(match[2]),
          bars: parseInt(match[3])
        });
      }
    }

    // Group loops by number for easier UI representation
    const groupedLoops = {};
    for (const l of loops) {
      if (!groupedLoops[l.loopNum]) {
        groupedLoops[l.loopNum] = {
          loopNum: l.loopNum,
          bars: l.bars,
          files: {}
        };
      }
      groupedLoops[l.loopNum].files[l.type] = l.fileName;
    }

    // Prefer pre-computed metadata.json (title/artist/duration_sec/bpm/key).
    // Falls back to filename parsing + ffprobe only when the JSON is missing.
    let title, artist, duration, practiceBpm, originalBpm, key, keySignature;
    // MPB Songlist fields (populated by mpb_sync.py). Default null so the
    // shape stays stable whether or not the importer has run.
    let singerLead = null, singerBackup = null, singerGroupVocal = null;
    let bandRequired = null, drumPattern = null, readiness = null;
    // Source URL + extracted YouTube video ID. The ingest tracker uses
    // these to match a submitted URL against the library so the row can
    // transition from "submitted" → "in library" when stems land. Without
    // them the tracker has no way to recognize completion (folderName is
    // a title/artist slug, never the video id).
    let sourceUrl = null, videoId = null;
    // Lyrics — fetched at ingest by lyrics_fetch.py on the Librarian.
    let lyricsText = null, lyricsChunks = null;
    const metaJsonPath = path.join(folderPath, 'metadata.json');
    let usedMetaJson = false;
    if (fs.existsSync(metaJsonPath)) {
      try {
        const mj = JSON.parse(fs.readFileSync(metaJsonPath, 'utf8'));
        title = mj.title;
        artist = mj.artist;
        duration = typeof mj.duration_sec === 'number' ? mj.duration_sec : null;
        if (typeof mj.bpm === 'number') practiceBpm = Math.round(mj.bpm);
        key = mj.key || null;
        keySignature = mj.key_signature || null;
        singerLead = mj.singer_lead || null;
        singerBackup = mj.singer_backup || null;
        singerGroupVocal = typeof mj.singer_group_vocal === 'boolean' ? mj.singer_group_vocal : null;
        bandRequired = Array.isArray(mj.band_required) ? mj.band_required : null;
        drumPattern = mj.drum_pattern || null;
        readiness = mj.readiness || null;
        sourceUrl = mj.source_url || null;
        lyricsText = mj.lyrics || null;
        lyricsChunks = Array.isArray(mj.lyrics_chunks) ? mj.lyrics_chunks : null;
        if (sourceUrl) {
          // Extract the YouTube video ID — the substring that uniquely
          // identifies a video across watch?v=, youtu.be/, and /shorts/.
          let m;
          if      ((m = sourceUrl.match(/[?&]v=([\w-]{6,})/)))      videoId = m[1];
          else if ((m = sourceUrl.match(/youtu\.be\/([\w-]{6,})/))) videoId = m[1];
          else if ((m = sourceUrl.match(/\/shorts\/([\w-]{6,})/i))) videoId = m[1];
          else if ((m = sourceUrl.match(/status\/(\d{6,})/)))       videoId = 'tw' + m[1];
        }
        // Favorite flag + timestamp — surfaced so the client renders a
        // star next to the song name and the Favorites pseudo-gig can
        // aggregate them.
        var favorite_meta = !!mj.favorite;
        var favorited_at_meta = mj.favorited_at || null;
        var play_count_meta = mj.play_count | 0;
        var last_played_at_meta = mj.last_played_at || null;
        var drum_machine_default_meta = !!mj.drum_machine_default;
        // Task #129 — last playback mode used ('stems'|'drum'|'backing').
        // Falls back to 'drum' when the legacy flag is set (for songs
        // saved before this field existed).
        var playback_mode_meta =
          (mj.playback_mode && ['stems','drum','backing'].includes(mj.playback_mode))
            ? mj.playback_mode
            : (mj.drum_machine_default ? 'drum' : null);
        var tags_meta = Array.isArray(mj.tags) ? mj.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [];
        // Task #132 — compact BMDJ# string encoding who's needed to play
        // the song. If not explicitly set, derive from the mpb_sync
        // band_required list so existing songs get sensible defaults.
        var band_required_compact_meta = String(mj.band_required_compact || '').toUpperCase();
        if (!band_required_compact_meta && Array.isArray(mj.band_required)) {
          const MAP = { Bill: 'B', Matt: 'M', Dan: 'D', JD: 'J', Mark: '#' };
          const chars = new Set();
          for (const name of mj.band_required) {
            const c = MAP[name];
            if (c) chars.add(c);
          }
          band_required_compact_meta = 'BMDJ#'.split('').filter(c => chars.has(c)).join('');
        }
        // Task #132 — short-form key ("F#m", "Eb", "C"). If not saved,
        // derive from the full "F# minor" / "Eb major" string.
        var key_short_meta = mj.key_short || null;
        if (!key_short_meta && typeof mj.key === 'string') {
          const m = /^([A-G](?:#|b)?)\s*(major|minor)?$/.exec(mj.key.trim());
          if (m) key_short_meta = (m[2] === 'minor') ? `${m[1]}m` : m[1];
        }
        usedMetaJson = true;
      } catch (e) {
        console.warn(`Bad metadata.json in ${folder}:`, e.message);
      }
    }
    if (!usedMetaJson) {
      const meta = parseSongMetadata(folder, true);
      title = meta.title;
      artist = meta.artist;
      practiceBpm = meta.practiceBpm;
      originalBpm = meta.originalBpm;
      key = meta.key;
      const representativeFile = stems.source || stems.drums || stems.bass || stems.vocals || stems.other;
      if (representativeFile) {
        duration = getAudioDuration(path.join(folderPath, representativeFile));
      }
    }

    results.push({
      id: `stem-${folder}`,
      type: 'stems',
      variantCode: 'STEMS',
      variantLabel: 'Multitrack Stems',
      folderName: folder,
      title: title,
      artist: artist,
      practiceBpm: practiceBpm || null,
      originalBpm: originalBpm || null,
      key: key,
      keySignature: keySignature || null,
      // MPB Songlist fields synced from the Google Sheet by mpb_sync.py.
      singer_lead: singerLead,
      singer_backup: singerBackup,
      singer_group_vocal: singerGroupVocal,
      band_required: bandRequired,
      drum_pattern: drumPattern,
      readiness: readiness,
      // Favorite — set via PUT /api/song/:base/favorite.
      favorite: (typeof favorite_meta !== 'undefined') ? favorite_meta : false,
      favorited_at: (typeof favorited_at_meta !== 'undefined') ? favorited_at_meta : null,
      // Play count — incremented via POST /api/song/:base/play.
      play_count: (typeof play_count_meta !== 'undefined') ? play_count_meta : 0,
      last_played_at: (typeof last_played_at_meta !== 'undefined') ? last_played_at_meta : null,
      // Drum machine as default playback mode — set via PUT
      // /api/song/:base/drum-default. Client auto-engages drum machine
      // on song-load when this is true. Kept in sync with playback_mode.
      drum_machine_default: (typeof drum_machine_default_meta !== 'undefined') ? drum_machine_default_meta : false,
      // Task #129 — last playback mode ('stems'|'drum'|'backing'). Null
      // means "no preference; use stems". Client honors this on song-load
      // to auto-engage whichever mode was last used.
      playback_mode: (typeof playback_mode_meta !== 'undefined') ? playback_mode_meta : null,
      // Task #132 — compact BMDJ# roster requirement (editable per song
      // in the Gig Builder library) + short-form key ("F#m").
      band_required_compact: (typeof band_required_compact_meta !== 'undefined') ? band_required_compact_meta : '',
      key_short: (typeof key_short_meta !== 'undefined') ? key_short_meta : null,
      // Free-form tags — set via PUT /api/song/:base/tags. Used by
      // dynamic-template pseudo-gigs (__protest_songs__, __sing_along__, …)
      // to derive their song lists at runtime.
      tags: (typeof tags_meta !== 'undefined') ? tags_meta : [],
      // Source URL + extracted videoId — used by the ingest tracker to
      // recognize when a submitted URL has finished rendering.
      source_url: sourceUrl,
      videoId: videoId,
      // Lyrics — fetched at ingest by lyrics_fetch.py (Librarian).
      // Pass through for the show-lyrics action overlay; both fields
      // null when Genius had no match.
      lyrics: lyricsText,
      lyrics_chunks: lyricsChunks,
      stems: stems,
      cached: isStemsFolderCached(folder),
      logicProjectName: logicProjectName,
      loops: Object.values(groupedLoops).sort((a, b) => a.loopNum - b.loopNum),
      duration: duration,
      stats: {
        stemCount: Object.values(stems).filter(Boolean).length,
        loopCount: loops.length
      }
    });
  }

  return results;
}

/**
 * scanM4a / M4A_DIR / variant suffixes RETIRED 2026-06-27.
 * The portal now mixes the six stems client-side; pre-baked mixdowns and
 * `M4A/` are no longer produced or read. See stem.sh + diagram 1.
 */

// =====================================================================
// LIBRARY CACHE
// The library directory changes at most a few times per hour; scanning
// it (especially M4A on Google Drive) is slow. We cache the full scan
// result in memory and persist to library_cache.json so a server restart
// serves stale data immediately while a refresh runs in the background.
// Refresh cadence: every 60 minutes + explicit ?refresh=1 query param.
// =====================================================================
const LIBRARY_CACHE_FILE = path.join(__dirname, 'library_cache.json');
const LIBRARY_REFRESH_MS = 60 * 60 * 1000; // 1 hour
let libraryCache = null;       // { scannedAt: ISO string, data: { stats, songs } }
let libraryRefreshing = false; // re-entrancy guard

// Dedupe raw song entries (stems + m4a) by (title, artist) — one entry per
// unique song so stats don't double-count a song that exists in multiple
// formats / variants. Prefer the stems entry when available since its
// metadata is canonical.
function pickUniqueSongs(allSongs) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const byKey = new Map();
  for (const s of allSongs) {
    const k = `${norm(s.title)}|${norm(s.artist)}`;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, s);
    } else if (prev.type !== 'stems' && s.type === 'stems') {
      // Upgrade: stems entry is canonical
      byKey.set(k, s);
    }
  }
  return [...byKey.values()];
}

async function buildLibraryData() {
  const stems = await scanStems();
  // Merge in loops from the flat LOOPS/ folder. Match by songSlug computed
  // from the song's title (or the stems folder name as fallback). Loops
  // found here are grouped by loopNum and appended to / replace the per-song
  // loops[] array. This is the modern layout; the per-folder layout in
  // scanStems still works for backward compatibility (e.g. unmigrated
  // older folders).
  const loopsBySlug = await scanLoops();
  if (loopsBySlug.size > 0) {
    for (const s of stems) {
      const slug = songSlugForLoops(s.title || s.folderName);
      const flat = loopsBySlug.get(slug);
      if (!flat || !flat.length) continue;
      // Group by bars (which is the canonical loop identity in the flat
      // layout — no more numbered loopN). Within a group, each instrument
      // contributes one file.
      const byBars = new Map();
      for (const r of flat) {
        if (!byBars.has(r.bars)) byBars.set(r.bars, { loopNum: 0, bars: r.bars, files: {}, fromLoopsDir: true });
        byBars.get(r.bars).files[r.inst] = r.fileName;
      }
      const flatLoops = [...byBars.values()].sort((a, b) => a.bars - b.bars);
      flatLoops.forEach((l, i) => { l.loopNum = i + 1; });
      s.loops = flatLoops;
    }
  }
  // 2026-06-27: scanM4a + the m4a merge retired. allSongs is now stems only —
  // the variant deduplication in pickUniqueSongs is now a no-op, but we
  // leave it in place so future song-source kinds can plug in without a
  // refactor.
  const allSongs = stems;

  const uniqueSongs = pickUniqueSongs(allSongs);

  // Cache contract: count how many songs are fully cached + how many are
  // missing. The library banner surfaces uncached songs so the operator
  // can hit Flash Cache before a gig. Policy: every song in /api/library
  // MUST be cached — see CLAUDE.md "All songs' m4a stems must be in
  // ~/.bt-cache at all times".
  let cachedSongs = 0;
  for (const s of uniqueSongs) {
    if (s.cached) cachedSongs++;
  }
  const stats = {
    totalSongs:  uniqueSongs.length,
    totalFiles:  allSongs.length,
    totalStems:  stems.length,
    totalM4as:   0,                                    // kept in payload for client back-compat
    cachedSongs,
    uncachedSongs: uniqueSongs.length - cachedSongs,
    artistCount: new Set(uniqueSongs.map(s => s.artist).filter(a => a && a !== 'Unknown Artist')).size,
    bpmDistribution: {
      slow:    uniqueSongs.filter(s => s.practiceBpm && s.practiceBpm < 90).length,
      medium:  uniqueSongs.filter(s => s.practiceBpm && s.practiceBpm >= 90 && s.practiceBpm <= 125).length,
      fast:    uniqueSongs.filter(s => s.practiceBpm && s.practiceBpm > 125).length,
      unknown: uniqueSongs.filter(s => !s.practiceBpm).length
    },
    keyDistribution: uniqueSongs.reduce((acc, s) => {
      if (s.key) acc[s.key] = (acc[s.key] || 0) + 1;
      return acc;
    }, {}),
    singerDistribution: uniqueSongs.reduce((acc, s) => {
      const who = (s.singer_lead || '').trim();
      const k = who || '(unassigned)';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  };

  return { stats, songs: allSongs };
}

// Returns mtimes (as ISO strings) of the source directories — used to detect
// whether anything was added/removed since the last scan so we can short-circuit.
function getSourceMtimes() {
  const out = { stems: null };
  try { out.stems = fs.statSync(STEMS_DIR).mtime.toISOString(); } catch (e) {}
  return out;
}

function refreshLibraryCache(reason, force) {
  if (libraryRefreshing) return Promise.resolve();
  libraryRefreshing = true;
  const t0 = Date.now();
  return new Promise(resolve => {
    setImmediate(async () => {
      try {
        // Layer 2: if the Librarian's CATALOG.json is present and fresh,
        // use it as the library source instead of walking the directories.
        // Read from the LOCAL MIRROR (Layer 3) — never from Drive in the
        // request path. The mirror is kept in sync by watchCatalogMirror.
        try {
          const fromCatalog = await tryLoadFromCatalog();
          if (fromCatalog) {
            // Augment the catalog stats with singerDistribution. catalog.py
            // (Librarian) doesn't compute it yet — we derive it on the
            // Performer from the same songs[] payload so the analytics
            // sidebar shows Bill/Matt/Dan/JD counts without requiring a
            // Librarian-side change.
            try {
              if (fromCatalog.data && fromCatalog.data.songs && !fromCatalog.data.stats?.singerDistribution) {
                const dist = {};
                for (const s of fromCatalog.data.songs) {
                  if (s.type !== 'stems') continue;
                  const who = (s.singer_lead || '').trim() || '(unassigned)';
                  dist[who] = (dist[who] || 0) + 1;
                }
                fromCatalog.data.stats = fromCatalog.data.stats || {};
                fromCatalog.data.stats.singerDistribution = dist;
              }
            } catch (e) { console.warn('[lib] singerDistribution augment failed:', e.message); }
            // Augment the catalog stats with the cache contract count
            // (catalog.py doesn't know what's in ~/.bt-cache; only the
            // Performer can answer that). Recomputes the per-row `cached`
            // flag on the catalog rows so the banner reflects the actual
            // local cache state.
            try {
              if (fromCatalog.data && fromCatalog.data.songs) {
                let cachedN = 0, total = 0;
                for (const s of fromCatalog.data.songs) {
                  if (s.type !== 'stems') continue;
                  total++;
                  if (s.folderName) {
                    s.cached = isStemsFolderCached(s.folderName);
                    if (s.cached) cachedN++;
                  }
                }
                fromCatalog.data.stats = fromCatalog.data.stats || {};
                fromCatalog.data.stats.cachedSongs = cachedN;
                fromCatalog.data.stats.uncachedSongs = total - cachedN;
              }
            } catch (e) { console.warn('[lib] cachedSongs augment failed:', e.message); }
            libraryCache = {
              scannedAt: fromCatalog.scannedAt || new Date().toISOString(),
              checkedAt: new Date().toISOString(),
              sourceMtimes: fromCatalog.sourceMtimes || {},
              codeVersion: BOOT_VERSION,
              source: 'catalog',
              data: fromCatalog.data,
            };
            try { fs.writeFileSync(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache)); } catch (e) {}
            console.log(`[lib] loaded from CATALOG.json (${reason}) — ${fromCatalog.data.songs.length} songs`);
            return;
          }
        } catch (e) {
          console.warn('[lib] catalog read failed, falling back to scan:', e.message);
        }

        // Catalog read failed and no catalog present. The fallback below
        // would walk STEMS/ + M4A/ directly on Drive, which is exactly what
        // we want to AVOID — every Drive readdir pulls files into Drive
        // Stream's own local cache (~/Library/Application Support/Google/
        // DriveFS/) without our control, eating disk. So unless a human has
        // explicitly opted in with SIMPLE_STEM_ALLOW_SCAN=1, keep whatever
        // libraryCache we have and return empty if nothing's hydrated.
        if (process.env.SIMPLE_STEM_ALLOW_SCAN !== '1') {
          if (libraryCache && libraryCache.data) {
            console.warn(`[lib] no CATALOG.json available (${reason}). Keeping previously-loaded cache. Set SIMPLE_STEM_ALLOW_SCAN=1 to re-enable Drive scan fallback.`);
            libraryCache.checkedAt = new Date().toISOString();
          } else {
            console.warn(`[lib] no CATALOG.json and no cache. Library is empty until the Librarian writes CATALOG.json. Set SIMPLE_STEM_ALLOW_SCAN=1 to fall back to a Drive scan.`);
            libraryCache = {
              scannedAt: new Date().toISOString(),
              checkedAt: new Date().toISOString(),
              sourceMtimes: {},
              codeVersion: BOOT_VERSION,
              source: 'empty-no-catalog',
              data: { stats: { totalSongs: 0, totalStems: 0, totalM4as: 0, artistCount: 0, bpmDistribution: { slow: 0, medium: 0, fast: 0, unknown: 0 } }, songs: [] },
            };
          }
          try { fs.writeFileSync(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache)); } catch (e) {}
          return;
        }

        const currentMtimes = getSourceMtimes();
        const prevMtimes = (libraryCache && libraryCache.sourceMtimes) || {};
        const sameMtimes =
          prevMtimes.stems === currentMtimes.stems &&
          prevMtimes.m4a   === currentMtimes.m4a;
        const sameCode = libraryCache && libraryCache.codeVersion === BOOT_VERSION;
        const unchanged = libraryCache && libraryCache.data && sameMtimes && sameCode;

        if (unchanged && !force) {
          console.log(`[lib] skipped (${reason}) — source dirs unchanged since ${libraryCache.scannedAt}`);
          libraryCache.checkedAt = new Date().toISOString();
          try { fs.writeFileSync(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache)); } catch (e) {}
          return;
        }

        console.warn(`[lib] SIMPLE_STEM_ALLOW_SCAN=1 — walking STEMS/ + M4A/ on Drive (${reason})`);
        const data = await buildLibraryData();
        libraryCache = {
          scannedAt: new Date().toISOString(),
          checkedAt: new Date().toISOString(),
          sourceMtimes: currentMtimes,
          codeVersion: BOOT_VERSION,
          data
        };
        try {
          fs.writeFileSync(LIBRARY_CACHE_FILE, JSON.stringify(libraryCache));
        } catch (e) { console.warn('[lib] persist failed:', e.message); }
        console.log(`[lib] rebuilt (${reason}) in ${Date.now() - t0}ms — ${data.songs.length} songs · stems mtime ${currentMtimes.stems}`);
      } catch (e) {
        console.warn('[lib] refresh failed:', e.message);
      } finally {
        libraryRefreshing = false;
        resolve();
      }
    });
  });
}

// Hydrate from persisted cache on startup so the first request is instant
try {
  if (fs.existsSync(LIBRARY_CACHE_FILE)) {
    libraryCache = JSON.parse(fs.readFileSync(LIBRARY_CACHE_FILE, 'utf8'));
    console.log(`[lib] hydrated cache from disk — ${libraryCache.data.songs.length} songs (scanned ${libraryCache.scannedAt})`);
  }
} catch (e) { console.warn('[lib] failed to hydrate cache:', e.message); }

// ── Layer 2 + 3: CATALOG.json read path + local mirror ──────────────────
// Library serving prefers a Librarian-built CATALOG.json over walking
// STEMS/ + M4A/. To keep Drive out of the request hot path entirely, we
// maintain a local mirror at CATALOG_LOCAL_MIRROR copied from
// CATALOG_DRIVE_PATH whenever it changes. The portal reads ONLY the
// local mirror.
//
// CATALOG.json shape (what the Librarian writes):
//   { "scannedAt":"…ISO…", "sourceMtimes":{…}, "data":{stats, songs:[…]} }

async function tryLoadFromCatalog() {
  if (!fs.existsSync(CATALOG_LOCAL_MIRROR)) return null;
  const raw = await fsp.readFile(CATALOG_LOCAL_MIRROR, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.warn(`[catalog] ⚠️  CATALOG.json present but unparseable: ${e.message}`);
    return null;
  }
  if (!parsed || !parsed.data || !Array.isArray(parsed.data.songs)) {
    // Shape drift — the producer (catalog.py on the Librarian) wrote a file
    // that doesn't match the contract documented in
    // prompts/librarian_catalog_canonical_shape.md. Loudly surface this so
    // the next person who looks at the logs knows what to fix instead of
    // silently falling back to a Drive scan (or, worse, a stale cache).
    const topKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
    console.warn(
      `[catalog] ⚠️  DRIFT: CATALOG.json shape mismatch — ` +
      `expected {data:{songs:[...]}} but got top-level keys [${topKeys.join(', ')}]. ` +
      `Update catalog.py on the Librarian to emit the canonical shape ` +
      `(see prompts/librarian_catalog_canonical_shape.md).`
    );
    return null;
  }
  return parsed;
}

// Copy CATALOG.json from Drive → local mirror. Cheap: one ~200KB file.
// Skips when sizes match to avoid pointless copies during Drive sync churn.
// Sync every .json under `srcDir` into `mirrorDir` (skip unchanged by
// size+mtime). Used for GIGS/ and SETLISTS/ -- live performance files
// that the App must serve offline. Best-effort: any Drive hiccup is
// logged and swallowed so it never blocks the boot path.
function mirrorJsonDirOnce(srcDir, mirrorDir, label) {
  let copied = 0, skipped = 0, removed = 0;
  try {
    if (!fs.existsSync(srcDir)) return;
    try { fs.mkdirSync(mirrorDir, { recursive: true }); } catch (e) {}
    const driveFiles = new Set(fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.json')));
    // Copy/refresh anything on Drive that's missing or stale in the mirror
    for (const f of driveFiles) {
      const src = path.join(srcDir, f);
      const dst = path.join(mirrorDir, f);
      try {
        const srcStat = fs.statSync(src);
        if (fs.existsSync(dst)) {
          const dstStat = fs.statSync(dst);
          if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
            skipped++; continue;
          }
        }
        fs.copyFileSync(src, dst);
        copied++;
      } catch (e) { /* per-file, keep going */ }
    }
    // Remove mirror entries that disappeared on Drive (deleted gigs/setlists).
    for (const f of fs.readdirSync(mirrorDir).filter(f => f.toLowerCase().endsWith('.json'))) {
      if (!driveFiles.has(f)) {
        try { fs.unlinkSync(path.join(mirrorDir, f)); removed++; } catch (e) {}
      }
    }
    if (copied || removed) {
      console.log(`[${label} mirror] copied ${copied} skipped ${skipped} removed ${removed}`);
    }
  } catch (e) {
    console.warn(`[${label} mirror] failed: ${e.message}`);
  }
}

function mirrorCatalogOnce(reason) {
  try {
    if (!fs.existsSync(CATALOG_DRIVE_PATH)) return;
    const srcStat = fs.statSync(CATALOG_DRIVE_PATH);
    const mirrorDir = path.dirname(CATALOG_LOCAL_MIRROR);
    if (!fs.existsSync(mirrorDir)) fs.mkdirSync(mirrorDir, { recursive: true });
    let needsCopy = true;
    if (fs.existsSync(CATALOG_LOCAL_MIRROR)) {
      const dstStat = fs.statSync(CATALOG_LOCAL_MIRROR);
      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) needsCopy = false;
    }
    if (needsCopy) {
      fs.copyFileSync(CATALOG_DRIVE_PATH, CATALOG_LOCAL_MIRROR);
      console.log(`[catalog] mirror updated (${reason}) — ${Math.round(srcStat.size / 1024)} KB`);
      // Trigger a library refresh so the in-memory cache catches up.
      refreshLibraryCache('catalog-mirror-updated', true);
    }
  } catch (e) {
    console.warn('[catalog] mirror failed:', e.message);
  }
}

// Conformance check: with catalog.py producing the canonical shape and the
// portal expecting the SAME shape, drift between the Python row builder and
// the JS row builder would silently break the library. On startup we take
// one catalog row, live-scan that same folder, and compare key fields. Any
// difference logs a [catalog-conformance] warning. Lightweight (one folder
// scan). The portal still works fine even when drift is detected — the
// catalog data is served; the warning is the early signal to update either
// side. Best run after a few seconds so initial decode finishes first.
async function runCatalogConformanceCheck() {
  // The conformance check live-scans STEMS/<one-folder>/ on Drive to compare
  // against the catalog row. That's a Drive readdir + stat, which is exactly
  // what we want to avoid. Gated behind SIMPLE_STEM_ALLOW_SCAN=1.
  if (process.env.SIMPLE_STEM_ALLOW_SCAN !== '1') {
    console.log('[catalog-conformance] skipped (SIMPLE_STEM_ALLOW_SCAN not set; no Drive walks)');
    return;
  }
  setTimeout(async () => {
    try {
      const parsed = await tryLoadFromCatalog();
      if (!parsed) {
        console.log('[catalog-conformance] no CATALOG.json present; skipping check');
        return;
      }
      const catalogStems = parsed.data.songs.find(s => s.type === 'stems');
      if (!catalogStems) return;
      const liveStems = await scanStems();
      const liveEntry = liveStems.find(s => s.folderName === catalogStems.folderName);
      if (!liveEntry) {
        console.warn(`[catalog-conformance] live scan can't find ${catalogStems.folderName}`);
        return;
      }
      const fields = ['title', 'artist', 'practiceBpm', 'key', 'keySignature', 'duration', 'logicProjectName'];
      const drift = [];
      for (const f of fields) {
        const a = catalogStems[f];
        const b = liveEntry[f];
        if (a !== b && !(a == null && b == null)) {
          drift.push(`${f}: catalog="${a}" vs live="${b}"`);
        }
      }
      if (drift.length) {
        console.warn(`[catalog-conformance] DRIFT detected on ${catalogStems.folderName}:\n  ${drift.join('\n  ')}\n  → either update catalog.py or scanStems to match`);
      } else {
        console.log(`[catalog-conformance] ${catalogStems.folderName} catalog row matches live scan ✓`);
      }
    } catch (e) {
      console.warn('[catalog-conformance] check failed:', e.message);
    }
  }, 5000);
}
runCatalogConformanceCheck();

// Initial mirror + watcher. fs.watch on Drive paths is sometimes flaky
// (the platform may not fire events from the Drive client), so we also
// poll every 60 seconds as a belt-and-suspenders backup. Both are cheap.
//
// IMPORTANT: every Drive-touching call here is deferred via setImmediate
// so the HTTP server comes up FIRST. With Drive Stream and no internet,
// fs.existsSync/fs.copyFileSync against Drive can block indefinitely
// (Drive tries to resolve the path). Previously that hang ate the whole
// boot and the portal never came up at the gig. The local mirror at
// ~/.simpleStem-catalog/CATALOG.json is what the request path actually
// reads from -- it persists across runs and is sufficient for offline
// performance. Drive-sync to it is best-effort.
setImmediate(() => {
  try { bootPhase('mirror.catalog.startup', () => mirrorCatalogOnce('startup')); } catch (e) {
    console.warn('[catalog] startup mirror skipped:', e.message);
  }
  try { bootPhase('mirror.gigs.startup',     () => mirrorJsonDirOnce(GIGS_DIR,     GIGS_LOCAL_MIRROR,     'gigs'));     } catch (e) {}
  try { bootPhase('mirror.setlists.startup', () => mirrorJsonDirOnce(SETLISTS_DIR, SETLISTS_LOCAL_MIRROR, 'setlists')); } catch (e) {}
  try {
    bootPhase('fs.watch.catalog', () => {
      if (fs.existsSync(path.dirname(CATALOG_DRIVE_PATH))) {
        fs.watch(path.dirname(CATALOG_DRIVE_PATH), (event, fname) => {
          if (fname === 'CATALOG.json') mirrorCatalogOnce('fs.watch');
        });
      }
    });
  } catch (e) {
    console.warn('[catalog] fs.watch setup failed:', e.message);
  }
});
setInterval(() => mirrorCatalogOnce('poll'), 60 * 1000);
// Refresh the GIGS + SETLISTS mirrors every 60s too, so a write on the
// other side (Librarian) lands here within a minute.
setInterval(() => {
  mirrorJsonDirOnce(GIGS_DIR,     GIGS_LOCAL_MIRROR,     'gigs');
  mirrorJsonDirOnce(SETLISTS_DIR, SETLISTS_LOCAL_MIRROR, 'setlists');
}, 60 * 1000);

// Kick off a refresh on startup (background, deferred) and every hour after.
// The first request that comes in before this completes serves from a
// disk-resident cache (libraryCache rehydrated from LIBRARY_CACHE_FILE on
// initial require) so it's fine if this takes a while.
setImmediate(() => { try { bootPhase('library.refresh.startup', () => refreshLibraryCache('startup')); } catch (e) {
  console.warn('[library] startup refresh skipped:', e.message);
}});
setInterval(() => refreshLibraryCache('hourly'), LIBRARY_REFRESH_MS);

// Overlay fresh `cached` state on every song in a library payload. The
// cached state changes frequently (every precache completion) but the
// library cache only rebuilds when source dirs change — so we update
// this field on every request rather than baking it into the cache.
function overlayCachedState(data) {
  if (!data || !data.songs) return data;
  for (const s of data.songs) {
    if (s.type === 'stems' && s.folderName) {
      s.cached = isStemsFolderCached(s.folderName);
    } else if (s.type === 'm4a' && s.fileName) {
      s.cached = isM4aCached(s.fileName);
    }
  }
  return data;
}

// Endpoint to retrieve the entire library and stats
app.get('/api/library', async (req, res) => {
  // ?refresh=1 forces a synchronous rescan
  if (req.query.refresh === '1') {
    await refreshLibraryCache('manual');
  }

  // Serve cached if we have it (even if stale — the background refresh updates it)
  if (libraryCache && libraryCache.data) {
    const data = overlayCachedState(libraryCache.data);
    return res.json({
      ...data,
      scannedAt: libraryCache.scannedAt,
      checkedAt: libraryCache.checkedAt,
      sourceMtimes: libraryCache.sourceMtimes,
      cached: true
    });
  }

  // First-ever startup with no persisted cache: do a synchronous scan
  try {
    await refreshLibraryCache('cold');
    if (libraryCache) {
      const data = overlayCachedState(libraryCache.data);
      return res.json({
        ...data,
        scannedAt: libraryCache.scannedAt,
        checkedAt: libraryCache.checkedAt,
        sourceMtimes: libraryCache.sourceMtimes,
        cached: false
      });
    }
    res.status(503).json({ error: 'Library not ready' });
  } catch (error) {
    console.error('Error scanning library:', error);
    res.status(500).json({ error: 'Failed to scan music library' });
  }
});

// Old inline endpoint replaced by the cached version above. The block below
// remains only to keep variable scope tidy for the catch-all at the bottom.
app.get('/api/library-uncached', async (req, res) => {
  try {
    const data = await buildLibraryData();
    res.json(data);
  } catch (error) {
    console.error('Error scanning library:', error);
    res.status(500).json({ error: 'Failed to scan music library' });
  }
});

// (legacy /api/library__old handler removed 2026-06-27 — it referenced
// scanM4a, which retired along with the mixdown variants. The real
// /api/library handler above is the only library endpoint now.)

// =====================================================================
// LOCAL DISK CACHE for audio files
// Google Drive (~/ClaudeDrive) streams on-demand and can take a minute+
// to download a stem on first access. We mirror requested files into
// ~/.bt-cache and serve from there afterward — fast on repeat plays and
// resilient to Drive evictions. Cache grows monotonically; the user can
// nuke ~/.bt-cache to reclaim disk.
// =====================================================================
const AUDIO_CACHE_DIR = path.join(require('os').homedir(), '.bt-cache');
const AUDIO_CACHE_STEMS = path.join(AUDIO_CACHE_DIR, 'STEMS');
const AUDIO_CACHE_M4A   = path.join(AUDIO_CACHE_DIR, 'M4A');
try {
  fs.mkdirSync(AUDIO_CACHE_STEMS, { recursive: true });
  fs.mkdirSync(AUDIO_CACHE_M4A,   { recursive: true });
} catch (e) { console.warn('cache mkdir:', e.message); }

// LRU cap — applies ONLY to the STEMS cache (the big WAV stems). M4A mixdowns
// are tiny (~3 MB each; the whole library is ~1 GB) so they're cached
// permanently and never pruned — every backing track stays instantly playable.
// Only the multi-hundred-MB stem WAVs are bounded: when the STEMS cache exceeds
// CACHE_CAP_BYTES, evict least-recently-used files until under cap. Never
// touches source data on Drive — only the ~/.bt-cache mirror.
// Cache cap applied to the WHOLE ~/.bt-cache tree (STEMS/, M4A/, LOOPS/).
// Default raised to 50 GB to match Bill's preferred ceiling — with the new
// "no WAV, no mixdown caching" policy, real usage should plateau ~5–8 GB,
// so the cap is a safety net, not a daily limit.
const CACHE_CAP_BYTES = Number(process.env.BT_CACHE_CAP_GB || 50) * 1024 * 1024 * 1024;
function pruneCache() {
  try {
    const files = [];
    const walk = dir => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== '.cached') {
          try { const st = fs.statSync(p); files.push({ p, size: st.size, used: st.atimeMs || st.mtimeMs }); }
          catch (e) {}
        }
      }
    };
    // Walk the whole cache, not just STEMS — every cached byte counts toward
    // the cap now that there's a single ceiling.
    walk(AUDIO_CACHE_DIR);
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total <= CACHE_CAP_BYTES) return;
    files.sort((a, b) => a.used - b.used);   // oldest-used first
    let removed = 0;
    for (const f of files) {
      if (total <= CACHE_CAP_BYTES) break;
      try { fs.unlinkSync(f.p); total -= f.size; removed++; } catch (e) {}
    }
    // invalidate any .cached sentinels whose folder we evicted stems from
    if (removed) {
      if (fs.existsSync(AUDIO_CACHE_STEMS)) for (const d of fs.readdirSync(AUDIO_CACHE_STEMS)) {
        const folder = path.join(AUDIO_CACHE_STEMS, d);
        try {
          const stems = fs.readdirSync(folder).filter(f => /\.m4a$/i.test(f));
          if (stems.length === 0) fs.rmSync(path.join(folder, '.cached'), { force: true });
        } catch (e) {}
      }
      console.log(`[cache] pruned ${removed} file(s) to keep total cache under ${Math.round(CACHE_CAP_BYTES/1e9)}GB`);
    }
  } catch (e) { console.warn('[cache] prune failed:', e.message); }
}
setInterval(pruneCache, 10 * 60 * 1000);   // every 10 min

// SYNC version — used by the on-demand audio request handler when the
// file isn't cached yet. Blocks the request until the copy is done, since
// the response can't be sent until we have the file.
function ensureCached(sourcePath, cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      const csz = fs.statSync(cachePath).size;
      const ssz = fs.statSync(sourcePath).size;
      if (csz === ssz && csz > 0) return cachePath;
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.copyFileSync(sourcePath, cachePath);
    return cachePath;
  } catch (e) {
    console.warn('cache copy failed:', sourcePath, '->', cachePath, e.message);
    return sourcePath;
  }
}

// ASYNC version — used by the background precache so it doesn't block the
// event loop. The user can play an M4A *while* large stems are streaming
// in from Google Drive in parallel. Uses fs.promises (async I/O) and
// awaits each file so we yield to incoming requests between copies.
const fsp = fs.promises;
async function ensureCachedAsync(sourcePath, cachePath, opts) {
  const force = !!(opts && opts.force);
  try {
    if (!force) {
      try {
        const [csz, ssz] = await Promise.all([
          fsp.stat(cachePath).then(s => s.size).catch(() => -1),
          fsp.stat(sourcePath).then(s => s.size).catch(() => -2)
        ]);
        if (csz > 0 && csz === ssz) return cachePath; // good cache hit
      } catch (e) {}
    }
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.copyFile(sourcePath, cachePath);
    return cachePath;
  } catch (e) {
    console.warn('cache copy failed (async):', sourcePath, '->', cachePath, e.message);
    return sourcePath;
  }
}

// Audio streaming endpoints — supports HTTP Range via res.sendFile.
// Hot-cache path: if `cachePath` already has the file at full size, serve
// from local SSD (fast, no Drive in the request loop).
// Cold-cache path: serve DIRECTLY from `sourcePath` (which lives on Drive
// Stream) — DO NOT block waiting for a copy. Kick off the cache copy in
// the background so the NEXT play of this file is hot. This eliminates
// the multi-second "spinning disc" the user saw on first play of any song
// in a cold cache: 6 stems would previously serialize through a blocking
// fs.copyFileSync each ~2s = 12s before the audio could even start.
// CACHE-FIRST audio serving. Pre-2026-06-27 this called
// fs.existsSync(sourcePath) and fs.statSync(sourcePath) on every request
// to decide whether a cached copy was valid (by size match). Those are
// synchronous Drive reads, and macOS's CloudStorage layer can block them
// for 30+ seconds when offline — which wedges Node's WHOLE event loop
// (no parallelism: every other request, including the heartbeat poll,
// stalls behind it). The "SERVER NOT RESPONDING" yellow banner Bill saw
// during the offline test was the heartbeat poll losing this race.
//
// New rule: if the cache file exists with non-zero size, serve it
// IMMEDIATELY without touching Drive. The size-equality check is
// abandoned — once a stem is written to cache by ensureCachedAsync it's
// the same byte-for-byte content forever (stems are immutable; we don't
// re-render and overwrite in place). On cold cache, we still need to
// touch Drive, but with an async stat + a 3-second timeout so the
// event loop never wedges.
async function sendCachedAudio(req, res, sourcePath, cachePath) {
  // 1) Cache hit — local FS only, no Drive interaction.
  if (cachePath) {
    try {
      const cs = fs.statSync(cachePath);
      if (cs.isFile() && cs.size > 0) {
        return res.sendFile(cachePath, { dotfiles: 'allow' }, (err) => {
          if (err) console.warn('[audio sendFile err - cache]', cachePath, err.message);
        });
      }
    } catch (e) { /* cache miss — fall through to Drive */ }
  }

  // 2) Cold cache. Probe Drive but bound the wait so a wedged Drive
  //    layer can't block the event loop. Fail fast with 503 if Drive
  //    isn't responsive — the client greys out the song and the
  //    operator can pick a different one instead of staring at a spinner.
  let sourceStat = null;
  try {
    sourceStat = await Promise.race([
      fsp.stat(sourcePath),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 3000)),
    ]);
  } catch (e) {
    if (e && e.message === 'drive-stall') {
      console.warn('[audio 503] drive stalled (>3s) for', sourcePath);
      return res.status(503).type('text')
        .send('Drive read timed out — audio not in local cache and Drive is unreachable.');
    }
    if (e && e.code === 'ENOENT') {
      return res.status(404).send('Audio file not found');
    }
    console.warn('[audio 500] stat error:', sourcePath, e.message);
    return res.status(500).send('Audio stat failed');
  }
  if (!sourceStat || !sourceStat.isFile()) {
    return res.status(404).send('Audio file not found');
  }
  res.sendFile(sourcePath, { dotfiles: 'allow' }, (err) => {
    if (err) console.warn('[audio sendFile err - source]', sourcePath, err.message);
  });
  // Schedule background cache copy so NEXT play is hot.
  if (cachePath) {
    setImmediate(() => {
      ensureCachedAsync(sourcePath, cachePath).catch(() => {});
    });
  }
}

app.get('/api/audio/stems/:song/:file', async (req, res) => {
  const { song, file } = req.params;
  if (song.includes('..') || file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(STEMS_DIR, song, file);
  // WAV requests are not cached — stems are always served as m4a in the
  // browser-side mixer. The legacy WAV path was kept for one-off debugging
  // only. Bounded with the same 3-second Drive probe so an offline gig
  // doesn't wedge the event loop here either.
  if (/\.wav$/i.test(file)) {
    try {
      const st = await Promise.race([
        fsp.stat(sourcePath),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 3000)),
      ]);
      if (!st.isFile()) return res.status(404).send('Audio file not found');
    } catch (e) {
      if (e && e.message === 'drive-stall') return res.status(503).send('Drive read timed out');
      return res.status(404).send('Audio file not found');
    }
    return res.sendFile(sourcePath, { dotfiles: 'allow' });
  }
  const cachePath = path.join(AUDIO_CACHE_STEMS, song, file);
  return sendCachedAudio(req, res, sourcePath, cachePath);
});

// Loops catalog — surfaces every loop file the portal can play, drawn from
// two sources merged together:
//   1) LOOPS/ flat folder (modern). Filename:
//      <inst>_<bpm-padded-3>_<song-slug>_<bars>bars.m4a
//      Each row exposes inst (drums|bass|drumsbass|guitar|piano), bpm, bars.
//   2) M4A/<base>_DO_loop<N>_<bars>bars.m4a (legacy). Drums-only mixdown
//      that pre-dates the per-instrument layout. Treated as inst='drums'
//      and retained so old songs keep working in the UI.
// Sort: alphabetical by filename (so inst, BPM, song all sort naturally).
app.get('/api/drum-loops', (req, res) => {
  const stems = (libraryCache && libraryCache.data && libraryCache.data.songs || [])
    .filter(s => s.type === 'stems');
  const stemsBySlug = new Map();
  for (const s of stems) {
    const slug = songSlugForLoops(s.title || s.folderName);
    if (slug) stemsBySlug.set(slug, s);
  }
  const stemsByBase = new Map(stems.map(s => [s.folderName, s]));
  const loops = [];

  if (fs.existsSync(LOOPS_DIR)) {
    const newRe = /^([a-z]+)_(\d{1,4})_(.+)_(\d+)bars\.m4a$/;
    try {
      for (const f of fs.readdirSync(LOOPS_DIR)) {
        if (/ \(\d+\)\.m4a$/i.test(f)) continue;
        const m = f.match(newRe);
        if (!m) continue;
        const inst       = m[1];
        const bpm        = Number(m[2]);
        const songSlug   = m[3];
        const bars       = Number(m[4]);
        const parent     = stemsBySlug.get(songSlug);
        loops.push({
          id:        `loop-${f}`,
          source:    'loops',
          fileName:  f,
          inst,
          bpm,
          bars,
          songSlug,
          songBase:  (parent && parent.folderName) || songSlug,
          title:     (parent && parent.title)  || songSlug.replace(/_/g, ' '),
          artist:    (parent && parent.artist) || '',
          key:       parent && parent.key       || null,
        });
      }
    } catch (e) {
      console.warn('[drum-loops] LOOPS/ read failed:', e.message);
    }
  }

  if (fs.existsSync(M4A_DIR)) {
    const legacyRe = /^(.+?)_DO_loop(\d+)_(\d+)bars\.m4a$/i;
    try {
      for (const f of fs.readdirSync(M4A_DIR)) {
        if (/ \(\d+\)\.m4a$/i.test(f)) continue;
        const m = f.match(legacyRe);
        if (!m) continue;
        const songBase  = m[1];
        const loopNumber = Number(m[2]);
        const bars       = Number(m[3]);
        const parent     = stemsByBase.get(songBase);
        loops.push({
          id:        `drumloop-${f}`,
          source:    'm4a-legacy',
          fileName:  f,
          inst:      'drums',
          songBase,
          loopNumber,
          bars,
          bpm:       parent && parent.practiceBpm || null,
          title:     (parent && parent.title)  || songBase.replace(/_/g, ' '),
          artist:    (parent && parent.artist) || '',
          key:       parent && parent.key       || null,
          cached:    isM4aCached(f),
        });
      }
    } catch (e) {
      console.warn('[drum-loops] M4A/ read failed:', e.message);
    }
  }

  loops.sort((a, b) => a.fileName.localeCompare(b.fileName));
  res.json({ loops, count: loops.length });
});

// /api/audio/m4a/:file retired 2026-06-27 — see stem.sh + diagram 1.
// If any old client code still hits this URL, fail loud with 410 so we
// can grep the access log and find the caller.
app.get('/api/audio/m4a/:file', (req, res) => {
  res.status(410).type('text').send(
    'Gone. M4A mixdowns retired 2026-06-27 — the portal mixes the six stems client-side. ' +
    'Use /api/audio/stems/:song/:file instead.'
  );
});

// ---------- DRUM MACHINE ---------------------------------------------------
// DRUM_MACHINE/<bpm>@<pattern>.m4a holds one short loopable .m4a per pattern.
// The portal calls /api/drum-machine/pick on song-load to decide which file
// to use for the top-of-screen Drum Machine button:
//   1. If the song's metadata.drum_pattern is set AND that file exists, use it.
//   2. Else fall back to the metronome series 110@<bpm>.m4a; if exact is
//      missing, pick the closest 110@N.m4a by BPM distance.
//   3. Else (no DRUM_MACHINE/ files at all) return null.
// /api/drum-machine/list returns the whole sorted list so the right-click
// context menu can render an override picker.
const AUDIO_CACHE_DRUM = path.join(AUDIO_CACHE_DIR, 'DRUM_MACHINE');
try { fs.mkdirSync(AUDIO_CACHE_DRUM, { recursive: true }); } catch (e) {}
const AUDIO_CACHE_BACKING = path.join(AUDIO_CACHE_DIR, 'BACKING_TRACKS');
try { fs.mkdirSync(AUDIO_CACHE_BACKING, { recursive: true }); } catch (e) {}

// In-memory mirror of every drum pattern filename. Populated by
// precacheAllDrumPatterns() at boot + hourly + Flash Cache; the audio
// endpoints read THIS, never Drive. Offline-gig contract: Drive is never
// in the audio request path. If the cache hasn't been warmed yet at boot
// (cold start, fresh machine), the array starts empty and the first
// precache cycle fills it. Audio requests during that gap fall through
// sendCachedAudio's bounded 3s Drive probe and either serve or 503.
let drumPatternList = [];
function refreshDrumPatternListFromCache() {
  try {
    drumPatternList = fs.readdirSync(AUDIO_CACHE_DRUM)
      .filter(f => f.toLowerCase().endsWith('.m4a'))
      .sort();
  } catch (e) { drumPatternList = []; }
}
refreshDrumPatternListFromCache();

function listDrumPatterns() {
  // Local-cache only. NEVER touch DRUM_MACHINE_DIR (Drive) here — this
  // is called by /api/drum-machine/pick on every song load, and a single
  // sync Drive read with no wifi wedges Node's event loop and freezes
  // ALL audio (including stems). 2026-06-28 gig postmortem.
  return drumPatternList;
}

// Parse <bpm>@<pattern>.m4a -> { bpm, pattern }. Returns null on shape miss.
function parseDrumName(filename) {
  const m = /^(\d+)@(\d+)\.m4a$/i.exec(filename);
  if (!m) return null;
  return { bpm: Number(m[1]), pattern: Number(m[2]), filename };
}

app.get('/api/drum-machine/list', (req, res) => {
  res.json({ patterns: listDrumPatterns() });
});

// Pick a drum file for the current song. Query params:
//   ?drum_pattern=120@130  (from metadata.json; optional)
//   ?bpm=92                 (fallback metronome target; optional but desired)
// Response: { file, url, source: 'exact'|'metronome-exact'|'metronome-near'|null,
//             alternates: [<filename>, ...]  -- 110@<near> options }
app.get('/api/drum-machine/pick', (req, res) => {
  const all = listDrumPatterns();
  if (all.length === 0) return res.json({ file: null, url: null, source: null, alternates: [] });

  const want = (req.query.drum_pattern || '').toString().trim();
  const bpm  = Number(req.query.bpm) || null;

  // Index everything as parsed {bpm, pattern, filename}; ignore non-conforming.
  const parsed = all.map(parseDrumName).filter(Boolean);

  // Pre-compute groups by BPM for fast nearest-pattern-in-family lookup.
  const byBpm = {};
  for (const d of parsed) {
    (byBpm[d.bpm] = byBpm[d.bpm] || []).push(d);
  }

  // Helper: pick the entry in `group` whose pattern is closest to target.
  function nearestInGroup(group, target) {
    if (!group || !group.length) return null;
    let best = group[0];
    let bestDist = Math.abs(best.pattern - target);
    for (const d of group) {
      const dist = Math.abs(d.pattern - target);
      if (dist < bestDist) { best = d; bestDist = dist; }
    }
    return best;
  }

  let chosen = null;
  let source = null;

  // 1. Explicit metadata.drum_pattern: try exact first, then nearest pattern
  //    in the SAME BPM family. e.g. drum_pattern = "114@95":
  //      a) try 114@95.m4a
  //      b) if missing, look at every 114@*.m4a and pick the closest N to 95
  //    This keeps the song's intended kit; only falls through to the
  //    110@ metronome family if no same-BPM pattern exists at all.
  if (want) {
    const wantFile = `${want}.m4a`;
    if (all.includes(wantFile)) {
      chosen = wantFile;
      source = 'exact';
    } else {
      const m = /^(\d+)@(\d+)$/.exec(want);
      if (m) {
        const familyBpm = Number(m[1]);
        const familyPat = Number(m[2]);
        const near = nearestInGroup(byBpm[familyBpm], familyPat);
        if (near) {
          chosen = near.filename;
          source = 'family-near';
        }
      }
    }
  }

  // 2. Metronome fallback: 110@<bpm>.m4a, then nearest 110@N to song bpm.
  if (!chosen && bpm) {
    const metronomes = byBpm[110];
    if (metronomes && metronomes.length) {
      const exact = metronomes.find(d => d.pattern === bpm);
      if (exact) {
        chosen = exact.filename; source = 'metronome-exact';
      } else {
        const near = nearestInGroup(metronomes, bpm);
        chosen = near.filename; source = 'metronome-near';
      }
    }
  }

  // 3. Last-ditch: just the first pattern. Better than silence.
  if (!chosen) {
    chosen = all[0];
    source = 'first-available';
  }

  // Right-click override menu. Show, in order:
  //   - the chosen file (top, marked as current)
  //   - every entry in the SAME BPM family as the chosen file, sorted by
  //     pattern distance from the requested pattern (or the song BPM)
  //   - then the 110@ metronome row
  // Capped to 12 total.
  const chosenParsed = parsed.find(d => d.filename === chosen) || null;
  const familyBpm = chosenParsed ? chosenParsed.bpm : (bpm || 110);
  const familyPat = chosenParsed ? chosenParsed.pattern : (bpm || 100);

  const familyAlts = (byBpm[familyBpm] || [])
    .slice()
    .sort((a, b) => Math.abs(a.pattern - familyPat) - Math.abs(b.pattern - familyPat));
  const metronomeAlts = (familyBpm === 110 ? [] : (byBpm[110] || []))
    .slice()
    .sort((a, b) => Math.abs(a.pattern - (bpm || 100)) - Math.abs(b.pattern - (bpm || 100)));

  const altsOrdered = [];
  const seen = new Set();
  for (const d of [...familyAlts, ...metronomeAlts]) {
    if (seen.has(d.filename)) continue;
    seen.add(d.filename);
    altsOrdered.push(d.filename);
    if (altsOrdered.length >= 12) break;
  }
  if (chosen && !altsOrdered.includes(chosen)) altsOrdered.unshift(chosen);

  res.json({
    file: chosen,
    url: `/api/audio/drum-machine/${encodeURIComponent(chosen)}`,
    source,
    alternates: altsOrdered,
  });
});

app.get('/api/audio/drum-machine/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(DRUM_MACHINE_DIR, file);
  const cachePath  = path.join(AUDIO_CACHE_DRUM, file);
  // NO sync existsSync on sourcePath — that path is Drive, and a probe
  // wedges the event loop offline. sendCachedAudio serves from local
  // cache, and only falls back to Drive behind a bounded 3s timeout.
  sendCachedAudio(req, res, sourcePath, cachePath);
});

// New endpoint — returns every drum pattern grouped by BPM family so the
// UI can show ALL patterns in a pulldown (task #128). Client picks the
// auto-matched pattern by default but can select any pattern from any
// family. Non-conforming filenames end up in the "other" bucket.
app.get('/api/drum-machine/all-grouped', (req, res) => {
  const all = listDrumPatterns();
  const groups = {};
  const other = [];
  for (const f of all) {
    const p = parseDrumName(f);
    if (!p) { other.push({ filename: f, label: f.replace(/\.m4a$/i, '') }); continue; }
    const key = String(p.bpm);
    (groups[key] = groups[key] || []).push({
      filename: f, bpm: p.bpm, pattern: p.pattern,
      label: `${p.bpm}@${p.pattern}`,
    });
  }
  // Sort each family by drum pattern number ascending; sort families by BPM.
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => a.pattern - b.pattern);
  }
  const orderedFamilies = Object.keys(groups)
    .map(Number).sort((a, b) => a - b).map(String);
  res.json({
    families: orderedFamilies.map(bpm => ({
      bpm: Number(bpm),
      label: `${bpm} BPM`,
      patterns: groups[bpm],
    })),
    other: other.length ? other : undefined,
    total: all.length,
  });
});

// ─── BACKING-TRACK MODULE ─────────────────────────────────────────────
// A curator's folder of hand-picked stereo m4a files that plays INSTEAD
// of the six-stem mix. Naming is unconstrained (Bill's history includes
// "Wicked Game-Chris Isaak.m4a", "100@135 Flagpole Sitta.m4a",
// "BillWithers-AintNoSunshine-2ch.m4a", "Already Gone-Eagles-Project.m4a").
// The server fuzzy-matches each file to a STEMS folder by normalized
// title+artist and exposes the pairing via /api/backing-tracks/pick/:base.
// Same offline-gig contract as the drum machine: precached to
// ~/.bt-cache/BACKING_TRACKS/ at boot + hourly, and served from local
// cache only.
let backingTrackList = [];          // filenames present in local cache
let backingTrackAssignments = {};   // song_base → { file, score, source }
function refreshBackingTrackListFromCache() {
  try {
    backingTrackList = fs.readdirSync(AUDIO_CACHE_BACKING)
      .filter(f => /\.(m4a|mp3)$/i.test(f))
      .sort();
  } catch (e) { backingTrackList = []; }
}
refreshBackingTrackListFromCache();

// Filename / library-title normalization. Strips extension, common
// suffixes, tempo markers, live-version / remaster / venue markers, and
// "BackingTrack" prefix; returns a bag of lowercase alphanumeric tokens
// for matching. Live versions ("Sweet Home Alabama - 7/2/1977 - Oakland
// Coliseum Stadium Lynyrd Skynyrd") normalize to the same token bag as
// the studio version so they share backing-track pairings.
function normalizeForMatch(s) {
  if (!s) return [];
  let x = String(s);
  x = x.replace(/\.(m4a|mp3|wav|aac|m4b)$/i, '');
  // Strip the "BackingTrack" or "Backing Tracks" prefix.
  x = x.replace(/^\s*Backing\s*Tracks?\s*/i, '');
  // Strip Logic-Pro / curator suffixes that don't identify the song.
  x = x.replace(/[-_\s]+(2ch|CountIn|Actual|Project|Matt|DrumsLeft|tight|remaster(ed)?|remastered?\s*20\d\d)$/i, '');
  x = x.replace(/[-_\s]+(V(-G(-B)?)?|DO|FULL|vocalsonly)$/i, '');
  // Strip "- <date> - <venue words>" style live markers. Two shapes are
  // common in the library:
  //   "Song - 7/2/1977 - Oakland Coliseum Stadium ..."
  //   "Song_-_7_2_1977_-_Oakland_Coliseum_Stadium_..."
  // The first regex handles the slash-date form; the second handles the
  // underscore-date form that STEMS folder slugs use.
  x = x.replace(/\s*[-_]\s*\d+[\/_]\d+[\/_]\d+\s*[-_]\s*[^-_]+?(?=[-_]{2,}|$)/g, '');
  x = x.replace(/\s*[\(\[]Live[^\)\]]*[\)\]]/gi, '');
  x = x.replace(/\s*[\(\[]Remaster(ed)?[^\)\]]*[\)\]]/gi, '');
  x = x.replace(/\s*[\(\[](Official|HD|HQ)[^\)\]]*[\)\]]/gi, '');
  // Strip leading OR trailing tempo markers like "100@135" or "-100".
  x = x.replace(/^\s*\d+@\d+\s+/, '');
  x = x.replace(/\s+\d+@\d+\s*$/, '');
  x = x.replace(/[-_\s]+\d+@\d+$/, '');
  x = x.replace(/[-_\s]+\d{2,3}$/, '');    // trailing "-110"
  // Tokenize on non-alphanumerics; drop empties + noise words.
  const NOISE = new Set([
    'the','a','an','of','in','on','at','to','for','and','&','with',
    'official','audio','video','music','hd','hq','remastered','remaster',
    'live','concert','cover','tribute','karaoke','feat','ft','featuring',
    'song','songs','track','tracks','backing','from','by','edit','version',
    // Venue words (strip common live-recording locations so the studio
    // and live forms of a song normalize to the same token bag).
    'coliseum','stadium','arena','garden','centre','center','hall',
    'auditorium','amphitheatre','amphitheater','pavilion','park',
    'oakland','wembley','madison','fillmore','budokan','forum',
  ]);
  return x.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t && t.length >= 2 && !NOISE.has(t) && !/^\d+$/.test(t));
}
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  let hit = 0;
  for (const t of a) if (bSet.has(t)) hit++;
  return (2 * hit) / (a.length + b.length);
}
// Manifest file for persistent manual overrides. Shape:
//   { "Sweet_Home_Alabama_Lynyrd_Skynyrd": "Sweet Home Alabama-Lynryd Skynyd-Project.m4a", ... }
// Auto-matcher fills in the rest; manifest wins on conflict. Survives
// server restart, unlike the in-memory-only assignments.
const BACKING_MANIFEST_PATH = path.join(BACKING_TRACKS_DIR, 'manifest.json');
function readBackingManifest() {
  try {
    if (fs.existsSync(BACKING_MANIFEST_PATH)) {
      const raw = fs.readFileSync(BACKING_MANIFEST_PATH, 'utf8');
      const j = JSON.parse(raw);
      return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
    }
  } catch (e) { console.warn('[backing-tracks] manifest read failed:', e.message); }
  return {};
}
function writeBackingManifest(obj) {
  try {
    fs.mkdirSync(path.dirname(BACKING_MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(BACKING_MANIFEST_PATH, JSON.stringify(obj, null, 2) + '\n');
    return true;
  } catch (e) {
    console.warn('[backing-tracks] manifest write failed:', e.message);
    return false;
  }
}

// Rebuild the song_base → filename assignment. Runs on boot + hourly
// (after precache) + on demand. Two changes from the first draft:
//   1. Files can be SHARED across songs — the studio and live versions
//      of "Sweet Home Alabama" both point at the same backing track.
//   2. Manual overrides from manifest.json win over auto-matches.
function rebuildBackingTrackAssignments() {
  const assignments = {};
  const songs = (libraryCache && libraryCache.data && Array.isArray(libraryCache.data.songs))
    ? libraryCache.data.songs : [];
  const stems = songs.filter(s => s.type === 'stems');
  if (!stems.length || !backingTrackList.length) {
    // Still honor manifest overrides even without library.
    const manifest = readBackingManifest();
    for (const base of Object.keys(manifest)) {
      if (backingTrackList.includes(manifest[base])) {
        assignments[base] = { file: manifest[base], score: 1, source: 'manifest' };
      }
    }
    backingTrackAssignments = assignments;
    return;
  }
  const btNorm = backingTrackList.map(f => ({ file: f, tokens: normalizeForMatch(f) }));
  let autoCount = 0;
  for (const s of stems) {
    const base = s.folderName;
    if (!base) continue;
    const libTokens = normalizeForMatch(`${s.title || ''} ${s.artist || ''}`);
    if (!libTokens.length) continue;
    let best = null;
    let bestScore = 0.45;   // slightly lower threshold now that noise is stripped
    for (const bt of btNorm) {
      if (!bt.tokens.length) continue;
      const score = dice(libTokens, bt.tokens);
      if (score > bestScore) { best = bt; bestScore = score; }
    }
    if (best) {
      assignments[base] = { file: best.file, score: Number(bestScore.toFixed(3)), source: 'auto' };
      autoCount++;
    }
  }
  // Layer manifest overrides on top (manifest wins). Only accept entries
  // whose target file actually exists in the cache; skip stale references.
  const manifest = readBackingManifest();
  let manifestCount = 0;
  for (const base of Object.keys(manifest)) {
    const file = manifest[base];
    if (!backingTrackList.includes(file)) continue;
    assignments[base] = { file, score: 1, source: 'manifest' };
    manifestCount++;
  }
  backingTrackAssignments = assignments;
  console.log(`[backing-tracks] rebuilt assignments: ${Object.keys(assignments).length} songs matched (${autoCount} auto, ${manifestCount} manifest), ${backingTrackList.length} files available`);
}

app.get('/api/backing-tracks/list', (req, res) => {
  res.json({ files: backingTrackList, total: backingTrackList.length });
});

// Pairing for a specific song. Returns { file, url, score, source } or 404.
app.get('/api/backing-tracks/pick/:base', (req, res) => {
  const base = req.params.base;
  const a = backingTrackAssignments[base];
  if (!a) return res.status(404).json({ error: 'no backing track matched for this song' });
  res.json({
    file: a.file,
    url: `/api/audio/backing/${encodeURIComponent(a.file)}`,
    score: a.score,
    source: a.source,
  });
});

// Manual override — sends { file } to force a specific pairing (edge
// cases the auto-matcher missed, or an operator preference). Writes to
// BACKING_TRACKS/manifest.json so the pairing survives server restart.
// Sending { file: null } removes the override (auto-match takes over).
app.post('/api/backing-tracks/assign/:base', express.json(), (req, res) => {
  const base = req.params.base;
  const file = req.body && req.body.file;
  const manifest = readBackingManifest();
  if (file === null || file === '') {
    delete manifest[base];
    writeBackingManifest(manifest);
    rebuildBackingTrackAssignments();
    return res.json({ ok: true, file: null, note: 'override removed' });
  }
  if (!file || !backingTrackList.includes(file)) {
    return res.status(400).json({ error: 'file not present in cache' });
  }
  manifest[base] = file;
  writeBackingManifest(manifest);
  rebuildBackingTrackAssignments();
  res.json({ ok: true, file, persisted: true });
});

// Bulk assignments — one call to render a "map" view for the operator.
app.get('/api/backing-tracks/assignments', (req, res) => {
  res.json({ assignments: backingTrackAssignments });
});

app.get('/api/audio/backing/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(BACKING_TRACKS_DIR, file);
  const cachePath  = path.join(AUDIO_CACHE_BACKING, file);
  sendCachedAudio(req, res, sourcePath, cachePath);
});

// ---------- CUSTOM LOOPS FROM URL ------------------------------------------
// User pastes a YouTube URL with a t=<seconds> anchor and says "grab the
// next N seconds". We shell out to yt-dlp with --download-sections to
// pull just that slice of audio, transcode to m4a, and drop it into
// CUSTOM_LOOPS/ where the portal can list + play it.
//
// File naming: <videoid>_t<start>_d<dur>.m4a (or with optional --name
// the user supplied as a prefix).
const CUSTOM_LOOPS_DIR = `${SIMPLE_STEM_ROOT}/CUSTOM_LOOPS`;
try { fs.mkdirSync(CUSTOM_LOOPS_DIR, { recursive: true }); } catch (e) {}
const AUDIO_CACHE_CUSTOM_LOOPS = path.join(AUDIO_CACHE_DIR, 'CUSTOM_LOOPS');
try { fs.mkdirSync(AUDIO_CACHE_CUSTOM_LOOPS, { recursive: true }); } catch (e) {}

// (Previously here: in-memory job table + newJobId for the /api/loops/
// from-url async fetcher. Both removed when clip curation moved to the
// standalone Clip Librarian on 2026-06-21.)

// Parse a video URL from ANY yt-dlp-supported source. Returns
// { videoId, startSec } where videoId is a short tag we use to name
// the raw capture file, and startSec is 0 unless the URL has a t= /
// #t= / ?start= anchor.
//
// Supported video-id extraction (used only for naming the local m4a):
//   YouTube         ?v=, youtu.be/, /shorts/
//   Twitter / X     /status/<id>            -> "tw<id>"
//   Vimeo           vimeo.com/<id>          -> "vm<id>"
//   SoundCloud      soundcloud.com/<user>/<track> -> "sc<user>-<track>"
//   Reddit          /comments/<id>/...      -> "rd<id>"
//   TikTok          /video/<id>             -> "tt<id>"
//   Instagram       /reel/<id>, /p/<id>     -> "ig<id>"
//   Fallback        last path segment, sanitized
//
// yt-dlp itself does the actual fetching; this is just for filename.
function parseSourceUrl(url) {
  const u = String(url || '').trim();
  if (!u) return { videoId: null, startSec: 0 };
  let videoId = null;
  let m;
  // YouTube
  if      ((m = u.match(/[?&]v=([\w-]{6,})/)))           videoId = m[1];
  else if ((m = u.match(/youtu\.be\/([\w-]{6,})/)))      videoId = m[1];
  else if ((m = u.match(/youtube\.com\/shorts\/([\w-]{6,})/i))) videoId = m[1];
  // Twitter / X
  else if ((m = u.match(/(?:twitter|x)\.com\/[^/]+\/status\/(\d{6,})/i))) videoId = 'tw' + m[1];
  // Vimeo
  else if ((m = u.match(/vimeo\.com\/(\d{4,})/i)))       videoId = 'vm' + m[1];
  // SoundCloud
  else if ((m = u.match(/soundcloud\.com\/([\w-]+)\/([\w-]+)/i))) videoId = ('sc' + m[1] + '-' + m[2]).slice(0, 30);
  // Reddit
  else if ((m = u.match(/reddit\.com\/r\/[^/]+\/comments\/(\w+)/i))) videoId = 'rd' + m[1];
  // TikTok
  else if ((m = u.match(/tiktok\.com\/[^/]+\/video\/(\d+)/i))) videoId = 'tt' + m[1];
  // Instagram
  else if ((m = u.match(/instagram\.com\/(?:reel|p|tv)\/([\w-]+)/i))) videoId = 'ig' + m[1];
  // Fallback: last meaningful path segment.
  else {
    try {
      const parts = new URL(u).pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || 'src';
      videoId = last.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24) || 'src';
    } catch (e) { videoId = 'src'; }
  }

  // t= / start= / #t= start-time anchor. Forms: t=20, t=20s, t=1m20s,
  // t=1h2m3s. Twitter doesn't use t=; that's fine, start stays 0.
  let startSec = 0;
  const tm = u.match(/[?&#]t=([0-9hms]+)|[?&]start=(\d+)/i);
  if (tm) {
    if (tm[2]) {
      startSec = Number(tm[2]);
    } else {
      const t = tm[1];
      if (/^\d+$/.test(t)) startSec = Number(t);
      else {
        const hm = t.match(/(\d+)h/i);
        const mm = t.match(/(\d+)m/i);
        const sm = t.match(/(\d+)s/i);
        startSec = (hm ? +hm[1] : 0) * 3600 + (mm ? +mm[1] : 0) * 60 + (sm ? +sm[1] : 0);
      }
    }
  }
  return { videoId, startSec };
}
// Back-compat alias — other places still call parseYoutubeUrl.
const parseYoutubeUrl = parseSourceUrl;

function sanitizeName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// /api/loops/from-url, /api/loops/from-url/poll/:job_id and
// /api/custom-loops/trim were removed 2026-06-21. Clip fetching + trimming
// moved out to the standalone Clip Librarian (clip_librarian/README.md at
// the simpleStem root). The App keeps only the read endpoints below.

app.get('/api/custom-loops/list', (req, res) => {
  // Read from local cache, NOT Drive. CUSTOM_LOOPS_DIR sits on Drive and
  // a sync readdirSync there freezes the event loop when offline.
  // precacheAllCustomLoops keeps AUDIO_CACHE_CUSTOM_LOOPS in sync.
  let files = [];
  try {
    files = fs.readdirSync(AUDIO_CACHE_CUSTOM_LOOPS)
      .filter(f => f.toLowerCase().endsWith('.m4a'))
      .map(f => {
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(path.join(AUDIO_CACHE_CUSTOM_LOOPS, f));
              size = st.size; mtime = st.mtimeMs; } catch (e) {}
        return {
          file: f,
          url:  `/api/audio/custom-loop/${encodeURIComponent(f)}`,
          size, mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {}
  res.json({ loops: files, count: files.length });
});

app.delete('/api/custom-loops/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).json({ error: 'bad name' });
  const p = path.join(CUSTOM_LOOPS_DIR, file);
  const cp = path.join(AUDIO_CACHE_CUSTOM_LOOPS, file);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  try { if (fs.existsSync(cp)) fs.unlinkSync(cp); } catch (e) {}
  res.json({ ok: true });
});

app.get('/api/audio/custom-loop/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(CUSTOM_LOOPS_DIR, file);
  const cachePath  = path.join(AUDIO_CACHE_CUSTOM_LOOPS, file);
  // No sync Drive probe — same reasoning as drum-machine endpoint.
  sendCachedAudio(req, res, sourcePath, cachePath);
});

// Trim a previously-captured raw_*.m4a down to a named final loop.
// POST body: { source: 'raw_...m4a', start_sec, end_sec, name, deleteSource? }
// ffmpeg with -c copy is a stream-copy at keyframe boundaries — very fast,
// no re-encode. Good enough for snipping practice loops; if the start point
// lands between keyframes you may hear a ~0.1s pad at the front.

// Serve loop files from the flat LOOPS/ folder. Mirrors the m4a endpoint.
// Cache key: file basename. Files like
//   drums_120_mary_janes_last_dance_18bars.m4a
// land in ~/.bt-cache/LOOPS/<filename> after first play, served from cache
// thereafter.
const AUDIO_CACHE_LOOPS = path.join(AUDIO_CACHE_DIR, 'LOOPS');
try { fs.mkdirSync(AUDIO_CACHE_LOOPS, { recursive: true }); } catch (e) {}
app.get('/api/audio/loop/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(LOOPS_DIR, file);
  const cachePath  = path.join(AUDIO_CACHE_LOOPS, file);
  sendCachedAudio(req, res, sourcePath, cachePath);
});

// Force-populate the local cache for a single loop file. Returns 202 fast;
// copying runs in the background. Used by the client when a loop is added
// to the sequence so playback never blocks on a Drive fetch mid-jam.
app.post('/api/precache/loop/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(LOOPS_DIR, file);
  const cachePath  = path.join(AUDIO_CACHE_LOOPS, file);
  // Local cache only on the sync path — never probe Drive here.
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return res.json({ ok: true, cached: true, alreadyCached: true });
  }
  res.json({ ok: true, cached: false, queued: true });
  (async () => {
    try {
      await ensureCachedAsync(sourcePath, cachePath);
      console.log(`[precache-loop] ${file} done`);
    } catch (e) {
      console.warn(`[precache-loop] ${file} failed:`, e.message);
    }
  })();
});

// Returns the cache state for a list of loop filenames. Body: { files: [...] }.
// Used by the client to mark pills as cached / not-cached at render time
// without doing one HEAD per pill.
// 5 MB limit accommodates the worst-case payload (every loop in the catalog
// in a single POST). Default express.json() is 100 KB which 413s on libraries
// with thousands of loop files.
app.post('/api/loop-cache-status', express.json({ limit: '5mb' }), (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
  const status = {};
  for (const f of files) {
    if (typeof f !== 'string' || f.includes('..')) { status[f] = false; continue; }
    const cachePath = path.join(AUDIO_CACHE_LOOPS, f);
    try {
      status[f] = fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0;
    } catch (e) { status[f] = false; }
  }
  res.json({ status });
});

// Returns true when every wav file we expect for a stems song is present
// in the local cache with non-zero size. Two-tier fast path:
//   1. .cached sentinel (written by the bulk precache POST) → instant true.
//   2. Otherwise, read the song's expected file list from the in-memory
//      library cache (built from the source folder's stems + loops) and
//      verify each is in the local cache. All stats are against the local
//      SSD; no Google Drive calls.
function isStemsFolderCached(folderName) {
  const sentinel = path.join(AUDIO_CACHE_STEMS, folderName, '.cached');
  if (fs.existsSync(sentinel)) return true;

  // Look up the expected file list from the library cache (already in memory)
  const data = libraryCache && libraryCache.data;
  if (!data) return false;
  const entry = data.songs.find(s => s.type === 'stems' && s.folderName === folderName);
  if (!entry) return false;

  // Only the main mixable stems count toward "ready". Loops + source.wav
  // are auxiliary — the user can mix without them.
  const MAIN_STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const expected = [];
  if (entry.stems) {
    for (const k of MAIN_STEMS) {
      if (entry.stems[k]) expected.push(entry.stems[k]);
    }
  }
  if (expected.length === 0) return false;

  for (const f of expected) {
    try {
      const cp = path.join(AUDIO_CACHE_STEMS, folderName, f);
      const st = fs.statSync(cp);
      if (!st.size) return false;
    } catch (e) {
      return false; // missing
    }
  }
  return true;
}

// Returns true if a single m4a file is mirrored in the cache with matching
// size. Used to mark instantly-playable songs in the library.
function isM4aCached(fileName) {
  try {
    const cachePath = path.join(AUDIO_CACHE_M4A, fileName);
    if (!fs.existsSync(cachePath)) return false;
    const srcPath = path.join(M4A_DIR, fileName);
    const csz = fs.statSync(cachePath).size;
    const ssz = fs.statSync(srcPath).size;
    return csz > 0 && csz === ssz;
  } catch (e) {
    return false;
  }
}

// Background pre-fetch of every M4A file at startup. M4As are small
// (~5-10MB each) so caching all of them uses modest disk (~2GB for 230
// files). This makes the user's primary play mode (M4A backing track)
// instant for every song without ever touching Google Drive at click time.
// WAV stems are NOT precached — they're huge (~50MB each × 6 per song
// × 89 folders ≈ 25GB), so they only enter the cache on explicit request.
// Process many files concurrently in capped-parallel batches. Pure serial
// was ~5s/file × 230 = 20+ minutes on Google Drive. Eight concurrent fetches
// keeps disk + network busy without thrashing.
async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { error: e }; }
    }
  });
  await Promise.all(runners);
  return results;
}

async function precacheAllM4as() {
  if (!fs.existsSync(M4A_DIR)) return;
  const t0 = Date.now();
  let copied = 0, skipped = 0, failed = 0;
  try {
    const files = (await fsp.readdir(M4A_DIR)).filter(f => f.toLowerCase().endsWith('.m4a'));
    console.log(`[m4a precache] starting — ${files.length} files (8 in parallel)`);
    await runWithConcurrency(files, 8, async (f) => {
      try {
        const sourcePath = path.join(M4A_DIR, f);
        const cachePath  = path.join(AUDIO_CACHE_M4A, f);
        // Cheap test: cache file already exists AND non-zero size → skip without statting source
        if (fs.existsSync(cachePath)) {
          const csz = fs.statSync(cachePath).size;
          if (csz > 0) { skipped++; return; }
        }
        await ensureCachedAsync(sourcePath, cachePath);
        copied++;
        if ((copied + skipped) % 25 === 0) {
          console.log(`[m4a precache] progress: ${copied + skipped}/${files.length}`);
        }
      } catch (e) { failed++; }
    });
    console.log(`[m4a precache] done — copied ${copied}, already cached ${skipped}, failed ${failed} (${Math.round((Date.now()-t0)/1000)}s)`);
  } catch (e) {
    console.warn('[m4a precache] failed:', e.message);
  }
}
// Boot-time bulk precache passes are DISABLED. They forced Drive Stream to
// readdir() every M4A/ and STEMS/ folder on startup which then pulled the
// touched files into Drive's own local cache (~/Library/Application
// Support/Google/DriveFS/), burning disk space outside our control.
//
// Current policy: cache is filled on demand only.
//   - First play of any file:  sendCachedAudio() copies that single file
//     from Drive into ~/.bt-cache/ as a side effect of serving.
//   - Gig Mode:                explicit per-song precache calls run when
//     the user enters Gig Mode (already implemented; touches only the
//     active gig's files, not the whole library).
//   - Loops added to sequence: precache-on-add hits /api/precache/loop/.
//
// Re-enable by setting SIMPLE_STEM_PRECACHE_ALL=1 in the environment — it's
// here for the original full-library precache use case but off by default.
if (process.env.SIMPLE_STEM_PRECACHE_ALL === '1') {
  console.log('[boot] SIMPLE_STEM_PRECACHE_ALL=1 — enabling library-wide precache passes');
  setImmediate(precacheAllM4as);
  setInterval(precacheAllM4as, 60 * 60 * 1000);
} else {
  console.log('[boot] precacheAllM4as DISABLED (default). Cache fills on demand.');
}

// Walk every STEMS/<song>/ folder and pull each .m4a stem onto local disk so
// stem playback never waits on Drive during a gig. Mirrors precacheAllM4as
// but for the per-stem files. WAV stems are skipped — we only need the
// playback-ready m4a copies for the portal. A .cached sentinel is written
// per folder so the UI can mark rows ready and Gig Mode can hide uncached
// rows accurately.
// Module-level state for the flash-cache UI button. Exposed via
// /api/cache/status so the client can poll progress. Reset on each
// fresh run (boot, hourly tick, or button press).
let cacheJobState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  copied: 0,
  skipped: 0,
  failed: 0,
  trigger: null,    // 'boot' | 'hourly' | 'manual' | 'manual-force'
  forceMode: false, // when true, overwrite cached files (bytes don't change but mtime refreshes)
};

async function precacheAllStemsM4a(opts) {
  const force = !!(opts && opts.force);
  const trigger = (opts && opts.trigger) || 'auto';
  if (cacheJobState.running) {
    console.log(`[stem precache] already running — ignoring ${trigger} request`);
    return cacheJobState;
  }
  if (!fs.existsSync(STEMS_DIR)) return cacheJobState;
  cacheJobState = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0, done: 0, copied: 0, skipped: 0, failed: 0,
    trigger, forceMode: force,
  };
  const t0 = Date.now();
  try {
    const songFolders = (await fsp.readdir(STEMS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
    cacheJobState.total = songFolders.length;
    console.log(`[stem precache] starting (${trigger}${force ? ', FORCE' : ''}) — ${songFolders.length} song folders (4 in parallel)`);
    await runWithConcurrency(songFolders, 4, async (song) => {
      try {
        const src = path.join(STEMS_DIR, song);
        const dst = path.join(AUDIO_CACHE_STEMS, song);
        await fsp.mkdir(dst, { recursive: true });
        const files = (await fsp.readdir(src)).filter(f => /\.m4a$/i.test(f));
        let localCopied = 0;
        for (const f of files) {
          const cachePath = path.join(dst, f);
          if (!force && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
            cacheJobState.skipped++;
            continue;
          }
          try {
            await ensureCachedAsync(path.join(src, f), cachePath, { force });
            cacheJobState.copied++;
            localCopied++;
          } catch (e) { cacheJobState.failed++; }
        }
        try {
          await fsp.writeFile(
            path.join(dst, '.cached'),
            JSON.stringify({ at: new Date().toISOString(), files: localCopied })
          );
        } catch (e) {}
        cacheJobState.done++;
        if (cacheJobState.done % 25 === 0) {
          console.log(`[stem precache] progress: ${cacheJobState.done}/${cacheJobState.total} folders`);
        }
      } catch (e) { cacheJobState.failed++; }
    });
    console.log(`[stem precache] done — ${cacheJobState.done} folders, copied ${cacheJobState.copied}, skipped ${cacheJobState.skipped}, failed ${cacheJobState.failed} (${Math.round((Date.now()-t0)/1000)}s)`);
  } catch (e) {
    console.warn('[stem precache] failed:', e.message);
  } finally {
    cacheJobState.running = false;
    cacheJobState.finishedAt = new Date().toISOString();
  }
  return cacheJobState;
}

// Manual Flash Cache trigger — the operator-facing "make sure every song
// is offline-ready" button. Idempotent; returns immediately with the
// current state. Client polls /api/cache/status to track progress.
// Memory: "all songs' m4a stems must be in the cache always" (CLAUDE.md).
app.post('/api/cache/flash', (req, res) => {
  const force = !!(req.body && req.body.force);
  if (cacheJobState.running) {
    return res.json({ ok: true, alreadyRunning: true, state: cacheJobState });
  }
  // Fire and don't await — endpoint returns immediately, work happens in
  // background. Client polls /status. Flash fires the stems pass (the
  // big one) plus drum patterns and custom loops so a "prep for gig"
  // click warms EVERYTHING that's on the audio request path.
  setImmediate(() => precacheAllStemsM4a({
    force,
    trigger: force ? 'manual-force' : 'manual',
  }));
  setImmediate(precacheAllDrumPatterns);
  setImmediate(precacheAllCustomLoops);
  res.json({ ok: true, started: true, force });
});
app.get('/api/cache/status', (req, res) => {
  res.json({ ok: true, state: cacheJobState });
});

// =====================================================================
// OPERATIONS DASHBOARD
// /dashboard renders a live workflow diagram with blocks colored by the
// state returned here. Polled every 3-5s by the client. Bounded with
// per-section timeouts so any one stalled probe (Drive in particular)
// can't wedge the whole response.
// =====================================================================
async function probeDashboardState() {
  const t0 = Date.now();
  const state = {
    when: new Date().toISOString(),
    root: SIMPLE_STEM_ROOT,
    drive: { accessible: false, latencyMs: null, error: null },
    folders: {},
    catalog: { exists: false, shape: null, songCount: null, scannedAt: null, ageSec: null },
    cache: { totalSongs: null, cached: null, uncached: null, jobState: cacheJobState },
    daemons: {},
    xr18: null,
    queue: { incoming: 0, queued: 0, processing: null, failedWeblocs: 0, failedRenders: 0 },
  };

  // Drive accessibility — bounded with a 1.5s timeout so a hung Drive
  // can't block the entire dashboard refresh.
  try {
    const driveT0 = Date.now();
    const st = await Promise.race([
      fsp.stat(SIMPLE_STEM_ROOT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    state.drive.accessible = !!(st && st.isDirectory());
    state.drive.latencyMs = Date.now() - driveT0;
  } catch (e) {
    state.drive.accessible = false;
    state.drive.error = (e && e.message) || String(e);
  }

  // Folder counts. Each wrapped so one missing folder doesn't sink the others.
  const safeCount = (dir, filterFn) => {
    try {
      if (!fs.existsSync(dir)) return null;
      const entries = fs.readdirSync(dir);
      const filtered = filterFn ? entries.filter(filterFn) : entries;
      let mtime = null;
      try { mtime = fs.statSync(dir).mtime.toISOString(); } catch (e) {}
      return { count: filtered.length, mtime };
    } catch (e) { return { count: 0, error: e.message }; }
  };
  state.folders.INCOMING_WEBLOC = safeCount(INCOMING_DIR, f => f.endsWith('.webloc'));
  state.folders.STEM_QUEUE      = safeCount(QUEUE_DIR, f => f.endsWith('.json') || (!f.startsWith('.') && !['_done','_failed'].includes(f)));
  state.folders.STEMS           = safeCount(STEMS_DIR);
  state.folders.GIGS            = safeCount(GIGS_DIR, f => f.endsWith('.json'));
  state.folders.SETLISTS        = safeCount(SETLISTS_DIR, f => f.endsWith('.json'));
  state.folders.CUSTOM_LOOPS    = safeCount(CUSTOM_LOOPS_DIR, f => f.endsWith('.m4a'));

  // Catalog: shape + age + count.
  try {
    const catPath = path.join(SIMPLE_STEM_ROOT, 'CATALOG.json');
    if (fs.existsSync(catPath)) {
      state.catalog.exists = true;
      const st = fs.statSync(catPath);
      state.catalog.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
      const j = JSON.parse(fs.readFileSync(catPath, 'utf8'));
      if (j.data && Array.isArray(j.data.songs)) {
        state.catalog.shape = 'canonical';
        state.catalog.songCount = j.data.songs.length;
        state.catalog.scannedAt = j.scannedAt || null;
      } else if (Array.isArray(j.songs)) {
        state.catalog.shape = 'legacy';
        state.catalog.songCount = j.songs.length;
        state.catalog.scannedAt = j.generated_at || null;
      } else {
        state.catalog.shape = 'unknown';
      }
    }
  } catch (e) { state.catalog.error = e.message; }

  // Cache contract.
  try {
    const libStats = libraryCache && libraryCache.data && libraryCache.data.stats;
    if (libStats) {
      state.cache.totalSongs = libStats.totalSongs || 0;
      state.cache.cached = (typeof libStats.cachedSongs === 'number') ? libStats.cachedSongs : null;
      state.cache.uncached = (typeof libStats.uncachedSongs === 'number') ? libStats.uncachedSongs : null;
    }
  } catch (e) {}

  // Queue state — same data as /api/queue but inlined here so the
  // dashboard doesn't need a second round-trip.
  try {
    if (fs.existsSync(INCOMING_DIR)) {
      const entries = fs.readdirSync(INCOMING_DIR);
      state.queue.incoming = entries.filter(f => f.endsWith('.webloc')).length;
      state.queue.failedWeblocs = entries.filter(f => f.endsWith('.failed')).length;
    }
    if (fs.existsSync(QUEUE_DIR)) {
      const entries = fs.readdirSync(QUEUE_DIR).filter(f => !f.startsWith('.') && !['_done','_failed'].includes(f));
      state.queue.queued = entries.length;
      const failedDir = path.join(QUEUE_DIR, '_failed');
      if (fs.existsSync(failedDir)) {
        state.queue.failedRenders = fs.readdirSync(failedDir).filter(f => f.endsWith('.json')).length;
      }
      const cur = path.join(QUEUE_DIR, '.current');
      if (fs.existsSync(cur)) {
        try { state.queue.processing = JSON.parse(fs.readFileSync(cur, 'utf8')); }
        catch (e) { state.queue.processing = { song: fs.readFileSync(cur, 'utf8').trim() }; }
      }
    }
  } catch (e) {}

  // Daemons — read PID files from BOTH machines' .run/ directories so the
  // dashboard reflects whichever side we're polling from. PID alive check
  // is `process.kill(pid, 0)` which throws if dead. Names match the
  // service identifiers in performer.sh + librarian.sh.
  const dotRun = path.join(SIMPLE_STEM_ROOT, '.run');
  const codeDotRun = path.join(__dirname, '..', '.run');
  const PID_NAMES = ['perf-runner', 'perf-server', 'perf-midi', 'lib-watcher',
                     'lib-cataloger', 'lib-catalogwatch', 'lib-mpbsync'];
  for (const name of PID_NAMES) {
    const pidPath1 = path.join(dotRun, `${name}.pid`);
    const pidPath2 = path.join(codeDotRun, `${name}.pid`);
    const pidPath = fs.existsSync(pidPath1) ? pidPath1 :
                    fs.existsSync(pidPath2) ? pidPath2 : null;
    if (!pidPath) {
      state.daemons[name] = { running: false, pid: null, reason: 'no pid file' };
      continue;
    }
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) {}
      state.daemons[name] = { running: alive, pid, pidPath };
    } catch (e) {
      state.daemons[name] = { running: false, pid: null, reason: e.message };
    }
  }

  // XR18 — reuse the cached probe written by /api/audio/xr18-status. The
  // dashboard polling cadence (3-5s) is slower than the XR18 cache TTL
  // (1.5s) so we should usually have fresh data without re-probing. If
  // the cache is cold we still skip the inline probe — the dashboard
  // will see xr18.unknown:true for one poll, then fresh data after the
  // client also polls the XR18 endpoint.
  state.xr18 = _xr18Cache || { unknown: true };

  state.totalProbeMs = Date.now() - t0;
  return state;
}

app.get('/api/dashboard/state', async (req, res) => {
  try {
    const state = await probeDashboardState();
    res.json({ ok: true, state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Static page lives at /dashboard.html in public/. Provide /dashboard as
// a convenience alias.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// =====================================================================
// LIBRARIAN DASHBOARD — separate from the Performer-flavored /dashboard.
// Bill: "I want the Librarian UI to be distinct from the simpleStem UI —
// it shows the librarian activities with minimal overlap with Performer."
// Focused on: ingest pipeline, catalog health + drift, MPB Sheet sync,
// recent renders, Librarian-side daemons. No XR18, no mixer, no cache
// contract (those are Performer concerns).
// =====================================================================
async function probeLibrarianState() {
  const t0 = Date.now();
  const state = {
    when: new Date().toISOString(),
    root: SIMPLE_STEM_ROOT,
    drive: { accessible: false, latencyMs: null, error: null },
    ingest: {
      incoming:    [],   // list of .webloc filenames awaiting watcher
      failed:      [],   // .failed files (yt-dlp couldn't process)
      processing:  null, // current STEM_QUEUE/.current payload
      queued:      [],   // pending render jobs
      failedRenders: 0,  // STEM_QUEUE/_failed/*.json count
      recentDone:  [],   // last 10 successful render jobs
    },
    catalog: {
      exists: false, shape: null, songCount: null,
      scannedAt: null, ageSec: null, drift: null,
    },
    mpbSync: {
      reportExists: false, ageSec: null,
      unmatched: 0, recentChanges: 0, runs: null,
    },
    recentRenders: [],   // last 10 STEMS/<dir>/ by mtime
    librarianDaemons: {},
    libraryStats: { songs: null, artistCount: null, withLyrics: null, missingMetadata: null },
  };

  // Drive access (timed).
  try {
    const driveT0 = Date.now();
    const st = await Promise.race([
      fsp.stat(SIMPLE_STEM_ROOT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    state.drive.accessible = !!(st && st.isDirectory());
    state.drive.latencyMs = Date.now() - driveT0;
  } catch (e) {
    state.drive.accessible = false;
    state.drive.error = (e && e.message) || String(e);
  }

  // Ingest pipeline state.
  try {
    if (fs.existsSync(INCOMING_DIR)) {
      const entries = fs.readdirSync(INCOMING_DIR);
      state.ingest.incoming = entries.filter(f => f.endsWith('.webloc')).sort();
      state.ingest.failed   = entries.filter(f => f.endsWith('.failed')).sort();
    }
    if (fs.existsSync(QUEUE_DIR)) {
      const entries = fs.readdirSync(QUEUE_DIR).filter(f => !f.startsWith('.') && !['_done','_failed'].includes(f));
      state.ingest.queued = entries.sort();
      const cur = path.join(QUEUE_DIR, '.current');
      if (fs.existsSync(cur)) {
        try { state.ingest.processing = JSON.parse(fs.readFileSync(cur, 'utf8')); }
        catch (e) { state.ingest.processing = { song: fs.readFileSync(cur, 'utf8').trim() }; }
      }
      const failedDir = path.join(QUEUE_DIR, '_failed');
      if (fs.existsSync(failedDir)) {
        state.ingest.failedRenders = fs.readdirSync(failedDir).filter(f => f.endsWith('.json')).length;
      }
      const doneDir = path.join(QUEUE_DIR, '_done');
      if (fs.existsSync(doneDir)) {
        const done = fs.readdirSync(doneDir).filter(f => f.endsWith('.json'))
          .map(f => ({ name: f, mtime: (() => { try { return fs.statSync(path.join(doneDir, f)).mtime.toISOString(); } catch (e) { return null; } })() }))
          .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''))
          .slice(0, 10);
        state.ingest.recentDone = done;
      }
    }
  } catch (e) { state.ingest.error = e.message; }

  // Catalog: shape, count, age, drift report if present.
  try {
    const catPath = path.join(SIMPLE_STEM_ROOT, 'CATALOG.json');
    if (fs.existsSync(catPath)) {
      state.catalog.exists = true;
      const st = fs.statSync(catPath);
      state.catalog.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
      const j = JSON.parse(fs.readFileSync(catPath, 'utf8'));
      if (j.data && Array.isArray(j.data.songs)) {
        state.catalog.shape = 'canonical';
        state.catalog.songCount = j.data.songs.length;
        state.catalog.scannedAt = j.scannedAt || null;
        const songsWithMeta = j.data.songs.filter(s => s.title && s.artist);
        state.libraryStats.songs = j.data.songs.length;
        state.libraryStats.artistCount = new Set(j.data.songs.map(s => s.artist).filter(Boolean)).size;
        state.libraryStats.withLyrics = j.data.songs.filter(s => s.lyrics && String(s.lyrics).trim()).length;
        state.libraryStats.missingMetadata = j.data.songs.length - songsWithMeta.length;
      } else if (Array.isArray(j.songs)) {
        state.catalog.shape = 'legacy';
        state.catalog.songCount = j.songs.length;
        state.catalog.scannedAt = j.generated_at || null;
      } else {
        state.catalog.shape = 'unknown';
      }
    }
  } catch (e) { state.catalog.error = e.message; }

  // MPB Sync report — written by mpb_sync.py to LOGS/mpb_sync_report.json.
  try {
    const reportPath = path.join(SIMPLE_STEM_ROOT, 'LOGS', 'mpb_sync_report.json');
    if (fs.existsSync(reportPath)) {
      state.mpbSync.reportExists = true;
      const st = fs.statSync(reportPath);
      state.mpbSync.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
      try {
        const j = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        state.mpbSync.unmatched = Array.isArray(j.unmatched) ? j.unmatched.length :
                                  (typeof j.unmatched === 'number' ? j.unmatched : 0);
        state.mpbSync.recentChanges = Array.isArray(j.changed) ? j.changed.length :
                                      (typeof j.changed === 'number' ? j.changed : 0);
        state.mpbSync.runs = j.runs || null;
      } catch (e) { state.mpbSync.parseError = e.message; }
    }
  } catch (e) {}

  // Recent renders — newest STEMS/ subfolders by mtime.
  try {
    if (fs.existsSync(STEMS_DIR)) {
      const entries = fs.readdirSync(STEMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          try {
            const st = fs.statSync(path.join(STEMS_DIR, d.name));
            return { name: d.name, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
          } catch (e) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 10);
      state.recentRenders = entries.map(({ name, mtime }) => ({ name, mtime }));
    }
  } catch (e) {}

  // Newest artifact per pipeline stage — powers the Living Pipeline's
  // per-folder "now processing" caption + flight labels on /librarian.
  // ADDITIVE field: nothing pre-existing reads it. All probes here are
  // ASYNC fs with a bounded Promise.race timeout (same rule as the SSE
  // reconciler below — these dirs sit on Drive, and one sync readdir/stat
  // would wedge the event loop when Drive stalls). On a timeout the stage
  // reports null for this poll and the next poll heals.
  state.pipelineNewest = { incoming: null, queued: null, stems: null, drums: null, clips: null };
  const newestInDir = async (dir, match, wantDir) => {
    const entries = await Promise.race([
      fsp.readdir(dir, { withFileTypes: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    const names = entries
      .filter(d => (wantDir ? d.isDirectory() : d.isFile()))
      .map(d => d.name)
      .filter(match);
    if (!names.length) return null;
    const stats = await Promise.race([
      Promise.all(names.map(async n => {
        try { const st = await fsp.stat(path.join(dir, n)); return { name: n, mtimeMs: st.mtimeMs }; }
        catch (e) { return null; }
      })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    const best = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return best ? { name: best.name, ageSec: Math.round((Date.now() - best.mtimeMs) / 1000) } : null;
  };
  try {
    const newestStages = [
      ['incoming', INCOMING_DIR,     f => f.endsWith('.webloc'),                      false],
      ['queued',   QUEUE_DIR,        f => f.endsWith('.json') && !f.startsWith('.'),  false],
      ['drums',    DRUM_MACHINE_DIR, f => /\.m4a$/i.test(f),                          false],
      ['clips',    CUSTOM_LOOPS_DIR, f => /\.m4a$/i.test(f),                          false],
    ];
    await Promise.all(newestStages.map(async ([key, dir, match, wantDir]) => {
      try { state.pipelineNewest[key] = await newestInDir(dir, match, wantDir); } catch (e) {}
    }));
    // STEMS is a few hundred song dirs — re-statting them all here would be
    // wasteful when the recentRenders block above already found the newest
    // one. Reuse its answer.
    if (state.recentRenders && state.recentRenders.length) {
      const newest = state.recentRenders[0];
      state.pipelineNewest.stems = {
        name: newest.name,
        ageSec: Math.round((Date.now() - new Date(newest.mtime).getTime()) / 1000),
      };
    }
  } catch (e) {}

  // Librarian-only daemons. AUTHORITATIVE SOURCE (2026-07-04): the mini's
  // heartbeat service writes $DATA/.run-status/librarian.json every ~20s
  // with pid + alive per service. That file is on Drive, so BOTH machines'
  // dashboards show truth with real PIDs — the old local-pid-file check
  // read "stopped · no pid file" whenever the dashboard wasn't served by
  // the same machine that runs the daemons. Local pid files remain as a
  // fallback when the heartbeat file is missing or stale (>90s).
  const LIB_DAEMONS = ['lib-watcher', 'lib-cataloger', 'lib-catalogwatch', 'lib-mpbsync', 'lib-portal', 'lib-autoupdate', 'lib-heartbeat'];
  let hb = null;
  try {
    const raw = await Promise.race([
      fsp.readFile(path.join(SIMPLE_STEM_ROOT, '.run-status', 'librarian.json'), 'utf8'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    hb = JSON.parse(raw);
  } catch (e) { /* no heartbeat file yet — fall back below */ }
  const hbAgeSec = hb && hb.epoch ? Math.round(Date.now() / 1000 - hb.epoch) : null;
  const hbFresh = hbAgeSec !== null && hbAgeSec < 90;

  const dotRun = path.join(SIMPLE_STEM_ROOT, '.run');
  const codeDotRun = path.join(__dirname, '..', '.run');
  for (const name of LIB_DAEMONS) {
    if (hb && hb.services && hb.services[name] !== undefined) {
      const svc = hb.services[name] || {};
      state.librarianDaemons[name] = {
        running: hbFresh && !!svc.alive,
        pid: svc.pid || null,
        host: hb.hostname || null,
        heartbeatAgeSec: hbAgeSec,
        source: 'heartbeat',
        reason: hbFresh ? undefined : `heartbeat stale (${hbAgeSec}s)`,
      };
      continue;
    }
    // Fallback: local pid files (only truthful on the machine that runs them).
    const pidPath1 = path.join(dotRun, `${name}.pid`);
    const pidPath2 = path.join(codeDotRun, `${name}.pid`);
    const pidPath = fs.existsSync(pidPath1) ? pidPath1 :
                    fs.existsSync(pidPath2) ? pidPath2 : null;
    if (!pidPath) {
      state.librarianDaemons[name] = { running: false, pid: null, reason: 'no pid file / no heartbeat' };
      continue;
    }
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) {}
      state.librarianDaemons[name] = { running: alive, pid, pidPath, source: 'local-pid' };
    } catch (e) {
      state.librarianDaemons[name] = { running: false, pid: null, reason: e.message };
    }
  }

  state.totalProbeMs = Date.now() - t0;
  return state;
}
app.get('/api/librarian/state', async (req, res) => {
  try {
    const state = await probeLibrarianState();
    res.json({ ok: true, state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/librarian', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'librarian.html'));
});

// ---------- LIVING LIBRARIAN — SSE FEED + AUX ENDPOINTS ------------------
// The /librarian page renders as a "living document": folders open/close
// based on contents, files animate moving between folders, health checks
// tick visibly. Backed by:
//   * GET /api/librarian/events  — Server-Sent Events; emits 'file-added',
//     'file-removed', 'snapshot' (every 5s), 'health' (drive probe every
//     60s), 'phase' (when STEM_QUEUE/.current changes).
//   * GET /api/librarian/stems-health — per-song stem completeness (6/6,
//     5/6, missing[]) so the Library view can flag incomplete renders.
//   * POST /api/librarian/enqueue-url — Librarian-side URL drop, writes a
//     .webloc into INCOMING_WEBLOC just like dragging a Chrome tab.
//
// fs.watch on Drive paths is known-flaky under heavy sync, so we ALSO
// send a full snapshot every 5s as a reconciliation safety net. Missed
// events get healed on the next snapshot tick.

const LIB_WATCH_FOLDERS = [
  { key: 'incoming',  dir: INCOMING_DIR,                                  match: f => f.endsWith('.webloc') },
  { key: 'queued',    dir: QUEUE_DIR,                                     match: f => f.endsWith('.json') && !f.startsWith('.') },
  { key: 'done',      dir: path.join(QUEUE_DIR, '_done'),                 match: f => f.endsWith('.json') },
  { key: 'failed',    dir: path.join(QUEUE_DIR, '_failed'),               match: f => f.endsWith('.json') },
  { key: 'stems',     dir: STEMS_DIR,                                     match: f => !f.startsWith('.'), isDir: true },
  { key: 'drums',     dir: DRUM_MACHINE_DIR,                              match: f => /\.m4a$/i.test(f) },
  { key: 'clips',     dir: CUSTOM_LOOPS_DIR,                              match: f => /\.m4a$/i.test(f) },
];

// SSE subscriber list. Each entry is the Express res object.
const librarianClients = new Set();
function librarianBroadcast(eventName, payload) {
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of librarianClients) {
    try { res.write(line); } catch (e) { /* socket closed; cleanup on next write */ }
  }
}

// Per-folder snapshot of filenames. fs.watch tells us SOMETHING changed
// but not what — we diff the new readdir against this snapshot to detect
// add/remove events.
//
// IMPORTANT — all folder probes use ASYNC fs (fsp.readdir) with a 1.5s
// Promise.race timeout, NEVER synchronous fs. These folders sit on Drive
// and a sync readdirSync wedges Node's event loop when Drive is slow,
// which freezes EVERY request including stems audio. This is the same
// rule documented in CLAUDE.md "no synchronous Drive reads in any hot
// endpoint" — reconcile counts as hot because it runs every 5s and on
// every fs.watch event. (Self-inflicted bug 2026-06-29 — caught before
// it reached a gig but the cost would have been silent dropouts.)
const librarianFolderSnapshot = {};
async function snapshotFolder(folder) {
  if (!folder || !folder.dir) return [];
  try {
    const entries = await Promise.race([
      fsp.readdir(folder.dir, { withFileTypes: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    return entries
      .filter(d => folder.isDir ? d.isDirectory() : d.isFile())
      .map(d => d.name)
      .filter(folder.match);
  } catch (e) {
    // ENOENT (folder missing) AND drive-stall both fall through to
    // "treat as empty for this tick". The next reconcile heals if the
    // folder reappears.
    return [];
  }
}

// Reconciliation tick. Reads every watched folder IN PARALLEL with a
// per-folder 1.5s budget, then diffs against the saved snapshot and
// emits add/remove events. A slow Drive on one folder can't block the
// others (parallel) and can't wedge the server (bounded timeout).
let _reconcileInFlight = false;
async function reconcileLibrarianFolders() {
  if (_reconcileInFlight) return;     // skip overlapping ticks
  _reconcileInFlight = true;
  try {
    const results = await Promise.all(LIB_WATCH_FOLDERS.map(folder =>
      snapshotFolder(folder).then(cur => ({ folder, cur }))
    ));
    for (const { folder, cur } of results) {
      const prev = librarianFolderSnapshot[folder.key] || [];
      const prevSet = new Set(prev);
      const curSet  = new Set(cur);
      for (const name of cur)  if (!prevSet.has(name)) librarianBroadcast('file-added',   { folder: folder.key, name, at: Date.now() });
      for (const name of prev) if (!curSet.has(name))  librarianBroadcast('file-removed', { folder: folder.key, name, at: Date.now() });
      librarianFolderSnapshot[folder.key] = cur;
    }
    // Also push a snapshot event so newly-connected SSE clients see
    // the full table without waiting for individual deltas.
    librarianBroadcast('snapshot', { folders: librarianFolderSnapshot, at: Date.now() });
  } catch (e) {
    /* per-folder timeouts already caught inside snapshotFolder; this
       is just a safety net for Promise.all weirdness. */
  } finally {
    _reconcileInFlight = false;
  }
}

// Seed snapshots ASYNCHRONOUSLY so boot is never blocked by Drive.
// Fire-and-forget; clients connecting before this finishes get an
// empty snapshot followed by per-folder updates as data arrives.
setImmediate(() => { reconcileLibrarianFolders().catch(() => {}); });

// ---- Stems-artifact reconciler --------------------------------------
// Emits 'artifact-created' when a source.wav or a stem *.m4a appears
// inside a STEMS/<song>/ folder. This is what powers the Librarian's
// "wav flow" (blue) and "m4a flow" (green) visualizations — the two
// key creation events in the pipeline:
//   • source.wav → webloc_watch just finished the YouTube download.
//   • *.m4a      → queue_runner just finished a Demucs+ffmpeg encode.
// Snapshot per song is a Set of artifact filenames; deltas broadcast.
const STEMS_ARTIFACT_NAMES = new Set([
  'source.wav', 'vocals.m4a', 'drums.m4a', 'bass.m4a',
  'guitar.m4a', 'piano.m4a',  'other.m4a', 'metadata.json',
]);
const stemsArtifactSnapshot = {};   // song → Set(artifact names present)
let _stemsArtifactSeeded = false;
let _artifactReconcileInFlight = false;
async function reconcileStemsArtifacts() {
  if (_artifactReconcileInFlight) return;
  _artifactReconcileInFlight = true;
  try {
    let songDirs;
    try {
      songDirs = await Promise.race([
        fsp.readdir(STEMS_DIR, { withFileTypes: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 2000)),
      ]);
    } catch (e) { return; }
    for (const d of songDirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const song = d.name;
      const songDir = path.join(STEMS_DIR, song);
      let files;
      try {
        files = await Promise.race([
          fsp.readdir(songDir),
          new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1200)),
        ]);
      } catch (e) { continue; }
      const cur = new Set();
      for (const f of files) if (STEMS_ARTIFACT_NAMES.has(f)) cur.add(f);
      const prev = stemsArtifactSnapshot[song] || new Set();
      // Only broadcast deltas AFTER the first seed pass — otherwise the
      // whole library floods the SSE channel on server boot.
      if (_stemsArtifactSeeded) {
        for (const name of cur) {
          if (!prev.has(name)) {
            const kind = name === 'source.wav'    ? 'source.wav'
                       : name === 'metadata.json' ? 'metadata.json'
                       : 'stem.m4a';
            librarianBroadcast('artifact-created', {
              kind, song, file: name, at: Date.now(),
            });
          }
        }
      }
      stemsArtifactSnapshot[song] = cur;
    }
    _stemsArtifactSeeded = true;
  } finally {
    _artifactReconcileInFlight = false;
  }
}
setImmediate(() => { reconcileStemsArtifacts().catch(() => {}); });
setInterval(() => { reconcileStemsArtifacts().catch(() => {}); }, 8000);

// fs.watch on each folder; debounce a quick reconcile after any event
// (Drive sync can fire many events for one logical change). fs.watch
// itself is async (callback-based) — only the readdir inside reconcile
// could have been the offender, and that's async now too.
let _libReconcileTimer = null;
function scheduleReconcile(delay = 250) {
  if (_libReconcileTimer) return;
  _libReconcileTimer = setTimeout(() => {
    _libReconcileTimer = null;
    reconcileLibrarianFolders().catch(() => {});
  }, delay);
}
for (const folder of LIB_WATCH_FOLDERS) {
  try {
    // mkdirSync is OK here — runs once at boot for missing folders,
    // typically a local path (Drive folders already exist).
    try { fs.mkdirSync(folder.dir, { recursive: true }); } catch (e) {}
    fs.watch(folder.dir, { persistent: false }, () => scheduleReconcile());
  } catch (e) {
    console.warn(`[librarian-watch] could not watch ${folder.dir}:`, e.message);
  }
}

// Background ticks:
//   * Reconcile every 5s as a safety net for missed fs.watch events on Drive.
//   * Drive health probe every 60s — emits a 'health' event the page uses
//     to tick a visible checkmark animation. Bill: "show a check mark
//     once a minute as it is being checked."
//   * Phase poll every 2s for STEM_QUEUE/.current (the active render).
setInterval(() => { reconcileLibrarianFolders().catch(() => {}); }, 5000);
let _lastQueuePhase = '';
let _phasePollInFlight = false;
setInterval(async () => {
  if (_phasePollInFlight) return;
  _phasePollInFlight = true;
  try {
    const cur = path.join(QUEUE_DIR, '.current');
    // Bounded async read — STEM_QUEUE sits on Drive. NEVER sync here.
    let raw = null;
    try {
      raw = await Promise.race([
        fsp.readFile(cur, 'utf8'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
      ]);
    } catch (e) { /* ENOENT or stall — treat as no current job */ }
    let payload = null;
    if (raw != null) {
      try { payload = JSON.parse(raw); } catch (e) { payload = { song: String(raw).trim() }; }
    }
    const key = payload ? JSON.stringify(payload) : '';
    if (key !== _lastQueuePhase) {
      _lastQueuePhase = key;
      librarianBroadcast('phase', { current: payload, at: Date.now() });
    }
  } catch (e) {}
  finally { _phasePollInFlight = false; }
}, 2000);

// =====================================================================
// SCHEDULED-TASK TRACKER — every time-driven background job registers
// itself here so the Librarian's living document can show countdown
// timers ("next drum precache in 47:12") and animate runs as they fire.
// The /api/librarian/timers endpoint returns the full table; SSE
// broadcasts 'task-fired' on each completion + 'timer-tick' once a
// second so countdowns animate smoothly client-side.
// =====================================================================
const scheduledTasks = {};
function registerTrackedInterval(name, intervalMs, fn, opts) {
  opts = opts || {};
  scheduledTasks[name] = {
    name,
    label: opts.label || name,
    folder: opts.folder || null,    // pipeline folder this task affects (for badge placement)
    intervalMs,
    lastRunAt: null,
    lastRunOk: null,
    lastRunMs: null,
    runCount: 0,
    nextRunAt: Date.now() + intervalMs,
    running: false,
  };
  const tick = async () => {
    const t = scheduledTasks[name];
    if (!t || t.running) return;
    t.running = true;
    const t0 = Date.now();
    let ok = true;
    try { await fn(); }
    catch (e) { ok = false; }
    const ms = Date.now() - t0;
    t.lastRunAt = Date.now();
    t.lastRunOk = ok;
    t.lastRunMs = ms;
    t.runCount += 1;
    t.nextRunAt = Date.now() + intervalMs;
    t.running = false;
    librarianBroadcast('task-fired', { name, ok, durationMs: ms, at: t.lastRunAt, nextRunAt: t.nextRunAt });
  };
  setInterval(tick, intervalMs);
  // Fire once shortly after boot so the countdown starts from a real
  // baseline instead of "never run yet".
  setTimeout(tick, (opts.initialDelayMs == null ? 1000 : opts.initialDelayMs));
}

// Drive health probe — bounded 1.5s stat, every 60s. Broadcasts both a
// 'health' event (the checkmark) and 'task-fired' via the tracker.
registerTrackedInterval('drive-health', 60 * 1000, async () => {
  const t0 = Date.now();
  let ok = false, latencyMs = null, error = null;
  try {
    const st = await Promise.race([
      fsp.stat(SIMPLE_STEM_ROOT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
    ]);
    ok = !!(st && st.isDirectory());
    latencyMs = Date.now() - t0;
  } catch (e) { error = (e && e.message) || String(e); }
  librarianBroadcast('health', { check: 'drive', ok, latencyMs, error, at: Date.now() });
  if (!ok) throw new Error(error || 'drive-stall');
}, { label: 'Drive availability', folder: null, initialDelayMs: 800 });

// 1Hz tick broadcaster so client countdowns animate. Light payload —
// only the current Date.now() — clients use their cached task table
// (refreshed via /api/librarian/timers) to draw bars + mm:ss labels.
setInterval(() => {
  librarianBroadcast('timer-tick', { now: Date.now() });
}, 1000);

app.get('/api/librarian/timers', (req, res) => {
  res.json({ ok: true, now: Date.now(), tasks: scheduledTasks });
});

app.get('/api/librarian/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders && res.flushHeaders();
  // Initial snapshot so the page can render full state without waiting
  // for the next reconciliation tick.
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    folders: librarianFolderSnapshot,
    at: Date.now(),
  })}\n\n`);
  librarianClients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch (e) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    librarianClients.delete(res);
  });
});

// Per-song stem health. Walks STEMS/<base>/ counting which of the six
// expected stem files exist and are non-empty. Returns rows shaped:
//   { base, title, artist, bpm, key, stemsPresent, stemsTotal: 6,
//     missing: ['piano.m4a', ...], sizeBytes }
// The Library view in /librarian renders this list with a Stems Health
// column so Bill can spot incomplete renders.
const EXPECTED_STEMS = ['vocals.m4a','drums.m4a','bass.m4a','guitar.m4a','piano.m4a','other.m4a'];
// Cached stems-health snapshot. Refreshed in the background by
// recomputeStemsHealth() — never on the request hot path. ~350 songs
// × 7 stat calls = ~2500 Drive ops; doing that synchronously inside
// the request handler would wedge the event loop for several seconds
// when Drive is slow and break every concurrent stems audio fetch.
let _stemsHealthCache = { rows: [], computedAt: 0 };
let _stemsHealthInFlight = false;

async function recomputeStemsHealth() {
  if (_stemsHealthInFlight) return;
  _stemsHealthInFlight = true;
  const t0 = Date.now();
  const rows = [];
  try {
    let dirents;
    try {
      dirents = await Promise.race([
        fsp.readdir(STEMS_DIR, { withFileTypes: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 3000)),
      ]);
    } catch (e) { _stemsHealthInFlight = false; return; }
    const dirs = dirents.filter(d => d.isDirectory() && !d.name.startsWith('.'));
    // Walk songs in parallel batches so one slow folder doesn't gate
    // the whole list. 8-way concurrency is gentle on Drive.
    const queue = dirs.slice();
    async function worker() {
      while (queue.length) {
        const d = queue.shift();
        if (!d) break;
        const dir = path.join(STEMS_DIR, d.name);
        let present = 0;
        const missing = [];
        let totalSize = 0;
        await Promise.all(EXPECTED_STEMS.map(async s => {
          try {
            const st = await Promise.race([
              fsp.stat(path.join(dir, s)),
              new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
            ]);
            if (st.isFile() && st.size > 1024) { present++; totalSize += st.size; }
            else missing.push(s);
          } catch (e) { missing.push(s); }
        }));
        let title = '', artist = '', bpm = null, key = '', singer = '';
        try {
          const raw = await Promise.race([
            fsp.readFile(path.join(dir, 'metadata.json'), 'utf8'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('drive-stall')), 1500)),
          ]);
          const meta = JSON.parse(raw);
          title  = meta.title  || '';
          artist = meta.artist || '';
          bpm    = meta.bpm    || null;
          key    = meta.key    || '';
          singer = meta.singer_lead || '';
        } catch (e) {}
        rows.push({
          base: d.name, title, artist, bpm, key, singer,
          stemsPresent: present, stemsTotal: EXPECTED_STEMS.length,
          missing, sizeBytes: totalSize,
        });
      }
    }
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    rows.sort((a, b) => (a.title || a.base).localeCompare(b.title || b.base));
    _stemsHealthCache = { rows, computedAt: Date.now(), durationMs: Date.now() - t0 };
    console.log(`[stems-health] recomputed ${rows.length} rows in ${_stemsHealthCache.durationMs}ms`);
  } catch (e) {
    console.warn('[stems-health] recompute failed:', e.message);
  } finally {
    _stemsHealthInFlight = false;
  }
}
// Compute at boot (delayed so audio precaches go first), then every
// 5 minutes. The Library view refreshes from the cache every 30s
// client-side; the cache itself refreshes every 5 min server-side.
setTimeout(() => { recomputeStemsHealth().catch(() => {}); }, 8000);
setInterval(() => { recomputeStemsHealth().catch(() => {}); }, 5 * 60 * 1000);

app.get('/api/librarian/stems-health', (req, res) => {
  // Cache-first read — never touches Drive on the request path. If
  // ?force=1 the operator can trigger a background recompute.
  if (req.query.force === '1') {
    setImmediate(() => { recomputeStemsHealth().catch(() => {}); });
  }
  res.json({
    ok: true,
    rows: _stemsHealthCache.rows,
    computedAt: _stemsHealthCache.computedAt,
    stale: Date.now() - _stemsHealthCache.computedAt > 10 * 60 * 1000,
  });
});

// Librarian-side URL drop. Writes a .webloc file into INCOMING_WEBLOC,
// which the watcher picks up the same as a Chrome drop.
app.post('/api/librarian/enqueue-url', express.json(), (req, res) => {
  const url = (req.body && req.body.url || '').toString().trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'url must start with http(s)://' });
  }
  try { fs.mkdirSync(INCOMING_DIR, { recursive: true }); } catch (e) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `librarian_${stamp}.webloc`;
  const file = path.join(INCOMING_DIR, name);
  // Minimal .webloc (Apple binary plist would be nicer; the watcher's
  // parser accepts a simple text fallback containing the URL).
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>${url.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</string></dict></plist>
`;
  try {
    fs.writeFileSync(file, body, 'utf8');
    res.json({ ok: true, file: name, queuedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Full-library stem precache is the DEFAULT now. The portal pulls every
// m4a stem in STEMS/ into ~/.bt-cache/STEMS/ at boot and then again every
// hour. Result: any song plays instantly with no Drive fetch. Total
// footprint ~3 GB for ~180 songs (well under the 50 GB cache cap).
//
// The boot pass is async — it doesn't block the HTTP server; the server
// starts answering requests immediately and the cache fills in the
// background. The hourly tick picks up any newly-added songs and skips
// already-cached files cheaply (mtime+size check).
// Boot run fires immediately; the tracker handles the hourly cadence
// AND records lastRunAt/durationMs for the Librarian countdown badge.
setImmediate(() => precacheAllStemsM4a({ trigger: 'boot' }));
registerTrackedInterval('stem-precache', 60 * 60 * 1000,
  () => precacheAllStemsM4a({ trigger: 'hourly' }),
  { label: 'Stem precache', folder: 'stems', initialDelayMs: 60 * 60 * 1000 });

// Walk every CUSTOM_LOOPS/*.m4a into ~/.bt-cache/CUSTOM_LOOPS/ so play-clip
// actions fire instantly during a gig with no Drive latency. Clips are
// curated by the Clip Librarian (see clip_librarian/README.md); the App
// just needs them pre-warmed locally.
async function precacheAllCustomLoops() {
  if (!fs.existsSync(CUSTOM_LOOPS_DIR)) return;
  const t0 = Date.now();
  let copied = 0, skipped = 0, failed = 0;
  try {
    const files = (await fsp.readdir(CUSTOM_LOOPS_DIR))
      .filter(f => /\.m4a$/i.test(f) && !f.startsWith('raw_'));
    if (files.length === 0) {
      console.log('[clip precache] nothing in CUSTOM_LOOPS/');
      return;
    }
    console.log(`[clip precache] starting — ${files.length} clip(s)`);
    await runWithConcurrency(files, 4, async (f) => {
      const src = path.join(CUSTOM_LOOPS_DIR, f);
      const dst = path.join(AUDIO_CACHE_CUSTOM_LOOPS, f);
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { skipped++; return; }
      try { await ensureCachedAsync(src, dst); copied++; }
      catch (e) { failed++; }
    });
    console.log(`[clip precache] done — copied ${copied}, skipped ${skipped}, failed ${failed} (${Math.round((Date.now()-t0)/1000)}s)`);
  } catch (e) {
    console.warn('[clip precache] failed:', e.message);
  }
}
setImmediate(precacheAllCustomLoops);
registerTrackedInterval('clip-precache', 60 * 60 * 1000,
  precacheAllCustomLoops,
  { label: 'Clip precache', folder: 'clips', initialDelayMs: 60 * 60 * 1000 });

// Walk every DRUM_MACHINE/*.m4a into ~/.bt-cache/DRUM_MACHINE/ so
// /api/drum-machine/pick + /api/audio/drum-machine/:file fire instantly
// with NO Drive interaction. Same shape as precacheAllCustomLoops above.
// Without this, every song-load would trigger a sync readdir on Drive
// inside listDrumPatterns(), wedging the event loop offline and breaking
// stems for every song. (2026-06-28 gig postmortem.)
async function precacheAllDrumPatterns() {
  if (!fs.existsSync(DRUM_MACHINE_DIR)) return;
  const t0 = Date.now();
  let copied = 0, skipped = 0, failed = 0;
  try {
    const files = (await fsp.readdir(DRUM_MACHINE_DIR))
      .filter(f => /\.m4a$/i.test(f));
    if (files.length === 0) {
      console.log('[drum precache] nothing in DRUM_MACHINE/');
      return;
    }
    console.log(`[drum precache] starting — ${files.length} pattern(s)`);
    await runWithConcurrency(files, 4, async (f) => {
      const src = path.join(DRUM_MACHINE_DIR, f);
      const dst = path.join(AUDIO_CACHE_DRUM, f);
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { skipped++; return; }
      try { await ensureCachedAsync(src, dst); copied++; }
      catch (e) { failed++; }
    });
    refreshDrumPatternListFromCache();
    console.log(`[drum precache] done — copied ${copied}, skipped ${skipped}, failed ${failed} (${Math.round((Date.now()-t0)/1000)}s, ${drumPatternList.length} cached)`);
  } catch (e) {
    console.warn('[drum precache] failed:', e.message);
  }
}
setImmediate(precacheAllDrumPatterns);
registerTrackedInterval('drum-precache', 60 * 60 * 1000,
  precacheAllDrumPatterns,
  { label: 'Drum precache', folder: 'drums', initialDelayMs: 60 * 60 * 1000 });

// Backing-track precache — same pattern as drum patterns. Copies every
// m4a/mp3 from BACKING_TRACKS/ into ~/.bt-cache/BACKING_TRACKS/ so the
// player can toggle "stems ↔ backing" at a gig with no wifi. On success
// rebuilds the song-base→file assignment map.
async function precacheAllBackingTracks() {
  if (!fs.existsSync(BACKING_TRACKS_DIR)) return;
  const t0 = Date.now();
  let copied = 0, skipped = 0, failed = 0;
  try {
    const files = (await fsp.readdir(BACKING_TRACKS_DIR))
      .filter(f => /\.(m4a|mp3)$/i.test(f));
    if (files.length === 0) {
      console.log('[backing precache] nothing in BACKING_TRACKS/');
      refreshBackingTrackListFromCache();
      rebuildBackingTrackAssignments();
      return;
    }
    console.log(`[backing precache] starting — ${files.length} track(s)`);
    await runWithConcurrency(files, 4, async (f) => {
      const src = path.join(BACKING_TRACKS_DIR, f);
      const dst = path.join(AUDIO_CACHE_BACKING, f);
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { skipped++; return; }
      try { await ensureCachedAsync(src, dst); copied++; }
      catch (e) { failed++; }
    });
    refreshBackingTrackListFromCache();
    rebuildBackingTrackAssignments();
    console.log(`[backing precache] done — copied ${copied}, skipped ${skipped}, failed ${failed} (${Math.round((Date.now()-t0)/1000)}s, ${backingTrackList.length} cached, ${Object.keys(backingTrackAssignments).length} matched)`);
  } catch (e) {
    console.warn('[backing precache] failed:', e.message);
  }
}
setImmediate(precacheAllBackingTracks);
registerTrackedInterval('backing-precache', 60 * 60 * 1000,
  precacheAllBackingTracks,
  { label: 'Backing precache', folder: 'clips', initialDelayMs: 60 * 60 * 1000 });

// Manual trigger — POST /api/precache/library forces all four passes immediately
// (useful after a big import or when prepping for a gig). Returns 202 fast;
// the work runs in the background and progress is in the server log.
app.post('/api/precache/library', (req, res) => {
  res.status(202).json({ status: 'started', m4a: 'background', stems: 'background', clips: 'background', drums: 'background', backing: 'background' });
  setImmediate(precacheAllM4as);
  setImmediate(precacheAllStemsM4a);
  setImmediate(precacheAllCustomLoops);
  setImmediate(precacheAllDrumPatterns);
  setImmediate(precacheAllBackingTracks);
});
// Clip-only trigger documented in clip_librarian/README.md.
app.post('/api/precache/custom-loops', (req, res) => {
  res.status(202).json({ status: 'started' });
  setImmediate(precacheAllCustomLoops);
});

// Background pre-fetch — kicks off cache fill for every file in a stems
// folder without blocking the request. Writes a `.cached` sentinel on
// success so the library can advertise the folder as ready-to-play.
app.post('/api/precache/stems/:song', (req, res) => {
  const { song } = req.params;
  if (song.includes('..')) return res.status(403).send('Forbidden');
  const folder = path.join(STEMS_DIR, song);
  if (!fs.existsSync(folder)) return res.status(404).send('Not found');

  // Respond immediately; the actual copying runs async so other HTTP
  // requests (in particular the user's M4A audio fetch) interleave with it.
  res.json({ status: 'precaching', song, alreadyCached: isStemsFolderCached(song) });
  if (isStemsFolderCached(song)) return;

  (async () => {
    const t0 = Date.now();
    try {
      let copied = 0;
      // Cache only m4a stems. WAVs stream directly per the audio endpoint
      // policy — caching them would balloon ~/.bt-cache by 6x.
      const files = (await fsp.readdir(folder)).filter(f => /\.m4a$/i.test(f));
      for (const f of files) {
        // Awaiting each copy yields to other handlers between files. For
        // even more concurrency we could Promise.all, but serial keeps
        // disk + network pressure predictable on Google Drive.
        await ensureCachedAsync(path.join(folder, f), path.join(AUDIO_CACHE_STEMS, song, f));
        copied++;
      }
      await fsp.writeFile(
        path.join(AUDIO_CACHE_STEMS, song, '.cached'),
        JSON.stringify({ at: new Date().toISOString(), files: copied })
      );
      console.log(`[precache] ${song} done (${copied} files, ${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      console.warn('[precache] failed for', song, '-', e.message);
    }
  })();
});

// Precache a whole SetList: pull every song's m4a + stems into the local cache
// in the background, so loading a setlist before a gig makes its songs instant.
// Honors the LRU cap afterward. Body/param: setlist slug.
app.post('/api/precache/setlist/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const file = path.join(SETLISTS_DIR, `${slug}.json`);
  if (!file.startsWith(SETLISTS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'setlist not found' });
  }
  let sl;
  try { sl = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const bases = (sl.songs || []).map(s => s.song_base).filter(Boolean);
  res.json({ status: 'precaching', setlist: slug, songs: bases.length });

  (async () => {
    for (const base of bases) {
      // Cache only m4a stems — WAVs and mixdowns stream directly per the
      // audio endpoint policy. Mixdowns are an offline backup that lives on
      // Drive (EZPerformer reads them there); the portal uses stems.
      const folder = path.join(STEMS_DIR, base);
      try {
        if (fs.existsSync(folder)) {
          for (const f of (await fsp.readdir(folder)).filter(f => /\.m4a$/i.test(f))) {
            await ensureCachedAsync(path.join(folder, f), path.join(AUDIO_CACHE_STEMS, base, f));
          }
        }
      } catch (e) {}
    }
    pruneCache();
    console.log(`[precache setlist] ${slug} done (${bases.length} songs, m4a stems only)`);
  })();
});

// Lightweight endpoint: returns which stems folders and m4a files are cached.
// Used by the frontend to refresh chips without re-scanning the full library.
app.get('/api/cache-status', (req, res) => {
  try {
    const stems = {};
    if (fs.existsSync(AUDIO_CACHE_STEMS)) {
      for (const d of fs.readdirSync(AUDIO_CACHE_STEMS)) {
        if (isStemsFolderCached(d)) stems[d] = true;
      }
    }
    const m4a = {};
    if (fs.existsSync(AUDIO_CACHE_M4A)) {
      for (const f of fs.readdirSync(AUDIO_CACHE_M4A)) {
        if (f.toLowerCase().endsWith('.m4a') && isM4aCached(f)) m4a[f] = true;
      }
    }
    // Back-compat shape: `cached` still holds stems; new field `m4a` holds m4a files.
    res.json({ cached: stems, m4a });
  } catch (e) {
    res.json({ cached: {}, m4a: {}, error: e.message });
  }
});

// ── Queue: submit a YouTube URL → drop a .webloc into INCOMING_WEBLOC ──────
// webloc_watch.sh turns it into metadata jobs in STEM_QUEUE; queue_runner.sh
// renders each into STEMS/ + M4A/. This endpoint only creates the .webloc.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
app.post('/api/enqueue', (req, res) => {
  const url = ((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url)) {
    return res.status(400).json({ error: 'Please paste a YouTube video or playlist URL.' });
  }
  try {
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const m = url.match(/[?&]v=([\w-]+)/) || url.match(/youtu\.be\/([\w-]+)/) || url.match(/[?&]list=([\w-]+)/);
    const tag = m ? m[1].slice(0, 20) : 'link';
    const file = path.join(INCOMING_DIR, `portal_${stamp}_${tag}.webloc`);
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>' + xmlEscape(url) + '</string>\n</dict>\n</plist>\n';
    fs.writeFileSync(file, plist);
    res.json({ ok: true, queued: path.basename(file) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Failed-renders triage ──────────────────────────────────────────────────
// Bill's Q2: clear current failures now; new failures get a UI page with
// a table (timestamp, details, retry/clear per row + retry-all / clear-all
// at the top). The page lives at /failed-renders.html; this endpoint is
// the JSON behind it.
app.get('/api/failed-renders', async (req, res) => {
  const items = [];
  const failedDir = path.join(QUEUE_DIR, '_failed');
  try {
    const entries = await fsp.readdir(failedDir).catch(() => []);
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(failedDir, f);
      let mtime = null;
      let body = null;
      try {
        const st = await fsp.stat(p);
        mtime = st.mtime.toISOString();
      } catch (e) {}
      try {
        const raw = await fsp.readFile(p, 'utf8');
        body = JSON.parse(raw);
      } catch (e) {
        body = { _parseError: (e && e.message) || String(e) };
      }
      items.push({ file: f, mtime, body });
    }
    items.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  } catch (e) {}
  res.json({ ok: true, count: items.length, items });
});
// Retry one — moves the JSON back to STEM_QUEUE/ so the runner picks it up.
app.post('/api/failed-renders/retry/:file', (req, res) => {
  const f = req.params.file;
  if (!f || f.includes('..') || !f.endsWith('.json')) return res.status(400).json({ ok: false, error: 'bad name' });
  const src = path.join(QUEUE_DIR, '_failed', f);
  const dst = path.join(QUEUE_DIR, f);
  try {
    fs.renameSync(src, dst);
    res.json({ ok: true, file: f });
  } catch (e) {
    // ENOENT = the failed job was already cleared by another tab/admin;
    // return 404 so the UI can resync instead of showing "Failed: ENOENT"
    if (e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'not found' });
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Clear one.
app.delete('/api/failed-renders/:file', (req, res) => {
  const f = req.params.file;
  if (!f || f.includes('..') || !f.endsWith('.json')) return res.status(400).json({ ok: false, error: 'bad name' });
  const p = path.join(QUEUE_DIR, '_failed', f);
  try {
    fs.unlinkSync(p);
    res.json({ ok: true, file: f });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ ok: false, error: 'not found' });
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Bulk: retry all, clear all.
app.post('/api/failed-renders/retry-all', (req, res) => {
  const dir = path.join(QUEUE_DIR, '_failed');
  let moved = 0, failed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { fs.renameSync(path.join(dir, f), path.join(QUEUE_DIR, f)); moved++; }
      catch (e) { failed++; }
    }
  } catch (e) {}
  res.json({ ok: true, moved, failed });
});
app.delete('/api/failed-renders', (req, res) => {
  const dir = path.join(QUEUE_DIR, '_failed');
  let deleted = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (e) {}
    }
  } catch (e) {}
  res.json({ ok: true, deleted });
});

// ── Queue status for the portal (derived from the filesystem) ──────────────
// Shows the three stages: dropped .webloc (awaiting metadata) → STEM_QUEUE
// jobs (awaiting render) → the one currently rendering (.current marker).
app.get('/api/queue', (req, res) => {
  const countJson = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length; } catch (e) { return 0; } };
  const out = { incoming: [], failed: [], queued: [], processing: null };
  try {
    if (fs.existsSync(INCOMING_DIR)) {
      for (const f of fs.readdirSync(INCOMING_DIR)) {
        if (f.endsWith('.webloc')) out.incoming.push(f);
        else if (f.endsWith('.failed')) out.failed.push(f);
      }
    }
    if (fs.existsSync(QUEUE_DIR)) {
      for (const entry of fs.readdirSync(QUEUE_DIR)) {
        // Skip the housekeeping subfolders. `_done` is render-success
        // archive; `_failed` is render-failure archive — neither belongs
        // in the queued list. Pre-fix the `_failed/` subfolder was being
        // rendered as if it were a queued setlist named `_failed (N)`
        // which terrified the operator.
        if (entry.startsWith('.') || entry === '_done' || entry === '_failed') continue;
        const p = path.join(QUEUE_DIR, entry);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.queued.push({ name: entry, type: 'setlist', songs: countJson(p) });
        else if (entry.endsWith('.json')) out.queued.push({ name: entry, type: 'single', songs: 1 });
      }
      // Surface the failed-renders count as a separate field so the
      // client can show it with proper "what is this" framing instead
      // of pretending it's a queued setlist.
      try {
        const failedDir = path.join(QUEUE_DIR, '_failed');
        if (fs.existsSync(failedDir)) {
          out.failedRenders = countJson(failedDir);
        } else {
          out.failedRenders = 0;
        }
      } catch (e) { out.failedRenders = 0; }
      const cur = path.join(QUEUE_DIR, '.current');
      if (fs.existsSync(cur)) {
        try { out.processing = JSON.parse(fs.readFileSync(cur, 'utf8')); }
        catch (e) { out.processing = { song: fs.readFileSync(cur, 'utf8').trim() }; }
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// SETLISTS — persistent ordered song collections maintained by the
// Librarian (setlist_sync.py). Two kinds, distinguished by `origin`:
//   "playlist" — synced from a YouTube playlist (sync owns the file)
//   "manual"   — curated here in the portal (sync never touches it)
// Each setlist file is SETLISTS/<slug>.json. registry.json is internal
// (playlist URLs) and is not served as a setlist.
// =====================================================================

// Reads come from the LOCAL MIRROR so Drive being offline never breaks
// the request path. Writes still go to Drive (the canonical store) AND
// are also dropped into the mirror so the next read sees them without
// waiting for the 60s poll. If the mirror is empty (first boot before
// any sync), fall back to Drive read just for that one request.
function bestSetlistsDir() {
  try {
    if (fs.existsSync(SETLISTS_LOCAL_MIRROR) &&
        fs.readdirSync(SETLISTS_LOCAL_MIRROR).some(f => f.endsWith('.json'))) {
      return SETLISTS_LOCAL_MIRROR;
    }
  } catch (e) {}
  return SETLISTS_DIR;
}
function bestGigsDir() {
  try {
    if (fs.existsSync(GIGS_LOCAL_MIRROR) &&
        fs.readdirSync(GIGS_LOCAL_MIRROR).some(f => f.endsWith('.json'))) {
      return GIGS_LOCAL_MIRROR;
    }
  } catch (e) {}
  return GIGS_DIR;
}
// Helper used by write paths to keep the mirror in lockstep with Drive.
function writeBothJson(driveDir, mirrorDir, filename, jsonStr) {
  try { fs.mkdirSync(driveDir,  { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(mirrorDir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(path.join(driveDir,  filename), jsonStr);
  try { fs.writeFileSync(path.join(mirrorDir, filename), jsonStr); } catch (e) {}
}
function unlinkBoth(driveDir, mirrorDir, filename) {
  try { fs.unlinkSync(path.join(driveDir,  filename)); } catch (e) {}
  try { fs.unlinkSync(path.join(mirrorDir, filename)); } catch (e) {}
}

// List all setlists (summaries only — title, origin, count, synced_at).
app.get('/api/setlists', (req, res) => {
  try {
    const dir = bestSetlistsDir();
    if (!fs.existsSync(dir)) return res.json({ setlists: [] });
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'registry.json') continue;
      try {
        const d = readJsonCached(path.join(dir, f));
        if (!d) continue;
        // Cache-ready count: how many of this setlist's songs have a fully
        // cached stems folder on local disk. Drives the 'ready/total' badge
        // in the saved-setlists panel so the user can see at a glance which
        // setlists are gig-safe (no Drive fetches needed).
        const songBases = Array.isArray(d.songs) ? d.songs.map(s => s.song_base).filter(Boolean) : [];
        let cachedCount = 0;
        for (const b of songBases) {
          if (isStemsFolderCached(b)) cachedCount++;
        }
        out.push({
          slug: f.replace(/\.json$/i, ''),
          title: d.title || f.replace(/\.json$/i, ''),
          origin: d.origin || 'manual',
          count: Array.isArray(d.songs) ? d.songs.length : (d.count || 0),
          cached_count: cachedCount,
          synced_at: d.synced_at || d.created_at || null,
          source_url: d.source_url || null,
        });
      } catch (e) { /* skip unreadable */ }
    }
    out.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ setlists: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full setlist by slug (the ordered songs).
app.get('/api/setlists/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  if (slug === 'registry') return res.status(404).json({ error: 'not a setlist' });
  const dir = bestSetlistsDir();
  const file = path.join(dir, `${slug}.json`);
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'setlist not found' });
  }
  const d = readJsonCached(file);
  if (!d) return res.status(500).json({ error: 'parse failed' });
  res.json(d);
});

// Delete a MANUAL setlist. Refuses to delete a playlist-origin one — those are
// owned by setlist_sync.py and would just re-sync on next pass.
app.delete('/api/setlists/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  if (slug === 'registry') return res.status(400).json({ error: 'not a setlist' });
  const file = path.join(SETLISTS_DIR, `${slug}.json`);
  if (!file.startsWith(SETLISTS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'setlist not found' });
  }
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.origin === 'playlist') {
      return res.status(409).json({ error: 'that setlist is playlist-synced; delete its source playlist instead' });
    }
    // Delete from BOTH Drive and the local mirror so the next GET
    // doesn't resurrect the file via fallback.
    unlinkBoth(SETLISTS_DIR, SETLISTS_LOCAL_MIRROR, `${slug}.json`);
    invalidateCachedFile(file);
    res.json({ ok: true, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save a MANUAL setlist (create or replace). Body: { title, songs:[song_base...] }.
// Refuses to overwrite a playlist-origin file — those belong to setlist_sync.py.
app.post('/api/setlists', (req, res) => {
  const { title, songs } = req.body || {};
  if (!title || !Array.isArray(songs)) {
    return res.status(400).json({ error: 'need { title, songs: [...] }' });
  }
  const slug = String(title).replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!slug) return res.status(400).json({ error: 'title produced an empty slug' });
  const file = path.join(SETLISTS_DIR, `${slug}.json`);
  if (!file.startsWith(SETLISTS_DIR)) return res.status(400).json({ error: 'bad slug' });
  try {
    // Existing-check reads from the mirror first.
    const mirrorFile = path.join(SETLISTS_LOCAL_MIRROR, `${slug}.json`);
    const checkFile = fs.existsSync(mirrorFile) ? mirrorFile : file;
    if (fs.existsSync(checkFile)) {
      const existing = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
      if (existing.origin === 'playlist') {
        return res.status(409).json({ error: 'that name is a playlist-synced setlist; pick another' });
      }
    }
    const payload = {
      origin: 'manual',
      title,
      created_at: new Date().toISOString(),
      count: songs.length,
      songs: songs.map((sb, i) => ({ position: i + 1, song_base: sb })),
    };
    const jsonStr = JSON.stringify(payload, null, 2) + '\n';
    writeBothJson(SETLISTS_DIR, SETLISTS_LOCAL_MIRROR, `${slug}.json`, jsonStr);
    invalidateCachedFile(file);
    res.json({ ok: true, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI setlist builder (file + KBM bridge to claude.ai chat) ──────────────
// We do NOT call Anthropic's API directly. Bill already has a Claude.ai
// subscription and prefers driving the browser to spend that quota
// instead of paying per-call for API tokens. The flow:
//
//   1. POST /api/setlist/ai-generate  -- write prompt.txt + library.json
//      under SIMPLE_STEM_ROOT/AI_SETLIST/<job_id>/, kick off the bash
//      bridge script that triggers a Keyboard Maestro macro, and return
//      { job_id } immediately so the browser can poll.
//   2. The KBM macro reads prompt.txt, pastes it into a Claude.ai chat
//      tab in Chrome, waits for the reply, copies it back into
//      response.txt under the same job folder. (Macro lives on the
//      operator's mac; Bill builds it from the contract documented in
//      AI_SETLIST/README.md alongside this codebase.)
//   3. GET /api/setlist/ai-generate/poll/:job_id  -- when response.txt
//      appears, parse the JSON out of it, cross-check song_base values
//      against the library, return the setlist + rationale.
//
// 5-minute soft timeout. The browser polls every 4 s and shows elapsed
// seconds + 'still waiting…' so the operator can see progress.

const AI_SETLIST_DIR = path.join(SIMPLE_STEM_ROOT, 'AI_SETLIST');
try { if (!fs.existsSync(AI_SETLIST_DIR)) fs.mkdirSync(AI_SETLIST_DIR, { recursive: true }); } catch (e) {}

// Shared system prompt + library packaging used by both the API path
// (kept around as a fallback) and the file+KBM bridge.
function aiSetlistBuildPrompt(description, corpus) {
  const SYS = `You are a setlist planner for a working cover band called the Mitchell Park Band. The band's working singers are Bill, Matt, Dan, and JD; other songs may be marked "All" for group vocals or "(unassigned)" if no lead has been chosen yet.

You will receive:
1. The band's full available library as a JSON array. Each song has: song_base (the canonical identifier you MUST return), title, artist, singer_lead, key, bpm, duration_sec, drum_pattern.
2. A free-form description of an upcoming gig with timing, mood, and constraints.

Build a timed, ordered setlist drawing songs ONLY from the supplied library. Respect the user's constraints (time of day, energy arc, genre, singer rotation rules, specific song requests, finishing songs). Compute each song's start time as the gig start time plus the cumulative duration of preceding songs plus ~20 seconds of changeover.

What we care about is the FLOW — the sequence as a single aesthetic object. We do NOT want a per-song justification; we want one substantive rationale that explains the arc.`;

  const SCHEMA = `Return ONLY valid JSON, no prose outside the JSON. Use exactly this schema:

{
  "flow_rationale": "4 to 8 sentences explaining the SHAPE of the setlist as a sequence: how the energy arc moves over time, how keys flow between consecutive songs, how the singer rotation is paced, and what overall aesthetic you went for (e.g. 'classic-rock-that-pulls-you-in-then-keeps-you-dancing'). Call out any constraint you couldn't fully meet and why.",
  "setlist": [
    {
      "time": "6:30 PM",
      "song_base": "exact song_base from the library",
      "title": "exact title from the library",
      "artist": "exact artist from the library",
      "singer": "singer_lead from the library",
      "key": "key from the library",
      "bpm": 124,
      "duration_min": 4
    }
  ]
}

Hard rules:
- song_base MUST appear verbatim in the library JSON. Do not invent songs.
- If the user says "no more than N <singer> songs in a row", enforce that.
- If the user names a specific song that is not in the library, omit it and call it out in flow_rationale.
- Do NOT add per-song "reason" fields. The flow_rationale covers the whole sequence.`;

  const user =
    `Band library (JSON array, ${corpus.length} songs):\n` +
    '```json\n' + JSON.stringify(corpus) + '\n```\n\n' +
    `Gig description from the band leader:\n${description}\n\n` +
    SCHEMA +
    `\n\nReply with the JSON object only — no preamble, no postscript.`;

  return { system: SYS, user };
}

function aiSetlistCollectCorpus() {
  const songs = (libraryCache && libraryCache.data && libraryCache.data.songs) || [];
  return songs
    .filter(s => s.type === 'stems')
    .map(s => ({
      song_base:    s.folderName,
      title:        s.title,
      artist:       s.artist,
      singer_lead:  s.singer_lead || '(unassigned)',
      key:          s.key || '?',
      bpm:          s.practiceBpm || null,
      duration_sec: s.duration || null,
      drum_pattern: s.drum_pattern || null,
    }));
}

// Canonical list of supported chatbots. The IDs are used in URLs, file
// paths, and localStorage keys -- they MUST stay lowercase, ASCII, and
// stable. Display names are operator-facing.
const AI_SETLIST_BOTS = [
  { id: 'claude',     name: 'Claude',     url: 'https://claude.ai/new' },
  { id: 'chatgpt',    name: 'ChatGPT',    url: 'https://chatgpt.com/' },
  { id: 'gemini',     name: 'Gemini',     url: 'https://gemini.google.com/' },
  { id: 'deepseek',   name: 'DeepSeek',   url: 'https://chat.deepseek.com/' },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/' },
  { id: 'grok',       name: 'Grok 3',     url: 'https://grok.com/' },
];
const AI_SETLIST_BOT_IDS = new Set(AI_SETLIST_BOTS.map(b => b.id));

// Helper: parse a raw chatbot reply (may be wrapped in prose) into the
// expected { flow_rationale, setlist } shape. Cross-checks song_base
// values against the live library and drops hallucinations. Returns
// { ok: true, setlist, rationale, total_minutes, dropped_unknown_count }
// or { ok: false, error, raw }.
function aiSetlistParseReply(raw, corpus) {
  const trimmed = String(raw || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(trimmed); }
  catch (e) {
    const first = trimmed.indexOf('{');
    const last  = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { parsed = JSON.parse(trimmed.slice(first, last + 1)); } catch (e2) {}
    }
  }
  if (!parsed || !Array.isArray(parsed.setlist)) {
    return { ok: false, error: 'no JSON setlist found in reply', raw: trimmed.slice(0, 800) };
  }
  const known = new Set(corpus.map(c => c.song_base));
  const cleaned = parsed.setlist.filter(s => s && typeof s.song_base === 'string' && known.has(s.song_base));
  const dropped = parsed.setlist.length - cleaned.length;
  const totalMin = cleaned.reduce((acc, s) => acc + (Number(s.duration_min) || 0), 0);
  return {
    ok: true,
    setlist: cleaned,
    rationale: parsed.flow_rationale || parsed.rationale || '',
    total_minutes: Math.round(totalMin),
    dropped_unknown_count: dropped,
  };
}

app.post('/api/setlist/ai-generate', (req, res) => {
  const description = (req.body && req.body.description || '').toString().trim();
  if (!description) return res.status(400).json({ error: 'need { description }' });
  if (description.length > 6000) return res.status(400).json({ error: 'description too long (cap 6000 chars)' });
  // Bot list: client sends an array of chosen bot ids. Default to all.
  let bots = Array.isArray(req.body && req.body.bots) ? req.body.bots : null;
  if (!bots || !bots.length) bots = AI_SETLIST_BOTS.map(b => b.id);
  bots = bots.filter(b => AI_SETLIST_BOT_IDS.has(b));
  if (!bots.length) return res.status(400).json({ error: 'no valid bots selected' });

  const corpus = aiSetlistCollectCorpus();
  if (corpus.length === 0) return res.status(503).json({ error: 'library is empty; nothing to plan against' });

  const jobId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 6);
  const jobDir = path.join(AI_SETLIST_DIR, jobId);
  try { fs.mkdirSync(jobDir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: 'mkdir failed: ' + e.message }); }

  const { system, user } = aiSetlistBuildPrompt(description, corpus);
  // One prompt file shared across all bots, since every bot gets the
  // same question. The KBM macro (or the operator copy-pasting by hand)
  // reads prompt.txt and pastes the contents into each selected bot.
  const fullPrompt = `${system}\n\n---\n\n${user}\n`;
  try {
    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), fullPrompt);
    fs.writeFileSync(path.join(jobDir, 'library.json'), JSON.stringify(corpus, null, 2));
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({
      job_id: jobId,
      created_at: new Date().toISOString(),
      description,
      library_size: corpus.length,
      bots,
      status: 'pending',
    }, null, 2));
    // Per-bot subdirs. The KBM macro writes <bot>/response.txt as each
    // bot completes; the poll endpoint reads from these.
    for (const b of bots) {
      const dir = path.join(jobDir, b);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  } catch (e) {
    return res.status(500).json({ error: 'write failed: ' + e.message });
  }

  // Kick off the bridge (detached, fire-and-forget). The bridge script
  // gets the job_dir and the comma-separated bot list as its args. The
  // KBM macro can read meta.json directly OR use those args.
  const bridgeScript = path.join(__dirname, '..', 'bin', 'ai_setlist_kbm.sh');
  const fallbackScript = path.join(__dirname, '..', 'ai_setlist_kbm.sh');
  const scriptPath = fs.existsSync(bridgeScript) ? bridgeScript : fallbackScript;
  if (fs.existsSync(scriptPath)) {
    const { spawn } = require('child_process');
    try {
      const child = spawn('bash', [scriptPath, jobDir, bots.join(',')], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`[ai-setlist] spawned ${path.basename(scriptPath)} for job ${jobId} (bots: ${bots.join(', ')})`);
    } catch (e) {
      console.warn('[ai-setlist] bridge spawn failed:', e.message);
    }
  } else {
    console.warn(`[ai-setlist] bridge script not found at ${scriptPath} -- per-bot responses must be pasted manually`);
  }

  res.json({
    ok: true,
    job_id: jobId,
    job_dir: jobDir,
    bots,
    library_size: corpus.length,
    poll_url: `/api/setlist/ai-generate/poll/${jobId}`,
  });
});

// Poll endpoint: returns per-bot status. Each bot is one of:
//   pending — no <bot>/response.txt yet
//   ready   — response parsed cleanly, includes setlist + rationale
//   error   — response present but unparseable; includes raw text
// The overall job is "ready" once at least one bot has produced a
// parseable reply (the operator can still wait for more).
app.get('/api/setlist/ai-generate/poll/:job_id', (req, res) => {
  const jobId = String(req.params.job_id).replace(/[^A-Za-z0-9_]/g, '');
  if (!jobId) return res.status(400).json({ error: 'bad job_id' });
  const jobDir = path.join(AI_SETLIST_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'unknown job_id' });
  const metaFile = path.join(jobDir, 'meta.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) {}
  const createdAt = meta.created_at ? Date.parse(meta.created_at) : Date.now();
  const elapsedSec = Math.round((Date.now() - createdAt) / 1000);
  const botIds = Array.isArray(meta.bots) ? meta.bots : AI_SETLIST_BOTS.map(b => b.id);

  const corpus = aiSetlistCollectCorpus();
  const bots = {};
  let anyReady = false;
  let allDone  = true;

  for (const id of botIds) {
    const botDir = path.join(jobDir, id);
    const responseFile = path.join(botDir, 'response.txt');
    if (!fs.existsSync(responseFile)) {
      bots[id] = { status: 'pending' };
      allDone = false;
      continue;
    }
    let raw = '';
    try { raw = fs.readFileSync(responseFile, 'utf8'); }
    catch (e) { bots[id] = { status: 'error', error: 'read failed: ' + e.message }; continue; }
    const parsed = aiSetlistParseReply(raw, corpus);
    if (!parsed.ok) {
      bots[id] = { status: 'error', error: parsed.error, raw: parsed.raw };
      continue;
    }
    bots[id] = {
      status: 'ready',
      setlist: parsed.setlist,
      rationale: parsed.rationale,
      total_minutes: parsed.total_minutes,
      dropped_unknown_count: parsed.dropped_unknown_count,
    };
    anyReady = true;
  }

  res.json({
    job_id: jobId,
    elapsed_sec: elapsedSec,
    overall: anyReady ? (allDone ? 'ready' : 'partial') : 'pending',
    bots,
    library_size: corpus.length,
  });
});

// Manual paste endpoint: the operator runs a chatbot themselves
// (because they don't have a KBM macro for it, or the macro failed)
// and pastes the reply into the per-bot card in the portal. This
// writes the text to <jobDir>/<bot>/response.txt so the next poll
// picks it up alongside any other bot replies.
app.post('/api/setlist/ai-generate/paste/:job_id/:bot', (req, res) => {
  const jobId = String(req.params.job_id).replace(/[^A-Za-z0-9_]/g, '');
  const bot   = String(req.params.bot).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!jobId || !AI_SETLIST_BOT_IDS.has(bot)) return res.status(400).json({ error: 'bad job_id or bot' });
  const jobDir = path.join(AI_SETLIST_DIR, jobId);
  const botDir = path.join(jobDir, bot);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'unknown job_id' });
  const text = (req.body && req.body.text || '').toString();
  if (!text.trim()) return res.status(400).json({ error: 'need { text }' });
  try {
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'response.txt'), text);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Expose the supported bot list to the client so the checkboxes stay
// in sync with the server's allow-list without hard-coding it on both
// sides.
app.get('/api/setlist/ai-bots', (req, res) => {
  res.json({ bots: AI_SETLIST_BOTS });
});

// Version status: what the running process booted with, what's on disk now, and
// whether they differ (→ an update is staged and a restart will pick it up).
app.get('/api/version', (req, res) => {
  const disk = readDiskVersion();
  res.json({
    running: BOOT_VERSION,
    available: disk,
    updateAvailable: disk !== 'unknown' && disk !== BOOT_VERSION,
  });
});

// Restart-script resolution (bug fix 2026-07-02): /api/restart used to run
// performer.sh from the DATA root (~/ClaudeDrive/simpleStem) — a stale Drive
// copy, NOT the git clone this server was launched from. Result observed in
// regression: the endpoint killed the server and nothing came back up.
// Prefer the performer.sh sitting next to this code (…/bt-construction-kit/..),
// fall back to the data root only if the clone copy is missing.
function resolveRestartScript() {
  const codeRoot = path.join(__dirname, '..');
  const candidates = [
    { root: codeRoot, script: path.join(codeRoot, 'performer.sh') },
    { root: SIMPLE_STEM_ROOT_FOR_VERSION(), script: path.join(SIMPLE_STEM_ROOT_FOR_VERSION(), 'performer.sh') },
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c.script)) return c; } catch (e) {}
  }
  return { root: null, script: null };
}

// Apply a staged update: relaunch via performer.sh so the new code runs. The
// restart is spawned DETACHED — it must outlive this very process (which it's
// about to kill + restart). We reply first, then trigger it a moment later.
app.post('/api/update', (req, res) => {
  const { root, script } = resolveRestartScript();
  if (!script) {
    return res.status(500).json({ error: 'performer.sh not found (code clone or data root)' });
  }
  res.json({ ok: true, restarting: true, to: readDiskVersion() });
  // Give the response time to flush, then restart out-of-band.
  setTimeout(() => {
    try {
      const child = spawn('bash', [script, 'restart'], {
        cwd: root, detached: true, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT) },
      });
      child.unref();   // don't let it tie to this dying process
    } catch (e) {
      console.error('[update] restart spawn failed:', e.message);
    }
  }, 300);
});

// Unconditional restart — same dispatch as /api/update but with no version
// guard. The sidebar Restart button posts here when the operator wants to
// recycle the server (e.g. after editing code, or when the portal feels
// stuck). The new process is double-forked so the parent dying mid-script
// won't take it down.
app.post('/api/restart', (req, res) => {
  const { root, script } = resolveRestartScript();
  if (!script) {
    return res.status(500).json({ error: 'performer.sh not found (code clone or data root)' });
  }
  res.json({ ok: true, restarting: true });
  setTimeout(() => {
    try {
      const child = spawn('bash', [script, 'restart'], {
        cwd: root, detached: true, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT) },
      });
      child.unref();
    } catch (e) { console.error('[restart] spawn failed:', e.message); }
  }, 300);
});

// Kick coreaudiod — software equivalent of unplugging the XR18 USB cable.
// macOS launchd respawns the daemon immediately; Core Audio re-binds to the
// XR18's still-running USB endpoint, breaking the stale handshake that
// silently swallows audio when app-switching between Logic and Chrome.
// REQUIRES a one-time passwordless sudoers entry so the server (running as
// the operator's user, not root) can issue the kill without an interactive
// password prompt mid-gig:
//
//   sudo visudo -f /etc/sudoers.d/simplestem-coreaudio
//
// Then add ONE line, replacing wbn with your username:
//
//   wbn ALL=(root) NOPASSWD: /usr/bin/killall coreaudiod
//
// `sudo -n` ("non-interactive") then succeeds; missing entry => exit 1
// with "a password is required" on stderr, which we surface to the UI.
app.post('/api/audio/kick-coreaudio', (req, res) => {
  const { spawn } = require('child_process');
  logDebugEvent('kick-coreaudio-start', {});
  const child = spawn('sudo', ['-n', '/usr/bin/killall', 'coreaudiod']);
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('close', code => {
    if (code === 0) {
      logDebugEvent('kick-coreaudio-ok', {});
      res.json({ ok: true });
    } else {
      const msg = stderr.trim() || `sudo killall coreaudiod exited ${code}`;
      logDebugEvent('kick-coreaudio-fail', { code, stderr: msg });
      res.status(500).json({
        error: msg,
        hint: 'Add a passwordless sudoers entry: see /api/audio/kick-coreaudio source for the one-line config.',
      });
    }
  });
  child.on('error', e => {
    logDebugEvent('kick-coreaudio-spawn-error', { error: e.message });
    res.status(500).json({ error: `spawn failed: ${e.message}` });
  });
});

// Debug snapshot log — append-only JSON-lines file. The client's "Snapshot"
// button POSTs the full audio state here before/after each step in the
// XR18 recovery protocol so Claude can read it later via the Read tool.
// One line per snapshot, no rotation (file is small per session and
// gig-tagged transitions are the interesting parts).
const DEBUG_SNAPSHOT_PATH = path.join(os.homedir(), '.simpleStem-catalog', 'debug-snapshots.log');
app.post('/api/debug/snapshot', (req, res) => {
  try {
    const dir = path.dirname(DEBUG_SNAPSHOT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = { server_when: new Date().toISOString(), ...req.body };
    fs.appendFileSync(DEBUG_SNAPSHOT_PATH, JSON.stringify(payload) + '\n');
    res.json({ ok: true, path: DEBUG_SNAPSHOT_PATH });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper: append a server-side diagnostic event to the same log so the
// client-side snapshots and server-side actions interleave on disk.
function logDebugEvent(label, details) {
  try {
    const dir = path.dirname(DEBUG_SNAPSHOT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = { server_when: new Date().toISOString(), source: 'server', label, ...details };
    fs.appendFileSync(DEBUG_SNAPSHOT_PATH, JSON.stringify(payload) + '\n');
  } catch (e) {}
}

// Spoken sound-check words. macOS `say` renders each label to an .aiff,
// ffmpeg transcodes to .m4a, both cached on disk per-word. First request
// for a given word is ~600 ms (synthesis + transcode); subsequent requests
// stream from cache. Used by the upgraded Sound Check button to play
// "Left", "Right", "Voice", "Drums", "Bass", "Guitar", "Piano", "Other"
// on each of the eight named XR18 outputs so the operator can verify by
// ear that the right stem is on the right channel.
const SC_WORD_CACHE_DIR = path.join(os.homedir(), '.simpleStem-cache', 'soundcheck');
const SC_WORDS = {
  left: 'Left', right: 'Right',
  one: 'One', two: 'Two', three: 'Three',
  four: 'Four', five: 'Five', six: 'Six',
  // Kept for backward-compat with any old cached request:
  voice: 'Voice', drums: 'Drums', bass: 'Bass',
  guitar: 'Guitar', piano: 'Piano', other: 'Other',
  test: 'Test',
};
app.get('/api/audio/soundcheck-word/:word', (req, res) => {
  const word = String(req.params.word || '').toLowerCase();
  const text = SC_WORDS[word];
  if (!text) return res.status(404).send('unknown word');
  const out = path.join(SC_WORD_CACHE_DIR, `${word}.m4a`);
  const serve = () => {
    res.set('Content-Type', 'audio/mp4');
    res.set('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(out).pipe(res);
  };
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return serve();
  try { fs.mkdirSync(SC_WORD_CACHE_DIR, { recursive: true }); } catch (e) {}
  const aiff = path.join(SC_WORD_CACHE_DIR, `${word}.aiff`);
  const { execFile } = require('child_process');
  // `say -r 180` is moderately fast — clear without dragging out the
  // sound check. `-v` left default (system voice) so users hear the
  // voice their Mac already uses.
  execFile('say', ['-r', '180', '-o', aiff, text], (err) => {
    if (err) return res.status(500).send(`say failed: ${err.message}`);
    execFile('ffmpeg', ['-y', '-i', aiff, '-c:a', 'aac', '-b:a', '64k', out], (err2) => {
      try { fs.unlinkSync(aiff); } catch (e) {}
      if (err2) return res.status(500).send(`ffmpeg failed: ${err2.message}`);
      serve();
    });
  });
});

// Set macOS default audio output device by name. Used by the "Preset:
// Stereo" / "Preset: Spread to 6 Stems" buttons so the operator can
// flip the entire rig (Chrome → speakers vs Chrome → XR18) with one
// click instead of trudging through System Settings → Sound. Requires
// the switchaudio-osx Homebrew package:
//
//   brew install switchaudio-osx
//
// If SwitchAudioSource isn't on PATH we return a structured 200 with
// `switched: false` so the client can surface a clean "install this"
// hint without treating it as a hard failure.
app.post('/api/audio/set-output', (req, res) => {
  const { spawn, spawnSync } = require('child_process');
  const name = (req.body && req.body.name && String(req.body.name).trim()) || '';
  if (!name) return res.status(400).json({ ok: false, error: 'name required (e.g. "XR18" or "MacBook Pro Speakers")' });
  // PATH on a GUI-launched Node misses /usr/local/bin and /opt/homebrew/bin
  // by default; check both explicitly. Take the first one that exists.
  const fs = require('fs');
  const candidates = ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'];
  const bin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  if (!bin) {
    return res.json({
      ok: false,
      switched: false,
      error: 'SwitchAudioSource is not installed.',
      hint: 'Install on the Performer with: brew install switchaudio-osx',
    });
  }
  // -s <name> sets the default output device; -t output limits to outputs
  // so a same-named INPUT (rare) can't be picked instead.
  const child = spawn(bin, ['-s', name, '-t', 'output']);
  let stderr = '', stdout = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('close', code => {
    if (code === 0) {
      // Confirm by asking SwitchAudioSource what the current default
      // output is now. Lets the client display the truth instead of
      // assuming the requested device took.
      let current = null;
      try {
        const r = spawnSync(bin, ['-c', '-t', 'output'], { encoding: 'utf8' });
        if (r.status === 0) current = (r.stdout || '').trim();
      } catch (e) {}
      logDebugEvent('set-output-ok', { requested: name, current });
      res.json({ ok: true, switched: true, requested: name, current });
    } else {
      const msg = (stderr || stdout || '').trim() || `SwitchAudioSource exited ${code}`;
      logDebugEvent('set-output-fail', { requested: name, error: msg });
      res.status(500).json({
        ok: false,
        switched: false,
        error: msg,
        hint: msg.match(/could not find an audio device/i)
          ? `No output device named "${name}" was found. Check the spelling (case-sensitive) or list devices on the Performer: SwitchAudioSource -a -t output`
          : undefined,
      });
    }
  });
  child.on('error', e => {
    res.status(500).json({ ok: false, switched: false, error: `spawn failed: ${e.message}` });
  });
});

// XR18 device status — interrogates macOS via system_profiler so we can
// truthfully say "XR18 is connected" on page load, BEFORE the user has
// triggered the Web Audio context with a click. Web Audio can't tell us
// the device channel count until the AudioContext is resumed by a
// gesture; system_profiler can, with no user interaction.
//
// Returns:
//   { ok: true, present, isDefaultOutput, deviceName, channels }
//
// `present` — XR18 hardware visible to macOS.
// `isDefaultOutput` — XR18 is the macOS default output device.
// `channels` — number of output channels the device exposes (18 for XR18).
//
// On non-macOS or system_profiler failure, returns { ok: false, error } and
// the client falls back to the Web Audio probe.
// Two-stage probe. Stage 1 (ioreg) is FAST (~50-100ms) and tells us
// whether the XR18 is on a USB bus — no parsing of nested JSON. Stage 2
// (system_profiler) is SLOW (1-3 sec) and tells us which output device
// macOS has selected by default. We run them in parallel and cache for
// 1.5 sec server-side so multiple clients (or the 2-sec poll on this
// one) don't slam the system.
let _xr18CacheAt = 0;
let _xr18Cache = null;
app.get('/api/audio/xr18-status', (req, res) => {
  if (_xr18Cache && (Date.now() - _xr18CacheAt) < 1500) {
    return res.json({ ..._xr18Cache, cached: true });
  }
  const { execFile } = require('child_process');
  const runIoreg = new Promise(resolve => {
    execFile('/bin/sh', ['-c', 'ioreg -p IOUSB -l 2>/dev/null'], { timeout: 2500 }, (err, stdout) => {
      if (err) return resolve({ ok: false, err: err.message });
      // Look for "USB Product Name" = "XR18" / "BEHRINGER ..." lines.
      const hit = /(XR18|BEHRINGER)/i.test(stdout || '');
      resolve({ ok: true, present: hit });
    });
  });
  const runProfiler = new Promise(resolve => {
    execFile('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 6000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, err: err.message });
      let data;
      try { data = JSON.parse(stdout); }
      catch (e) { return resolve({ ok: false, err: 'unparseable system_profiler output: ' + e.message }); }
      // The structure varies by macOS version; walk every nested _items
      // array and look for the XR18 + the default-output flag wherever
      // they appear.
      let xr18 = null, defaultOutputName = null;
      // macOS reports TWO defaults: the audio-output device (where playback
      // goes) and the system device (alerts/UI sounds). Keys observed on
      // macOS 14/15:
      //   coreaudio_default_audio_output_device = spaudio_yes  <-- this one
      //   coreaudio_default_audio_system_device = spaudio_yes  <-- NOT this
      // We must require BOTH "default" AND "output" in the key — matching on
      // "audio" alone bleeds the system-device flag onto whatever device
      // owns it (often the laptop speakers) and overwrites the real answer.
      const looksLikeYes = (v) => {
        if (v == null) return false;
        if (v === true) return true;
        if (typeof v === 'number' && v) return true;
        const s = String(v).toLowerCase();
        return s === 'spaudio_yes' || s === 'yes' || s === 'true' || s === '1';
      };
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const name = node._name || '';
        if (/xr18|behringer/i.test(name)) xr18 = xr18 || node;
        for (const k of Object.keys(node)) {
          const lk = k.toLowerCase();
          if (lk.includes('default') && lk.includes('output')) {
            if (looksLikeYes(node[k]) && name) defaultOutputName = name;
          }
          if (k === '_items' || k === 'SPAudioDataType' || k === 'items') walk(node[k]);
        }
      };
      walk(data);
      // Channel count — modern macOS uses `coreaudio_device_output` (a bare
      // integer, no "channels" suffix). Older versions used
      // `coreaudio_device_output_channels`. Try the known keys first, then
      // fall back to any output-ish key that isn't actually input/source.
      let channels = 0;
      if (xr18) {
        for (const k of ['coreaudio_device_output', 'coreaudio_device_output_channels']) {
          if (xr18[k] != null) {
            const n = parseInt(xr18[k], 10);
            if (n > 0) { channels = n; break; }
          }
        }
        if (!channels) {
          for (const k of Object.keys(xr18)) {
            const lk = k.toLowerCase();
            if (lk.includes('output') && !lk.includes('input') &&
                !lk.includes('source') && !lk.includes('default')) {
              const n = parseInt(xr18[k], 10);
              if (n > 0) { channels = n; break; }
            }
          }
        }
      }
      resolve({
        ok: true,
        present: !!xr18,
        deviceName: xr18 ? xr18._name : null,
        defaultOutputName,
        channels,
        isDefaultOutput: !!(xr18 && defaultOutputName && /xr18|behringer/i.test(defaultOutputName)),
      });
    });
  });
  Promise.all([runIoreg, runProfiler]).then(([ioreg, prof]) => {
    // Prefer system_profiler's data because it has channel count + default
    // output info. Use ioreg as a fast confirmation OR fallback when
    // system_profiler is dead. If both fail, report ok:false with both
    // errors so the client can surface them.
    let payload;
    if (prof.ok) {
      payload = {
        ok: true,
        present: prof.present || (ioreg.ok && ioreg.present),
        deviceName: prof.deviceName,
        defaultOutputName: prof.defaultOutputName,
        channels: prof.channels,
        isDefaultOutput: prof.isDefaultOutput,
        source: 'system_profiler',
      };
    } else if (ioreg.ok) {
      payload = {
        ok: true,
        present: ioreg.present,
        deviceName: ioreg.present ? 'BEHRINGER XR18 (via ioreg)' : null,
        defaultOutputName: null,
        channels: ioreg.present ? 18 : 0,
        // We don't know if XR18 is the default output without system_profiler;
        // assume it IS if it's connected so the operator doesn't get a
        // false alarm.
        isDefaultOutput: ioreg.present,
        source: 'ioreg-fallback',
        warning: 'system_profiler failed: ' + (prof.err || 'unknown'),
      };
    } else {
      payload = {
        ok: false,
        error: 'Both probes failed',
        ioregError: ioreg.err,
        profilerError: prof.err,
      };
    }
    _xr18Cache = payload;
    _xr18CacheAt = Date.now();
    res.json(payload);
  });
});

// Health probe — extremely cheap, no Drive, no FS scan. The client spinner
// uses it to distinguish "server is up but library is still loading" from
// "server itself is not answering". Useful during boot when /api/library is
// still warming the cache.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    pid: BOOT_PID,
    bootVersion: BOOT_VERSION,
    uptimeMs: Date.now() - BOOT_T0,
    libraryReady: !!(libraryCache && libraryCache.data && Array.isArray(libraryCache.data.songs) && libraryCache.data.songs.length > 0),
    librarySongs: (libraryCache && libraryCache.data && libraryCache.data.songs) ? libraryCache.data.songs.length : 0,
  });
});

// Boot trace — last two runs of the post-mortem journal. Read from the
// LOCAL-disk trace; never touches Drive.
app.get('/api/boot-trace', (req, res) => {
  const out = { current: '', previous: '', path: BOOT_TRACE_PATH };
  try { out.current  = fs.readFileSync(BOOT_TRACE_PATH, 'utf8'); } catch (e) {}
  try { out.previous = fs.readFileSync(BOOT_TRACE_PATH + '.prev', 'utf8'); } catch (e) {}
  res.json(out);
});

// =====================================================================
// PER-SONG management: metadata / delete / re-fetch.
// :base is the STEMS folder name (the canonical song_base, e.g.
// Valerie_Amy_Winehouse). All paths are validated to stay inside the
// library — no traversal, no touching anything but this song's own files.
// =====================================================================
function safeSongDir(base) {
  const b = path.basename(base);                 // strip any path components
  const dir = path.join(STEMS_DIR, b);
  if (!dir.startsWith(STEMS_DIR + path.sep)) return null;   // guard traversal
  return { b, dir };
}

// Full metadata for one song.
app.get('/api/song/:base/metadata', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json for this song' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    // also report which artifacts currently exist on disk
    const EX = ['vocals','drums','bass','other','piano','guitar'];
    const stems = EX.filter(x => fs.existsSync(path.join(s.dir, `${x}.wav`)));
    let m4a = [];
    try { m4a = fs.readdirSync(M4A_DIR).filter(f => f.startsWith(s.b + '_') && f.endsWith('.m4a')); } catch (e) {}
    let sourceBytes = null;
    try { sourceBytes = fs.statSync(path.join(s.dir, 'source.wav')).size; } catch (e) {}
    res.json({ base: s.b, metadata: meta, artifacts: { stems, m4a, hasSource: sourceBytes != null, sourceBytes } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-song MIDI automation ────────────────────────────────────────────────
// The portal lets the user click on a song's waveform to drop MIDI events at
// specific times (Program Changes to the Helix, fader CCs to the XR18, etc.).
// Events live inside the song's metadata.json under an `automation` array
// sorted by timestamp. Stored shape (per event):
//   { t: <seconds>, device: "helix"|"logic"|"xr18", type: "pc"|"cc",
//     channel: 1..16, program: 0..127, controller: 0..127, value: 0..127,
//     label: "Big Lead" }
app.get('/api/song/:base/automation', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.json({ base: s.b, automation: [] });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    res.json({
      base: s.b,
      automation: Array.isArray(meta.automation) ? meta.automation : [],
      sections:   Array.isArray(meta.sections)   ? meta.sections   : [],
      // sectionCandidates is a read-only array of timestamps produced by
      // section_detect.py — moments where multiple stems change together.
      // The portal uses them to snap user-placed section markers to real
      // musical boundaries (see snapTimeToBeat in app.js).
      sectionCandidates: Array.isArray(meta.sectionCandidates) ? meta.sectionCandidates : [],
      countIn:    !!meta.countIn,
      // Per-song pitch shift settings — half-steps and cents. Default to 0
      // when absent so the client can always render the knobs at neutral.
      pitch_semis: typeof meta.pitch_semis === 'number' ? meta.pitch_semis : 0,
      pitch_cents: typeof meta.pitch_cents === 'number' ? meta.pitch_cents : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save the per-song pitch shift values into metadata.json. Small, focused
// endpoint so the client can debounce-save on knob change without touching
// the much-larger automation array.
app.put('/api/song/:base/pitch', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json for this song' });
  const semis = Math.max(-12, Math.min(12, parseInt((req.body || {}).semis, 10) || 0));
  const cents = Math.max(-50, Math.min(50, parseInt((req.body || {}).cents, 10) || 0));
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.pitch_semis = semis;
    meta.pitch_cents = cents;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    res.json({ ok: true, pitch_semis: semis, pitch_cents: cents });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/song/:base/automation', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const events   = req.body && req.body.automation;
  const sections = (req.body && req.body.sections) || [];
  const countIn  = !!(req.body && req.body.countIn);
  if (!Array.isArray(events)) return res.status(400).json({ error: 'need { automation: [...] }' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json for this song' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    // Sort by timestamp so the dispatcher can walk forward without sorting
    // each tick. Clamp + validate basic fields; reject obviously bad rows.
    const VALID_STEMS = new Set(['vocals','drums','bass','guitar','piano','other']);
    const clean = events
      .filter(e => e && typeof e.t === 'number' && e.t >= 0 && typeof e.type === 'string')
      .map(e => {
        const base = {
          t: Math.round(e.t * 1000) / 1000,
          type: String(e.type).slice(0, 16),
          label: String(e.label || '').slice(0, 60),
        };
        if (e.type === 'pc' || e.type === 'cc') {
          base.device  = String(e.device || '').slice(0, 32);
          base.channel = Math.max(1, Math.min(16, parseInt(e.channel, 10) || 1));
          if (e.type === 'pc') {
            base.program = Math.max(0, Math.min(127, parseInt(e.program, 10) || 0));
          } else {
            base.controller = Math.max(0, Math.min(127, parseInt(e.controller, 10) || 0));
            base.value      = Math.max(0, Math.min(127, parseInt(e.value, 10) || 0));
          }
        } else if (e.type === 'mute' || e.type === 'unmute') {
          base.stem = VALID_STEMS.has(e.stem) ? e.stem : 'vocals';
        } else if (e.type === 'play-clip') {
          // Plays a CUSTOM_LOOPS sample in parallel with the backing
          // track at this point in the timeline. Stored as `clip`, the
          // m4a filename. `boost` is the additional gain in dB (0-20)
          // applied via a GainNode in the clip's audio chain so soft
          // captures can sit on top of a loud backing track.
          const clip = String(e.clip || '');
          base.clip = clip.includes('..') ? '' : clip.slice(0, 200);
          const boost = Number(e.boost);
          base.boost = (Number.isFinite(boost) && boost >= -20 && boost <= 20)
            ? Math.round(boost * 10) / 10 : 0;
        } else if (e.type === 'fade') {
          base.stem = VALID_STEMS.has(e.stem) ? e.stem : 'vocals';
          base.level = Math.max(0, Math.min(10, parseInt(e.level, 10) || 0));
        } else if (e.type === 'init') {
          // INIT carries a snapshot of every stem's level at t=0.
          const state = {};
          if (e.state && typeof e.state === 'object') {
            for (const [stem, lvl] of Object.entries(e.state)) {
              if (VALID_STEMS.has(stem)) {
                state[stem] = Math.max(0, Math.min(10, parseInt(lvl, 10) || 0));
              }
            }
          }
          base.state = state;
          base.t = 0;
        } else if (e.type === 'lyric-line') {
          // Lyric overlay action. `text` is the lyric body (empty string
          // is a valid value — the L0 escape-clear). `mode` is 'replace'
          // (resets the overlay to this line) or 'append' (stacks under
          // whatever is already showing). Whitelist clamps text length
          // so a runaway paste can't bloat metadata.json.
          base.text = String(e.text == null ? '' : e.text).slice(0, 240);
          base.mode = (e.mode === 'append') ? 'append' : 'replace';
        } else if (e.type === 'skip-section') {
          // No extra fields — t alone defines the skip's firing time.
          // The target is computed dynamically at fire time from the
          // current section list, so editing sections doesn't break
          // saved skips.
        }
        return base;
      })
      .sort((a, b) => a.t - b.t);
    // Sections: {t, color: 1..9}. Sort by t. Dedup with 0.3s tolerance is
    // handled client-side, so accept whatever the client sent.
    const cleanSections = Array.isArray(sections)
      ? sections
          .filter(x => x && typeof x.t === 'number' && x.t >= 0)
          .map(x => ({
            t: Math.round(x.t * 1000) / 1000,
            color: Math.max(1, Math.min(9, parseInt(x.color, 10) || 1)),
            // Click-in: 4-beat metronome pre-roll fires before this section
            // starts. Per-section flag — sets first-section pre-roll AND
            // mid-song "approach" pre-roll when the playhead enters this
            // section's window.
            clickIn: !!x.clickIn,
          }))
          .sort((a, b) => a.t - b.t)
      : [];
    meta.automation = clean;
    meta.sections   = cleanSections;
    meta.countIn    = countIn;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    res.json({ ok: true, automation: clean, sections: cleanSections, countIn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ActionSequences per song ────────────────────────────────────────────
// Sketch (metadata.json):
//   actionSequences: [
//     { id, label, armed, items: [
//         { id, t, kind: 'play-sample', label, spec: { loopFile, mode,
//           stopAt? }, trigger: 'auto' | 'manual' },
//         ...
//     ]},
//     ...
//   ]
// Sequences are toggled on/off ('armed') before a gig. Only armed
// sequences contribute buttons and auto-fires during playback.
app.get('/api/song/:base/action-sequences', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.json({ base: s.b, actionSequences: [] });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    res.json({
      base: s.b,
      actionSequences: Array.isArray(meta.actionSequences) ? meta.actionSequences : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/song/:base/action-sequences', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const seqs = (req.body && req.body.actionSequences) || [];
  if (!Array.isArray(seqs)) return res.status(400).json({ error: 'need { actionSequences: [...] }' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json for this song' });

  // Sanitize. Each sequence: {id, label, armed, items:[]}. Each item:
  // {id, t, kind, label, spec, trigger}. Anything unknown is dropped.
  const VALID_KINDS = new Set(['play-sample']);
  const VALID_MODES = new Set(['overlay', 'replace', 'loop-until-t', 'one-shot']);
  const cleanSeqs = seqs.filter(s => s && typeof s === 'object').map(seq => {
    const items = Array.isArray(seq.items) ? seq.items : [];
    const cleanItems = items.filter(it => it && VALID_KINDS.has(it.kind)).map(it => {
      const out = {
        id:    String(it.id || ('it_' + Date.now() + '_' + Math.random().toString(36).slice(2,6))).slice(0,40),
        kind:  it.kind,
        label: String(it.label || '').slice(0, 80),
        trigger: it.trigger === 'manual' ? 'manual' : 'auto',
      };
      if (typeof it.t === 'number' && it.t >= 0) out.t = Math.round(it.t * 1000) / 1000;
      if (it.kind === 'play-sample') {
        const spec = it.spec || {};
        out.spec = {
          loopFile: String(spec.loopFile || '').slice(0, 200),
          mode: VALID_MODES.has(spec.mode) ? spec.mode : 'overlay',
        };
        if (typeof spec.stopAt === 'number' && spec.stopAt > 0) {
          out.spec.stopAt = Math.round(spec.stopAt * 1000) / 1000;
        }
      }
      return out;
    });
    // Sort items by anchor time (manual-trigger items go at the end with t=null)
    cleanItems.sort((a, b) => {
      const ta = (typeof a.t === 'number') ? a.t : Infinity;
      const tb = (typeof b.t === 'number') ? b.t : Infinity;
      return ta - tb;
    });
    return {
      id:    String(seq.id || ('as_' + Date.now() + '_' + Math.random().toString(36).slice(2,6))).slice(0,40),
      label: String(seq.label || 'Untitled').slice(0, 80),
      armed: seq.armed !== false,   // default armed
      items: cleanItems,
    };
  });

  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.actionSequences = cleanSeqs;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    res.json({ ok: true, actionSequences: cleanSeqs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Per-song favorite flag ─────────────────────────────────────────────────
// Toggles meta.favorite (bool). The library scanner surfaces it in each
// stems row; the client renders a yellow star next to the song name and
// a synthetic Favorites pseudo-gig aggregates all songs where the flag
// is true. No restem / no audio change — purely a marker.
// Lyrics auto-lookup retired 2026-06-27. Bill curates lyrics by hand for
// the handful of songs he wants them on; the modal's Google / UG / AZLyrics
// buttons + per-song lyrics.txt cover that workflow. This endpoint stays
// reachable so the legacy "Fetch from Genius" UI button doesn't 404 — it
// just returns a friendly 410 explaining the new policy.
app.post('/api/song/:base/fetch-lyrics', (req, res) => {
  res.status(410).json({
    ok: false,
    retired: true,
    error: 'Auto-fetch retired. Paste lyrics into the editor (or STEMS/<base>/lyrics.txt).',
    hint: 'Use the Google / Ultimate Guitar / AZLyrics buttons on the left side of the editor to open a search in a new window, then copy-paste.',
  });
});

// ── Per-song lyrics.txt — the operator-curated source of truth ──────────
// Lives next to source.wav at STEMS/<base>/lyrics.txt. Plain text, one
// displayed line per row. Bill paste-curates in TextEdit (or any editor)
// from Google search results; simpleStem reads the file on demand. This
// route checks for the file FIRST in the lyrics-fetch fall-through chain
// — only when it doesn't exist does the modal's paste dialog get used.
//
// Three endpoints:
//   GET    /api/song/:base/lyrics-file        — read text content
//   PUT    /api/song/:base/lyrics-file        — write text content
//   POST   /api/song/:base/lyrics-file/open   — create-if-empty + open in
//                                               TextEdit (macOS `open`),
//                                               returns the path + the
//                                               Google search URL for
//                                               the song title + artist
function lyricsTxtPath(songDir) { return path.join(songDir, 'lyrics.txt'); }
app.get('/api/song/:base/lyrics-file', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const lp = lyricsTxtPath(s.dir);
  if (!fs.existsSync(lp)) return res.status(404).json({ error: 'no lyrics.txt' });
  try {
    const text = fs.readFileSync(lp, 'utf8');
    res.json({ ok: true, text, path: lp, size: Buffer.byteLength(text, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/song/:base/lyrics-file', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  try {
    fs.writeFileSync(lyricsTxtPath(s.dir), text, 'utf8');
    res.json({ ok: true, path: lyricsTxtPath(s.dir), size: Buffer.byteLength(text, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/song/:base/lyrics-file/open', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const lp = lyricsTxtPath(s.dir);
  // Create empty file if it doesn't exist so `open -t` has something to
  // open. Pre-existing files are preserved.
  try { if (!fs.existsSync(lp)) fs.writeFileSync(lp, '', 'utf8'); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  // `-t` opens in the default text editor (TextEdit on a clean Mac, or
  // whatever the user has registered as the .txt handler — VS Code,
  // BBEdit, etc.). Fire-and-forget; spawn is detached so it survives
  // this request.
  try {
    spawn('open', ['-t', lp], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return res.status(500).json({ error: `open failed: ${e.message}` });
  }
  // Build the Google search URL using the song's metadata.json title +
  // artist (whatever the client has — pass them in body to override).
  let title = (req.body && req.body.title) || '';
  let artist = (req.body && req.body.artist) || '';
  if (!title || !artist) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(s.dir, 'metadata.json'), 'utf8'));
      title  = title  || meta.title  || '';
      artist = artist || meta.artist || '';
    } catch (e) {}
  }
  const q = encodeURIComponent(`Lyrics ${title} ${artist}`.trim());
  res.json({
    ok: true,
    path: lp,
    googleUrl: `https://www.google.com/search?q=${q}`,
  });
});

// Read the current lyrics for ONE song straight from metadata.json on
// disk. Bypasses libraryCache / CATALOG.json — those rehydrate from
// catalog.py output which lags whenever the Performer edits a song
// locally. When the client's currentSong.lyrics is missing but the
// file actually has them, this endpoint serves as the self-heal path
// so + Lyric stops launching the editor.
app.get('/api/song/:base/lyrics', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    // Prefer lyrics.txt next to source.wav if it exists AND has content.
    // That's the operator-curated file Bill paste-edits in TextEdit. Falls
    // back to whatever's stored in metadata.json (legacy / Genius fetch).
    let lyrics = null;
    let source = meta.lyrics_source || null;
    const lp = lyricsTxtPath(s.dir);
    if (fs.existsSync(lp)) {
      try {
        const txt = fs.readFileSync(lp, 'utf8').trim();
        if (txt) { lyrics = txt; source = 'lyrics.txt'; }
      } catch (e) {}
    }
    if (!lyrics) lyrics = meta.lyrics || null;
    // While we're here, patch libraryCache in place so subsequent
    // GET /api/library responses include lyrics for this song.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) { row.lyrics = lyrics; row.lyrics_chunks = meta.lyrics_chunks || null; }
      }
    } catch (e) {}
    res.json({
      ok: true,
      lyrics,
      lyrics_chunks: Array.isArray(meta.lyrics_chunks) ? meta.lyrics_chunks : null,
      source,
      fetchedAt: meta.lyrics_fetched_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual-paste lyrics. Saves whatever the operator pasted from Google /
// AZLyrics / a tab site directly into the song's metadata.json so the
// next + Lyric tap can use them. No Genius involvement; this is the
// escape hatch for songs Genius doesn't have.
app.put('/api/song/:base/lyrics', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const text = (req.body && typeof req.body.lyrics === 'string') ? req.body.lyrics : '';
  if (!text.trim()) return res.status(400).json({ error: 'lyrics body is empty' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.lyrics = text.trim();
    meta.lyrics_source = 'manual';
    meta.lyrics_fetched_at = new Date().toISOString();
    // Build lyrics_chunks the same way lyrics_fetch.py does: split on
    // bracketed section markers, keep the body in each chunk. Falls back
    // to a single "Lyrics" chunk if no markers found.
    const re = /^\s*\[([^\]]+)\]\s*$/gm;
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) matches.push({ label: m[1].trim(), idx: m.index, end: re.lastIndex });
    let chunks;
    if (!matches.length) {
      chunks = [{ label: 'Lyrics', text: text.trim() }];
    } else {
      chunks = [];
      if (matches[0].idx > 0) {
        const pre = text.slice(0, matches[0].idx).trim();
        if (pre) chunks.push({ label: 'Intro', text: pre });
      }
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].end;
        const end   = i + 1 < matches.length ? matches[i + 1].idx : text.length;
        const body  = text.slice(start, end).trim();
        if (body) chunks.push({ label: matches[i].label, text: body });
      }
    }
    meta.lyrics_chunks = chunks;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    // Patch libraryCache in place.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) { row.lyrics = meta.lyrics; row.lyrics_chunks = chunks; }
      }
    } catch (e) {}
    res.json({ ok: true, lyrics: meta.lyrics, lyrics_chunks: chunks, chunkCount: chunks.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/song/:base/favorite', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const flag = !!(req.body && req.body.favorite);
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.favorite = flag;
    const at = flag ? new Date().toISOString() : null;
    if (flag) meta.favorited_at = at;
    else      delete meta.favorited_at;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    // Patch libraryCache in place so GET /api/favorites returns the new
    // state immediately. Without this, the song stays at favorite: false
    // in the cached songs[] until the next CATALOG.json rebuild (could be
    // hours), and the Favorites pseudo-gig appears not to reflect the star.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) {
          row.favorite = flag;
          row.favorited_at = at;
        }
      }
    } catch (e) { console.warn('[favorite] cache patch failed:', e.message); }
    res.json({ ok: true, favorite: flag, favorited_at: at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Playback-state recorder for offline-test verification. The client
// POSTs current playback state on every transition so an external bash
// script can read it via GET and assert "the second song is now playing".
// State lives in memory only — a fresh server restart wipes it. The
// script reads it via a curl one-liner that needs no JSON parsing if
// the body fields are stable. Bill's offline test scenarios depend on
// this for verifying playback through a wifi-off window.
const _playbackState = { base: null, isPlaying: false, paused: true, currentTime: 0, duration: 0, at: 0 };
app.post('/api/debug/playback-state', express.json(), (req, res) => {
  try {
    const b = req.body || {};
    _playbackState.base       = b.base || null;
    _playbackState.isPlaying  = !!b.isPlaying;
    _playbackState.paused     = !!b.paused;
    _playbackState.currentTime = Number(b.currentTime) || 0;
    _playbackState.duration   = Number(b.duration) || 0;
    _playbackState.at         = Date.now();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/debug/playback-state', (req, res) => {
  res.json({ ok: true, state: _playbackState, ageMs: _playbackState.at ? Date.now() - _playbackState.at : null });
});

// Play-count tracker. POST /api/song/:base/play increments the count
// and updates last_played_at. Client calls this on the FIRST 'playing'
// event per song-load (debounced — six stems firing 'playing' must not
// produce six increments). Returns the new count.
app.post('/api/song/:base/play', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.play_count = (meta.play_count | 0) + 1;
    meta.last_played_at = new Date().toISOString();
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    // Patch libraryCache so /api/library reflects the new count without
    // waiting for the next CATALOG.json rebuild.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) {
          row.play_count = meta.play_count;
          row.last_played_at = meta.last_played_at;
        }
      }
    } catch (e) {}
    res.json({ ok: true, play_count: meta.play_count, last_played_at: meta.last_played_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Global tag registry. The library cell pulldown shows checkboxes for
// every registered tag, plus an "Add tag…" item that appends to this
// list and persists it across server restarts. Stored at the simpleStem
// root as TAGS.json so it syncs with the rest of the library.
const TAGS_REGISTRY_PATH = path.join(SIMPLE_STEM_ROOT, 'TAGS.json');
const DEFAULT_TAGS = ['Protest', 'Bill&Matt'];
function loadTagRegistry() {
  try {
    if (fs.existsSync(TAGS_REGISTRY_PATH)) {
      const j = JSON.parse(fs.readFileSync(TAGS_REGISTRY_PATH, 'utf8'));
      if (Array.isArray(j.tags)) return j.tags.map(t => String(t).trim()).filter(Boolean);
    }
  } catch (e) { console.warn('[tags] registry read failed:', e.message); }
  return DEFAULT_TAGS.slice();
}
function saveTagRegistry(tags) {
  try {
    fs.writeFileSync(TAGS_REGISTRY_PATH, JSON.stringify({ tags }, null, 2) + '\n');
  } catch (e) { console.warn('[tags] registry write failed:', e.message); }
}
// Boot: ensure the file exists with the default tags so first call to
// GET /api/tags is never blank.
if (!fs.existsSync(TAGS_REGISTRY_PATH)) saveTagRegistry(DEFAULT_TAGS.slice());

app.get('/api/tags', (req, res) => {
  res.json({ ok: true, tags: loadTagRegistry() });
});
// Add a tag to the global registry. De-duped case-insensitive.
app.post('/api/tags', express.json(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const tags = loadTagRegistry();
  if (tags.some(t => t.toLowerCase() === name.toLowerCase())) {
    return res.json({ ok: true, tags, alreadyExists: true });
  }
  tags.push(name);
  saveTagRegistry(tags);
  res.json({ ok: true, tags });
});

// Readiness — radio group "InTheBag" / "Rehearsal" / "TBD".
// Persisted to metadata.readiness alongside the existing MPB-synced
// values. Bill's per-row spec 2026-06-30.
const READINESS_VALUES = new Set(['InTheBag', 'Rehearsal', 'TBD']);
app.put('/api/song/:base/readiness', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const v = String((req.body && req.body.readiness) || '').trim();
  if (!READINESS_VALUES.has(v)) return res.status(400).json({ error: 'bad readiness value' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.readiness = v;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) row.readiness = v;
      }
    } catch (e) {}
    res.json({ ok: true, readiness: v });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-song tags. Free-form labels the operator attaches in-portal so
// dynamic templates ("Protest Songs", "Slow Jams", "Singalongs") can
// pull a query-based list. Body: { tags: ['protest', 'sing-along'] }
// — array of strings, lowercased + trimmed on write. Empty array allowed.
app.put('/api/song/:base/tags', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  let tags = (req.body && req.body.tags) || [];
  if (!Array.isArray(tags)) tags = [];
  tags = tags.map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
  // De-dupe while preserving order.
  tags = [...new Set(tags)];
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.tags = tags;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) row.tags = tags;
      }
    } catch (e) {}
    res.json({ ok: true, tags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-song "who's needed to play this" — a compact string over the alphabet
// {B, M, D, J, #} (Bill, Matt, Dan, JD, drums-role). The Gig Builder's roster
// filter reads this to decide whether tonight's musicians can play the song
// (with # optionally supplied by drum-machine or backing-track compensation).
// Body: { requires: "BMD#" }. Case-insensitive on write, uppercased on save.
// Task #132.
const REQUIRES_ALPHABET = /^[BMDJ#]*$/;
app.put('/api/song/:base/requires', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  let val = String((req.body && req.body.requires) || '').toUpperCase().trim();
  if (!REQUIRES_ALPHABET.test(val)) {
    return res.status(400).json({ error: 'requires must be a subset of B/M/D/J/# only' });
  }
  // Preserve BMDJ# canonical order rather than user-typed order; makes
  // downstream string-equality checks work without normalization.
  const ORDER = 'BMDJ#';
  val = ORDER.split('').filter(c => val.includes(c)).join('');
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.band_required_compact = val;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) row.band_required_compact = val;
      }
    } catch (e) {}
    res.json({ ok: true, requires: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-song key override. metadata.py sets this from librosa on ingest;
// the operator can correct it in the row-level Key dropdown. Body:
// { key: "F#m" } — short form (major implied, "m" suffix = minor).
// Task #132.
const KEY_PATTERN = /^[A-G](#|b)?m?$/;
app.put('/api/song/:base/key', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const val = String((req.body && req.body.key) || '').trim();
  if (!KEY_PATTERN.test(val)) {
    return res.status(400).json({ error: 'key must match [A-G](#|b)?m? — e.g. F#m, C, Eb' });
  }
  const isMinor = val.endsWith('m');
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.key = isMinor
      ? `${val.slice(0, -1)} minor`
      : `${val} major`;
    meta.key_short = val;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) { row.key = meta.key; row.key_short = val; }
      }
    } catch (e) {}
    res.json({ ok: true, key: meta.key, key_short: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drum-machine-as-default-per-song. Some songs the band plays without the
// backing track — drum machine only. PUT this endpoint to remember that
// choice. On next song-load the client checks metadata.drum_machine_default
// and auto-engages the drum machine if true. Body: { drumDefault: bool }.
app.put('/api/song/:base/drum-default', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    const flag = !!(req.body && req.body.drumDefault);
    meta.drum_machine_default = flag;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    // Patch libraryCache so the next /api/library call reflects the flag.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) row.drum_machine_default = flag;
      }
    } catch (e) {}
    res.json({ ok: true, drum_machine_default: flag });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-song playback mode (task #129). Modes: 'stems' | 'drum' | 'backing'.
// Client persists whichever mode was last used; loadSong reads this on
// next open and auto-engages. Backward compat: drum_machine_default is
// kept in sync (drum=true, stems/backing=false) so any legacy consumer
// still sees the correct flag.
const PLAYBACK_MODES = new Set(['stems', 'drum', 'backing']);
app.put('/api/song/:base/playback-mode', express.json(), (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const mode = (req.body && req.body.mode);
  if (!PLAYBACK_MODES.has(mode)) {
    return res.status(400).json({ error: `mode must be one of ${[...PLAYBACK_MODES].join(', ')}` });
  }
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    meta.playback_mode = mode;
    // Sync the legacy flag so anything still reading drum_machine_default
    // stays consistent.
    meta.drum_machine_default = (mode === 'drum');
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) {
          row.playback_mode = mode;
          row.drum_machine_default = (mode === 'drum');
        }
      }
    } catch (e) {}
    res.json({ ok: true, playback_mode: mode, drum_machine_default: mode === 'drum' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Local singer_lead override. The Mitchell Park Band Google Sheet is the
// authoritative source for singer assignments, and the next mpb_sync run
// will overwrite this field. This endpoint is for in-portal quick edits
// when the sheet is behind or wrong.
app.put('/api/song/:base/singer', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  const mp = path.join(s.dir, 'metadata.json');
  if (!fs.existsSync(mp)) return res.status(404).json({ error: 'no metadata.json' });
  const raw = (req.body && req.body.singer_lead);
  const singer = (typeof raw === 'string' ? raw : '').trim();
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
    if (singer) meta.singer_lead = singer;
    else        delete meta.singer_lead;
    fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
    // Same in-place cache patch as the favorite handler — without it the
    // singer pseudo-gigs (Bill / Matt / Dan / JD Songs) keep showing the
    // stale assignment until the next CATALOG.json rebuild.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        const row = songs.find(x => x.type === 'stems' && x.folderName === s.b);
        if (row) row.singer_lead = singer || null;
      }
    } catch (e) { console.warn('[singer] cache patch failed:', e.message); }
    res.json({ ok: true, singer_lead: singer || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recents: rolling log of the last 50 songs the operator loaded ──────────
// File lives at <root>/RECENTS.json — { entries: [{ base, at }, ...] }.
// Performer-owned, NOT git-tracked. POST = log a load. GET = read list.
const RECENTS_PATH = path.join(SIMPLE_STEM_ROOT, 'RECENTS.json');
const RECENTS_CAP  = 50;

function loadRecents() {
  try {
    if (!fs.existsSync(RECENTS_PATH)) return { entries: [] };
    const raw = JSON.parse(fs.readFileSync(RECENTS_PATH, 'utf8'));
    return { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch (e) { return { entries: [] }; }
}
function saveRecents(r) {
  try { fs.writeFileSync(RECENTS_PATH, JSON.stringify(r, null, 2) + '\n'); }
  catch (e) { console.warn('[recents] save failed:', e.message); }
}

app.get('/api/recents', (req, res) => {
  res.json(loadRecents());
});

app.post('/api/recents', (req, res) => {
  const base = (req.body && req.body.base) || '';
  if (!base || typeof base !== 'string') {
    return res.status(400).json({ error: 'need { base: "<song_folder>" }' });
  }
  const r = loadRecents();
  // Dedupe: drop any prior entries with the same base — most-recent wins.
  const entries = r.entries.filter(e => e.base !== base);
  entries.unshift({ base, at: new Date().toISOString() });
  // Cap at RECENTS_CAP.
  r.entries = entries.slice(0, RECENTS_CAP);
  saveRecents(r);
  res.json({ ok: true, count: r.entries.length });
});

// Favorites listing — walks the library cache and returns the bases of
// every song with meta.favorite === true. Caps at RECENTS_CAP so the
// client's synthetic gig stays manageable.
app.get('/api/favorites', (req, res) => {
  try {
    const songs = (libraryCache && libraryCache.data && libraryCache.data.songs) || [];
    const favs = songs
      .filter(s => s.type === 'stems' && s.favorite === true)
      .map(s => ({ base: s.folderName, title: s.title, artist: s.artist, favorited_at: s.favorited_at || null }))
      .sort((a, b) => (b.favorited_at || '').localeCompare(a.favorited_at || ''))
      .slice(0, RECENTS_CAP);
    res.json({ entries: favs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HOLODECK named snapshots ────────────────────────────────────────────────
// A snapshot is a complete copy of every editable file in the portal's state
// — GIGS/, SETLISTS/, RECENTS.json, and each song's metadata.json (which
// holds singer assignment, automation events, sections, favorite flag). It
// also carries a JSON blob of the client's localStorage + in-memory mixer
// state so the audible mix is reproducible on restore. Triggered by voice
// (HOLODECK, save this as 'before joyce setlist') or button. The folder is
// SNAPSHOTS/<name>/ alongside the rest of the project. Designed so a
// non-technical operator can experiment freely; every change is reversible.
const SNAPSHOTS_DIR = path.join(SIMPLE_STEM_ROOT, 'SNAPSHOTS');
try { if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch (e) {}

function safeSnapshotName(raw) {
  const s = String(raw || '').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 64).replace(/\s+/g, '_');
  return s || null;
}
function copyDirSync(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

app.post('/api/snapshot/save', (req, res) => {
  const name = safeSnapshotName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  const snapDir = path.join(SNAPSHOTS_DIR, name);
  try {
    if (fs.existsSync(snapDir)) {
      // Overwrite an existing snapshot by archiving it first.
      fs.renameSync(snapDir, snapDir + '.bak_' + Date.now());
    }
    fs.mkdirSync(snapDir, { recursive: true });
    copyDirSync(path.join(SIMPLE_STEM_ROOT, 'GIGS'),     path.join(snapDir, 'GIGS'));
    copyDirSync(path.join(SIMPLE_STEM_ROOT, 'SETLISTS'), path.join(snapDir, 'SETLISTS'));
    const recents = path.join(SIMPLE_STEM_ROOT, 'RECENTS.json');
    if (fs.existsSync(recents)) fs.copyFileSync(recents, path.join(snapDir, 'RECENTS.json'));
    // Snapshot every song's metadata.json (small JSON files; the audio is
    // not duplicated — the audio is content-addressed by folder name).
    const metaDir = path.join(snapDir, 'STEMS_META');
    fs.mkdirSync(metaDir, { recursive: true });
    try {
      for (const folder of fs.readdirSync(STEMS_DIR)) {
        const meta = path.join(STEMS_DIR, folder, 'metadata.json');
        if (fs.existsSync(meta)) fs.copyFileSync(meta, path.join(metaDir, folder + '.json'));
      }
    } catch (e) { console.warn('[snapshot] meta scan partial:', e.message); }
    const manifest = {
      name,
      created_at: new Date().toISOString(),
      version: BOOT_VERSION,
      client_state: req.body.client_state || null,
    };
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[snapshot] saved "${name}"`);
    res.json({ ok: true, name, created_at: manifest.created_at });
  } catch (e) {
    console.error('[snapshot] save failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/snapshot/list', (req, res) => {
  try {
    const list = [];
    if (fs.existsSync(SNAPSHOTS_DIR)) {
      for (const e of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.includes('.bak_')) continue;
        const manifestPath = path.join(SNAPSHOTS_DIR, e.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          list.push({ name: m.name, created_at: m.created_at, version: m.version });
        } catch (err) {}
      }
    }
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json({ snapshots: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/snapshot/restore/:name', (req, res) => {
  const name = safeSnapshotName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  const snapDir = path.join(SNAPSHOTS_DIR, name);
  if (!fs.existsSync(snapDir)) return res.status(404).json({ error: 'snapshot not found' });
  try {
    const gigs = path.join(snapDir, 'GIGS');
    if (fs.existsSync(gigs)) {
      const target = path.join(SIMPLE_STEM_ROOT, 'GIGS');
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      copyDirSync(gigs, target);
    }
    const setlists = path.join(snapDir, 'SETLISTS');
    if (fs.existsSync(setlists)) {
      const target = path.join(SIMPLE_STEM_ROOT, 'SETLISTS');
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      copyDirSync(setlists, target);
    }
    const recents = path.join(snapDir, 'RECENTS.json');
    if (fs.existsSync(recents)) fs.copyFileSync(recents, path.join(SIMPLE_STEM_ROOT, 'RECENTS.json'));
    const metaDir = path.join(snapDir, 'STEMS_META');
    if (fs.existsSync(metaDir)) {
      for (const f of fs.readdirSync(metaDir)) {
        if (!f.endsWith('.json')) continue;
        const folder = f.slice(0, -5);
        const target = path.join(STEMS_DIR, folder, 'metadata.json');
        if (fs.existsSync(path.dirname(target))) {
          try { fs.copyFileSync(path.join(metaDir, f), target); } catch (e) {}
        }
      }
    }
    let clientState = null;
    const manifestPath = path.join(snapDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        clientState = m.client_state;
      } catch (e) {}
    }
    // Force a library refresh on the next read.
    libraryCache = null;
    try { refreshLibraryCache('snapshot-restore', true); } catch (e) {}
    console.log(`[snapshot] restored "${name}"`);
    res.json({ ok: true, name, client_state: clientState });
  } catch (e) {
    console.error('[snapshot] restore failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/snapshot/diff/:name', (req, res) => {
  const name = safeSnapshotName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  const snapDir = path.join(SNAPSHOTS_DIR, name);
  if (!fs.existsSync(snapDir)) return res.status(404).json({ error: 'snapshot not found' });
  const changes = [];
  function diffOne(snapSub, liveSub, prefix) {
    const a = path.join(snapDir, snapSub);
    const b = path.join(SIMPLE_STEM_ROOT, liveSub);
    const aF = fs.existsSync(a) ? fs.readdirSync(a) : [];
    const bF = fs.existsSync(b) ? fs.readdirSync(b) : [];
    const all = new Set([...aF, ...bF]);
    for (const f of all) {
      const aP = path.join(a, f);
      const bP = path.join(b, f);
      if (!fs.existsSync(aP)) { changes.push(prefix + f + ' (added)');   continue; }
      if (!fs.existsSync(bP)) { changes.push(prefix + f + ' (removed)'); continue; }
      try {
        const aS = fs.readFileSync(aP, 'utf8');
        const bS = fs.readFileSync(bP, 'utf8');
        if (aS !== bS) changes.push(prefix + f + ' (modified)');
      } catch (e) {}
    }
  }
  try {
    diffOne('GIGS',     'GIGS',     'GIGS/');
    diffOne('SETLISTS', 'SETLISTS', 'SETLISTS/');
    res.json({ name, changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MIDI sidecar proxy ──────────────────────────────────────────────────────
// The sidecar (midi_sidecar.py) runs on :5555. We proxy here so the client
// stays same-origin and gets a friendly error when the sidecar is down.
const MIDI_SIDECAR_URL = process.env.MIDI_SIDECAR_URL || 'http://127.0.0.1:5555';

async function sidecarFetch(path, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch(`${MIDI_SIDECAR_URL}${path}`, { ...init, signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } finally { clearTimeout(t); }
}

app.get('/api/midi/ports', async (req, res) => {
  try {
    const r = await sidecarFetch('/ports');
    res.status(r.status).json(r.body);
  } catch (e) {
    res.status(503).json({ error: 'midi sidecar unreachable', detail: e.message, available: [] });
  }
});

app.post('/api/midi/send', async (req, res) => {
  try {
    const r = await sidecarFetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    res.status(r.status).json(r.body);
  } catch (e) {
    res.status(503).json({ error: 'midi sidecar unreachable', detail: e.message });
  }
});

// Hard delete a song: remove its STEMS folder (if present), its M4A files,
// and its cache. Body must include { confirm: "<base>" } matching the song
// id — a deliberate guard against accidental deletes. NOT reversible.
//
// Two modes:
//   - stems+m4a: the base names a STEMS folder; folder + matching m4a + caches go.
//   - m4a-only:  the base does NOT have a STEMS folder, but there are m4a files
//                that share that base prefix (e.g. orphaned variants like
//                Harvest_Moon_..._Neil_Young_-V-G-B.m4a with no stems folder).
//                Just the m4a files + their caches are removed.
app.delete('/api/song/:base', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  if (!req.body || req.body.confirm !== s.b) {
    return res.status(400).json({ error: 'confirmation mismatch — send { confirm: "<base>" }' });
  }
  const stemsExists = fs.existsSync(s.dir);
  // Find every m4a file that starts with the base prefix. The trailing
  // underscore guards against partial matches (e.g. base "Mary" matching
  // "Mary_Jane's_Last_Dance.m4a" — only ones with "_" after the prefix).
  let m4aMatches = [];
  try {
    for (const f of fs.readdirSync(M4A_DIR)) {
      if (f.startsWith(s.b + '_') && f.endsWith('.m4a')) m4aMatches.push(f);
    }
  } catch (e) {}
  if (!stemsExists && m4aMatches.length === 0) {
    return res.status(404).json({ error: 'nothing to delete: no stems folder and no matching m4a files' });
  }
  try {
    let removedM4a = 0;
    if (stemsExists) {
      fs.rmSync(s.dir, { recursive: true, force: true });
      try { fs.rmSync(path.join(AUDIO_CACHE_STEMS, s.b), { recursive: true, force: true }); } catch (e) {}
    }
    for (const f of m4aMatches) {
      try { fs.rmSync(path.join(M4A_DIR, f), { force: true }); } catch (e) {}
      try { fs.rmSync(path.join(AUDIO_CACHE_M4A, f), { force: true }); } catch (e) {}
      removedM4a++;
    }
    console.log(`[delete] ${s.b}: ${stemsExists ? 'removed STEMS folder + ' : ''}${removedM4a} m4a`);
    // Patch libraryCache in place so the deleted song disappears from the
    // portal immediately, even before the next CATALOG.json rebuild.
    try {
      const songs = libraryCache && libraryCache.data && libraryCache.data.songs;
      if (Array.isArray(songs)) {
        libraryCache.data.songs = songs.filter(x => {
          if (x.type === 'stems' && x.folderName === s.b) return false;
          if (x.type === 'm4a'   && x.fileName && m4aMatches.includes(x.fileName)) return false;
          return true;
        });
      }
    } catch (e) { console.warn('[delete] cache patch failed:', e.message); }
    // Also kick off a background refresh in case the Librarian has rebuilt
    // CATALOG.json — picks up any non-obvious changes too.
    try { refreshLibraryCache('song-deleted', true); } catch (e) {}
    res.json({ ok: true, base: s.b, removedM4a, stemsFolderExisted: stemsExists });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-fetch a song from a NEW url: update source_url in metadata, delete the
// stale source.wav + stems + m4a (so the cache model re-downloads instead of
// reusing), and drop a .webloc so the Librarian re-ingests. The actual download
// happens on the Librarian (mini) watcher; re-stem on the Performer runner.
app.post('/api/song/:base/refetch', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  if (!fs.existsSync(s.dir)) return res.status(404).json({ error: 'song not found' });
  const url = ((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(url)) {
    return res.status(400).json({ error: 'need a valid YouTube URL' });
  }
  try {
    // 1. update source_url in metadata.json (keep title/artist so the re-ingest
    //    names it the same — webloc_watch derives title/artist from the video,
    //    but we preserve the existing record as a hint).
    const mp = path.join(s.dir, 'metadata.json');
    if (fs.existsSync(mp)) {
      try {
        const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
        meta.source_url = url;
        if (meta.processing && meta.processing.download) meta.processing.download.source_url = url;
        meta.refetched_at = new Date().toISOString();
        fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n');
      } catch (e) {}
    }
    // 2. delete stale audio so stem.sh won't reuse it (the cache model otherwise
    //    skips download when source.wav exists).
    for (const f of ['source.wav', 'source.info.json', 'vocals.wav','drums.wav','bass.wav','other.wav','piano.wav','guitar.wav','bass+drums.wav']) {
      fs.rmSync(path.join(s.dir, f), { force: true });
    }
    // also any loop files + the whole cached copy
    try { for (const f of fs.readdirSync(s.dir)) if (/loop\d+_\d+bars\.(wav|m4a)$/i.test(f)) fs.rmSync(path.join(s.dir, f), { force: true }); } catch (e) {}
    fs.rmSync(path.join(AUDIO_CACHE_STEMS, s.b), { recursive: true, force: true });
    // 3. delete old m4a mixdowns (they're from the old source)
    try { for (const f of fs.readdirSync(M4A_DIR)) if (f.startsWith(s.b + '_') && f.endsWith('.m4a')) { fs.rmSync(path.join(M4A_DIR, f), { force: true }); fs.rmSync(path.join(AUDIO_CACHE_M4A, f), { force: true }); } } catch (e) {}
    // 4. drop a webloc for the Librarian to re-ingest the new URL
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(INCOMING_DIR, `refetch_${s.b}_${stamp}.webloc`),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>URL</key>\n\t<string>' + xmlEscape(url) + '</string>\n</dict>\n</plist>\n');
    console.log(`[refetch] ${s.b}: cleared old artifacts, queued new URL ${url}`);
    refreshLibraryCache('song-refetch', true);
    res.json({ ok: true, base: s.b, url, note: 'Old artifacts cleared and re-ingest queued. The Librarian (mini) must be running to download; then it re-stems on the Performer.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Re-stem in Logic Pro via Keyboard Maestro ──────────────────────────────
// Hands a song off to a Keyboard Maestro macro that drives Logic Pro's Stem
// Splitter and bounces replacement m4a mixdowns. The server sets KBM Engine
// variables (so the macro can read them as %Variable%simpleStem_*%) and then
// fires the macro via the kmtrigger:// URL scheme — fire-and-forget, so the
// HTTP request returns in <1s even though the macro runs for ~3 minutes.
//
// Two protections against overlapping Logic runs:
//   1. Atomic check-and-set in a single osascript: read simpleStem_Running;
//      if non-empty, return its value (the song already in flight) and
//      DON'T overwrite any variables. Otherwise set all variables in one
//      block and stamp simpleStem_Running with the new song's base.
//   2. The macro itself MUST clear simpleStem_Running at exit (both the
//      success and error paths). The /api/logic-restem/unlock endpoint
//      below clears it manually if the macro fails to.
//
// If KBM Engine restarts, all engine variables reset — the lock auto-clears.
// If the macro hangs and never clears the variable, the user calls
// /api/logic-restem/unlock to release it.
//
// KBM macro contract:
//   Macro name: "simpleStem"
//   Reads these KBM variables (all strings; empty if unknown):
//     ─ paths ───────────────────────────────────────────────────────
//     simpleStem_SourceDir   → STEMS/<base>            (folder)
//     simpleStem_SourceWav   → STEMS/<base>/source.wav (full path)
//     simpleStem_M4ADir      → M4A                     (bounce target)
//     simpleStem_M4ABase     → <base>                  (filename prefix)
//     ─ identity ────────────────────────────────────────────────────
//     simpleStem_Title       → song title
//     simpleStem_Artist      → artist
//     simpleStem_Version     → "studio"/"live"/etc
//     simpleStem_SourceUrl   → YouTube URL of the source
//     ─ musical metadata (for Logic project setup) ──────────────────
//     simpleStem_BPM         → e.g. "120.5"   (from metadata.json bpm)
//     simpleStem_Key         → e.g. "G# major"
//     simpleStem_KeySignature→ e.g. "3 sharps"
//     simpleStem_Duration    → active audio length in seconds
//     simpleStem_Bars        → ceil(BPM × Duration / 240), 4/4 assumed
//     simpleStem_ClipStartSec→ chapter window start (album sources only)
//     simpleStem_ClipEndSec  → chapter window end (album sources only)
//     ─ reference links (for Project Notes) ─────────────────────────
//     simpleStem_LyricsUrl   → lyrics_search_url
//     simpleStem_ChordsUrl   → chords_search_url
//     ─ lifecycle (managed by server + macro together) ──────────────
//     simpleStem_Running     → set by server before firing (= song base);
//                              MACRO MUST CLEAR THIS AT EXIT (success or
//                              error path). While non-empty, new triggers
//                              are rejected with 409.
//
//   Expected output files (overwriting the demucs versions):
//     M4A/<base>_-V.m4a       source minus vocals
//     M4A/<base>_-V-G.m4a     source minus vocals, guitar
//     M4A/<base>_-V-G-B.m4a   source minus vocals, guitar, bass
//     M4A/<base>_DO.m4a       drums only
const KBM_MACRO_NAME = 'simpleStem';
const KBM_VAR_PREFIX = 'simpleStem_';
const KBM_RUNNING_VAR = KBM_VAR_PREFIX + 'Running';

// Escape a string for embedding inside an AppleScript double-quoted literal.
function asEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Format a number to a stable string for KBM (no JS quirks like "12.0"→"12").
// Returns '' for null/undefined/NaN so the macro can branch on empty.
function numStr(n, digits) {
  if (n == null || (typeof n === 'number' && !isFinite(n))) return '';
  const x = Number(n);
  if (!isFinite(x)) return '';
  return digits == null ? String(x) : x.toFixed(digits);
}

app.post('/api/song/:base/logic-restem', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  if (!fs.existsSync(s.dir)) return res.status(404).json({ error: 'song folder not found' });
  const sourceWav = path.join(s.dir, 'source.wav');
  if (!fs.existsSync(sourceWav)) return res.status(404).json({ error: 'source.wav not found in song folder' });

  // Pull metadata.json — every field is best-effort. Missing values are
  // passed to KBM as empty strings so the macro can branch on them.
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(s.dir, 'metadata.json'), 'utf8')) || {};
  } catch (e) {}

  // Active audio duration: source.wav is the clip window when this is an
  // album chapter; the full youtube video duration otherwise. Pick whichever
  // describes what's actually in source.wav so KBM/Logic see consistent length.
  const clipStart = (typeof meta.clip_start_sec === 'number') ? meta.clip_start_sec : null;
  const clipEnd   = (typeof meta.clip_end_sec   === 'number') ? meta.clip_end_sec   : null;
  const fullDur   = (typeof meta.duration_sec   === 'number') ? meta.duration_sec   : null;
  const activeDur = (clipStart != null && clipEnd != null) ? (clipEnd - clipStart) : fullDur;

  // Bars assumes 4/4 (covers the band's repertoire; flag in CLAUDE.md if that
  // ever changes). Formula: ceil(BPM × seconds / 240). Empty if either input
  // is missing so the macro can skip setting project end.
  let bars = '';
  if (typeof meta.bpm === 'number' && typeof activeDur === 'number' && meta.bpm > 0) {
    bars = String(Math.ceil((meta.bpm * activeDur) / 240));
  }

  // Six-stem targets — as of 2026-06-27 the portal mixes stems
  // client-side and Logic Pro 12's Stem Splitter produces the same
  // 6 stems Demucs produces. Bounce each stem into the SAME song folder
  // as source.wav, using the canonical filenames the portal reads:
  //   vocals.m4a  drums.m4a  bass.m4a  guitar.m4a  piano.m4a  other.m4a
  // The four legacy variables (M4ADir, VMix, VGMix, VGBMix, DOMix) are
  // kept for backward compat with any old macro version still in the
  // wild, but they now point at the same STEMS folder so a macro that
  // ignores the new variables at least writes to the right place.
  const stemDir = s.dir;
  const vars = {
    // paths
    SourceDir:      s.dir,
    SourceWav:      sourceWav,
    StemDir:        stemDir,               // NEW: bounce target for all 6 stems
    StemBase:       s.b,
    // Explicit filenames the macro should write. Six canonical stems.
    VocalsFile:     path.join(stemDir, 'vocals.m4a'),
    DrumsFile:      path.join(stemDir, 'drums.m4a'),
    BassFile:       path.join(stemDir, 'bass.m4a'),
    GuitarFile:     path.join(stemDir, 'guitar.m4a'),
    PianoFile:      path.join(stemDir, 'piano.m4a'),
    OtherFile:      path.join(stemDir, 'other.m4a'),
    // Legacy vars kept for backward compat. Older macro versions read
    // M4ADir + suffix; point those at the SAME stem folder so they
    // still land in the right place if not yet updated.
    M4ADir:         stemDir,
    M4ABase:        s.b,
    // identity
    Title:          meta.title  || s.b,
    Artist:         meta.artist || '',
    Version:        meta.version || '',
    SourceUrl:      meta.source_url || '',
    // musical metadata
    BPM:            numStr(meta.bpm, 1),
    Key:            meta.key || '',
    KeySignature:   meta.key_signature || '',
    Duration:       numStr(activeDur, 2),
    Bars:           bars,
    ClipStartSec:   numStr(clipStart, 2),
    ClipEndSec:     numStr(clipEnd, 2),
    // reference links
    LyricsUrl:      meta.lyrics_search_url || '',
    ChordsUrl:      meta.chords_search_url || '',
  };

  // Phase 1 — atomic check-and-set, fully synchronous but tiny (~16 KBM
  // setvariable AppleEvents, sub-second total). The AppleScript reads the
  // current lock first; if held, it returns the existing owner WITHOUT
  // overwriting any variables. Otherwise it sets every variable, stamps
  // the lock, and returns "". This single tell-block is atomic from the
  // Engine's perspective — concurrent triggers can't interleave halfway.
  const setupLines = [
    `tell application "Keyboard Maestro Engine"`,
    `  set existingLock to getvariable "${KBM_RUNNING_VAR}"`,
    `  if existingLock is not "" then return existingLock`,
  ];
  for (const [k, v] of Object.entries(vars)) {
    setupLines.push(`  setvariable "${KBM_VAR_PREFIX}${k}" to "${asEscape(v)}"`);
  }
  // Stamp the lock LAST so all the song's variables are already in place
  // by the time any observer sees Running != "".
  setupLines.push(`  setvariable "${KBM_RUNNING_VAR}" to "${asEscape(s.b)}"`);
  setupLines.push(`  return ""`);
  setupLines.push(`end tell`);
  const setupScript = setupLines.join('\n');

  let lockOwner;
  try {
    const out = execFileSync('osascript', ['-e', setupScript],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    lockOwner = out.toString().trim();
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || '';
    return res.status(500).json({
      error: `Failed to set up KBM variables: ${e.message}${stderr ? ' — ' + stderr.trim() : ''}. Is KBM Engine running?`
    });
  }

  if (lockOwner) {
    // Lock was already held — macro is currently running for that song.
    return res.status(409).json({
      error: `Keyboard Maestro is already running simpleStem for "${lockOwner}". Wait for it to finish, or POST /api/logic-restem/unlock if the macro is stuck.`,
      lockedBy: lockOwner,
    });
  }

  // Phase 2 — fire the macro via the kmtrigger:// URL scheme, detached.
  // open(1) hands the URL to the OS URL handler and returns in ~50ms;
  // KBM picks it up out of band and runs the macro for its full 3
  // minutes without holding any handle back to this Node process.
  try {
    const proc = spawn('open',
      [`kmtrigger://macro=${encodeURIComponent(KBM_MACRO_NAME)}`],
      { detached: true, stdio: 'ignore' });
    proc.unref();
  } catch (e) {
    // Couldn't even fire open(1). Release the lock so the user isn't stuck.
    try {
      execFileSync('osascript', ['-e',
        `tell application "Keyboard Maestro Engine" to setvariable "${KBM_RUNNING_VAR}" to ""`
      ], { timeout: 5000 });
    } catch (e2) { /* best-effort */ }
    return res.status(500).json({ error: `Failed to fire kmtrigger URL: ${e.message}` });
  }

  console.log(`[logic-restem] ${s.b}: lock acquired, kmtrigger URL fired (detached)`);
  res.json({ ok: true, base: s.b, macro: KBM_MACRO_NAME, vars });
});

// Open the song's Logic Pro project in a FRESH Logic instance. macOS by
// default brings an existing Logic forward and opens the project there;
// 'open -n' forces a new process, so the user can have multiple Logic
// instances running in parallel — different songs, different XR18 output
// routings, all at once. Endpoint returns immediately; Logic launches in
// the background.
app.post('/api/song/:base/open-in-logic', (req, res) => {
  const s = safeSongDir(req.params.base);
  if (!s) return res.status(400).json({ error: 'bad song id' });
  if (!fs.existsSync(s.dir)) return res.status(404).json({ error: 'song folder not found' });
  const dirents = fs.readdirSync(s.dir);
  const proj = dirents.find(d => d.toLowerCase().endsWith('.logicx'));
  if (!proj) return res.status(404).json({ error: 'no .logicx project in this song folder' });
  const projPath = path.join(s.dir, proj);
  try {
    spawn('open', ['-n', '-a', 'Logic Pro', projPath], { detached: true, stdio: 'ignore' }).unref();
    console.log(`[logic-open] ${s.b}: spawned new Logic Pro for ${proj}`);
    res.json({ ok: true, project: proj });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual lock release — escape hatch for when the macro fails to clear
// simpleStem_Running on exit (macro doesn't exist yet, user aborted it
// from the KBM Editor, macro crashed, etc.). Idempotent.
app.post('/api/logic-restem/unlock', (req, res) => {
  try {
    execFileSync('osascript', ['-e',
      `tell application "Keyboard Maestro Engine" to setvariable "${KBM_RUNNING_VAR}" to ""`
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    console.log(`[logic-restem] unlocked: ${KBM_RUNNING_VAR} cleared`);
    res.json({ ok: true, note: `Cleared ${KBM_RUNNING_VAR} in KBM Engine.` });
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || '';
    res.status(500).json({ error: `Unlock failed: ${e.message}${stderr ? ' — ' + stderr.trim() : ''}` });
  }
});

// Precache every audio file for every song across every setlist in a gig.
// 'Every audio file' means: all WAVs in STEMS/<base>/ + all m4a variants in
// M4A/ whose filename starts with <base>_. The point is that when Gig Mode
// is on, NOTHING in the active gig should ever require a Drive fetch — every
// song row, every variant chip, every drum loop, every loop-mix m4a is
// already on local disk. Fire-and-forget; the client polls cache state.
app.post('/api/precache/gig/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const file = path.join(GIGS_DIR, `${slug}.json`);
  if (!file.startsWith(GIGS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'gig not found' });
  }
  let gig;
  try { gig = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  // Flatten unique bases across all the gig's setlists. Same base in multiple
  // setlists is normal (and what the user explicitly wanted) — only precache once.
  const bases = new Set();
  for (const sl of (gig.setlists || [])) {
    for (const s of (sl.songs || [])) {
      if (s.song_base) bases.add(s.song_base);
    }
  }
  res.json({ status: 'precaching', gig: slug, songs: bases.size });

  (async () => {
    const t0 = Date.now();
    let stems = 0, errors = 0;
    for (const base of bases) {
      // Cache m4a stems only. WAVs (source.wav, *.wav) stream directly from
      // Drive when requested. Mixdowns (M4A/<base>_*.m4a) also stream
      // directly — the portal uses simpleStem's stem-mixer for live play
      // and EZPerformer reads mixdowns from the EZ_*/ Drive folders instead.
      const folder = path.join(STEMS_DIR, base);
      try {
        if (fs.existsSync(folder)) {
          for (const f of (await fsp.readdir(folder)).filter(f => /\.m4a$/i.test(f))) {
            try {
              await ensureCachedAsync(path.join(folder, f), path.join(AUDIO_CACHE_STEMS, base, f));
              stems++;
            } catch (e) { errors++; }
          }
          // Mark the folder as cached so isStemsFolderCached() lights the chip.
          try {
            await fsp.mkdir(path.join(AUDIO_CACHE_STEMS, base), { recursive: true });
            await fsp.writeFile(
              path.join(AUDIO_CACHE_STEMS, base, '.cached'),
              JSON.stringify({ at: new Date().toISOString(), via: 'gig-precache' })
            );
          } catch (e) {}
        }
      } catch (e) { errors++; }
      // Mixdowns (M4A/<base>_*.m4a) deliberately skipped — they stream from
      // Drive on the rare occasion the portal needs them, and EZPerformer
      // reads them from the EZ_*/ Drive folders. Caching mixdowns added 35 GB
      // of duplicated audio (4,330 files in M4A/ when only 700 are current).
    }
    console.log(`[gig precache] ${slug}: ${stems} m4a stems across ${bases.size} songs in ${Math.round((Date.now()-t0)/1000)}s (errors: ${errors})`);
  })();
});

// ── Gigs CRUD ───────────────────────────────────────────────────────────────
// A 'gig' groups 1-4 setlists together as the unit you actually plan for —
// e.g. June 15 Concert = [Opening Set, Main Set, Encore]. Setlists are
// stored INLINE inside the gig file (not referenced) so duplicating a gig
// duplicates its setlists too; that's the workflow the user described
// ("duplicate a gig and modify the new gig's setlists").
//
// File shape: GIGS/<slug>.json
//   {
//     "title": "June 15 Concert",
//     "created_at": "...", "updated_at": "...",
//     "setlists": [
//       { "title": "Set 1", "songs": [{ "song_base": "..." }, ...] },
//       ...
//     ]
//   }
//
// Slug rule: same as setlists — title slugified to filesystem-safe ASCII.
function gigSlug(title) {
  return String(title || '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ── In-memory cache for GIGS/ and SETLISTS/ ──────────────────────────────────
// Drive FUSE makes readdirSync + readFileSync on these dirs surprisingly slow.
// Both dirs hold tiny JSON files so we keep ALL of them in memory and refresh
// per-file lazily on read (mtime check) instead of walking Drive each request.
// Eager-load at startup so the first /api/gigs request after boot is hot.
const fileCache = new Map();  // path -> { mtimeMs, data }

function readJsonCached(file) {
  try {
    const st = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    fileCache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch (e) {
    return null;
  }
}

function invalidateCachedFile(file) { fileCache.delete(file); }

function eagerLoadJsonDir(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'registry.json') continue;
    if (readJsonCached(path.join(dir, f))) n++;
  }
  return n;
}

// Kick off the warm-up at startup. Both calls run synchronously but only
// once; subsequent requests reuse the in-memory copies.
setImmediate(() => {
  const g = eagerLoadJsonDir(GIGS_DIR);
  const s = eagerLoadJsonDir(SETLISTS_DIR);
  console.log(`[cache] warmed GIGS=${g} SETLISTS=${s}`);
});

function readGig(slug) {
  // Prefer the local mirror so Drive being offline doesn't break gig load.
  const dir = bestGigsDir();
  const file = path.join(dir, `${slug}.json`);
  if (!file.startsWith(dir) || !fs.existsSync(file)) return null;
  return readJsonCached(file);
}
function writeGig(slug, body) {
  const jsonStr = JSON.stringify(body, null, 2) + '\n';
  writeBothJson(GIGS_DIR, GIGS_LOCAL_MIRROR, `${slug}.json`, jsonStr);
  invalidateCachedFile(path.join(GIGS_DIR, `${slug}.json`));
}
function validateGig(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.title || typeof body.title !== 'string') return 'title required';
  if (!Array.isArray(body.setlists)) return 'setlists must be an array';
  if (body.setlists.length > 4) return 'a gig can have at most 4 setlists';
  for (const sl of body.setlists) {
    if (!sl || typeof sl !== 'object') return 'each setlist must be an object';
    if (typeof sl.title !== 'string') return 'each setlist needs a title';
    if (!Array.isArray(sl.songs)) return 'each setlist needs songs[]';
  }
  return null;
}

app.get('/api/gigs', (req, res) => {
  const dir = bestGigsDir();
  if (!fs.existsSync(dir)) return res.json({ gigs: [] });
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = readJsonCached(path.join(dir, f));
      if (!d) continue;
      // Task #132: _ignored gigs are hidden from the sidebar. Set by
      // DELETE on a sheet-synced gig to keep mpb_sync from re-adding it.
      if (d._ignored) continue;
      const setlists = Array.isArray(d.setlists) ? d.setlists : [];
      out.push({
        slug: f.replace(/\.json$/i, ''),
        title: d.title || f.replace(/\.json$/i, ''),
        setlist_count: setlists.length,
        song_count: setlists.reduce((n, sl) => n + (sl.songs ? sl.songs.length : 0), 0),
        source: d.source || 'manual',
        created_at: d.created_at || null,
        updated_at: d.updated_at || null,
      });
    } catch (e) { /* skip unreadable */ }
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  res.json({ gigs: out });
});

app.get('/api/gigs/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const gig = readGig(slug);
  if (!gig) return res.status(404).json({ error: 'gig not found' });
  res.json({ slug, ...gig });
});

app.post('/api/gigs', (req, res) => {
  const body = req.body || {};
  const err = validateGig(body);
  if (err) return res.status(400).json({ error: err });
  const slug = gigSlug(body.title);
  if (!slug) return res.status(400).json({ error: 'title produced an empty slug' });
  const file = path.join(GIGS_DIR, `${slug}.json`);
  if (fs.existsSync(file)) return res.status(409).json({ error: 'a gig with that title already exists' });
  // Always start with at least one setlist so the UI has something to render
  const setlists = body.setlists.length ? body.setlists : [{ title: 'Set 1', songs: [] }];
  const now = new Date().toISOString();
  writeGig(slug, { title: body.title, created_at: now, updated_at: now, setlists });
  res.json({ ok: true, slug });
});

// ─── Gig Builder — deterministic query engine (task #132) ────────────
// Accepts a compact spec describing tonight's constraints and returns a
// DRAFT gig JSON the client can display, tweak, and eventually POST to
// /api/gigs. This endpoint has no side effects — it doesn't create,
// modify, or delete anything on disk. The client owns Accept/Discard.
//
// Input body (all fields optional except roster):
//   {
//     title:          "Sunday Practice Nov 2026",
//     roster:         ["Bill","Matt","Dan"],
//     purpose:        "practice" | "gig",
//     set_count:      4,               // default 4
//     target_minutes: 50,              // per set
//     max_minutes:    60,              // hard cap per set
//     tags_all:       ["harmonies"],   // require ALL of these tags
//     tags_none:      ["opener"],      // exclude any of these tags
//     modes:          ["6STEMS","DRUM","BACKING","NONE"],  // Show-filter
//     sequencing:     "round-robin" | "natural" | "warmup" | "alternating",
//     song_bases:     null | ["…"],    // if set, restrict to these songs
//   }
//
// The scoring/assembly is pure JS over the in-memory library cache. No
// network I/O; safe to call offline. Response is a full gig object with
// setlists filled and a _draft: true marker.
const ROSTER_TO_CAP = { Bill: 'B', Matt: 'M', Dan: 'D', JD: 'J', Mark: '#' };

function gbCapabilitySet(roster) {
  const caps = new Set();
  for (const name of roster || []) {
    const c = ROSTER_TO_CAP[name];
    if (c) caps.add(c);
  }
  return caps;
}
function gbSongPlaysWithRoster(song, caps) {
  const req = String(song.band_required_compact || '').toUpperCase();
  if (!req) return true;   // no constraint set → playable by anyone
  for (const ch of req) {
    if (ch === '#' && !caps.has('#')) {
      // Drums-role can be satisfied by a drum machine OR a backing track.
      const hasDrumMachine = !!(song.drum_pattern);
      // Best-effort backing-track check — the assignments map is authoritative.
      const hasBackingTrack = !!(backingTrackAssignments && backingTrackAssignments[song.folderName]);
      if (!hasDrumMachine && !hasBackingTrack) return false;
    } else if (!caps.has(ch)) {
      return false;
    }
  }
  return true;
}
function gbReadinessOk(song, purpose) {
  const r = song.readiness || 'tbd';
  if (purpose === 'gig') return r === 'InTheCan' || r === 'Rehearse';
  return r === 'Rehearse' || r === 'tbd';   // practice
}
function gbStalenessScore(song) {
  // Higher = older = more valuable in a practice setlist.
  if (!song.last_played_at) return 1.0;
  const days = (Date.now() - new Date(song.last_played_at).getTime()) / 86400000;
  return Math.min(1, days / 90);   // saturates at 3 months
}
function gbCurrentMode(song) {
  return song.playback_mode || (song.drum_machine_default ? 'drum' : '6STEMS');
}
function gbModePass(song, allowedModes) {
  if (!allowedModes || allowedModes.length === 0) return true;
  const m = gbCurrentMode(song);
  const norm = m.toUpperCase() === 'DRUM' ? 'DRUM' :
               m.toUpperCase() === 'STEMS' || m === '6STEMS' ? '6STEMS' :
               m.toUpperCase() === 'BACKING' ? 'BACKING' :
               m.toUpperCase() === 'NONE' ? 'NONE' : '6STEMS';
  return allowedModes.includes(norm);
}
function gbTagPass(song, tagsAll, tagsNone) {
  const tags = Array.isArray(song.tags) ? song.tags : [];
  if (tagsAll && tagsAll.length) {
    for (const t of tagsAll) if (!tags.includes(t)) return false;
  }
  if (tagsNone && tagsNone.length) {
    for (const t of tagsNone) if (tags.includes(t)) return false;
  }
  return true;
}

app.post('/api/gig-builder/build', express.json(), (req, res) => {
  const spec = req.body || {};
  const roster = Array.isArray(spec.roster) && spec.roster.length ? spec.roster : ['Bill','Matt','Dan'];
  const purpose = spec.purpose === 'gig' ? 'gig' : 'practice';
  const setCount = Math.max(1, Math.min(4, spec.set_count || 4));
  const targetSec = Math.max(20, Math.min(120, spec.target_minutes || 50)) * 60;
  const maxSec = Math.max(targetSec, (spec.max_minutes || 60) * 60);
  const tagsAll = Array.isArray(spec.tags_all) ? spec.tags_all : [];
  const tagsNone = Array.isArray(spec.tags_none) ? spec.tags_none : [];
  const modes = Array.isArray(spec.modes) ? spec.modes : ['6STEMS','DRUM','BACKING','NONE'];
  const sequencing = spec.sequencing || 'round-robin';
  const restrictBases = Array.isArray(spec.song_bases) && spec.song_bases.length
    ? new Set(spec.song_bases) : null;

  const songs = (libraryCache && libraryCache.data && libraryCache.data.songs) || [];
  const stems = songs.filter(s => s.type === 'stems');
  const caps = gbCapabilitySet(roster);

  // Filter
  const filtered = stems.filter(s => {
    if (restrictBases && !restrictBases.has(s.folderName)) return false;
    if (!gbSongPlaysWithRoster(s, caps)) return false;
    if (!gbReadinessOk(s, purpose)) return false;
    if (!gbTagPass(s, tagsAll, tagsNone)) return false;
    if (!gbModePass(s, modes)) return false;
    return true;
  });

  // Score
  const scored = filtered.map(s => {
    let score = 0;
    if (purpose === 'practice') {
      score += 0.7 * gbStalenessScore(s);
      score += (s.readiness === 'Rehearse') ? 0.4 : (s.readiness === 'tbd' ? 0.2 : 0);
    } else {
      score += 0.5 * Math.min(1, (s.play_count || 0) / 20);   // crowd-tested
      score += (s.readiness === 'InTheCan') ? 0.4 : 0.1;
    }
    if (s.favorite) score += 0.15;
    return { song: s, score };
  }).sort((a, b) => b.score - a.score);

  // Assemble into setCount setlists
  const singers = ['Bill','Matt','Dan','JD'].filter(name => roster.includes(name));
  const bySinger = {};
  for (const name of singers) bySinger[name] = [];
  for (const { song } of scored) {
    const singer = (song.singer_lead || '').split(/\s+/)[0] || 'Bill';
    if (bySinger[singer]) bySinger[singer].push(song);
  }

  const setlists = Array.from({ length: setCount }, (_, i) => ({
    title: `Set ${i + 1}`, songs: [],
  }));
  const setDur = new Array(setCount).fill(0);

  function pickNext(iRoundRobin) {
    if (sequencing === 'round-robin' && singers.length) {
      // Rotate through singer buckets until we find one with a song.
      for (let k = 0; k < singers.length; k++) {
        const singer = singers[(iRoundRobin + k) % singers.length];
        if (bySinger[singer].length) return { song: bySinger[singer].shift(), advance: k + 1 };
      }
      return null;
    }
    // Natural: highest-score first, ignoring singer buckets.
    if (!scored.length) return null;
    const next = scored.shift().song;
    // Remove from bucket too so re-runs stay consistent.
    for (const sg of singers) {
      const idx = bySinger[sg].indexOf(next);
      if (idx >= 0) bySinger[sg].splice(idx, 1);
    }
    return { song: next, advance: 1 };
  }

  let curSet = 0;
  let rrCursor = 0;
  const remaining = () => singers.some(sg => bySinger[sg].length) || scored.length > 0;
  let guard = 0;
  while (remaining() && guard++ < 300 && curSet < setCount) {
    const pick = pickNext(rrCursor);
    if (!pick) break;
    const song = pick.song;
    rrCursor = (rrCursor + pick.advance) % Math.max(1, singers.length);
    const dur = Number(song.duration_sec || song.duration || 180) + 8;   // +8s for transition
    if (setDur[curSet] + dur > maxSec) {
      curSet++;
      if (curSet >= setCount) break;
    }
    setlists[curSet].songs.push({
      song_base: song.folderName,
      title: song.title || song.folderName,
      artist: song.artist || '',
      singer: song.singer_lead || '',
      key: song.key_short || song.key || '',
      duration_sec: Number(song.duration_sec || song.duration || 0),
      mode: gbCurrentMode(song),
    });
    setDur[curSet] += dur;
    if (setDur[curSet] >= targetSec) {
      curSet++;
      if (curSet >= setCount) break;
    }
  }

  const total = setDur.reduce((a, b) => a + b, 0);
  res.json({
    ok: true,
    draft: {
      _draft: true,
      title: String(spec.title || `Draft gig ${new Date().toLocaleDateString()}`).slice(0, 96),
      spec,
      setlists,
      totals: {
        songs: setlists.reduce((a, s) => a + s.songs.length, 0),
        seconds: total,
        set_seconds: setDur,
      },
    },
    stats: {
      library_size: stems.length,
      filtered: filtered.length,
      scored: scored.length,
    },
  });
});

app.put('/api/gigs/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const existing = readGig(slug);
  if (!existing) return res.status(404).json({ error: 'gig not found' });
  const body = req.body || {};
  // PUT is full-replace of the editable fields (title + setlists).
  const err = validateGig({ title: body.title || existing.title, setlists: body.setlists });
  if (err) return res.status(400).json({ error: err });
  const newSlug = body.title && body.title !== existing.title ? gigSlug(body.title) : slug;
  const updated = {
    title: body.title || existing.title,
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    setlists: body.setlists,
  };
  if (newSlug !== slug) {
    // Title (and thus filename) changed. Refuse if the new slug collides
    // (check the mirror first to stay offline-safe); otherwise rename
    // atomically across BOTH Drive and the local mirror.
    const newMirror = path.join(GIGS_LOCAL_MIRROR, `${newSlug}.json`);
    const newDrive  = path.join(GIGS_DIR, `${newSlug}.json`);
    if (fs.existsSync(newMirror) || fs.existsSync(newDrive)) {
      return res.status(409).json({ error: 'a gig with that title already exists' });
    }
    writeGig(newSlug, updated);
    unlinkBoth(GIGS_DIR, GIGS_LOCAL_MIRROR, `${slug}.json`);
    invalidateCachedFile(path.join(GIGS_DIR, `${slug}.json`));
    return res.json({ ok: true, slug: newSlug, renamed_from: slug });
  }
  writeGig(slug, updated);
  res.json({ ok: true, slug });
});

app.post('/api/gigs/:slug/duplicate', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const src = readGig(slug);
  if (!src) return res.status(404).json({ error: 'gig not found' });
  const newTitle = (req.body && req.body.newTitle && String(req.body.newTitle).trim()) ||
    `${src.title} (copy)`;
  const newSlug = gigSlug(newTitle);
  if (!newSlug) return res.status(400).json({ error: 'newTitle produced an empty slug' });
  const newMirror = path.join(GIGS_LOCAL_MIRROR, `${newSlug}.json`);
  const newDrive  = path.join(GIGS_DIR, `${newSlug}.json`);
  if (fs.existsSync(newMirror) || fs.existsSync(newDrive)) {
    return res.status(409).json({ error: 'a gig with that title already exists' });
  }
  const now = new Date().toISOString();
  const setlists = (src.setlists || []).map(sl => ({
    title: sl.title,
    songs: (sl.songs || []).map(s => ({ song_base: s.song_base })),
  }));
  writeGig(newSlug, { title: newTitle, created_at: now, updated_at: now, setlists });
  res.json({ ok: true, slug: newSlug, source_slug: slug });
});

app.delete('/api/gigs/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const dir = bestGigsDir();
  const file = path.join(dir, `${slug}.json`);
  if (!file.startsWith(dir) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'gig not found' });
  }
  // Task #132: sheet-synced gigs get soft-deleted with _ignored:true.
  // The next mpb_sync.py run reads this field and skips regenerating
  // the gig, so it stays hidden until the operator either removes the
  // field or deletes the file entirely. Real (non-synced) gigs are
  // hard-deleted, unchanged behavior.
  const softMode = String(req.query.mode || '').toLowerCase() === 'hide';
  try {
    const gig = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    if (softMode || gig.source === 'mpb_sync') {
      gig._ignored = true;
      gig.ignored_at = new Date().toISOString();
      writeGig(slug, gig);
      return res.json({ ok: true, slug, mode: 'hidden', note: 'Sheet-synced gig hidden. Remove _ignored to restore.' });
    }
  } catch (e) { /* fall through to hard delete */ }
  unlinkBoth(GIGS_DIR, GIGS_LOCAL_MIRROR, `${slug}.json`);
  invalidateCachedFile(path.join(GIGS_DIR, `${slug}.json`));
  res.json({ ok: true, slug, mode: 'deleted' });
});

// Fallback to serve index.html for spa behavior
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

bootTrace('app.listen', 'ENTER', `port=${PORT}`);
app.listen(PORT, () => {
  bootTrace('app.listen', 'EXIT', `port=${PORT}`);
  console.log(`==================================================`);
  console.log(`Backing Track Construction Kit Server Running`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
