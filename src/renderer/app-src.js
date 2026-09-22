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
const bootSurface = $('bootSurface');
const bootDetail = $('bootDetail');
const bootProgress = $('bootProgress');
const setupSurface = $('setupSurface');
const setupSongPath = $('setupSongPath');
const setupSongCount = $('setupSongCount');
const setupBgvPath = $('setupBgvPath');
const setupBgvCount = $('setupBgvCount');
const setupBankPath = $('setupBankPath');
const setupBankState = $('setupBankState');
const setupContinue = $('setupContinue');
const setupHint = $('setupHint');
const introSurface = $('introSurface');
const introCountdown = $('introCountdown');
const introVisualName = $('introVisualName');
const newSongsList = $('newSongsList');
const newSongsSource = $('newSongsSource');
const spotlightKicker = $('spotlightKicker');
const spotlightTitle = $('spotlightTitle');
const numberPreview = $('numberPreview');
const idleCurrentCode = $('idleCurrentCode');
const idleCurrentTitle = $('idleCurrentTitle');
const songIntroCard = $('songIntroCard');
const songCover = $('songCover');
const songCoverFallback = $('songCoverFallback');

const FONT_STACKS = {
  system: '"Segoe UI Variable", "Segoe UI", "Arial", sans-serif',
  karaoke: '"Arial Rounded MT Bold", "Arial Black", "Malgun Gothic", "Segoe UI", sans-serif',
  clean: '"Aptos", "Segoe UI Variable", "Segoe UI", sans-serif',
  condensed: '"Arial Narrow", "Bahnschrift SemiCondensed", "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Mono", "Consolas", monospace'
};

