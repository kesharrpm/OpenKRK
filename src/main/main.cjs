const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const MIDI_EXTENSIONS = new Set(['.mid', '.midi', '.kar']);
const MAX_LIBRARY_FILES = 100000;
const MAX_VISUAL_FILES = 5000;
const LOCAL_CODE_MIN = 9000000;
const LOCAL_CODE_RANGE = 1000000;

let songIndex = [];
let songByCode = new Map();
let visualIndex = [];
let settings = { mediaRoot: '', libraryRoot: '', bgvRoot: '' };
let scanState = { scanning: false, root: '', scanned: 0, songs: 0, visuals: 0 };

function settingsFile() {
  return path.join(app.getPath('userData'), 'openkrk-settings.json');
}

function libraryCacheFile() {
  return path.join(app.getPath('userData'), 'openkrk-library-index.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (error) {
    console.warn('[OpenKRK] Could not save', file, error.message);
  }
}

function normalize(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseSongFilename(filePath) {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext).trim();
  const chunks = stem.split(/\s+[-–—]\s+/).map(part => part.trim()).filter(Boolean);

  let code = '';
  let title = stem;
  let artist = 'Unknown Artist';

  if (chunks.length >= 3 && /^\d{3,7}$/.test(chunks[0])) {
    code = chunks[0];
    title = chunks.slice(1, -1).join(' - ');
    artist = chunks[chunks.length - 1];
  } else if (chunks.length >= 2 && /^\d{3,7}$/.test(chunks[0])) {
    code = chunks[0];
    title = chunks.slice(1).join(' - ');
  } else if (chunks.length >= 2) {
    artist = chunks[0];
    title = chunks.slice(1).join(' - ');
  } else {
    const codeMatch = stem.match(/^\s*(\d{3,7})[\s._-]+(.+)$/);
    if (codeMatch) {
      code = codeMatch[1];
      title = codeMatch[2].replace(/[_.]+/g, ' ').trim();
    }
  }

  return {
    code,
    sourceCode: code,
    generatedCode: false,
    title,
    artist,
    path: filePath,
    ext: ext.toLowerCase(),
    key: normalize(`${code} ${title} ${artist}`)
  };
}

function hashPath(value) {
  let hash = 2166136261;
  const input = String(value).toLowerCase().replace(/\\/g, '/');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function assignLocalCodes(songs, previousSongs = []) {
  const previousByPath = new Map();
  for (const previous of previousSongs) {
    if (previous?.path && previous?.generatedCode && previous?.code) {
      previousByPath.set(path.normalize(previous.path).toLowerCase(), String(previous.code));
    }
  }

  const used = new Set();
  for (const song of songs) {
    if (song.code) used.add(String(song.code));
  }

  const uncoded = songs
    .filter(song => !song.code)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));

  for (const song of uncoded) {
    const lookupKey = path.normalize(song.path).toLowerCase();
    let code = previousByPath.get(lookupKey) || '';

    if (!code || used.has(code)) {
      let candidate = LOCAL_CODE_MIN + (hashPath(lookupKey) % LOCAL_CODE_RANGE);
      let attempts = 0;
      while (used.has(String(candidate)) && attempts < LOCAL_CODE_RANGE) {
        candidate = LOCAL_CODE_MIN + ((candidate - LOCAL_CODE_MIN + 1) % LOCAL_CODE_RANGE);
        attempts += 1;
      }
      code = String(candidate);
    }

    song.code = code;
    song.sourceCode = '';
    song.generatedCode = true;
    song.key = normalize(`${code} ${song.title} ${song.artist}`);
    used.add(code);
  }

  for (const song of songs) {
    if (!song.generatedCode) {
      song.sourceCode = song.sourceCode || song.code || '';
      song.generatedCode = false;
      song.key = normalize(`${song.code} ${song.title} ${song.artist}`);
    }
  }

  return songs;
}

function rebuildCodeMap() {
  songByCode = new Map();
  for (const song of songIndex) {
    if (song.code && !songByCode.has(song.code)) songByCode.set(song.code, song);
  }
}

