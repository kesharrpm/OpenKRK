const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);
const MIDI_EXTENSIONS = new Set(['.mid', '.midi', '.kar']);
const SOUND_BANK_EXTENSIONS = new Set(['.sf2', '.sf3', '.sfogg', '.dls']);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MAX_LIBRARY_FILES = 100000;
const MAX_VISUAL_FILES = 12000;
const LOCAL_CODE_MIN = 9000000;
const LOCAL_CODE_RANGE = 1000000;

let songIndex = [];
let songByCode = new Map();
let visualIndex = [];
let allowedBinaryPaths = new Set();
let settings = { mediaRoot: '', libraryRoot: '', bgvRoot: '', soundBankPath: '' };
let scanState = { scanning: false, root: '', scanned: 0, songs: 0, visuals: 0 };

function settingsFile() { return path.join(app.getPath('userData'), 'openkrk-settings.json'); }
function libraryCacheFile() { return path.join(app.getPath('userData'), 'openkrk-library-index.json'); }
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

function parseSongFilename(filePath) {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext).trim();
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
  for (const previous of previousSongs) {
    if (previous?.path && previous?.generatedCode && previous?.code) previousByPath.set(canonicalPath(previous.path), String(previous.code));
  }
  const used = new Set();
  for (const song of songs) if (song.code) used.add(String(song.code));
  const uncoded = songs.filter(song => !song.code).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));

  for (const song of uncoded) {
    const lookupKey = canonicalPath(song.path);
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
  const normalizedSongs = cached.songs.map(song => ({ ...song, sourceCode: song.sourceCode ?? (song.generatedCode ? '' : (song.code || '')), generatedCode: Boolean(song.generatedCode) }));
  songIndex = assignLocalCodes(normalizedSongs, cached.songs);
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
  writeJson(libraryCacheFile(), { version: 3, root, visualRoot: settings.bgvRoot || root, songs: songIndex, visuals: visualIndex });
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
    songIndex = assignLocalCodes(media.midiFiles.map(parseSongFilename), previousSongs);
    settings.mediaRoot = root;
    settings.libraryRoot = root;
    settings.bgvRoot = root;
    visualIndex = media.videoFiles.map(filePath => makeVisualRecord(filePath, root));
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
  const result = await dialog.showOpenDialog({ title: 'Choose your OpenKRK media folder (MIDI / KAR + BGV videos)', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return scanLibrary(result.filePaths[0], event.sender);
});
ipcMain.handle('library:rescan', async event => {
  const root = settings.mediaRoot || settings.libraryRoot;
  if (!root) return { canceled: true, reason: 'no-root' };
  return scanLibrary(root, event.sender);
});
ipcMain.handle('library:status', () => ({ root: settings.mediaRoot || settings.libraryRoot || '', count: songIndex.length, visualCount: visualIndex.length, scanning: scanState.scanning, scanned: scanState.scanned }));
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
  loadCachedLibrary();
  if (settings.soundBankPath && fs.existsSync(settings.soundBankPath)) allowedBinaryPaths.add(canonicalPath(settings.soundBankPath));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
