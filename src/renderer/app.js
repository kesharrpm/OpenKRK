(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const bgv = document.getElementById('bgv');
  const codeDisplay = document.getElementById('codeDisplay');
  const roomState = document.getElementById('roomState');
  const roomHint = document.getElementById('roomHint');
  const libraryStatus = document.getElementById('libraryStatus');
  const bgvStatus = document.getElementById('bgvStatus');
  const tickerPrimary = document.getElementById('tickerPrimary');
  const tickerSecondary = document.getElementById('tickerSecondary');
  const searchInput = document.getElementById('searchInput');
  const searchMeta = document.getElementById('searchMeta');
  const searchResults = document.getElementById('searchResults');
  const toast = document.getElementById('toast');

  let mode = 'idle';
  let codeBuffer = '';
  let bgvFiles = [];
  let bgvIndex = -1;
  let libraryCount = 0;
  let toastTimer = null;
  let searchTimer = null;

  function setMode(next) {
    mode = next;
    stage.classList.remove('mode-idle', 'mode-player', 'mode-search');
    stage.classList.add(`mode-${next}`);
    document.getElementById('playerSurface').setAttribute('aria-hidden', String(next !== 'player'));
    document.getElementById('searchSurface').setAttribute('aria-hidden', String(next !== 'search'));
    if (next === 'search') requestAnimationFrame(() => searchInput.focus());
  }

  function showToast(message, ms = 2200) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function renderCode() {
    codeDisplay.textContent = codeBuffer ? codeBuffer.split('').join(' ') : '— — — — —';
  }

  function pushDigit(digit) {
    if (mode === 'search') return;
    if (codeBuffer.length >= 7) codeBuffer = '';
    codeBuffer += digit;
    renderCode();
  }

  function clearCode() {
    codeBuffer = '';
    renderCode();
  }

  function formatCount(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
  }

  function updateVisualUi() {
    bgvStatus.textContent = bgvFiles.length ? `${formatCount(bgvFiles.length)} VISUALS` : 'BGV OFF';
  }

  function updateLibraryUi(status = {}) {
    libraryCount = Number(status.count) || 0;
    libraryStatus.textContent = libraryCount ? `${formatCount(libraryCount)} SONGS` : 'NO LIBRARY';

    if (typeof status.visualCount === 'number' && !bgvFiles.length && status.visualCount > 0) {
      bgvStatus.textContent = `${formatCount(status.visualCount)} VISUALS`;
    }

    if (status.scanning) {
      roomState.textContent = 'INDEXING';
      roomHint.textContent = `${formatCount(status.scanned)} files checked`;
      tickerPrimary.textContent = 'Reading songs and visuals from one media folder…';
      tickerSecondary.textContent = `${formatCount(status.count || status.songs)} songs · ${formatCount(status.visualCount || status.visuals)} visuals found so far`;
    } else if (libraryCount) {
      roomState.textContent = 'ROOM READY';
      roomHint.textContent = 'Type any song number or press F1 to search';
      tickerPrimary.textContent = `${formatCount(libraryCount)} songs indexed locally`;
      tickerSecondary.textContent = status.root || 'Local mixed karaoke media folder';
    } else {
      roomState.textContent = 'MEDIA NEEDED';
      roomHint.textContent = 'F2 · choose the folder containing your songs and BGVs';
      tickerPrimary.textContent = 'Point OpenKRK at your karaoke media folder.';
      tickerSecondary.textContent = 'MID / MIDI / KAR and video BGVs can live together in the same folder tree.';
    }
  }

  async function refreshLibraryStatus() {
    const status = await window.openkrk?.getLibraryStatus?.();
    if (status) updateLibraryUi(status);
  }

  function localFileUrl(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`);
  }

  function playBgv(index) {
    if (!bgvFiles.length) return;
    bgvIndex = ((index % bgvFiles.length) + bgvFiles.length) % bgvFiles.length;
    bgv.src = localFileUrl(bgvFiles[bgvIndex]);
    bgv.load();
    bgv.play().catch(() => {});
  }

  async function refreshVisuals(playIfIdle = false) {
    const files = await window.openkrk?.getVisuals?.();
    if (!Array.isArray(files)) return;
    bgvFiles = files;
    updateVisualUi();
    if (playIfIdle && bgvFiles.length) playBgv(Math.floor(Math.random() * bgvFiles.length));
  }

  async function chooseLibraryFolder() {
    if (!window.openkrk?.chooseLibraryFolder) return;
    showToast('Choose the folder containing your MID/KAR files and BGV videos');
    const result = await window.openkrk.chooseLibraryFolder();
    if (!result || result.canceled) return;

    if (Array.isArray(result.visuals)) {
      bgvFiles = result.visuals;
      updateVisualUi();
      if (bgvFiles.length) playBgv(Math.floor(Math.random() * bgvFiles.length));
    } else {
      await refreshVisuals(true);
    }

    await refreshLibraryStatus();
    showToast(`${formatCount(result.count)} songs · ${formatCount(result.visualCount)} visuals indexed`);
  }

  async function chooseBgvFolder() {
    if (!window.openkrk?.chooseBgvFolder) return;
    const result = await window.openkrk.chooseBgvFolder();
    if (!result || result.canceled) return;
    bgvFiles = Array.isArray(result.files) ? result.files : [];
    updateVisualUi();
    if (!bgvFiles.length) {
      showToast('No supported videos found in that folder');
      return;
    }
    showToast(`${formatCount(bgvFiles.length)} BGVs ready`);
    playBgv(Math.floor(Math.random() * bgvFiles.length));
  }

  function openSearch() {
    setMode('search');
    renderSearchMessage(libraryCount ? 'Start typing to search your local library.' : 'Press F2 after closing search to choose your mixed media folder.');
    searchMeta.textContent = libraryCount ? `${formatCount(libraryCount)} SONGS INDEXED` : 'NO LIBRARY INDEXED';
  }

  function closeSearch() {
    searchInput.value = '';
    searchResults.replaceChildren();
    setMode('idle');
  }

  function renderSearchMessage(message) {
    searchResults.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = message;
    searchResults.appendChild(empty);
  }

  function renderSearchResults(rows, query) {
    searchResults.replaceChildren();
    searchMeta.textContent = `${rows.length} RESULT${rows.length === 1 ? '' : 'S'} · ${formatCount(libraryCount)} SONGS INDEXED`;

    if (!rows.length) {
      renderSearchMessage(`No local songs matched “${query}”.`);
      return;
    }

    for (const song of rows) {
      const row = document.createElement('div');
      row.className = 'search-row';
      row.tabIndex = 0;

      const code = document.createElement('span');
      code.className = 'search-row-code';
      code.textContent = song.code || '—';
      if (song.generatedCode) code.dataset.local = 'true';
      code.title = song.generatedCode ? 'OpenKRK local song number' : 'Song number';

      const copy = document.createElement('div');
      copy.className = 'search-row-copy';
      const title = document.createElement('strong');
      title.textContent = song.title || 'Untitled';
      const artist = document.createElement('span');
      artist.textContent = song.artist || 'Unknown Artist';
      copy.append(title, artist);

      const ext = document.createElement('span');
      ext.className = 'search-row-ext';
      ext.textContent = song.generatedCode
        ? `LOCAL · ${String(song.ext || '').replace('.', '').toUpperCase()}`
        : String(song.ext || '').replace('.', '').toUpperCase();

      const acceptSong = () => {
        codeBuffer = String(song.code || '');
        renderCode();
        closeSearch();
        showToast(`${song.generatedCode ? 'LOCAL ' : ''}${song.code} · ${song.title}`);
      };

      row.append(code, copy, ext);
      row.addEventListener('click', acceptSong);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          acceptSong();
        }
      });
      searchResults.appendChild(row);
    }
  }

  async function performSearch(query) {
    const trimmed = query.trim();
    if (!trimmed) {
      renderSearchMessage(libraryCount ? 'Start typing to search your local library.' : 'No library indexed yet.');
      return;
    }
    const rows = await window.openkrk?.searchSongs?.(trimmed, 80) || [];
    if (searchInput.value.trim() !== trimmed) return;
    renderSearchResults(rows, trimmed);
  }

  async function reserveCode(immediate = false) {
    if (!codeBuffer) return;
    const selected = codeBuffer;
    const song = await window.openkrk?.findSongByCode?.(selected);
    clearCode();

    if (!song) {
      showToast(libraryCount ? `Song ${selected} was not found` : 'Choose your media folder with F2 first');
      return;
    }

    if (!immediate) {
      showToast(`RESERVED · ${song.generatedCode ? 'LOCAL ' : ''}${song.code} · ${song.title}`);
      return;
    }

    document.getElementById('nowCode').textContent = song.code || '—';
    document.getElementById('nowTitle').textContent = song.title || 'Untitled';
    document.getElementById('nowArtist').textContent = song.artist || 'Unknown Artist';
    document.getElementById('lyricCurrent').textContent = 'MIDI playback engine is the next production layer';
    setMode('player');
    showToast(song.generatedCode ? 'Local-number song resolved from your library' : 'Song resolved from your library');
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const value = searchInput.value;
    searchTimer = setTimeout(() => performSearch(value), 90);
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'search') openSearch();
    if (action === 'library') await chooseLibraryFolder();
    if (action === 'bgv') await chooseBgvFolder();
    if (action === 'fullscreen') await window.openkrk?.toggleFullscreen?.();
    if (action === 'queue') showToast('Queue engine is not connected yet');
    if (action === 'close-search') closeSearch();
  });

  document.addEventListener('keydown', async event => {
    if (mode === 'search') {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
      }
      return;
    }

    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      pushDigit(event.key);
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      codeBuffer = codeBuffer.slice(0, -1);
      renderCode();
      return;
    }

    if (event.key === 'Escape') {
      if (mode === 'player') setMode('idle');
      else clearCode();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      await reserveCode(event.ctrlKey || event.metaKey);
      return;
    }

    if (event.key === 'F1') {
      event.preventDefault();
      openSearch();
      return;
    }

    if (event.key === 'F2') {
      event.preventDefault();
      await chooseLibraryFolder();
      return;
    }

    if (event.key === 'F3') {
      event.preventDefault();
      await chooseBgvFolder();
      return;
    }

    if (event.key === 'F11') {
      event.preventDefault();
      await window.openkrk?.toggleFullscreen?.();
    }
  });

  bgv.addEventListener('ended', () => {
    if (bgvFiles.length) playBgv(bgvIndex + 1);
  });
  bgv.addEventListener('error', () => {
    if (bgvFiles.length > 1) playBgv(bgvIndex + 1);
  });

  window.openkrk?.onLibraryProgress?.(progress => {
    updateLibraryUi({
      count: progress.songs || 0,
      visualCount: progress.visuals || 0,
      scanning: progress.scanning,
      scanned: progress.scanned,
      root: progress.root
    });
    if (progress.done) {
      refreshLibraryStatus();
      refreshVisuals(true);
    }
    if (progress.error) showToast(`Library scan failed · ${progress.error}`, 5000);
  });

  renderCode();
  Promise.all([refreshLibraryStatus(), refreshVisuals(true)]).catch(() => {});
})();
