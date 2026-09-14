import { WorkletSynthesizer, Sequencer } from 'spessasynth_lib';

const $ = id => document.getElementById(id);
const stage = $('stage');
const bgv = $('bgv');
const codeDisplay = $('codeDisplay');
const roomState = $('roomState');
const roomHint = $('roomHint');
const libraryStatus = $('libraryStatus');
const bgvStatus = $('bgvStatus');
const audioStatus = $('audioStatus');
const tickerPrimary = $('tickerPrimary');
const tickerSecondary = $('tickerSecondary');
const searchInput = $('searchInput');
const searchMeta = $('searchMeta');
const searchResults = $('searchResults');
const visualCategories = $('visualCategories');
const visualNowCategory = $('visualNowCategory');
const visualNowName = $('visualNowName');
const soundBankName = $('soundBankName');
const toast = $('toast');

const FONT_STACKS = {
  condensed: '"Bahnschrift SemiCondensed", "Arial Narrow", sans-serif',
  system: '"Segoe UI Variable", "Segoe UI", sans-serif',
  rounded: '"Arial Rounded MT Bold", "Trebuchet MS", sans-serif',
  mono: '"Cascadia Mono", "Consolas", monospace',
  serif: 'Georgia, "Times New Roman", serif'
};

const DEFAULT_PREFS = {
  uiScale: 100,
  lyricScale: 100,
  systemFont: 'condensed',
  lyricFont: 'condensed',
  systemFontPath: '',
  lyricFontPath: '',
  sfxEnabled: true,
  sfxVolume: 45
};

let prefs = loadPrefs();
let mode = 'idle';
let codeBuffer = '';
let libraryCount = 0;
let visualCatalog = { root: '', count: 0, categories: [], visuals: [] };
let activeVisualCategory = 'ALL';
let activeVisuals = [];
let bgvIndex = -1;
let currentSong = null;
let currentLyrics = [];
let currentLyricLine = -1;
let toastTimer = null;
let searchTimer = null;
let transportRaf = 0;

