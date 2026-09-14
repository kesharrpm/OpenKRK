const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openkrk', {
  chooseBgvFolder: () => ipcRenderer.invoke('bgv:choose-folder'),
  chooseLibraryFolder: () => ipcRenderer.invoke('library:choose-folder'),
  rescanLibrary: () => ipcRenderer.invoke('library:rescan'),
  getLibraryStatus: () => ipcRenderer.invoke('library:status'),
  findSongByCode: code => ipcRenderer.invoke('library:find-code', code),
  searchSongs: (query, limit) => ipcRenderer.invoke('library:search', query, limit),
  onLibraryProgress: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('library:scan-progress', handler);
    return () => ipcRenderer.removeListener('library:scan-progress', handler);
  },
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen')
});
