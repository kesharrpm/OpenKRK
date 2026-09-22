const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const MIDI_EXTENSIONS = new Set(['.mid', '.midi', '.kar']);
const SOUND_BANK_EXTENSIONS = new Set(['.sf2', '.sf3', '.sfogg', '.dls']);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MAX_LIBRARY_FILES = 100000;
const MAX_VISUAL_FILES = 12000;
const LOCAL_CODE_MIN = 10000;
const LOCAL_CODE_RANGE = 90000;

let songIndex = [];
let songByCode = new Map();
let visualIndex = [];
let allowedBinaryPaths = new Set();
let settings = { mediaRoot: '', libraryRoot: '', bgvRoot: '', soundBankPath: '' };
let scanState = { scanning: false, root: '', scanned: 0, songs: 0, visuals: 0 };
let metadataCache = {};
let lastMusicBrainzRequestAt = 0;
let lastItunesRequestAt = 0;
const artworkDataCache = new Map();

function settingsFile() { return path.join(app.getPath('userData'), 'openkrk-settings.json'); }
function libraryCacheFile() { return path.join(app.getPath('userData'), 'openkrk-library-index.json'); }
function metadataCacheFile() { return path.join(app.getPath('userData'), 'openkrk-metadata-cache.json'); }
function discoveryCacheFile() { return path.join(app.getPath('userData'), 'openkrk-discovery-cache.json'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (error) {
    console.warn('[OpenKRK] Could not save', file, error.message);
  }
}
function normalize(value = '') {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function canonicalPath(filePath) { return path.resolve(String(filePath || '')).toLowerCase(); }
function cleanTransportSuffix(value = '') {
  return String(value)
    .replace(/\.(xtsp|hmc|enc|pack)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hydrateSongFreshness(files, previousSongs = []) {
  const previousByPath = new Map(previousSongs.filter(Boolean).map(song => [canonicalPath(song.path), song]));
  const now = Date.now();
  const songs = [];
  const concurrency = 96;
  for (let start = 0; start < files.length; start += concurrency) {
    const batch = files.slice(start, start + concurrency);
    const hydrated = await Promise.all(batch.map(async filePath => {
      const parsed = parseSongFilename(filePath);
      const previous = previousByPath.get(canonicalPath(filePath));
      let mtimeMs = Number(previous?.mtimeMs) || 0;
      try { mtimeMs = (await fs.promises.stat(filePath)).mtimeMs || mtimeMs; } catch {}
      return {
        ...parsed,
        mtimeMs,
        firstSeenAt: Number(previous?.firstSeenAt) || now,
        lastSeenAt: now
      };
    }));
    songs.push(...hydrated);
    await new Promise(resolve => setImmediate(resolve));
  }
  return songs;
}

function newestSongs(limit = 10) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 40));
  return [...songIndex]
    .sort((a, b) => (Number(b.firstSeenAt) - Number(a.firstSeenAt)) || (Number(b.mtimeMs) - Number(a.mtimeMs)) || String(a.title).localeCompare(String(b.title)))
    .slice(0, max);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function escapeMbQuery(value = '') { return String(value).replace(/[\\"]/g, match => '\\' + match).trim(); }

async function musicBrainzJson(url) {
  const wait = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt));
  if (wait) await sleep(wait);
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'OpenKRK/0.3 (https://github.com/kesharrpm/OpenKRK)'
    },
    redirect: 'follow'
  });
  lastMusicBrainzRequestAt = Date.now();
  if (!response.ok) throw new Error('MusicBrainz HTTP ' + response.status);
  return response.json();
}


function cleanDiscoveryText(value = '') {
  return normalize(String(value)
    .replace(/\([^)]*(feat|ft|remaster|version|edit|mix)[^)]*\)/ig, ' ')
    .replace(/\[[^\]]*(feat|ft|remaster|version|edit|mix)[^\]]*\]/ig, ' ')
    .replace(/\s+-\s+(remaster(ed)?|live|radio edit|single version).*$/ig, ' '));
}

function songTitleKey(song) { return cleanDiscoveryText(song?.title || ''); }
function songArtistKey(song) { return cleanDiscoveryText(song?.artist || ''); }

