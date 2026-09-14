const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openkrk', {
  chooseBgvFolder: () => ipcRenderer.invoke('bgv:choose-folder'),
  getVisualCatalog: () => ipcRenderer.invoke('media:visual-catalog'),
  chooseLibraryFolder: () => ipcRenderer.invoke('library:choose-folder'),
  rescanLibrary: () => ipcRenderer.invoke('library:rescan'),
  getLibraryStatus: () => ipcRenderer.invoke('library:status'),
  findSongByCode: code => ipcRenderer.invoke('library:find-code', code),
  searchSongs: (query, limit) => ipcRenderer.invoke('library:search', query, limit),
  chooseSoundBank: () => ipcRenderer.invoke('soundbank:choose'),
  getSoundBankStatus: () => ipcRenderer.invoke('soundbank:status'),
  chooseFontFile: () => ipcRenderer.invoke('font:choose'),
  readBinaryFile: filePath => ipcRenderer.invoke('file:read-binary', filePath),
  onLibraryProgress: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('library:scan-progress', handler);
    return () => ipcRenderer.removeListener('library:scan-progress', handler);
  },
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen')
});
