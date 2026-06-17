const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

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
const BOOT_VERSION = readDiskVersion();

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

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Paths to the media directories
// Root: ~/ClaudeDrive/simpleStem (browses the local filesystem, not the cloud).
// Derived from the home dir so it works on both Macs; override with
// SIMPLE_STEM_ROOT=/path if Drive is mounted somewhere non-default.
const SIMPLE_STEM_ROOT = process.env.SIMPLE_STEM_ROOT || path.join(os.homedir(), 'ClaudeDrive', 'simpleStem');
const STEMS_DIR = `${SIMPLE_STEM_ROOT}/STEMS`;
const M4A_DIR = `${SIMPLE_STEM_ROOT}/M4A`;
// Flat per-instrument loop folder. Filenames follow
//   <inst>_<bpm-padded-3>_<song-slug>_<bars>bars.m4a
// e.g. drums_120_mary_janes_last_dance_18bars.m4a
// Sortable alphabetically = sortable by (inst, BPM, song). Migrated from
// the older per-song STEMS/<song>/*_loop*.wav layout by migrate_loops.sh
// and produced directly by stem.sh going forward.
const LOOPS_DIR = `${SIMPLE_STEM_ROOT}/LOOPS`;
const INCOMING_DIR = `${SIMPLE_STEM_ROOT}/INCOMING_WEBLOC`;
const QUEUE_DIR = `${SIMPLE_STEM_ROOT}/STEM_QUEUE`;
const SETLISTS_DIR = `${SIMPLE_STEM_ROOT}/SETLISTS`;
const GIGS_DIR     = `${SIMPLE_STEM_ROOT}/GIGS`;
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
        // Favorite flag + timestamp — surfaced so the client renders a
        // star next to the song name and the Favorites pseudo-gig can
        // aggregate them.
        var favorite_meta = !!mj.favorite;
        var favorited_at_meta = mj.favorited_at || null;
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
 * Scan the M4A directory and return list of backing tracks.
 * If a matching STEMS folder exists, inherits title/artist/bpm/key/duration
 * from its metadata.json (avoids re-running ffprobe and gives accurate data).
 */