const DEFAULT_PREFS = {
  uiScale: 100,
  lyricScale: 100,
  systemFont: 'system',
  lyricFont: 'karaoke',
  systemFontPath: '',
  lyricFontPath: '',
  sfxEnabled: true,
  sfxVolume: 45,
  romanizedEnabled: true,
  lyricDelayMs: 0,
  uiThemeVersion: 3,
  themeMode: 'dark',
  lyricOffsets: {}
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
let startupComplete = false;
let introTimer = null;
let songIntroTimer = null;
let lastLibraryStatus = { root: '', bgvRoot: '', count: 0, visualCount: 0 };
let spotlightPools = { new: [], top: [] };
let spotlightOrders = { new: [], top: [] };
let spotlightCursors = { new: 0, top: 0 };
let spotlightMode = 'new';
let latestRotateTimer = null;
let artworkRequestToken = 0;
let activeLyricDelayMs = Number(prefs.lyricDelayMs) || 0;
let liveLyricCorrectionSec = 0;
let liveLyricSamples = [];
let codePreviewTimer = null;
let codePreviewSerial = 0;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('openkrk-ui-prefs') || '{}');
    const merged = { ...DEFAULT_PREFS, ...saved };
    if (!saved.uiThemeVersion || Number(saved.uiThemeVersion) < 3) {
      if (!saved.systemFont || saved.systemFont === 'condensed') merged.systemFont = 'system';
      if (!saved.lyricFont || saved.lyricFont === 'condensed' || saved.lyricFont === 'rounded') merged.lyricFont = 'karaoke';
      merged.uiThemeVersion = 3;
      if (!saved.themeMode) merged.themeMode = 'dark';
      localStorage.setItem('openkrk-ui-prefs', JSON.stringify(merged));
    }
    return merged;
  } catch { return { ...DEFAULT_PREFS, uiThemeVersion: 3 }; }
}
function savePrefs() { localStorage.setItem('openkrk-ui-prefs', JSON.stringify(prefs)); }
function cleanSongTitle(value = '') {
  return String(value).replace(/\.(xtsp|hmc|enc|pack)$/i, '').trim();
}
function formatLyricDelay(value) {
  const ms = Number(value) || 0;
  const seconds = ms / 1000;
  return (seconds >= 0 ? '+' : '') + seconds.toFixed(2) + 's';
}
function songSyncKey(song) {
  return String(song?.path || song?.code || ((song?.title || '') + '|' + (song?.artist || '')));
}
function loadSongLyricDelay(song) {
  const offsets = prefs.lyricOffsets && typeof prefs.lyricOffsets === 'object' ? prefs.lyricOffsets : {};
  activeLyricDelayMs = Number(offsets[songSyncKey(song)]) || 0;
  if ($('lyricDelay')) $('lyricDelay').value = activeLyricDelayMs;
  if ($('lyricDelayValue')) $('lyricDelayValue').textContent = formatLyricDelay(activeLyricDelayMs);
  if ($('lyricDelayHud')) {
    $('lyricDelayHud').textContent = 'SYNC ' + formatLyricDelay(activeLyricDelayMs);
    $('lyricDelayHud').classList.toggle('active', Math.abs(activeLyricDelayMs) >= 25);
  }
}
function setLyricDelay(value, announce = false) {
  activeLyricDelayMs = Math.max(-5000, Math.min(5000, Math.round(Number(value) || 0)));
  if (currentSong) {
    if (!prefs.lyricOffsets || typeof prefs.lyricOffsets !== 'object') prefs.lyricOffsets = {};
    const key = songSyncKey(currentSong);
    if (Math.abs(activeLyricDelayMs) < 25) delete prefs.lyricOffsets[key];
    else prefs.lyricOffsets[key] = activeLyricDelayMs;
  } else {
    prefs.lyricDelayMs = activeLyricDelayMs;
  }
  savePrefs();
  if ($('lyricDelay')) $('lyricDelay').value = activeLyricDelayMs;
  if ($('lyricDelayValue')) $('lyricDelayValue').textContent = formatLyricDelay(activeLyricDelayMs);
  if ($('lyricDelayHud')) {
    $('lyricDelayHud').textContent = 'SYNC ' + formatLyricDelay(activeLyricDelayMs);
    $('lyricDelayHud').classList.toggle('active', Math.abs(activeLyricDelayMs) >= 25);
  }
  if (announce) showToast('LYRIC SYNC · ' + formatLyricDelay(activeLyricDelayMs));
}

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
  prefs.uiScale = Math.max(80, Math.min(125, Number(prefs.uiScale) || 100));
  prefs.lyricScale = Math.max(75, Math.min(135, Number(prefs.lyricScale) || 100));
  document.documentElement.style.setProperty('--ui-scale', String(prefs.uiScale / 100));
  document.documentElement.style.setProperty('--lyric-scale', String(prefs.lyricScale / 100));
  const requestedTheme = prefs.themeMode || 'dark';
  const resolvedTheme = requestedTheme === 'auto'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : requestedTheme;
  stage.dataset.theme = resolvedTheme;
  const systemStack = prefs.systemFont === 'custom' && prefs.systemFontPath ? installCustomFont('system', prefs.systemFontPath) : FONT_STACKS[prefs.systemFont] || FONT_STACKS.system;
  const lyricStack = prefs.lyricFont === 'custom' && prefs.lyricFontPath ? installCustomFont('lyric', prefs.lyricFontPath) : FONT_STACKS[prefs.lyricFont] || FONT_STACKS.karaoke;
  document.documentElement.style.setProperty('--ui', systemStack);
  document.documentElement.style.setProperty('--display', systemStack);
  document.documentElement.style.setProperty('--lyric-font', lyricStack);
  $('uiScale').value = prefs.uiScale;
  $('uiScaleValue').textContent = `${prefs.uiScale}%`;
  $('lyricScale').value = prefs.lyricScale;
  $('lyricScaleValue').textContent = `${prefs.lyricScale}%`;
  $('systemFont').value = prefs.systemFont;
  $('lyricFont').value = prefs.lyricFont;
  $('themeMode').value = prefs.themeMode || 'dark';
  $('sfxEnabled').value = prefs.sfxEnabled ? 'on' : 'off';
  $('romanizedEnabled').value = prefs.romanizedEnabled ? 'on' : 'off';
  $('sfxVolume').value = prefs.sfxVolume;
  $('sfxVolumeValue').textContent = `${prefs.sfxVolume}%`;
  $('lyricDelay').value = activeLyricDelayMs;
  $('lyricDelayValue').textContent = formatLyricDelay(activeLyricDelayMs);
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
  intro() {
    void this.tone(220, 1.7, 0.02, 'sine', 0);
    void this.tone(330, 1.6, 0.016, 'sine', 0.14);
    void this.tone(440, 1.45, 0.012, 'triangle', 0.32);
    void this.tone(660, 0.28, 0.02, 'sine', 2.9);
    void this.tone(880, 0.42, 0.016, 'sine', 3.16);
  }
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
    this.pendingReject = null;
    this.onTextEvent = null;
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
    this.sequencer.eventHandler.addEvent('songChange', 'openkrk-song-ready', midiData => {
      if (this.pendingReady) {
        const resolve = this.pendingReady;
        this.pendingReady = null;
        this.pendingReject = null;
        resolve(midiData);
      }
    });
    this.sequencer.eventHandler.addEvent('midiError', 'openkrk-midi-error', error => {
      if (this.pendingReject) {
        const reject = this.pendingReject;
        this.pendingReady = null;
        this.pendingReject = null;
        reject(error instanceof Error ? error : new Error(String(error?.message || error || 'MIDI parse error')));
      }
    });
    this.sequencer.eventHandler.addEvent('textEvent', 'openkrk-lyric-clock', payload => {
      try { this.onTextEvent?.(payload); } catch (error) { console.warn('[OpenKRK] text event:', error); }
    });
    await this.context.resume();
  }
  setSoundBankPath(filePath) { this.soundBankPath = filePath || ''; }
  async resetCore() {
    try { this.sequencer?.pause(); } catch {}
    try { this.synth?.stopAll(true); } catch {}
    try { await this.synth?.destroy?.(); } catch {}
    try { await this.context?.close?.(); } catch {}
    this.context = null; this.synth = null; this.sequencer = null; this.loadedBankPath = ''; this.pendingReady = null; this.pendingReject = null;
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
    const ready = new Promise((resolve, reject) => {
      this.pendingReady = resolve;
      this.pendingReject = reject;
      setTimeout(() => {
        if (this.pendingReady === resolve) {
          this.pendingReady = null;
          this.pendingReject = null;
          reject(new Error('MIDI did not finish loading. Check the file format or SoundFont.'));
        }
      }, 12000);
    });
    this.sequencer.loadNewSongList([{ binary, fileName: cleanSongTitle(song.title) || 'OpenKRK Song' }]);
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
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestValue(sorted, target) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid] < target) lo = mid + 1; else hi = mid;
  }
  const a = sorted[lo];
  const b = lo > 0 ? sorted[lo - 1] : null;
  if (b == null) return a;
  return Math.abs(a - target) < Math.abs(b - target) ? a : b;
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
      const notes = [];

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

        if (status === 0xf0 || status === 0xf7) {
          state.pos = Math.min(end, state.pos + readVlq(bytes, state));
          continue;
        }

        const hi = status & 0xf0;
        const channel = status & 0x0f;
        const size = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        const data1 = bytes[state.pos] ?? 0;
        const data2 = size > 1 ? (bytes[state.pos + 1] ?? 0) : 0;
        if (hi === 0x90 && data2 > 0 && channel !== 9) notes.push({ tick, pitch: data1, channel });
        state.pos = Math.min(end, state.pos + size);
      }

      tracks.push({ name: trackName, texts, notes });
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
      lastTick = tempo.tick;
      us = tempo.us;
    }

    const tickToSec = tick => {
      let segment = tempoSegments[0] || { tick: 0, sec: 0, us: 500000 };
      for (let i = 1; i < tempoSegments.length; i += 1) {
        if (tempoSegments[i].tick > tick) break;
        segment = tempoSegments[i];
      }
      return segment.sec + ((tick - segment.tick) * segment.us) / (ppq * 1_000_000);
    };

    const scored = tracks.map(track => {
      const lyricEvents = track.texts.filter(item => item.type === 0x05);
      const usefulText = track.texts.filter(item => {
        const text = String(item.text || '').trim();
        if (!text || text.startsWith('@')) return false;
        if (item.tick === 0 && /^(title|artist|composer|copyright|words|music)\b/i.test(text)) return false;
        return true;
      });
      const nameBonus = /lyric|vocal|kara|words|melody|guide/i.test(track.name || '') ? 40 : 0;
      return { ...track, lyricEvents, usefulText, score: lyricEvents.length * 5 + usefulText.length + nameBonus };
    }).sort((a, b) => b.score - a.score);

    const candidate = scored[0];
    if (!candidate || candidate.usefulText.length < 2) return [];

    const sourceEvents = candidate.lyricEvents.length >= Math.max(2, candidate.usefulText.length * 0.35)
      ? candidate.lyricEvents
      : candidate.usefulText;

    let events = sourceEvents
      .filter(item => {
        const text = String(item.text || '').trim();
        return text && !text.startsWith('@') && !(item.tick === 0 && /^(title|artist|composer|copyright|words|music)\b/i.test(text));
      })
      .map(item => ({ tick: item.tick, time: tickToSec(item.tick), text: String(item.text || '') }))
      .sort((a, b) => a.time - b.time);

    if (!events.length) return [];

    // Find the note track whose note onsets line up best with lyric events.
    let bestNoteTimes = [];
    let bestAlignmentScore = 0;
    for (const track of tracks) {
      if (track.notes.length < 4) continue;
      const times = track.notes.map(note => tickToSec(note.tick)).sort((a, b) => a - b);
      let hits = 0;
      let error = 0;
      for (const event of events) {
        const nearest = nearestValue(times, event.time);
        const diff = nearest == null ? Infinity : Math.abs(nearest - event.time);
        if (diff <= 0.34) { hits += 1; error += diff; }
      }
      const hitRate = hits / events.length;
      const avgError = hits ? error / hits : 1;
      const densityPenalty = Math.min(0.35, Math.abs(times.length - events.length) / Math.max(times.length, events.length) * 0.2);
      const nameBonus = /vocal|melody|guide|lead|sing/i.test(track.name || '') ? 0.18 : 0;
      const score = hitRate - avgError * 0.55 - densityPenalty + nameBonus;
      if (score > bestAlignmentScore) { bestAlignmentScore = score; bestNoteTimes = times; }
    }

    // Estimate a stable global lyric offset from the guide/melody note onsets.
    let autoOffset = 0;
    if (bestNoteTimes.length && bestAlignmentScore > 0.33) {
      const diffs = [];
      for (const event of events) {
        const nearest = nearestValue(bestNoteTimes, event.time);
        if (nearest != null && Math.abs(nearest - event.time) <= 0.34) diffs.push(nearest - event.time);
      }
      if (diffs.length >= Math.min(8, Math.ceil(events.length * 0.35))) {
        const med = median(diffs);
        const mad = median(diffs.map(value => Math.abs(value - med)));
        if (mad < 0.17) autoOffset = Math.max(-0.55, Math.min(0.55, med));
      }
    }

    events = events.map(event => {
      let time = Math.max(0, event.time + autoOffset);
      if (bestNoteTimes.length && bestAlignmentScore > 0.48) {
        const nearest = nearestValue(bestNoteTimes, time);
        if (nearest != null && Math.abs(nearest - time) <= 0.095) time = nearest;
      }
      return { ...event, time };
    });

    const lines = [];
    let segments = [];

    const lineText = () => segments.map(segment => segment.text).join('').replace(/\s+/g, ' ').trim();
    const pushLine = explicitEnd => {
      if (!segments.length) return;
      const text = lineText();
      if (!text) { segments = []; return; }
      lines.push({ start: segments[0].start, explicitEnd, text, segments: segments.map(segment => ({ ...segment })) });
      segments = [];
    };

    const addSegment = (text, time, tick) => {
      const normalized = String(text || '').replace(/\^/g, ' ').replace(/\s+/g, ' ');
      if (!normalized.trim()) return;
      if (segments.length) {
        const previous = segments[segments.length - 1];
        const gap = time - previous.start;
        const currentText = lineText();
        const punctuated = /[.!?…,:;]$/.test(currentText);
        if (gap > 1.65 || (gap > .82 && punctuated) || (gap > .58 && currentText.length > 48)) pushLine(time);
      }
      segments.push({ text: normalized, start: time, tick: Number(tick) || 0 });
    };

    for (const event of events) {
      let buffer = '';
      const flush = () => {
        if (buffer) addSegment(buffer, event.time, event.tick);
        buffer = '';
      };
      for (const char of event.text.replace(/\r/g, '\n')) {
        if (char === '/' || char === '\\' || char === '\n') {
          flush();
          pushLine(event.time);
        } else {
          buffer += char;
        }
      }
      flush();
    }
    pushLine(null);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const nextLineStart = lines[i + 1]?.start;
      const lastStart = line.segments[line.segments.length - 1].start;
      const naturalLineEnd = Number.isFinite(nextLineStart) ? Math.max(line.start + .35, nextLineStart - .04) : lastStart + 2.4;
      line.end = Math.max(line.start + .35, Number.isFinite(line.explicitEnd) ? Math.max(line.explicitEnd, lastStart + .16) : naturalLineEnd);

      const gaps = [];
      for (let s = 1; s < line.segments.length; s += 1) gaps.push(line.segments[s].start - line.segments[s - 1].start);
      const medianGap = Math.max(.18, Math.min(1.2, median(gaps.filter(value => value > .03)) || .55));

      for (let s = 0; s < line.segments.length; s += 1) {
        const segment = line.segments[s];
        const nextStart = line.segments[s + 1]?.start;
        const desiredEnd = Number.isFinite(nextStart) ? nextStart : Math.min(line.end, segment.start + medianGap * 1.15);
        segment.end = Math.max(segment.start + .09, Math.min(desiredEnd, segment.start + 1.55));
      }
    }

    lines.autoOffset = autoOffset;
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
function pushDigit(digit) {
  if (!startupComplete) return;
  if (mode !== 'idle' && mode !== 'player') return;
  if (codeBuffer.length >= 5) codeBuffer = '';
  codeBuffer += digit;
  renderCode();
}
function clearCode() { codeBuffer = ''; renderCode(); }