function loadCachedLibrary() {
  const cached = readJson(libraryCacheFile(), null);
  if (!cached || !cached.root || !Array.isArray(cached.songs)) return;
  if (!fs.existsSync(cached.root)) return;

  const normalizedSongs = cached.songs.map(song => ({
    ...song,
    sourceCode: song.sourceCode ?? (song.generatedCode ? '' : (song.code || '')),
    generatedCode: Boolean(song.generatedCode)
  }));

  songIndex = assignLocalCodes(normalizedSongs, cached.songs);
  visualIndex = Array.isArray(cached.visuals) ? cached.visuals.filter(file => fs.existsSync(file)) : [];
  rebuildCodeMap();
  settings.mediaRoot = cached.root;
  settings.libraryRoot = cached.root;
  if (!settings.bgvRoot) settings.bgvRoot = cached.root;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1100,
    minHeight: 650,
    backgroundColor: '#050506',
    autoHideMenuBar: true,
    title: 'OpenKRK',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

async function collectMedia(root, onProgress) {
  const midiFiles = [];
  const videoFiles = [];
  const stack = [root];
  let visited = 0;

  while (stack.length && (midiFiles.length < MAX_LIBRARY_FILES || videoFiles.length < MAX_VISUAL_FILES)) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        visited += 1;
        const ext = path.extname(entry.name).toLowerCase();
        if (MIDI_EXTENSIONS.has(ext) && midiFiles.length < MAX_LIBRARY_FILES) midiFiles.push(full);
        if (VIDEO_EXTENSIONS.has(ext) && videoFiles.length < MAX_VISUAL_FILES) videoFiles.push(full);
      }

      if (visited % 750 === 0) {
        onProgress?.({ visited, songs: midiFiles.length, visuals: videoFiles.length });
        await new Promise(resolve => setImmediate(resolve));
      }
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
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function scanLibrary(root, sender) {
  if (scanState.scanning) return { busy: true, ...scanState };
  scanState = { scanning: true, root, scanned: 0, songs: 0, visuals: 0 };
  sender?.send('library:scan-progress', scanState);

  try {
    const previousSongs = songIndex;
    const media = await collectMedia(root, progress => {
      scanState.scanned = progress.visited;
      scanState.songs = progress.songs;
      scanState.visuals = progress.visuals;
      sender?.send('library:scan-progress', { ...scanState });
    });

    songIndex = assignLocalCodes(media.midiFiles.map(parseSongFilename), previousSongs);
    visualIndex = media.videoFiles;
    rebuildCodeMap();

    settings.mediaRoot = root;
    settings.libraryRoot = root;
    settings.bgvRoot = root;
    writeJson(settingsFile(), settings);
    writeJson(libraryCacheFile(), {
      version: 2,
      root,
      songs: songIndex,
      visuals: visualIndex
    });

    scanState = {
      scanning: false,
      root,
      scanned: media.visited,
      songs: songIndex.length,
      visuals: visualIndex.length
    };
    sender?.send('library:scan-progress', { ...scanState, done: true });
    return {
      canceled: false,
      root,
      count: songIndex.length,
      visualCount: visualIndex.length,
      visuals: visualIndex
    };
  } catch (error) {
    scanState.scanning = false;
    sender?.send('library:scan-progress', { ...scanState, error: error.message });
    throw error;
  }
}

ipcMain.handle('library:choose-folder', async event => {
  const result = await dialog.showOpenDialog({
    title: 'Choose your OpenKRK media folder (MIDI / KAR + BGV videos)',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return scanLibrary(result.filePaths[0], event.sender);
});

ipcMain.handle('library:rescan', async event => {
  const root = settings.mediaRoot || settings.libraryRoot;
  if (!root) return { canceled: true, reason: 'no-root' };
  return scanLibrary(root, event.sender);
});

ipcMain.handle('library:status', () => ({
  root: settings.mediaRoot || settings.libraryRoot || '',
  count: songIndex.length,
  visualCount: visualIndex.length,
  scanning: scanState.scanning,
  scanned: scanState.scanned
}));

ipcMain.handle('media:visuals', () => visualIndex);

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
  const result = await dialog.showOpenDialog({
    title: 'Choose a different BGV / visual folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, files: [] };

  const root = result.filePaths[0];
  visualIndex = await collectFiles(root, VIDEO_EXTENSIONS, MAX_VISUAL_FILES);
  settings.bgvRoot = root;
  writeJson(settingsFile(), settings);

  const cached = readJson(libraryCacheFile(), null);
  if (cached && Array.isArray(cached.songs)) {
    writeJson(libraryCacheFile(), { ...cached, version: 2, visuals: visualIndex });
  }

  return { canceled: false, root, files: visualIndex };
});

ipcMain.handle('app:toggle-fullscreen', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

app.whenReady().then(() => {
  settings = { ...settings, ...readJson(settingsFile(), {}) };
  loadCachedLibrary();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