function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('openkrk-ui-prefs') || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs() { localStorage.setItem('openkrk-ui-prefs', JSON.stringify(prefs)); }
function localFileUrl(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`);
}
function installCustomFont(slot, filePath) {
  const id = `openkrk-custom-${slot}`;
  let style = document.getElementById(id);
  if (!style) { style = document.createElement('style'); style.id = id; document.head.appendChild(style); }
  const family = slot === 'system' ? 'OpenKRK Custom System' : 'OpenKRK Custom Lyric';
  style.textContent = filePath ? `@font-face{font-family:"${family}";src:url("${localFileUrl(filePath)}");font-display:swap;}` : '';
  return `"${family}", sans-serif`;
}
function applyPrefs() {
  document.documentElement.style.setProperty('--ui-scale', String((Number(prefs.uiScale) || 100) / 100));
  document.documentElement.style.setProperty('--lyric-scale', String((Number(prefs.lyricScale) || 100) / 100));
  const systemStack = prefs.systemFont === 'custom' && prefs.systemFontPath ? installCustomFont('system', prefs.systemFontPath) : FONT_STACKS[prefs.systemFont] || FONT_STACKS.condensed;
  const lyricStack = prefs.lyricFont === 'custom' && prefs.lyricFontPath ? installCustomFont('lyric', prefs.lyricFontPath) : FONT_STACKS[prefs.lyricFont] || FONT_STACKS.condensed;
  document.documentElement.style.setProperty('--ui', systemStack);
  document.documentElement.style.setProperty('--display', systemStack);
  document.documentElement.style.setProperty('--lyric-font', lyricStack);
  $('uiScale').value = prefs.uiScale;
  $('uiScaleValue').textContent = `${prefs.uiScale}%`;
  $('lyricScale').value = prefs.lyricScale;
  $('lyricScaleValue').textContent = `${prefs.lyricScale}%`;
  $('systemFont').value = prefs.systemFont;
  $('lyricFont').value = prefs.lyricFont;
  $('sfxEnabled').value = prefs.sfxEnabled ? 'on' : 'off';
  $('sfxVolume').value = prefs.sfxVolume;
  $('sfxVolumeValue').textContent = `${prefs.sfxVolume}%`;
}

class InterfaceSfx {
  constructor() { this.context = null; }
  async ready() {
    if (!prefs.sfxEnabled || Number(prefs.sfxVolume) <= 0) return null;
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
    return this.context;
  }
  async tone(frequency, duration = 0.035, gain = 0.04, type = 'sine', delay = 0) {
    const context = await this.ready();
    if (!context) return;
    const oscillator = context.createOscillator();
    const amp = context.createGain();
    const start = context.currentTime + delay;
    const volume = Math.max(0, Math.min(1, Number(prefs.sfxVolume) / 100));
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * volume), start + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(amp).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }
  move() { void this.tone(520, 0.028, 0.026, 'triangle'); }
  confirm() { void this.tone(690, 0.04, 0.032, 'sine'); void this.tone(920, 0.045, 0.025, 'sine', 0.035); }
  back() { void this.tone(330, 0.045, 0.026, 'triangle'); }
  error() { void this.tone(180, 0.07, 0.035, 'square'); }
}
const sfx = new InterfaceSfx();

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return new Uint8Array(value).buffer;
}

class MidiEngine {
  constructor() {
    this.context = null;
    this.synth = null;
    this.sequencer = null;
    this.soundBankPath = '';
    this.loadedBankPath = '';
    this.pendingReady = null;
  }
  async ensureCore() {
    if (this.context && this.synth && this.sequencer) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const processorUrl = new URL('./vendor/spessasynth_processor.min.js', document.baseURI).href;
    await this.context.audioWorklet.addModule(processorUrl);
    this.synth = new WorkletSynthesizer(this.context);
    this.synth.connect(this.context.destination);
    await this.synth.isReady;
    this.sequencer = new Sequencer(this.synth, { skipToFirstNoteOn: false });
    this.sequencer.eventHandler.addEvent('songChange', 'openkrk-song-ready', () => {
      if (this.pendingReady) { const resolve = this.pendingReady; this.pendingReady = null; resolve(); }
    });
    await this.context.resume();
  }
  setSoundBankPath(filePath) { this.soundBankPath = filePath || ''; }
  async resetCore() {
    try { this.sequencer?.pause(); } catch {}
    try { this.synth?.stopAll(true); } catch {}
    try { await this.synth?.destroy?.(); } catch {}
    try { await this.context?.close?.(); } catch {}
    this.context = null; this.synth = null; this.sequencer = null; this.loadedBankPath = ''; this.pendingReady = null;
  }
  async ensureSoundBank() {
    if (!this.soundBankPath) throw new Error('Choose an SF2, SF3, SFOGG or DLS file in F4 System first.');
    if (this.loadedBankPath === this.soundBankPath && this.synth) return;
    if (this.loadedBankPath && this.loadedBankPath !== this.soundBankPath) await this.resetCore();
    await this.ensureCore();
    const raw = await window.openkrk.readBinaryFile(this.soundBankPath);
    await this.synth.soundBankManager.addSoundBank(toArrayBuffer(raw), 'openkrk-main');
    this.loadedBankPath = this.soundBankPath;
  }
  async playSong(song) {
    await this.ensureSoundBank();
    const raw = await window.openkrk.readBinaryFile(song.path);
    const binary = toArrayBuffer(raw);
    this.sequencer.pause();
    this.synth.stopAll(true);
    const ready = new Promise(resolve => {
      this.pendingReady = resolve;
      setTimeout(() => { if (this.pendingReady === resolve) { this.pendingReady = null; resolve(); } }, 2500);
    });
    this.sequencer.loadNewSongList([{ binary, fileName: song.title || 'OpenKRK Song' }]);
    await ready;
    this.sequencer.currentTime = 0;
    this.sequencer.play();
    if (this.context.state === 'suspended') await this.context.resume();
    return binary;
  }
  togglePause() {
    if (!this.sequencer) return false;
    if (this.sequencer.paused) this.sequencer.play(); else this.sequencer.pause();
    return this.sequencer.paused;
  }
  stop() {
    try { this.sequencer?.pause(); } catch {}
    try { if (this.sequencer) this.sequencer.currentTime = 0; } catch {}
    try { this.synth?.stopAll(true); } catch {}
  }
  state() {
    if (!this.sequencer) return { ready: false, currentTime: 0, duration: 0, paused: true, finished: false };
    return {
      ready: true,
      currentTime: Number(this.sequencer.currentHighResolutionTime ?? this.sequencer.currentTime ?? 0) || 0,
      duration: Number(this.sequencer.duration || 0) || 0,
      paused: Boolean(this.sequencer.paused),
      finished: Boolean(this.sequencer.isFinished)
    };
  }
}
const midiEngine = new MidiEngine();

function readVlq(bytes, state) {
  let value = 0;
  let count = 0;
  while (state.pos < bytes.length && count < 4) {
    const b = bytes[state.pos++];
    value = (value << 7) | (b & 0x7f);
    count += 1;
    if (!(b & 0x80)) break;
  }
  return value >>> 0;
}
function decodeText(bytes) {
  try { return new TextDecoder('utf-8').decode(bytes).replace(/\0/g, ''); }
  catch { return String.fromCharCode(...bytes).replace(/\0/g, ''); }
}
function parseMidiLyrics(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') return [];
    const headerLength = view.getUint32(4, false);
    const trackCount = view.getUint16(10, false);
    const division = view.getUint16(12, false);
    if (division & 0x8000) return [];
    const ppq = division || 480;
    let pos = 8 + headerLength;
    const tempos = [{ tick: 0, us: 500000 }];
    const tracks = [];

    for (let trackIndex = 0; trackIndex < trackCount && pos + 8 <= bytes.length; trackIndex += 1) {
      const tag = String.fromCharCode(...bytes.slice(pos, pos + 4));
      const length = view.getUint32(pos + 4, false);
      pos += 8;
      if (tag !== 'MTrk' || pos + length > bytes.length) { pos += length; continue; }
      const end = pos + length;
      const state = { pos };
      let tick = 0;
      let running = 0;
      let trackName = '';
      const texts = [];
      while (state.pos < end) {
        tick += readVlq(bytes, state);
        if (state.pos >= end) break;
        let status = bytes[state.pos++];
        if (status < 0x80) { state.pos -= 1; status = running; }
        else if (status < 0xf0) running = status;
        if (!status) break;
        if (status === 0xff) {
          const type = bytes[state.pos++];
          const metaLength = readVlq(bytes, state);
          const start = state.pos;
          const stop = Math.min(end, start + metaLength);
          const payload = bytes.slice(start, stop);
          state.pos = stop;
          if (type === 0x51 && payload.length >= 3) tempos.push({ tick, us: (payload[0] << 16) | (payload[1] << 8) | payload[2] });
          if (type === 0x03) trackName = decodeText(payload);
          if (type === 0x05 || type === 0x01) texts.push({ tick, type, text: decodeText(payload) });
          continue;
        }
        if (status === 0xf0 || status === 0xf7) { state.pos = Math.min(end, state.pos + readVlq(bytes, state)); continue; }
        const hi = status & 0xf0;
        state.pos = Math.min(end, state.pos + (hi === 0xc0 || hi === 0xd0 ? 1 : 2));
      }
      tracks.push({ name: trackName, texts });
      pos = end;
    }

    tempos.sort((a, b) => a.tick - b.tick);
    const compactTempos = [];
    for (const tempo of tempos) {
      if (compactTempos.length && compactTempos[compactTempos.length - 1].tick === tempo.tick) compactTempos[compactTempos.length - 1] = tempo;
      else compactTempos.push(tempo);
    }
    const tempoSegments = [];
    let sec = 0, lastTick = 0, us = 500000;
    for (const tempo of compactTempos) {
      if (tempo.tick > lastTick) sec += ((tempo.tick - lastTick) * us) / (ppq * 1_000_000);
      tempoSegments.push({ tick: tempo.tick, sec, us: tempo.us });
      lastTick = tempo.tick; us = tempo.us;
    }
    const tickToSec = tick => {
      let segment = tempoSegments[0] || { tick: 0, sec: 0, us: 500000 };
      for (let i = 1; i < tempoSegments.length; i += 1) { if (tempoSegments[i].tick > tick) break; segment = tempoSegments[i]; }
      return segment.sec + ((tick - segment.tick) * segment.us) / (ppq * 1_000_000);
    };

    const candidate = tracks.map(track => ({
      ...track,
      useful: track.texts.filter(item => item.type === 0x05 || !String(item.text).startsWith('@')).length,
      lyricCount: track.texts.filter(item => item.type === 0x05).length
    })).sort((a, b) => (b.lyricCount * 3 + b.useful + (/lyric|kara/i.test(b.name) ? 20 : 0)) - (a.lyricCount * 3 + a.useful + (/lyric|kara/i.test(a.name) ? 20 : 0)))[0];
    if (!candidate || !candidate.texts.length) return [];

    const events = candidate.texts.filter(item => item.text && !item.text.trim().startsWith('@')).map(item => ({ time: tickToSec(item.tick), text: item.text })).sort((a, b) => a.time - b.time);
    const lines = [];
    let segments = [];
    const pushLine = explicitEnd => {
      if (!segments.length) return;
      const text = segments.map(segment => segment.text).join('').replace(/\s+/g, ' ').trim();
      if (!text) { segments = []; return; }
      lines.push({ start: segments[0].start, explicitEnd, text, segments: segments.map(segment => ({ ...segment })) });
      segments = [];
    };

    for (const event of events) {
      let buffer = '';
      const flushBuffer = () => {
        if (!buffer) return;
        const normalized = buffer.replace(/\^/g, ' ');
        if (normalized) segments.push({ text: normalized, start: event.time });
        buffer = '';
      };
      for (const char of event.text.replace(/\r/g, '\n')) {
        if (char === '/' || char === '\\' || char === '\n') { flushBuffer(); pushLine(event.time); }
        else buffer += char;
      }
      flushBuffer();
    }
    pushLine(null);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const nextLineStart = lines[i + 1]?.start;
      const fallbackEnd = Number.isFinite(nextLineStart) ? nextLineStart : line.segments[line.segments.length - 1].start + 3.2;
      line.end = Math.max(line.start + 0.25, Number.isFinite(line.explicitEnd) ? Math.max(line.explicitEnd, line.segments[line.segments.length - 1].start + 0.15) : fallbackEnd);
      for (let s = 0; s < line.segments.length; s += 1) {
        const segment = line.segments[s];
        const nextStart = line.segments[s + 1]?.start;
        segment.end = Math.max(segment.start + 0.08, Number.isFinite(nextStart) ? nextStart : line.end);
      }
    }
    return lines;
  } catch (error) {
    console.warn('[OpenKRK] lyric parser:', error);
    return [];
  }
}

function setMode(next) {
  mode = next;
  stage.classList.remove('mode-idle', 'mode-player', 'mode-search', 'mode-visuals', 'mode-system');
  stage.classList.add(`mode-${next}`);
  $('playerSurface').setAttribute('aria-hidden', String(next !== 'player'));
  $('searchSurface').setAttribute('aria-hidden', String(next !== 'search'));
  $('visualSurface').setAttribute('aria-hidden', String(next !== 'visuals'));
  $('systemSurface').setAttribute('aria-hidden', String(next !== 'system'));
  if (next === 'search') requestAnimationFrame(() => searchInput.focus());
}
function returnToRoom() { setMode(currentSong ? 'player' : 'idle'); }
function showToast(message, ms = 2300) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}
function formatCount(value) { return new Intl.NumberFormat().format(Number(value) || 0); }
function formatTime(value) { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function renderCode() { codeDisplay.textContent = codeBuffer ? codeBuffer.split('').join(' ') : '— — — — —'; }
function pushDigit(digit) { if (mode !== 'idle' && mode !== 'player') return; if (codeBuffer.length >= 7) codeBuffer = ''; codeBuffer += digit; renderCode(); }
function clearCode() { codeBuffer = ''; renderCode(); }

function updateLibraryUi(status = {}) {
  libraryCount = Number(status.count) || 0;
  libraryStatus.textContent = libraryCount ? `${formatCount(libraryCount)} SONGS` : 'NO LIBRARY';
  if (typeof status.visualCount === 'number') bgvStatus.textContent = status.visualCount ? `${formatCount(status.visualCount)} VISUALS` : 'BGV OFF';
  if (status.scanning) {
    roomState.textContent = 'INDEXING';
    roomHint.textContent = `${formatCount(status.scanned)} files checked`;
    tickerPrimary.textContent = 'Reading songs and visuals from one media folder…';
    tickerSecondary.textContent = `${formatCount(status.count || status.songs)} songs · ${formatCount(status.visualCount || status.visuals)} visuals found so far`;
  } else if (libraryCount) {
    roomState.textContent = 'ROOM READY';
    roomHint.textContent = 'Type a song number or press F1 to search';
    tickerPrimary.textContent = `${formatCount(libraryCount)} songs indexed locally`;
    tickerSecondary.textContent = status.root || 'Local karaoke media folder';
  } else {
    roomState.textContent = 'MEDIA NEEDED';
    roomHint.textContent = 'F2 · choose the folder containing your songs and BGVs';
    tickerPrimary.textContent = 'Point OpenKRK at your karaoke media folder.';
    tickerSecondary.textContent = 'MID / MIDI / KAR and video BGVs can live together in the same folder tree.';
  }
}
async function refreshLibraryStatus() { const status = await window.openkrk?.getLibraryStatus?.(); if (status) updateLibraryUi(status); }

function filesForCategory(category = activeVisualCategory) {
  if (!visualCatalog.visuals?.length) return [];
  if (!category || category === 'ALL') return visualCatalog.visuals;
  return visualCatalog.visuals.filter(item => item.category === category);
}
function renderVisualCategories() {
  visualCategories.replaceChildren();
  const all = [{ name: 'ALL', count: visualCatalog.count || 0 }, ...(visualCatalog.categories || [])];
  for (const category of all) {
    const button = document.createElement('button');
    button.className = `visual-category${activeVisualCategory === category.name ? ' active' : ''}`;
    const title = document.createElement('strong'); title.textContent = category.name === 'ALL' ? 'All visuals' : category.name;
    const count = document.createElement('span'); count.textContent = `${formatCount(category.count)} VIDEO${category.count === 1 ? '' : 'S'}`;
    button.append(title, count);
    button.addEventListener('click', () => {
      activeVisualCategory = category.name;
      activeVisuals = filesForCategory();
      renderVisualCategories();
      playBgv(Math.floor(Math.random() * Math.max(1, activeVisuals.length)));
      sfx.confirm();
    });
    visualCategories.appendChild(button);
  }
}
async function refreshVisualCatalog(playIfIdle = false) {
  const catalog = await window.openkrk?.getVisualCatalog?.();
  if (!catalog) return;
  visualCatalog = catalog;
  if (!filesForCategory(activeVisualCategory).length) activeVisualCategory = 'ALL';
  activeVisuals = filesForCategory();
  bgvStatus.textContent = catalog.count ? `${formatCount(catalog.count)} VISUALS` : 'BGV OFF';
  renderVisualCategories();
  if (playIfIdle && activeVisuals.length) playBgv(Math.floor(Math.random() * activeVisuals.length));
}
function playBgv(index) {
  activeVisuals = filesForCategory();
  if (!activeVisuals.length) return;
  bgvIndex = ((index % activeVisuals.length) + activeVisuals.length) % activeVisuals.length;
  const visual = activeVisuals[bgvIndex];
  bgv.src = localFileUrl(visual.path);
  bgv.load();
  bgv.play().catch(() => {});
  visualNowCategory.textContent = activeVisualCategory === 'ALL' ? 'ALL VISUALS' : activeVisualCategory.toUpperCase();
  visualNowName.textContent = visual.name || 'Untitled visual';
}
async function chooseLibraryFolder() {
  showToast('Choose the folder containing your MID/KAR files and BGV videos');
  const result = await window.openkrk?.chooseLibraryFolder?.();
  if (!result || result.canceled) return;
  await Promise.all([refreshLibraryStatus(), refreshVisualCatalog(true)]);
  showToast(`${formatCount(result.count)} songs · ${formatCount(result.visualCount)} visuals indexed`);
  sfx.confirm();
}
async function chooseVisualSource() {
  const result = await window.openkrk?.chooseBgvFolder?.();
  if (!result || result.canceled) return;
  activeVisualCategory = 'ALL';
  await refreshVisualCatalog(true);
  showToast(`${formatCount(result.count)} visuals categorized from folder names`);
  sfx.confirm();
}

function renderSearchMessage(message) {
  searchResults.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'search-empty';
  empty.textContent = message;
  searchResults.appendChild(empty);
}
function openSearch() {
  setMode('search');
  renderSearchMessage(libraryCount ? 'Start typing to search your local library.' : 'Close search and press F2 to choose your media folder.');
  searchMeta.textContent = libraryCount ? `${formatCount(libraryCount)} SONGS INDEXED` : 'NO LIBRARY INDEXED';
  sfx.move();
}
function openVisuals() { setMode('visuals'); renderVisualCategories(); sfx.move(); }
function openSystem() { setMode('system'); sfx.move(); }
function closePanel() { sfx.back(); returnToRoom(); }
function renderSearchResults(rows, query) {
  searchResults.replaceChildren();
  searchMeta.textContent = `${rows.length} RESULT${rows.length === 1 ? '' : 'S'} · ${formatCount(libraryCount)} SONGS INDEXED`;
  if (!rows.length) { renderSearchMessage(`No local songs matched “${query}”.`); return; }
  for (const song of rows) {
    const row = document.createElement('div'); row.className = 'search-row'; row.tabIndex = 0;
    const code = document.createElement('span'); code.className = 'search-row-code'; code.textContent = song.code || '—'; if (song.generatedCode) code.dataset.local = 'true';
    const copy = document.createElement('div'); copy.className = 'search-row-copy';
    const title = document.createElement('strong'); title.textContent = song.title || 'Untitled';
    const artist = document.createElement('span'); artist.textContent = song.artist || 'Unknown Artist'; copy.append(title, artist);
    const ext = document.createElement('span'); ext.className = 'search-row-ext'; ext.textContent = String(song.ext || '').replace('.', '').toUpperCase();
    const accept = () => { codeBuffer = String(song.code || ''); renderCode(); returnToRoom(); showToast(`${song.code} · ${song.title}`); sfx.confirm(); };
    row.append(code, copy, ext);
    row.addEventListener('click', accept);
    row.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); accept(); } });
    searchResults.appendChild(row);
  }
}
async function performSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) { renderSearchMessage(libraryCount ? 'Start typing to search your local library.' : 'No library indexed yet.'); return; }
  const rows = await window.openkrk?.searchSongs?.(trimmed, 80) || [];
  if (searchInput.value.trim() !== trimmed) return;
  renderSearchResults(rows, trimmed);
}

function renderLyricLine(index, time) {
  if (!currentLyrics.length || index < 0 || index >= currentLyrics.length) {
    $('lyricPrev').textContent = ''; $('lyricCurrent').textContent = '♪'; $('lyricNext').textContent = ''; return;
  }
  const line = currentLyrics[index];
  $('lyricPrev').textContent = currentLyrics[index - 1]?.text || '';
  $('lyricNext').textContent = currentLyrics[index + 1]?.text || '';
  const current = $('lyricCurrent');
  if (currentLyricLine !== index) {
    current.replaceChildren();
    for (const segment of line.segments) {
      const span = document.createElement('span'); span.className = 'lyric-segment'; span.dataset.text = segment.text; span.textContent = segment.text; span.style.setProperty('--segment-fill', '0%'); current.appendChild(span);
    }
    currentLyricLine = index;
  }
  const spans = [...current.querySelectorAll('.lyric-segment')];
  line.segments.forEach((segment, i) => {
    const progress = Math.max(0, Math.min(1, (time - segment.start) / Math.max(0.04, segment.end - segment.start)));
    spans[i]?.style.setProperty('--segment-fill', `${progress * 100}%`);
  });
}
function updateLyrics(time) {
  if (!currentLyrics.length) return;
  let index = currentLyrics.findIndex(line => time >= line.start && time < line.end);
  if (index < 0) {
    index = currentLyrics.findLastIndex ? currentLyrics.findLastIndex(line => line.start <= time) : (() => { let found = -1; for (let i = 0; i < currentLyrics.length; i += 1) if (currentLyrics[i].start <= time) found = i; return found; })();
  }
  if (index >= 0) renderLyricLine(index, time);
}
function startTransportLoop() {
  cancelAnimationFrame(transportRaf);
  const tick = () => {
    const state = midiEngine.state();
    if (currentSong && state.ready) {
      $('elapsed').textContent = formatTime(state.currentTime);
      $('remaining').textContent = `-${formatTime(Math.max(0, state.duration - state.currentTime))}`;
      $('progressFill').style.width = `${state.duration > 0 ? Math.min(100, (state.currentTime / state.duration) * 100) : 0}%`;
      $('playState').textContent = state.paused ? 'PAUSE' : 'PLAY';
      updateLyrics(state.currentTime);
      if (state.finished && state.duration > 0) { stopCurrentSong(false); return; }
    }
    transportRaf = requestAnimationFrame(tick);
  };
  transportRaf = requestAnimationFrame(tick);
}
async function playResolvedSong(song) {
  if (!song) return;
  if (!midiEngine.soundBankPath) { openSystem(); showToast('Choose a SoundFont / DLS in F4 before playing MIDI'); sfx.error(); return; }
  try {
    currentSong = song;
    $('nowCode').textContent = song.code || '—'; $('nowTitle').textContent = song.title || 'Untitled'; $('nowArtist').textContent = song.artist || 'Unknown Artist';
    $('lyricCurrent').textContent = 'LOADING MIDI…'; $('lyricPrev').textContent = ''; $('lyricNext').textContent = '';
    setMode('player');
    const binary = await midiEngine.playSong(song);
    currentLyrics = parseMidiLyrics(binary);
    currentLyricLine = -1;
    if (!currentLyrics.length) $('lyricCurrent').textContent = '♪';
    showToast(`PLAYING · ${song.title}`); sfx.confirm(); startTransportLoop();
  } catch (error) {
    console.error(error); currentSong = null; currentLyrics = []; setMode('idle'); showToast(`MIDI ERROR · ${error.message || error}`, 5200); sfx.error();
  }
}
function stopCurrentSong(withSfx = true) {
  midiEngine.stop(); currentSong = null; currentLyrics = []; currentLyricLine = -1; cancelAnimationFrame(transportRaf);
  $('progressFill').style.width = '0%'; $('elapsed').textContent = '0:00'; $('remaining').textContent = '-0:00'; setMode('idle'); if (withSfx) sfx.back();
}
async function reserveCode(immediate = false) {
  if (!codeBuffer) return;
  const selected = codeBuffer;
  const song = await window.openkrk?.findSongByCode?.(selected);
  clearCode();
  if (!song) { showToast(libraryCount ? `Song ${selected} was not found` : 'Choose your media folder with F2 first'); sfx.error(); return; }
  if (!immediate) { showToast(`RESERVED · ${song.code} · ${song.title}`); sfx.confirm(); return; }
  await playResolvedSong(song);
}

async function refreshSoundBankStatus() {
  const status = await window.openkrk?.getSoundBankStatus?.();
  const bankPath = status?.path || '';
  midiEngine.setSoundBankPath(bankPath);
  soundBankName.textContent = status?.name || 'Not selected';
  audioStatus.textContent = status?.name ? 'MIDI READY' : 'NO SOUNDBANK';
}
async function chooseSoundBank() {
  const result = await window.openkrk?.chooseSoundBank?.();
  if (!result || result.canceled) { if (result?.error) showToast('Unsupported sound bank format'); return; }
  midiEngine.setSoundBankPath(result.path);
  soundBankName.textContent = result.name;
  audioStatus.textContent = 'LOADING BANK';
  try { await midiEngine.ensureSoundBank(); audioStatus.textContent = 'MIDI READY'; showToast(`Sound bank ready · ${result.name}`); sfx.confirm(); }
  catch (error) { audioStatus.textContent = 'BANK ERROR'; showToast(`Sound bank error · ${error.message || error}`, 5000); sfx.error(); }
}
async function chooseCustomFont(slot) {
  const result = await window.openkrk?.chooseFontFile?.();
  if (!result || result.canceled) return;
  if (slot === 'system') { prefs.systemFontPath = result.path; prefs.systemFont = 'custom'; }
  else { prefs.lyricFontPath = result.path; prefs.lyricFont = 'custom'; }
  savePrefs(); applyPrefs(); showToast(`${slot === 'system' ? 'System' : 'Lyric'} font · ${result.name}`); sfx.confirm();
}

searchInput.addEventListener('input', () => { clearTimeout(searchTimer); const value = searchInput.value; searchTimer = setTimeout(() => performSearch(value), 90); });
$('uiScale').addEventListener('input', event => { prefs.uiScale = Number(event.target.value); savePrefs(); applyPrefs(); });
$('lyricScale').addEventListener('input', event => { prefs.lyricScale = Number(event.target.value); savePrefs(); applyPrefs(); });
$('systemFont').addEventListener('change', event => { prefs.systemFont = event.target.value; savePrefs(); applyPrefs(); sfx.move(); });
$('lyricFont').addEventListener('change', event => { prefs.lyricFont = event.target.value; savePrefs(); applyPrefs(); sfx.move(); });
$('sfxEnabled').addEventListener('change', event => { prefs.sfxEnabled = event.target.value === 'on'; savePrefs(); if (prefs.sfxEnabled) sfx.confirm(); });
$('sfxVolume').addEventListener('input', event => { prefs.sfxVolume = Number(event.target.value); savePrefs(); applyPrefs(); });

bgv.addEventListener('ended', () => { if (filesForCategory().length) playBgv(bgvIndex + 1); });
bgv.addEventListener('error', () => { if (filesForCategory().length > 1) playBgv(bgvIndex + 1); });
window.openkrk?.onLibraryProgress?.(progress => {
  updateLibraryUi({ count: progress.songs || 0, visualCount: progress.visuals || 0, scanning: progress.scanning, scanned: progress.scanned, root: progress.root });
  if (progress.done) Promise.all([refreshLibraryStatus(), refreshVisualCatalog(true)]).catch(() => {});
  if (progress.error) showToast(`Library scan failed · ${progress.error}`, 5000);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'search') openSearch();
  else if (action === 'library') { sfx.move(); await chooseLibraryFolder(); }
  else if (action === 'visuals') openVisuals();
  else if (action === 'system') openSystem();
  else if (action === 'queue') { showToast('Queue engine is the next production commit'); sfx.move(); }
  else if (action === 'fullscreen') { sfx.move(); await window.openkrk?.toggleFullscreen?.(); }
  else if (action === 'close-panel') closePanel();
  else if (action === 'visual-random') { playBgv(Math.floor(Math.random() * Math.max(1, filesForCategory().length))); sfx.confirm(); }
  else if (action === 'visual-all') { activeVisualCategory = 'ALL'; activeVisuals = filesForCategory(); renderVisualCategories(); playBgv(Math.floor(Math.random() * Math.max(1, activeVisuals.length))); sfx.confirm(); }
  else if (action === 'visual-source') await chooseVisualSource();
  else if (action === 'soundbank') await chooseSoundBank();
  else if (action === 'system-font-file') await chooseCustomFont('system');
  else if (action === 'lyric-font-file') await chooseCustomFont('lyric');
});

document.addEventListener('keydown', async event => {
  if (mode === 'search') { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } return; }
  if (mode === 'visuals' || mode === 'system') { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } return; }
  if (/^\d$/.test(event.key)) { event.preventDefault(); pushDigit(event.key); sfx.move(); return; }
  if (event.key === 'Backspace') { event.preventDefault(); codeBuffer = codeBuffer.slice(0, -1); renderCode(); sfx.move(); return; }
  if (event.key === 'Escape') { event.preventDefault(); if (currentSong) stopCurrentSong(); else { clearCode(); sfx.back(); } return; }
  if (event.key === ' ') { if (currentSong) { event.preventDefault(); const paused = midiEngine.togglePause(); showToast(paused ? 'PAUSED' : 'RESUMED'); sfx.move(); } return; }
  if (event.key === 'Enter') { event.preventDefault(); await reserveCode(event.ctrlKey || event.metaKey); return; }
  if (event.key === 'F1') { event.preventDefault(); openSearch(); return; }
  if (event.key === 'F2') { event.preventDefault(); await chooseLibraryFolder(); return; }
  if (event.key === 'F3') { event.preventDefault(); openVisuals(); return; }
  if (event.key === 'F4') { event.preventDefault(); openSystem(); return; }
  if (event.key === 'F11') { event.preventDefault(); await window.openkrk?.toggleFullscreen?.(); }
});

applyPrefs();
renderCode();
Promise.all([refreshLibraryStatus(), refreshVisualCatalog(true), refreshSoundBankStatus()]).catch(error => console.warn(error));
