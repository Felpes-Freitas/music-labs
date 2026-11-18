// Ponte mínima entre a interface e a janela nativa (minimizar, maximizar, fechar).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mlabsWindow', {
  minimize: () => ipcRenderer.send('win', 'min'),
  toggleMaximize: () => ipcRenderer.send('win', 'max'),
  close: () => ipcRenderer.send('win', 'close'),
  isMaximized: () => ipcRenderer.invoke('win:isMax'),
  onState: (cb) => ipcRenderer.on('win:state', (_e, max) => cb(!!max)),
});
