(() => {
  'use strict';

  const stage = document.getElementById('stage');
  const bgv = document.getElementById('bgv');
  const codeDisplay = document.getElementById('codeDisplay');
  const roomState = document.getElementById('roomState');
  const searchInput = document.getElementById('searchInput');
  const toast = document.getElementById('toast');
  const pickTrack = document.getElementById('pickTrack');

  let mode = 'idle';
  let codeBuffer = '';
  let bgvFiles = [];
  let bgvIndex = -1;
  let pickIndex = 0;
  let toastTimer = null;

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
    if (!codeBuffer) {
      codeDisplay.textContent = '— — — — —';
      return;
    }
    codeDisplay.textContent = codeBuffer.split('').join(' ');
  }

  function pushDigit(digit) {
    if (mode === 'search') return;
    if (codeBuffer.length >= 6) codeBuffer = '';
    codeBuffer += digit;
    renderCode();
  }

  function clearCode() {
    codeBuffer = '';
    renderCode();
  }

  function reserveCode(immediate = false) {
    if (!codeBuffer) return;
    const selected = codeBuffer;
    clearCode();
    if (immediate) {
      showToast(`PLAY REQUEST · ${selected}`);
      document.getElementById('nowCode').textContent = selected;
      document.getElementById('nowTitle').textContent = 'Waiting for library engine';
      document.getElementById('nowArtist').textContent = 'OpenKRK production shell';
      setMode('player');
      return;
    }
    showToast(`RESERVED · ${selected}`);
  }

  function localFileUrl(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`);
  }

  function playBgv(index) {
    if (!bgvFiles.length) return;
    bgvIndex = ((index % bgvFiles.length) + bgvFiles.length) % bgvFiles.length;
    bgv.src = localFileUrl(bgvFiles[bgvIndex]);
    bgv.load();
    bgv.play().catch(() => {
      roomState.textContent = 'BGV READY';
    });
  }

  async function chooseBgvFolder() {
    if (!window.openkrk?.chooseBgvFolder) {
      showToast('BGV picker is available in the Electron app only.');
      return;
    }
    const result = await window.openkrk.chooseBgvFolder();
    if (!result || result.canceled) return;
    bgvFiles = Array.isArray(result.files) ? result.files : [];
    if (!bgvFiles.length) {
      roomState.textContent = 'NO BGV FOUND';
      showToast('No supported videos found in that folder.');
      return;
    }
    roomState.textContent = `${bgvFiles.length} BGV${bgvFiles.length === 1 ? '' : 'S'} READY`;
    showToast(`${bgvFiles.length} BGVs loaded`);
    playBgv(Math.floor(Math.random() * bgvFiles.length));
  }

  function cyclePick() {
    const items = [...pickTrack.querySelectorAll('span')];
    if (!items.length) return;
    items.forEach(item => item.classList.remove('pick-active'));
    pickIndex = (pickIndex + 1) % items.length;
    items[pickIndex].classList.add('pick-active');
  }

  function openSearch() {
    setMode('search');
  }

  function closeSearch() {
    searchInput.value = '';
    setMode('idle');
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'search') openSearch();
    if (action === 'bgv') await chooseBgvFolder();
    if (action === 'fullscreen') await window.openkrk?.toggleFullscreen?.();
    if (action === 'queue') showToast('QUEUE · engine lands in the next production milestone');
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
      reserveCode(event.ctrlKey || event.metaKey);
      return;
    }

    if (event.key === 'F1') {
      event.preventDefault();
      openSearch();
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

  setInterval(cyclePick, 4200);
  renderCode();
})();