function updateLibraryUi(status = {}) {
  lastLibraryStatus = { ...lastLibraryStatus, ...status };
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
async function refreshLibraryStatus() {
  const status = await window.openkrk?.getLibraryStatus?.();
  if (status) {
    updateLibraryUi(status);
    updateSetupUi(status);
  }
  return status || null;
}

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
  updateSetupUi(lastLibraryStatus);
  return catalog;
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
  showToast('Choose the folder containing your MID / MIDI / KAR files');
  const result = await window.openkrk?.chooseLibraryFolder?.();
  if (!result || result.canceled) return;
  await Promise.all([refreshLibraryStatus(), refreshVisualCatalog(true)]);
  showToast('Song library updated');
  sfx.confirm();
  await renderLatestSongs();
  return result;
}
async function chooseVisualSource() {
  const result = await window.openkrk?.chooseBgvFolder?.();
  if (!result || result.canceled) return;
  activeVisualCategory = 'ALL';
  await refreshVisualCatalog(true);
  showToast('Background videos updated');
  sfx.confirm();
  updateSetupUi(lastLibraryStatus);
  return result;
}


function compactPath(value = '') {
  const text = String(value || '');
  if (text.length <= 58) return text || 'Not selected';
  return '…' + text.slice(-57);
}

function updateSetupUi(status = lastLibraryStatus) {
  const songs = Number(status?.count) || libraryCount || 0;
  const visuals = Number(visualCatalog?.count) || Number(status?.visualCount) || 0;
  setupSongPath.textContent = compactPath(status?.root);
  setupSongCount.textContent = songs ? formatCount(songs) + ' SONGS READY' : 'NOT CONNECTED';
  setupBgvPath.textContent = compactPath(visualCatalog?.root || status?.bgvRoot);
  setupBgvCount.textContent = visuals ? formatCount(visuals) + ' VISUALS READY' : 'OPTIONAL';
  setupContinue.disabled = songs < 1;
  setupHint.textContent = songs
    ? (visuals ? 'Library is ready. Enter the room.' : 'Songs are ready. You can add BGVs now or later with F3.')
    : 'Add a songs folder to continue.';
}

