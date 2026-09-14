const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openkrk', {
  chooseBgvFolder: () => ipcRenderer.invoke('bgv:choose-folder'),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen')
});