async function scanM4a(stemsByKey) {
  if (!fs.existsSync(M4A_DIR)) {
    console.warn(`M4A directory not found: ${M4A_DIR}`);
    return [];
  }
  // Async readdir with type filtering via Dirent — saves a per-file stat()
  // round-trip on Drive, where every stat is expensive.
  let dirents;
  try {
    dirents = await fsp.readdir(M4A_DIR, { withFileTypes: true });
  } catch (e) {
    console.warn(`[scan] could not read ${M4A_DIR}:`, e.message);
    return [];
  }
  const files = dirents
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.m4a'))
    .filter(d => !/ \(\d+\)\.m4a$/i.test(d.name))                      // skip ' (1)' duplicate downloads
    .filter(d => !/[_ ]loop\d+[_ ]\d+bars\.m4a$/i.test(d.name))        // skip loop artifacts
    .map(d => d.name);

  // Known variant suffixes appended after artist (e.g. Foo_Artist_-V-G-B.m4a).
  // Strip these BEFORE title/artist parsing, then label the variant.
  const VARIANT_PATTERNS = [
    { re: /_-V-G-B$/i,  code: '-V-G-B', label: 'No Vocals/Guitar/Bass' },
    { re: /_-V-G$/i,    code: '-V-G',   label: 'No Vocals/Guitar' },
    { re: /_-V-B$/i,    code: '-V-B',   label: 'No Vocals/Bass' },
    { re: /_-V$/i,      code: '-V',     label: 'No Vocals' },
    { re: /_DO$/i,      code: 'DO',     label: 'Drums Only' },
  ];

  return files.map(file => {
    const baseName = file.replace(/\.m4a$/i, '');
    let stripped = baseName;
    let variantCode = 'FULL';
    let variantLabel = 'Full Mix';
    for (const v of VARIANT_PATTERNS) {
      if (v.re.test(stripped)) {
        stripped = stripped.replace(v.re, '');
        variantCode = v.code;
        variantLabel = v.label;
        break;
      }
    }
    // Try to inherit metadata from a sibling STEMS folder (same stripped name).
    // E.g. Come_Together_Beatles_-V-G-B.m4a → STEMS/Come_Together_Beatles/metadata.json.
    let title, artist, duration, practiceBpm, originalBpm, key, keySignature;
    const sibling = stemsByKey && stemsByKey[stripped];
    if (sibling) {
      title = sibling.title;
      artist = sibling.artist;
      duration = sibling.duration;
      practiceBpm = sibling.practiceBpm;
      originalBpm = sibling.originalBpm;
      key = sibling.key;
      keySignature = sibling.keySignature;
    } else {
      const meta = parseSongMetadata(stripped, true);
      title = meta.title;
      artist = meta.artist;
      practiceBpm = meta.practiceBpm;
      originalBpm = meta.originalBpm;
      key = meta.key;
      duration = getAudioDuration(path.join(M4A_DIR, file));
    }
    return {
      id: `m4a-${file}`,
      type: 'm4a',
      fileName: file,
      title,
      artist,
      practiceBpm: practiceBpm || null,
      originalBpm: originalBpm || null,
      key,
      keySignature: keySignature || null,
      duration,
      cached: isM4aCached(file),
      variantCode,
      variantLabel
    };
  });
}

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
  const stemsByKey = {};
  for (const s of stems) stemsByKey[s.folderName] = s;
  const m4as = await scanM4a(stemsByKey);
  const allSongs = [...stems, ...m4as];

  // Stats are computed from unique songs (one entry per title+artist), not raw
  // file entries — so "Eminence Front" doesn't show up 4 times (stems + 3 m4a
  // variants) when counting "songs in F minor".
  const uniqueSongs = pickUniqueSongs(allSongs);

  const stats = {
    totalSongs:  uniqueSongs.length,                   // unique songs (was raw file count)
    totalFiles:  allSongs.length,                      // new: raw file count (stems + m4a entries)
    totalStems:  stems.length,
    totalM4as:   m4as.length,
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
  const out = { stems: null, m4a: null };
  try { out.stems = fs.statSync(STEMS_DIR).mtime.toISOString(); } catch (e) {}
  try { out.m4a   = fs.statSync(M4A_DIR).mtime.toISOString();   } catch (e) {}
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
mirrorCatalogOnce('startup');
try {
  if (fs.existsSync(path.dirname(CATALOG_DRIVE_PATH))) {
    fs.watch(path.dirname(CATALOG_DRIVE_PATH), (event, fname) => {
      if (fname === 'CATALOG.json') mirrorCatalogOnce('fs.watch');
    });
  }
} catch (e) {
  console.warn('[catalog] fs.watch setup failed:', e.message);
}
setInterval(() => mirrorCatalogOnce('poll'), 60 * 1000);

// Kick off a refresh on startup (background) and every hour after
refreshLibraryCache('startup');
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

// (the original handler below is unreachable now; left for reference)
app.get('/api/library__old', (req, res) => {
  try {
    const stems = scanStems();
    const stemsByKey = {};
    for (const s of stems) stemsByKey[s.folderName] = s;
    const m4as = scanM4a(stemsByKey);
    const allSongs = [...stems, ...m4as];

    // Compute library statistics (Instrumentation)
    const stats = {
      totalSongs: allSongs.length,
      totalStems: stems.length,
      totalM4as: m4as.length,
      artistCount: new Set(allSongs.map(s => s.artist).filter(a => a !== 'Unknown Artist')).size,
      bpmDistribution: {
        slow: allSongs.filter(s => s.practiceBpm && s.practiceBpm < 90).length,
        medium: allSongs.filter(s => s.practiceBpm && s.practiceBpm >= 90 && s.practiceBpm <= 125).length,
        fast: allSongs.filter(s => s.practiceBpm && s.practiceBpm > 125).length,
        unknown: allSongs.filter(s => !s.practiceBpm).length
      },
      keyDistribution: allSongs.reduce((acc, s) => {
        if (s.key) {
          acc[s.key] = (acc[s.key] || 0) + 1;
        }
        return acc;
      }, {}),
      singerDistribution: allSongs.reduce((acc, s) => {
        const who = (s.singer_lead || '').trim();
        const k = who || '(unassigned)';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
    };

    res.json({
      stats,
      songs: allSongs
    });
  } catch (error) {
    console.error('Error scanning library:', error);
    res.status(500).json({ error: 'Failed to scan music library' });
  }
});

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
async function ensureCachedAsync(sourcePath, cachePath) {
  try {
    try {
      const [csz, ssz] = await Promise.all([
        fsp.stat(cachePath).then(s => s.size).catch(() => -1),
        fsp.stat(sourcePath).then(s => s.size).catch(() => -2)
      ]);
      if (csz > 0 && csz === ssz) return cachePath; // good cache hit
    } catch (e) {}
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
function sendCachedAudio(req, res, sourcePath, cachePath) {
  if (!fs.existsSync(sourcePath)) {
    console.warn('[audio 404] source missing:', sourcePath);
    return res.status(404).send('Audio file not found');
  }
  let served = sourcePath;
  try {
    if (fs.existsSync(cachePath)) {
      const csz = fs.statSync(cachePath).size;
      const ssz = fs.statSync(sourcePath).size;
      if (csz === ssz && csz > 0) served = cachePath;
    }
  } catch (e) {}
  // dotfiles: 'allow' is required because our cache lives under ~/.bt-cache
  // and 'send' otherwise refuses any path with a dot-prefixed segment.
  res.sendFile(served, { dotfiles: 'allow' }, (err) => {
    if (err) console.warn('[audio sendFile err]', served, err.message);
  });
  // Cold-cache path → schedule background copy. setImmediate yields so the
  // sendFile response goes first. ensureCachedAsync handles dedup + errors.
  if (served === sourcePath && cachePath) {
    setImmediate(() => {
      ensureCachedAsync(sourcePath, cachePath).catch(() => {});
    });
  }
}

app.get('/api/audio/stems/:song/:file', (req, res) => {
  const { song, file } = req.params;
  if (song.includes('..') || file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(STEMS_DIR, song, file);
  // Cache policy: m4a stems only. WAVs are 6× larger and the mixer prefers
  // m4a anyway. WAV requests stream directly from Drive — no local copy.
  if (/\.wav$/i.test(file)) {
    if (!fs.existsSync(sourcePath)) return res.status(404).send('Audio file not found');
    return res.sendFile(sourcePath, { dotfiles: 'allow' });
  }
  const cachePath = path.join(AUDIO_CACHE_STEMS, song, file);
  sendCachedAudio(req, res, sourcePath, cachePath);
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

app.get('/api/audio/m4a/:file', (req, res) => {
  const { file } = req.params;
  if (file.includes('..')) return res.status(403).send('Forbidden');
  const sourcePath = path.join(M4A_DIR, file);
  // Mixdowns (-V, -V-G, -V-G-B, DO) stream directly from Drive. We rely on
  // simpleStem's stem-mixer for live use; mixdowns are an offline backup
  // (EZPerformer reads them from the EZ_*/ folders on Drive, not from here).
  // No local cache — keeps ~/.bt-cache small and predictable.
  if (!fs.existsSync(sourcePath)) return res.status(404).send('Audio file not found');
  res.sendFile(sourcePath, { dotfiles: 'allow' });
});

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
  if (!fs.existsSync(sourcePath)) return res.status(404).json({ ok: false, error: 'not found' });
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
async function precacheAllStemsM4a() {
  if (!fs.existsSync(STEMS_DIR)) return;
  const t0 = Date.now();
  let folders = 0, copied = 0, skipped = 0, failed = 0;
  try {
    const songFolders = (await fsp.readdir(STEMS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
    console.log(`[stem precache] starting — ${songFolders.length} song folders (4 in parallel)`);
    await runWithConcurrency(songFolders, 4, async (song) => {
      try {
        const src = path.join(STEMS_DIR, song);
        const dst = path.join(AUDIO_CACHE_STEMS, song);
        await fsp.mkdir(dst, { recursive: true });
        const files = (await fsp.readdir(src)).filter(f => /\.m4a$/i.test(f));
        let localCopied = 0;
        for (const f of files) {
          const cachePath = path.join(dst, f);
          if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
            skipped++; continue;
          }
          try {
            await ensureCachedAsync(path.join(src, f), cachePath);
            copied++; localCopied++;
          } catch (e) { failed++; }
        }
        // Per-folder sentinel — flips the UI's READY chip.
        try {
          await fsp.writeFile(
            path.join(dst, '.cached'),
            JSON.stringify({ at: new Date().toISOString(), files: localCopied })
          );
        } catch (e) { /* sentinel best-effort */ }
        folders++;
        if (folders % 25 === 0) {
          console.log(`[stem precache] progress: ${folders}/${songFolders.length} folders`);
        }
      } catch (e) { failed++; }
    });
    console.log(`[stem precache] done — ${folders} folders, copied ${copied}, skipped ${skipped}, failed ${failed} (${Math.round((Date.now()-t0)/1000)}s)`);
  } catch (e) {
    console.warn('[stem precache] failed:', e.message);
  }
}
// Full-library stem precache is the DEFAULT now. The portal pulls every
// m4a stem in STEMS/ into ~/.bt-cache/STEMS/ at boot and then again every
// hour. Result: any song plays instantly with no Drive fetch. Total
// footprint ~3 GB for ~180 songs (well under the 50 GB cache cap).
//
// The boot pass is async — it doesn't block the HTTP server; the server
// starts answering requests immediately and the cache fills in the
// background. The hourly tick picks up any newly-added songs and skips
// already-cached files cheaply (mtime+size check).
setImmediate(precacheAllStemsM4a);
setInterval(precacheAllStemsM4a, 60 * 60 * 1000);

// Manual trigger — POST /api/precache/library forces both passes immediately
// (useful after a big import or when prepping for a gig). Returns 202 fast;
// the work runs in the background and progress is in the server log.
app.post('/api/precache/library', (req, res) => {
  res.status(202).json({ status: 'started', m4a: 'background', stems: 'background' });
  setImmediate(precacheAllM4as);
  setImmediate(precacheAllStemsM4a);
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
        if (entry.startsWith('.') || entry === '_done') continue;
        const p = path.join(QUEUE_DIR, entry);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.queued.push({ name: entry, type: 'setlist', songs: countJson(p) });
        else if (entry.endsWith('.json')) out.queued.push({ name: entry, type: 'single', songs: 1 });
      }
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

// List all setlists (summaries only — title, origin, count, synced_at).
app.get('/api/setlists', (req, res) => {
  try {
    if (!fs.existsSync(SETLISTS_DIR)) return res.json({ setlists: [] });
    const out = [];
    for (const f of fs.readdirSync(SETLISTS_DIR)) {
      if (!f.endsWith('.json') || f === 'registry.json') continue;
      try {
        const d = readJsonCached(path.join(SETLISTS_DIR, f));
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
  const file = path.join(SETLISTS_DIR, `${slug}.json`);
  if (!file.startsWith(SETLISTS_DIR) || !fs.existsSync(file)) {
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
    fs.rmSync(file, { force: true });
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
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing.origin === 'playlist') {
        return res.status(409).json({ error: 'that name is a playlist-synced setlist; pick another' });
      }
    }
    if (!fs.existsSync(SETLISTS_DIR)) fs.mkdirSync(SETLISTS_DIR, { recursive: true });
    const payload = {
      origin: 'manual',
      title,
      created_at: new Date().toISOString(),
      count: songs.length,
      // store as ordered entries keyed by song_base; the client resolves details from /api/library
      songs: songs.map((sb, i) => ({ position: i + 1, song_base: sb })),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    invalidateCachedFile(file);
    res.json({ ok: true, slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Apply a staged update: relaunch via performer.sh so the new code runs. The
// restart is spawned DETACHED — it must outlive this very process (which it's
// about to kill + restart). We reply first, then trigger it a moment later.
app.post('/api/update', (req, res) => {
  const root = SIMPLE_STEM_ROOT_FOR_VERSION();
  const script = path.join(root, 'performer.sh');
  if (!fs.existsSync(script)) {
    return res.status(500).json({ error: 'performer.sh not found at root' });
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

// ── Per-song favorite flag ─────────────────────────────────────────────────
// Toggles meta.favorite (bool). The library scanner surfaces it in each
// stems row; the client renders a yellow star next to the song name and
// a synthetic Favorites pseudo-gig aggregates all songs where the flag
// is true. No restem / no audio change — purely a marker.
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

  const vars = {
    // paths
    SourceDir:      s.dir,
    SourceWav:      sourceWav,
    M4ADir:         M4A_DIR,
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
  const file = path.join(GIGS_DIR, `${slug}.json`);
  if (!file.startsWith(GIGS_DIR) || !fs.existsSync(file)) return null;
  return readJsonCached(file);
}
function writeGig(slug, body) {
  if (!fs.existsSync(GIGS_DIR)) fs.mkdirSync(GIGS_DIR, { recursive: true });
  const file = path.join(GIGS_DIR, `${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  invalidateCachedFile(file);
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
  if (!fs.existsSync(GIGS_DIR)) return res.json({ gigs: [] });
  const out = [];
  for (const f of fs.readdirSync(GIGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = readJsonCached(path.join(GIGS_DIR, f));
      if (!d) continue;
      const setlists = Array.isArray(d.setlists) ? d.setlists : [];
      out.push({
        slug: f.replace(/\.json$/i, ''),
        title: d.title || f.replace(/\.json$/i, ''),
        setlist_count: setlists.length,
        song_count: setlists.reduce((n, sl) => n + (sl.songs ? sl.songs.length : 0), 0),
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
    // Title (and thus filename) changed. Refuse if the new slug collides;
    // otherwise rename atomically.
    const newFile = path.join(GIGS_DIR, `${newSlug}.json`);
    if (fs.existsSync(newFile)) return res.status(409).json({ error: 'a gig with that title already exists' });
    writeGig(newSlug, updated);
    const oldFile = path.join(GIGS_DIR, `${slug}.json`);
    fs.rmSync(oldFile, { force: true });
    invalidateCachedFile(oldFile);
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
  const newFile = path.join(GIGS_DIR, `${newSlug}.json`);
  if (fs.existsSync(newFile)) return res.status(409).json({ error: 'a gig with that title already exists' });
  const now = new Date().toISOString();
  // Deep clone the setlists so the copy doesn't share references with the source.
  const setlists = (src.setlists || []).map(sl => ({
    title: sl.title,
    songs: (sl.songs || []).map(s => ({ song_base: s.song_base })),
  }));
  writeGig(newSlug, { title: newTitle, created_at: now, updated_at: now, setlists });
  res.json({ ok: true, slug: newSlug, source_slug: slug });
});

app.delete('/api/gigs/:slug', (req, res) => {
  const slug = path.basename(req.params.slug).replace(/\.json$/i, '');
  const file = path.join(GIGS_DIR, `${slug}.json`);
  if (!file.startsWith(GIGS_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'gig not found' });
  }
  fs.rmSync(file, { force: true });
  invalidateCachedFile(file);
  res.json({ ok: true, slug });
});

// Fallback to serve index.html for spa behavior
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Backing Track Construction Kit Server Running`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