function formatFreshDate(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return 'LOCAL';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'TODAY';
  return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' }).toUpperCase();
}

function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function loadArtworkInto(element, url) {
  if (!url || !element) return;
  try {
    const data = await window.openkrk?.getArtworkData?.(url);
    if (!data || !element.isConnected) return;
    const image = document.createElement('img');
    image.className = 'new-song-art';
    image.alt = '';
    image.src = data;
    element.replaceWith(image);
  } catch {}
}

function renderLatestPage() {
  if (!latestPool.length) return;
  if (!latestOrder.length || latestCursor + 8 > latestOrder.length) {
    latestOrder = shuffled(latestPool);
    latestCursor = 0;
  }
  const rows = latestOrder.slice(latestCursor, latestCursor + 8);
  latestCursor += rows.length;

  newSongsList.classList.add('rotating');
  setTimeout(() => {
    newSongsList.replaceChildren();
    rows.forEach((song, index) => {
      const row = document.createElement('div');
      row.className = 'new-song-row';
      row.tabIndex = 0;

      const art = document.createElement('div');
      art.className = 'new-song-art placeholder';
      art.textContent = '♪';

      const code = document.createElement('span');
      code.className = 'new-song-code';
      code.textContent = song.code || String(index + 1).padStart(4, '0');

      const title = document.createElement('strong');
      title.className = 'new-song-title';
      title.textContent = cleanSongTitle(song.title || 'Untitled');

      const artist = document.createElement('span');
      artist.className = 'new-song-artist';
      artist.textContent = song.artist || 'Unknown Artist';

      const accept = () => {
        codeBuffer = String(song.code || '');
        renderCode();
        idleCurrentCode.textContent = song.code || '—';
        idleCurrentTitle.textContent = cleanSongTitle(song.title || 'Untitled') + ' · ' + (song.artist || 'Unknown Artist');
        sfx.confirm();
      };

      row.append(art, code, title, artist);
      row.addEventListener('click', accept);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); accept(); }
      });
      newSongsList.appendChild(row);

      const artwork = song.discovery?.artworkUrl || '';
      if (artwork) loadArtworkInto(art, artwork);
    });
    requestAnimationFrame(() => newSongsList.classList.remove('rotating'));
  }, 170);
}