function buildDiscoveryLookup() {
  const byTitle = new Map();
  for (const song of songIndex) {
    const key = songTitleKey(song);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(song);
  }
  return byTitle;
}

function tokenSimilarity(a = '', b = '') {
  const left = new Set(cleanDiscoveryText(a).split(' ').filter(Boolean));
  const right = new Set(cleanDiscoveryText(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

function matchDiscoveryCandidate(candidate, byTitle) {
  const titleKey = cleanDiscoveryText(candidate.title);
  const artistKey = cleanDiscoveryText(candidate.artist);
  if (!titleKey || !artistKey) return null;

  const direct = byTitle.get(titleKey) || [];
  let best = null;
  let bestScore = 0;
  for (const song of direct) {
    const localArtist = songArtistKey(song);
    if (!localArtist || localArtist === 'unknown artist') continue;
    const artistScore = tokenSimilarity(localArtist, artistKey);
    if (artistScore < 0.72) continue;
    const score = artistScore + (localArtist === artistKey ? 0.4 : 0);
    if (score > bestScore) { best = song; bestScore = score; }
  }
  return best;
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OpenKRK/0.3 (https://github.com/kesharrpm/OpenKRK)',
        ...headers
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}


async function itunesJson(url) {
  const wait = Math.max(0, 3200 - (Date.now() - lastItunesRequestAt));
  if (wait) await sleep(wait);
  const json = await fetchJsonWithTimeout(url, {}, 9000);
  lastItunesRequestAt = Date.now();
  return json;
}

function scoreTrackMatch(localTitle, localArtist, item, durationMs = 0) {
  const titleScore = tokenSimilarity(localTitle, item.trackName || '');
  const artistScore = tokenSimilarity(localArtist, item.artistName || '');
  const exactTitle = cleanDiscoveryText(localTitle) === cleanDiscoveryText(item.trackName || '');
  const exactArtist = cleanDiscoveryText(localArtist) === cleanDiscoveryText(item.artistName || '');
  if (titleScore < 0.84) return 0;
  if (localArtist && localArtist !== 'Unknown Artist' && artistScore < 0.58) return 0;
  let durationScore = 0;
  if (durationMs > 0 && Number(item.trackTimeMillis) > 0) {
    const ratio = Math.abs(Number(item.trackTimeMillis) - durationMs) / Math.max(durationMs, Number(item.trackTimeMillis));
    if (ratio <= 0.06) durationScore = 0.10;
    else if (ratio <= 0.12) durationScore = 0.05;
    else if (ratio >= 0.25) durationScore = -0.12;
  }
  return (titleScore * 0.68) + (artistScore * 0.27) + (exactTitle ? 0.08 : 0) + (exactArtist ? 0.07 : 0) + durationScore;
}

async function searchItunesTrack(title, artist, durationMs = 0) {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', [title, artist].filter(Boolean).join(' '));
  url.searchParams.set('country', 'US');
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', '25');

  const json = await itunesJson(url);
  let best = null;
  let bestScore = 0;
  for (const item of json?.results || []) {
    const score = scoreTrackMatch(title, artist, item, durationMs);
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 0.82 ? best : null;
}

async function artworkToDataUrl(url) {
  const target = String(url || '');
  if (!target || !/^https:\/\//i.test(target)) return '';
  let parsed;
  try { parsed = new URL(target); } catch { return ''; }
  const host = parsed.hostname.toLowerCase();
  const allowed = host.endsWith('.mzstatic.com') || host === 'coverartarchive.org' || host.endsWith('.coverartarchive.org');
  if (!allowed) return '';
  if (artworkDataCache.has(target)) return artworkDataCache.get(target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(target, {
      headers: { 'User-Agent': 'OpenKRK/0.4 (https://github.com/kesharrpm/OpenKRK)' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) return '';
    const type = response.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 5 * 1024 * 1024) return '';
    const data = 'data:' + type + ';base64,' + buffer.toString('base64');
    artworkDataCache.set(target, data);
    if (artworkDataCache.size > 120) {
      const first = artworkDataCache.keys().next().value;
      artworkDataCache.delete(first);
    }
    return data;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAppleGlobalCharts() {
  const storefronts = [
    ['us', 'US'], ['gb', 'UK'], ['ca', 'Canada'], ['au', 'Australia'],
    ['jp', 'Japan'], ['kr', 'Korea'], ['de', 'Germany'], ['fr', 'France'],
    ['br', 'Brazil'], ['mx', 'Mexico'], ['za', 'South Africa'], ['sg', 'Singapore']
  ];

  const responses = await Promise.allSettled(storefronts.map(async ([code, label]) => {
    const url = 'https://rss.applemarketingtools.com/api/v2/' + code + '/music/most-played/50/songs.json';
    const json = await fetchJsonWithTimeout(url);
    return (json?.feed?.results || []).map((item, index) => ({
      title: item.name || '',
      artist: item.artistName || '',
      releaseDate: item.releaseDate || '',
      artworkUrl: item.artworkUrl100 || '',
      market: label,
      rank: index + 1
    }));
  }));

  const merged = new Map();
  for (const response of responses) {
    if (response.status !== 'fulfilled') continue;
    for (const item of response.value) {
      const key = cleanDiscoveryText(item.title) + '|' + cleanDiscoveryText(item.artist);
      if (!key || key === '|') continue;
      const score = Math.max(1, 51 - item.rank);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...item,
          markets: [item.market],
          globalScore: score
        });
      } else {
        existing.globalScore += score;
        if (!existing.markets.includes(item.market)) existing.markets.push(item.market);
        if (item.rank < existing.rank) {
          existing.rank = item.rank;
          existing.artworkUrl = item.artworkUrl || existing.artworkUrl;
          existing.releaseDate = item.releaseDate || existing.releaseDate;
        }
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => (b.globalScore - a.globalScore) || (a.rank - b.rank))
    .slice(0, 250)
    .map(item => ({
      title: item.title,
      artist: item.artist,
      releaseDate: item.releaseDate,
      artworkUrl: item.artworkUrl,
      source: 'Apple Music Global',
      sourceKind: 'chart',
      rank: item.rank,
      globalScore: item.globalScore,
      markets: item.markets
    }));
}

async function fetchMusicBrainzRecentReleases() {
  const end = new Date();
  const start = new Date(end.getTime() - 75 * 24 * 60 * 60 * 1000);
  const iso = date => date.toISOString().slice(0, 10);
  const url = new URL('https://musicbrainz.org/ws/2/release/');
  url.searchParams.set('query', 'date:[' + iso(start) + ' TO ' + iso(end) + '] AND status:official');
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', '100');
  const json = await musicBrainzJson(url);
  return (json?.releases || []).map(item => ({
    title: item.title || '',
    artist: (item['artist-credit'] || []).map(credit => credit.name || credit.artist?.name).filter(Boolean).join(''),
    releaseDate: item.date || '',
    artworkUrl: item.id ? 'https://coverartarchive.org/release/' + item.id + '/front-250' : '',
    source: 'MusicBrainz Recent',
    sourceKind: 'release',
    rank: 999
  }));
}

function discoverySortValue(item) {
  const time = Date.parse(item.releaseDate || '') || 0;
  const sourceBoost = item.sourceKind === 'release' ? 100000 : 0;
  const rankBoost = item.sourceKind === 'chart' ? Math.max(0, 101 - Number(item.rank || 101)) : 0;
  return time + sourceBoost + rankBoost;
}

async function discoverCurrentLibrarySongs(limit = 10, force = false) {
  const max = Math.max(1, Math.min(Number(limit) || 36, 80));
  const cached = readJson(discoveryCacheFile(), null);
  const cacheAge = cached?.fetchedAt ? Date.now() - Number(cached.fetchedAt) : Infinity;
  if (!force && cached?.version === 2 && cached?.items?.length && cacheAge < 6 * 60 * 60 * 1000) {
    const byCode = new Map(songIndex.map(song => [String(song.code), song]));
    const restored = cached.items.map(item => {
      const song = byCode.get(String(item.code));
      return song ? { ...song, discovery: item.discovery } : null;
    }).filter(Boolean).slice(0, max);
    if (restored.length) return { ...cached, items: restored, cached: true };
  }

  const candidates = [];
  const errors = [];
  const results = await Promise.allSettled([
    fetchAppleGlobalCharts(),
    fetchMusicBrainzRecentReleases()
  ]);
  for (const result of results) {
    if (result.status === 'fulfilled') candidates.push(...result.value);
    else errors.push(result.reason?.message || String(result.reason));
  }

  const byTitle = buildDiscoveryLookup();
  const matched = [];
  const usedCodes = new Set();
  const recentCutoff = Date.now() - (540 * 24 * 60 * 60 * 1000);
  for (const candidate of candidates) {
    const candidateDate = Date.parse(candidate.releaseDate || '') || 0;
    if (candidate.sourceKind === 'chart' && candidateDate && candidateDate < recentCutoff) continue;
    const song = matchDiscoveryCandidate(candidate, byTitle);
    if (!song || usedCodes.has(String(song.code))) continue;
    usedCodes.add(String(song.code));
    matched.push({
      ...song,
      discovery: {
        title: candidate.title,
        artist: candidate.artist,
        releaseDate: candidate.releaseDate,
        artworkUrl: candidate.artworkUrl,
        source: candidate.source,
        sourceKind: candidate.sourceKind,
        rank: candidate.rank,
        globalScore: candidate.globalScore || 0,
        markets: candidate.markets || []
      }
    });
  }

  matched.sort((a, b) => discoverySortValue(b.discovery) - discoverySortValue(a.discovery));
  const items = matched.slice(0, max);
  const payload = {
    version: 2,
    fetchedAt: Date.now(),
    source: results.some(result => result.status === 'fulfilled') ? 'ONLINE' : 'OFFLINE',
    sources: [
      ...(results[0]?.status === 'fulfilled' ? ['Apple Music Global'] : []),
      ...(results[1]?.status === 'fulfilled' ? ['MusicBrainz Recent'] : [])
    ],
    candidateCount: candidates.length,
    matchedCount: matched.length,
    errors,
    items
  };

  writeJson(discoveryCacheFile(), {
    ...payload,
    items: items.map(item => ({
      code: item.code,
      discovery: item.discovery
    }))
  });
  return payload;
}

async function resolveSongMetadata(song) {
  if (!song?.title) return null;
  const cleanTitle = cleanTransportSuffix(song.title);
  const cleanArtist = cleanTransportSuffix(song.artist || '');
  const cacheKey = normalize(cleanTitle + '|' + cleanArtist);
  const cached = metadataCache[cacheKey];
  if (cached && Number(cached.cachedAt || 0) > Date.now() - (30 * 24 * 60 * 60 * 1000)) return cached;

  let metadata = null;

  try {
    const item = await searchItunesTrack(cleanTitle, cleanArtist, Number(song.durationMs) || 0);
    if (item) {
      metadata = {
        source: 'iTunes Search',
        matched: true,
        title: item.trackName || cleanTitle,
        artist: item.artistName || cleanArtist,
        album: item.collectionName || '',
        releaseDate: item.releaseDate || '',
        genre: item.primaryGenreName || '',
        durationMs: Number(item.trackTimeMillis) || 0,
        artworkUrl: item.artworkUrl100 || '',
        storeUrl: item.trackViewUrl || '',
        cachedAt: Date.now()
      };
    }
  } catch (error) {
    console.warn('[OpenKRK] iTunes metadata lookup failed:', error.message);
  }

  if (!metadata) {
    const queryParts = ['recording:"' + escapeMbQuery(cleanTitle) + '"'];
    if (cleanArtist && cleanArtist !== 'Unknown Artist') queryParts.push('artist:"' + escapeMbQuery(cleanArtist) + '"');
    const searchUrl = new URL('https://musicbrainz.org/ws/2/recording/');
    searchUrl.searchParams.set('query', queryParts.join(' AND '));
    searchUrl.searchParams.set('fmt', 'json');
    searchUrl.searchParams.set('limit', '10');

    try {
      const search = await musicBrainzJson(searchUrl);
      const recordings = search.recordings || [];
      let recording = null;
      let bestScore = 0;
      for (const candidate of recordings) {
        const candidateArtist = (candidate['artist-credit'] || []).map(item => item.name || item.artist?.name).filter(Boolean).join(' ');
        const titleScore = tokenSimilarity(cleanTitle, candidate.title || '');
        const artistScore = tokenSimilarity(cleanArtist, candidateArtist);
        if (titleScore < 0.84 || (cleanArtist && cleanArtist !== 'Unknown Artist' && artistScore < 0.58)) continue;
        const score = titleScore * 0.7 + artistScore * 0.3;
        if (score > bestScore) { recording = candidate; bestScore = score; }
      }

      if (recording) {
        const detailUrl = new URL('https://musicbrainz.org/ws/2/recording/' + recording.id);
        detailUrl.searchParams.set('inc', 'artist-credits+releases+release-groups');
        detailUrl.searchParams.set('fmt', 'json');
        let detail = recording;
        try { detail = await musicBrainzJson(detailUrl); } catch {}

        const artist = (detail['artist-credit'] || recording['artist-credit'] || []).map(item => item.name || item.artist?.name).filter(Boolean).join('');
        const releases = detail.releases || recording.releases || [];
        const release = releases.find(item => item.date) || releases[0] || null;
        const releaseGroupId = release?.['release-group']?.id || detail.releases?.[0]?.['release-group']?.id || '';
        metadata = {
          source: 'MusicBrainz',
          matched: true,
          title: detail.title || recording.title || cleanTitle,
          artist: artist || cleanArtist,
          album: release?.title || '',
          releaseDate: release?.date || detail['first-release-date'] || recording['first-release-date'] || '',
          genre: '',
          durationMs: Number(detail.length || recording.length) || 0,
          artworkUrl: releaseGroupId
            ? 'https://coverartarchive.org/release-group/' + releaseGroupId + '/front-500'
            : (release?.id ? 'https://coverartarchive.org/release/' + release.id + '/front-500' : ''),
          storeUrl: '',
          cachedAt: Date.now()
        };
      }
    } catch (error) {
      console.warn('[OpenKRK] MusicBrainz metadata lookup failed:', error.message);
    }
  }

  if (!metadata) {
    metadata = {
      source: '',
      matched: false,
      title: cleanTitle || song.title,
      artist: cleanArtist || song.artist || '',
      album: '',
      releaseDate: '',
      genre: '',
      durationMs: 0,
      artworkUrl: '',
      storeUrl: '',
      cachedAt: Date.now()
    };
  }

  metadataCache[cacheKey] = metadata;
  writeJson(metadataCacheFile(), metadataCache);
  return metadata;
}

function parseSongFilename(filePath) {
  const ext = path.extname(filePath);
  const stem = cleanTransportSuffix(path.basename(filePath, ext).trim());
  const chunks = stem.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);
  let code = '';
  let title = stem;
  let artist = 'Unknown Artist';

  if (chunks.length >= 3 && /^\d{3,7}$/.test(chunks[0])) {
    code = chunks[0]; title = chunks.slice(1, -1).join(' - '); artist = chunks[chunks.length - 1];
  } else if (chunks.length >= 2 && /^\d{3,7}$/.test(chunks[0])) {
    code = chunks[0]; title = chunks.slice(1).join(' - ');
  } else if (chunks.length >= 2) {
    artist = chunks[0]; title = chunks.slice(1).join(' - ');
  } else {
    const codeMatch = stem.match(/^\s*(\d{3,7})[\s._-]+(.+)$/);
    if (codeMatch) { code = codeMatch[1]; title = codeMatch[2].replace(/[_.]+/g, ' ').trim(); }
  }

  return { code, sourceCode: code, generatedCode: false, title, artist, path: filePath, ext: ext.toLowerCase(), key: normalize(`${code} ${title} ${artist}`) };
}

function hashPath(value) {
  let hash = 2166136261;
  const input = String(value).toLowerCase().replace(/\\/g, '/');
  for (let i = 0; i < input.length; i += 1) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function assignLocalCodes(songs, previousSongs = []) {
  const previousByPath = new Map();
  const validDisplayCode = value => /^\d{4,5}$/.test(String(value || ''));

  for (const previous of previousSongs) {
    if (previous?.path && previous?.generatedCode && validDisplayCode(previous?.code)) {
      previousByPath.set(canonicalPath(previous.path), String(previous.code));
    }
  }

  const used = new Set();
  for (const song of songs) {
    const original = String(song.sourceCode || song.code || '').trim();
    song.sourceCode = original;

    if (song.generatedCode || !validDisplayCode(song.code)) {
      song.code = '';
      song.generatedCode = true;
    } else {
      song.code = String(song.code);
      song.generatedCode = false;
      used.add(song.code);
    }
  }

  const needsLocalCode = songs.filter(song => !song.code)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));

  for (const song of needsLocalCode) {
    const lookupKey = canonicalPath(song.path);
    let code = previousByPath.get(lookupKey) || '';
    if (!validDisplayCode(code) || used.has(code)) {
      let candidate = LOCAL_CODE_MIN + (hashPath(lookupKey) % LOCAL_CODE_RANGE);
      let attempts = 0;
      while (used.has(String(candidate)) && attempts < LOCAL_CODE_RANGE) {
        candidate = LOCAL_CODE_MIN + ((candidate - LOCAL_CODE_MIN + 1) % LOCAL_CODE_RANGE);
        attempts += 1;
      }
      code = String(candidate);
    }
    song.code = code;
    song.generatedCode = true;
    used.add(code);
  }

  for (const song of songs) {
    song.key = normalize(`${song.code} ${song.sourceCode || ''} ${song.title} ${song.artist}`);
  }
  return songs;
}

function deriveVisualCategory(filePath, root) {
  const relativeParent = path.relative(root, path.dirname(filePath));
  if (!relativeParent || relativeParent === '.') return 'General';
  const parts = relativeParent.split(path.sep).filter(Boolean);
  return (parts[parts.length - 1] || 'General').replace(/[_-]+/g, ' ').trim() || 'General';
}
function makeVisualRecord(filePath, root) {
  return { path: filePath, category: deriveVisualCategory(filePath, root), folder: path.basename(path.dirname(filePath)) || 'General', name: path.basename(filePath, path.extname(filePath)) };
}
function normalizeVisuals(items, root) {
  return (items || []).map(item => {
    if (typeof item === 'string') return makeVisualRecord(item, root);
    if (!item?.path) return null;
    return { path: item.path, category: item.category || deriveVisualCategory(item.path, root), folder: item.folder || path.basename(path.dirname(item.path)) || 'General', name: item.name || path.basename(item.path, path.extname(item.path)) };
  }).filter(Boolean).filter(item => fs.existsSync(item.path));
}

function rebuildMaps() {
  songByCode = new Map();
  allowedBinaryPaths = new Set();
  for (const song of songIndex) {
    if (song.code && !songByCode.has(song.code)) songByCode.set(song.code, song);
    if (song.path) allowedBinaryPaths.add(canonicalPath(song.path));
  }
  if (settings.soundBankPath) allowedBinaryPaths.add(canonicalPath(settings.soundBankPath));
}

function loadCachedLibrary() {
  const cached = readJson(libraryCacheFile(), null);
  if (!cached || !cached.root || !Array.isArray(cached.songs) || !fs.existsSync(cached.root)) return;
  const normalizedSongs = cached.songs.map(song => {
    const title = cleanTransportSuffix(song.title || '');
    const artist = cleanTransportSuffix(song.artist || '');
    const normalized = {
      ...song,
      title: title || song.title,
      artist: artist || song.artist,
      sourceCode: song.sourceCode ?? (song.generatedCode ? '' : (song.code || '')),
      generatedCode: Boolean(song.generatedCode)
    };
    normalized.key = normalize(`${normalized.code || ''} ${normalized.title || ''} ${normalized.artist || ''}`);
    return normalized;
  });
  songIndex = assignLocalCodes(normalizedSongs.map(song => ({ ...song, firstSeenAt: Number(song.firstSeenAt) || Number(song.mtimeMs) || Date.now(), mtimeMs: Number(song.mtimeMs) || 0 })), cached.songs);
  const visualRoot = cached.visualRoot || settings.bgvRoot || cached.root;
  visualIndex = normalizeVisuals(cached.visuals, visualRoot);
  settings.mediaRoot = cached.root;
  settings.libraryRoot = cached.root;
  if (!settings.bgvRoot) settings.bgvRoot = visualRoot;
  rebuildMaps();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1100, minHeight: 650, backgroundColor: '#050506', autoHideMenuBar: true, title: 'OpenKRK',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

async function collectMedia(root, onProgress) {
  const midiFiles = [];
  const videoFiles = [];
  const stack = [root];
  let visited = 0;
  while (stack.length && (midiFiles.length < MAX_LIBRARY_FILES || videoFiles.length < MAX_VISUAL_FILES)) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        visited += 1;
        const ext = path.extname(entry.name).toLowerCase();
        if (MIDI_EXTENSIONS.has(ext) && midiFiles.length < MAX_LIBRARY_FILES) midiFiles.push(full);
        if (VIDEO_EXTENSIONS.has(ext) && videoFiles.length < MAX_VISUAL_FILES) videoFiles.push(full);
      }
      if (visited % 750 === 0) { onProgress?.({ visited, songs: midiFiles.length, visuals: videoFiles.length }); await new Promise(resolve => setImmediate(resolve)); }
    }
  }
  onProgress?.({ visited, songs: midiFiles.length, visuals: videoFiles.length });
  return { midiFiles, videoFiles, visited };
}

async function collectFiles(root, extensions, limit) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function saveLibraryCache(root) {
  writeJson(libraryCacheFile(), { version: 4, root, visualRoot: settings.bgvRoot || root, songs: songIndex, visuals: visualIndex });
}

async function scanLibrary(root, sender) {
  if (scanState.scanning) return { busy: true, ...scanState };
  scanState = { scanning: true, root, scanned: 0, songs: 0, visuals: 0 };
  sender?.send('library:scan-progress', scanState);
  try {
    const previousSongs = songIndex;
    const media = await collectMedia(root, progress => {
      scanState.scanned = progress.visited; scanState.songs = progress.songs; scanState.visuals = progress.visuals;
      sender?.send('library:scan-progress', { ...scanState });
    });
    const hydratedSongs = await hydrateSongFreshness(media.midiFiles, previousSongs);
    songIndex = assignLocalCodes(hydratedSongs, previousSongs);
    settings.mediaRoot = root;
    settings.libraryRoot = root;
    if (!settings.bgvRoot) settings.bgvRoot = root;
    if (!visualIndex.length || canonicalPath(settings.bgvRoot) === canonicalPath(root)) {
      settings.bgvRoot = root;
      visualIndex = media.videoFiles.map(filePath => makeVisualRecord(filePath, root));
    }
    rebuildMaps();
    writeJson(settingsFile(), settings);
    saveLibraryCache(root);
    scanState = { scanning: false, root, scanned: media.visited, songs: songIndex.length, visuals: visualIndex.length };
    sender?.send('library:scan-progress', { ...scanState, done: true });
    return { canceled: false, root, count: songIndex.length, visualCount: visualIndex.length };
  } catch (error) {
    scanState.scanning = false;
    sender?.send('library:scan-progress', { ...scanState, error: error.message });
    throw error;
  }
}

function visualCatalog() {
  const categories = new Map();
  for (const visual of visualIndex) categories.set(visual.category || 'General', (categories.get(visual.category || 'General') || 0) + 1);
  return {
    root: settings.bgvRoot || settings.mediaRoot || '',
    count: visualIndex.length,
    categories: [...categories.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    visuals: visualIndex
  };
}

ipcMain.handle('library:choose-folder', async event => {
  const result = await dialog.showOpenDialog({ title: 'Choose your OpenKRK songs folder (MID / MIDI / KAR)', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return scanLibrary(result.filePaths[0], event.sender);
});
ipcMain.handle('library:rescan', async event => {
  const root = settings.mediaRoot || settings.libraryRoot;
  if (!root) return { canceled: true, reason: 'no-root' };
  return scanLibrary(root, event.sender);
});
ipcMain.handle('library:status', () => ({ root: settings.mediaRoot || settings.libraryRoot || '', bgvRoot: settings.bgvRoot || '', count: songIndex.length, visualCount: visualIndex.length, scanning: scanState.scanning, scanned: scanState.scanned }));
ipcMain.handle('library:latest', (_event, limit = 10) => newestSongs(limit));
ipcMain.handle('library:discover-current', async (_event, limit = 10, force = false) => discoverCurrentLibrarySongs(limit, Boolean(force)));
ipcMain.handle('media:visual-catalog', () => visualCatalog());
ipcMain.handle('library:find-code', (_event, code) => songByCode.get(String(code || '').trim()) || null);
ipcMain.handle('library:search', (_event, query, limit = 80) => {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(' ').filter(Boolean);
  const exactCode = /^\d+$/.test(q) ? songByCode.get(q) : null;
  const results = [];
  if (exactCode) results.push(exactCode);
  for (const song of songIndex) {
    if (results.length >= Math.min(Number(limit) || 80, 120)) break;
    if (song === exactCode) continue;
    if (tokens.every(token => song.key.includes(token))) results.push(song);
  }
  return results;
});

ipcMain.handle('bgv:choose-folder', async () => {
  const result = await dialog.showOpenDialog({ title: 'Choose BGV / visual source folder', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const root = result.filePaths[0];
  const files = await collectFiles(root, VIDEO_EXTENSIONS, MAX_VISUAL_FILES);
  visualIndex = files.map(filePath => makeVisualRecord(filePath, root));
  settings.bgvRoot = root;
  writeJson(settingsFile(), settings);
  saveLibraryCache(settings.mediaRoot || settings.libraryRoot || root);
  return { canceled: false, ...visualCatalog() };
});

ipcMain.handle('soundbank:choose', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose SoundFont / sound bank', properties: ['openFile'],
    filters: [{ name: 'Sound banks', extensions: ['sf2', 'sf3', 'sfogg', 'dls'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  if (!SOUND_BANK_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return { canceled: true, error: 'unsupported-soundbank' };
  settings.soundBankPath = filePath;
  allowedBinaryPaths.add(canonicalPath(filePath));
  writeJson(settingsFile(), settings);
  return { canceled: false, path: filePath, name: path.basename(filePath) };
});
ipcMain.handle('soundbank:status', () => ({ path: settings.soundBankPath || '', name: settings.soundBankPath ? path.basename(settings.soundBankPath) : '' }));
ipcMain.handle('metadata:resolve', async (_event, song) => {
  try { return await resolveSongMetadata(song); }
  catch (error) { return { source: '', matched: false, error: error.message || String(error), title: cleanTransportSuffix(song?.title || ''), artist: cleanTransportSuffix(song?.artist || ''), album: '', releaseDate: '', genre: '', durationMs: 0, artworkUrl: '', storeUrl: '' }; }
});
ipcMain.handle('metadata:artwork-data', async (_event, url) => artworkToDataUrl(url));

ipcMain.handle('font:choose', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a font file', properties: ['openFile'],
    filters: [{ name: 'Font files', extensions: ['ttf', 'otf', 'woff', 'woff2'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  if (!FONT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return { canceled: true, error: 'unsupported-font' };
  return { canceled: false, path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('file:read-binary', async (_event, filePath) => {
  const target = canonicalPath(filePath);
  if (!allowedBinaryPaths.has(target)) throw new Error('File is not in the OpenKRK media/sound-bank allowlist.');
  const data = await fs.promises.readFile(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle('app:toggle-fullscreen', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

app.whenReady().then(() => {
  settings = { ...settings, ...readJson(settingsFile(), {}) };
  metadataCache = readJson(metadataCacheFile(), {}) || {};
  loadCachedLibrary();
  if (settings.soundBankPath && fs.existsSync(settings.soundBankPath)) allowedBinaryPaths.add(canonicalPath(settings.soundBankPath));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
