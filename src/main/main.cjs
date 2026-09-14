const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const MIDI_EXTENSIONS = new Set(['.mid', '.midi', '.kar']);
const MAX_LIBRARY_FILES = 100000;

let songIndex = [];
let songByCode = new Map();
let settings = { libraryRoot: '', bgvRoot: '' };
let scanState = { scanning: false, root: '', scanned: 0, songs: 0 };

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
    title,
    artist,
    path: filePath,
    ext: ext.toLowerCase(),
    key: normalize(`${code} ${title} ${artist}`)
  };
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
  songIndex = cached.songs;
  rebuildCodeMap();
  settings.libraryRoot = cached.root;
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

async function collectFiles(root, extensions, limit, onProgress) {
  const files = [];
  const stack = [root];
  let visited = 0;

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
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        visited += 1;
        if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
      }

      if (visited % 750 === 0) {
        onProgress?.({ visited, matched: files.length });
        await new Promise(resolve => setImmediate(resolve));
      }

      if (files.length >= limit) break;
    }
  }

  onProgress?.({ visited, matched: files.length });
  return files;
}

async function scanLibrary(root, sender) {
  if (scanState.scanning) return { busy: true, ...scanState };
  scanState = { scanning: true, root, scanned: 0, songs: 0 };
  sender?.send('library:scan-progress', scanState);

  try {
    const files = await collectFiles(root, MIDI_EXTENSIONS, MAX_LIBRARY_FILES, progress => {
      scanState.scanned = progress.visited;
      scanState.songs = progress.matched;
      sender?.send('library:scan-progress', { ...scanState });
    });

    songIndex = files.map(parseSongFilename);
    rebuildCodeMap();
    settings.libraryRoot = root;
    writeJson(settingsFile(), settings);
    writeJson(libraryCacheFile(), { version: 1, root, songs: songIndex });

    scanState = { scanning: false, root, scanned: scanState.scanned, songs: songIndex.length };
    sender?.send('library:scan-progress', { ...scanState, done: true });
    return { canceled: false, root, count: songIndex.length };
  } catch (error) {
    scanState.scanning = false;
    sender?.send('library:scan-progress', { ...scanState, error: error.message });
    throw error;
  }
}

ipcMain.handle('library:choose-folder', async event => {
  const result = await dialog.showOpenDialog({
    title: 'Choose your MIDI / KAR library folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return scanLibrary(result.filePaths[0], event.sender);
});

ipcMain.handle('library:rescan', async event => {
  if (!settings.libraryRoot) return { canceled: true, reason: 'no-root' };
  return scanLibrary(settings.libraryRoot, event.sender);
});

ipcMain.handle('library:status', () => ({
  root: settings.libraryRoot || '',
  count: songIndex.length,
  scanning: scanState.scanning,
  scanned: scanState.scanned
}));

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
    title: 'Choose your BGV / visual folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, files: [] };

  const root = result.filePaths[0];
  const files = await collectFiles(root, VIDEO_EXTENSIONS, 5000);
  settings.bgvRoot = root;
  writeJson(settingsFile(), settings);
  return { canceled: false, root, files };
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