function startLatestRotation() {
  clearInterval(latestRotateTimer);
  if (latestPool.length <= 8) return;
  latestRotateTimer = setInterval(() => {
    if (mode === 'idle') renderLatestPage();
  }, 6500);
}

async function renderLatestSongs(force = false) {
  newSongsSource.textContent = force ? 'REFRESHING…' : 'FINDING RECENT TRACKS…';
  newSongsList.replaceChildren();
  const waiting = document.createElement('div');
  waiting.className = 'new-song-empty';
  waiting.textContent = 'Finding recent songs…';
  newSongsList.appendChild(waiting);

  let discovery = null;
  try {
    discovery = await window.openkrk?.discoverCurrentSongs?.(64, force);
  } catch (error) {
    console.warn('[OpenKRK] discovery API:', error);
  }

  let rows = discovery?.items || [];
  let fallback = false;
  if (!rows.length) {
    rows = await window.openkrk?.getLatestSongs?.(64) || [];
    fallback = true;
  }

  latestPool = rows;
  latestOrder = shuffled(rows);
  latestCursor = 0;

  if (!rows.length) {
    newSongsList.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'new-song-empty';
    empty.textContent = 'No songs found.';
    newSongsList.appendChild(empty);
    newSongsSource.textContent = 'NO SONGS';
    clearInterval(latestRotateTimer);
    return;
  }

  newSongsSource.textContent = fallback
    ? 'RECENT SONGS'
    : 'GLOBAL · ' + formatCount(discovery?.matchedCount || rows.length) + ' FOUND';

  renderLatestPage();
  startLatestRotation();
}

function showSetup() {
  startupComplete = false;
  bootSurface.classList.add('hidden');
  setupSurface.classList.add('visible');
  setupSurface.setAttribute('aria-hidden', 'false');
  updateSetupUi(lastLibraryStatus);
}

function hideSetup() {
  setupSurface.classList.remove('visible');
  setupSurface.setAttribute('aria-hidden', 'true');
}

function stopIntroSequence() {
  if (introTimer) clearTimeout(introTimer);
  introTimer = null;
  introSurface.classList.remove('visible');
  introSurface.setAttribute('aria-hidden', 'true');
  if (introCountdown) {
    introCountdown.style.transition = 'none';
    introCountdown.style.width = '0%';
  }
}

async function runIntroSequence() {
  hideSetup();
  bootSurface.classList.add('hidden');
  await refreshVisualCatalog(true);
  introVisualName.textContent = visualNowName.textContent || (visualCatalog.count ? 'BGV PREVIEW' : 'DEFAULT VISUAL');
  introSurface.classList.add('visible');
  introSurface.setAttribute('aria-hidden', 'false');
  sfx.intro();

  requestAnimationFrame(() => {
    introCountdown.style.transition = 'width 5s linear';
    introCountdown.style.width = '100%';
  });

  await new Promise(resolve => {
    introTimer = setTimeout(resolve, 5000);
  });
  stopIntroSequence();
  startupComplete = true;
  await renderLatestSongs();
  setMode('idle');
  showToast('ROOM READY · type a song number or press F1');
}

async function bootstrapRoom() {
  startupComplete = false;
  bootDetail.textContent = 'Reading cached library';
  bootProgress.style.width = '18%';

  const status = await refreshLibraryStatus();
  bootProgress.style.width = '46%';
  await refreshVisualCatalog(false);
  bootProgress.style.width = '68%';
  await refreshSoundBankStatus();
  bootProgress.style.width = '88%';
  updateSetupUi(status || lastLibraryStatus);

  if (!status?.count) {
    bootDetail.textContent = 'No songs found — media setup required';
    bootProgress.style.width = '100%';
    setTimeout(showSetup, 450);
    return;
  }

  bootDetail.textContent = formatCount(status.count) + ' songs ready';
  bootProgress.style.width = '100%';
  await new Promise(resolve => setTimeout(resolve, 550));
  await runIntroSequence();
}

function renderMetadataCard(song, metadata = null) {
  const title = cleanSongTitle(metadata?.title || song?.title || 'Untitled');
  const artist = metadata?.artist || song?.artist || 'Unknown Artist';
  $('metaTitle').textContent = title;
  $('metaArtist').textContent = artist;
  $('metaAlbum').textContent = metadata?.album || '';
  $('metaCredits').textContent = '';
  $('metaReleaseDate').textContent = metadata?.releaseDate || '';

  const requestToken = ++artworkRequestToken;
  songCoverFallback.style.display = '';
  songCover.removeAttribute('src');

  const artwork = metadata?.artworkUrl || song?.discovery?.artworkUrl || '';
  if (artwork) {
    window.openkrk?.getArtworkData?.(artwork).then(data => {
      if (!data || requestToken !== artworkRequestToken || currentSong !== song) return;
      songCover.onload = () => { songCoverFallback.style.display = 'none'; };
      songCover.onerror = () => { songCover.removeAttribute('src'); songCoverFallback.style.display = ''; };
      songCover.src = data;
    }).catch(() => {});
  }
}

function revealSongIntro(song) {
  clearTimeout(songIntroTimer);
  renderMetadataCard(song, null);
  songIntroCard.classList.remove('hidden');
  songIntroTimer = setTimeout(() => songIntroCard.classList.add('hidden'), 6200);
}

function enrichSongIntro(song, durationSeconds = 0) {
  window.openkrk?.resolveSongMetadata?.({
    code: song.code,
    title: song.title,
    artist: song.artist,
    durationMs: Math.round(Math.max(0, Number(durationSeconds) || 0) * 1000)
  }).then(metadata => {
    if (currentSong !== song) return;
    renderMetadataCard(song, metadata);
  }).catch(() => {});
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
  renderSearchMessage(libraryCount ? 'Start typing to search your songs.' : 'Open System and choose a songs folder first.');
  searchMeta.textContent = libraryCount ? `${formatCount(libraryCount)} SONGS INDEXED` : 'NO LIBRARY INDEXED';
  sfx.move();
}
function openVisuals() { setMode('visuals'); renderVisualCategories(); sfx.move(); }
function openSystem() { setMode('system'); sfx.move(); }
function closePanel() { sfx.back(); returnToRoom(); }
function renderSearchResults(rows, query) {
  searchResults.replaceChildren();
  searchMeta.textContent = `${rows.length} RESULT${rows.length === 1 ? '' : 'S'} · ${formatCount(libraryCount)} SONGS INDEXED`;
  if (!rows.length) { renderSearchMessage(`No songs matched “${query}”.`); return; }
  for (const song of rows) {
    const row = document.createElement('div'); row.className = 'search-row'; row.tabIndex = 0;
    const code = document.createElement('span'); code.className = 'search-row-code'; code.textContent = song.code || '—'; if (song.generatedCode) code.dataset.local = 'true';
    const copy = document.createElement('div'); copy.className = 'search-row-copy';
    const title = document.createElement('strong'); title.textContent = cleanSongTitle(song.title || 'Untitled');
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
  if (!trimmed) { renderSearchMessage(libraryCount ? 'Start typing to search your songs.' : 'No song library yet.'); return; }
  const rows = await window.openkrk?.searchSongs?.(trimmed, 80) || [];
  if (searchInput.value.trim() !== trimmed) return;
  renderSearchResults(rows, trimmed);
}

function renderLyricLine(index, time) {
  if (!currentLyrics.length || index < 0 || index >= currentLyrics.length) {
    $('lyricPrev').textContent = ''; $('lyricCurrent').textContent = '♪'; $('lyricRomanized').textContent = ''; $('lyricNext').textContent = ''; return;
  }
  const line = currentLyrics[index];
  $('lyricPrev').textContent = currentLyrics[index - 1]?.text || '';
  $('lyricNext').textContent = currentLyrics[index + 1]?.text || '';
  $('lyricRomanized').textContent = prefs.romanizedEnabled ? (line.romanized || '') : '';
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

  const activeIndex = currentLyrics.findIndex(line => time >= line.start && time < line.end);
  if (activeIndex >= 0) {
    renderLyricLine(activeIndex, time);
    return;
  }

  let previousIndex = -1;
  let nextIndex = -1;
  for (let i = 0; i < currentLyrics.length; i += 1) {
    if (currentLyrics[i].start <= time) previousIndex = i;
    else { nextIndex = i; break; }
  }

  const current = $('lyricCurrent');
  current.replaceChildren();
  current.textContent = '♪';
  $('lyricPrev').textContent = previousIndex >= 0 ? currentLyrics[previousIndex].text : '';
  $('lyricNext').textContent = nextIndex >= 0 ? currentLyrics[nextIndex].text : '';
  $('lyricRomanized').textContent = '';
  currentLyricLine = -1;
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
      const lyricTime = Math.max(0, state.currentTime - (activeLyricDelayMs / 1000));
      updateLyrics(lyricTime);
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
    loadSongLyricDelay(song);
    const displayTitle = cleanSongTitle(song.title || 'Untitled');
    $('nowCode').textContent = song.code || '—'; $('nowTitle').textContent = displayTitle; $('nowArtist').textContent = song.artist || 'Unknown Artist'; idleCurrentCode.textContent = song.code || '—'; idleCurrentTitle.textContent = displayTitle + ' · ' + (song.artist || 'Unknown Artist');
    $('lyricCurrent').textContent = 'LOADING MIDI…'; $('lyricPrev').textContent = ''; $('lyricNext').textContent = '';
    setMode('player');
    revealSongIntro(song);
    const binary = await midiEngine.playSong(song);
    enrichSongIntro(song, midiEngine.state().duration);
    currentLyrics = parseMidiLyrics(binary);
    currentLyricLine = -1;
    $('lyricCurrent').textContent = '♪';
    $('lyricPrev').textContent = '';
    $('lyricRomanized').textContent = '';
    $('lyricNext').textContent = currentLyrics[0]?.text || '';
    sfx.confirm(); startTransportLoop();
  } catch (error) {
    console.error(error); currentSong = null; currentLyrics = []; setMode('idle'); showToast(`MIDI ERROR · ${error.message || error}`, 5200); sfx.error();
  }
}
function stopCurrentSong(withSfx = true) {
  midiEngine.stop(); currentSong = null; currentLyrics = []; currentLyricLine = -1; activeLyricDelayMs = Number(prefs.lyricDelayMs) || 0; cancelAnimationFrame(transportRaf); clearTimeout(songIntroTimer); songIntroCard.classList.remove('hidden'); setLyricDelay(activeLyricDelayMs, false);
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
  setupBankPath.textContent = status?.path ? compactPath(status.path) : 'Choose SF2 / SF3 / DLS for MIDI playback';
  setupBankState.textContent = status?.name ? 'READY · ' + status.name : 'REQUIRED TO PLAY';
  return status || null;
}
async function chooseSoundBank() {
  const result = await window.openkrk?.chooseSoundBank?.();
  if (!result || result.canceled) { if (result?.error) showToast('Unsupported sound bank format'); return; }
  midiEngine.setSoundBankPath(result.path);
  soundBankName.textContent = result.name;
  audioStatus.textContent = 'LOADING BANK';
  try { await midiEngine.ensureSoundBank(); audioStatus.textContent = 'MIDI READY'; setupBankPath.textContent = compactPath(result.path); setupBankState.textContent = 'READY · ' + result.name; showToast(`Sound bank ready · ${result.name}`); sfx.confirm(); }
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
$('themeMode').addEventListener('change', event => { prefs.themeMode = event.target.value; savePrefs(); applyPrefs(); sfx.move(); });
$('lyricScale').addEventListener('input', event => { prefs.lyricScale = Number(event.target.value); savePrefs(); applyPrefs(); });
$('lyricDelay').addEventListener('input', event => { setLyricDelay(event.target.value, false); });
$('systemFont').addEventListener('change', event => { prefs.systemFont = event.target.value; savePrefs(); applyPrefs(); sfx.move(); });
$('lyricFont').addEventListener('change', event => { prefs.lyricFont = event.target.value; savePrefs(); applyPrefs(); sfx.move(); });
$('sfxEnabled').addEventListener('change', event => { prefs.sfxEnabled = event.target.value === 'on'; savePrefs(); if (prefs.sfxEnabled) sfx.confirm(); });
$('romanizedEnabled').addEventListener('change', event => { prefs.romanizedEnabled = event.target.value === 'on'; savePrefs(); applyPrefs(); sfx.move(); });
$('sfxVolume').addEventListener('input', event => { prefs.sfxVolume = Number(event.target.value); savePrefs(); applyPrefs(); });

bgv.addEventListener('ended', () => { if (filesForCategory().length) playBgv(bgvIndex + 1); });
bgv.addEventListener('error', () => { if (filesForCategory().length > 1) playBgv(bgvIndex + 1); });
window.openkrk?.onLibraryProgress?.(progress => {
  updateLibraryUi({ count: progress.songs || 0, visualCount: progress.visuals || 0, scanning: progress.scanning, scanned: progress.scanned, root: progress.root });
  if (progress.done) Promise.all([refreshLibraryStatus(), refreshVisualCatalog(false), renderLatestSongs()]).catch(() => {});
  if (bootProgress && progress.scanning) bootProgress.style.width = `${Math.min(92, 20 + Math.log10(Math.max(10, Number(progress.scanned) || 10)) * 20)}%`;
  if (bootDetail && progress.scanning) bootDetail.textContent = `${formatCount(progress.scanned)} files checked · ${formatCount(progress.songs)} songs`;
  if (progress.error) showToast(`Library scan failed · ${progress.error}`, 5000);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'setup-songs') { sfx.move(); const result = await chooseLibraryFolder(); if (result) updateSetupUi(await refreshLibraryStatus()); }
  else if (action === 'setup-bgvs') { sfx.move(); await chooseVisualSource(); updateSetupUi(await refreshLibraryStatus()); }
  else if (action === 'setup-bank') { sfx.move(); await chooseSoundBank(); await refreshSoundBankStatus(); }
  else if (action === 'setup-continue') { if (!setupContinue.disabled) await runIntroSequence(); }
  else if (action === 'refresh-new-songs') { sfx.move(); await renderLatestSongs(true); showToast('NEW SONGS UPDATED'); }
  else if (action === 'search') openSearch();
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
  if (!startupComplete) {
    if (setupSurface.classList.contains('visible') && event.key === 'Enter' && !setupContinue.disabled) {
      event.preventDefault();
      await runIntroSequence();
    }
    return;
  }
  if (mode === 'search') { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } return; }
  if (mode === 'visuals' || mode === 'system') { if (event.key === 'Escape') { event.preventDefault(); closePanel(); } return; }
  if (/^\d$/.test(event.key)) { event.preventDefault(); pushDigit(event.key); sfx.move(); return; }
  if (event.key === 'Backspace') { event.preventDefault(); codeBuffer = codeBuffer.slice(0, -1); renderCode(); sfx.move(); return; }
  if (event.key === 'Escape') { event.preventDefault(); if (currentSong) stopCurrentSong(); else { clearCode(); sfx.back(); } return; }
  if (event.key === ' ') { if (currentSong) { event.preventDefault(); const paused = midiEngine.togglePause(); showToast(paused ? 'PAUSED' : 'RESUMED'); sfx.move(); } return; }
  if (currentSong && event.key === '[') { event.preventDefault(); setLyricDelay(activeLyricDelayMs - 100, true); return; }
  if (currentSong && event.key === ']') { event.preventDefault(); setLyricDelay(activeLyricDelayMs + 100, true); return; }
  if (currentSong && event.key === '\\') { event.preventDefault(); setLyricDelay(0, true); return; }
  if (event.key === 'Enter') { event.preventDefault(); await reserveCode(true); return; }
  if (event.key === 'F1') { event.preventDefault(); openSearch(); return; }
  if (event.key === 'F2') { event.preventDefault(); await chooseLibraryFolder(); return; }
  if (event.key === 'F3') { event.preventDefault(); openVisuals(); return; }
  if (event.key === 'F4') { event.preventDefault(); openSystem(); return; }
  if (event.key === 'F11') { event.preventDefault(); await window.openkrk?.toggleFullscreen?.(); }
});

window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (prefs.themeMode === 'auto') applyPrefs();
});
applyPrefs();
setLyricDelay(activeLyricDelayMs, false);
renderCode();
bootstrapRoom().catch(error => {
  console.error(error);
  bootDetail.textContent = 'Startup error · ' + (error.message || error);
  bootProgress.style.width = '100%';
  setTimeout(showSetup, 900);
});
