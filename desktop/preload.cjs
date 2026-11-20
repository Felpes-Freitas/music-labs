// Ponte mínima entre a interface e a janela nativa (minimizar, maximizar, fechar).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mlabsWindow', {
  minimize: () => ipcRenderer.send('win', 'min'),
  toggleMaximize: () => ipcRenderer.send('win', 'max'),
  close: () => ipcRenderer.send('win', 'close'),
  isMaximized: () => ipcRenderer.invoke('win:isMax'),
  /** Reinicia o app (servidor atualizado). Devolve false se o servidor não é deste app. */
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onState: (cb) => ipcRenderer.on('win:state', (_e, max) => cb(!!max)),
  /** Arquivo de projeto passado ao abrir o app (duplo clique no gerenciador de arquivos). */
  pendingFile: () => ipcRenderer.invoke('app:pendingFile'),
  onOpenFile: (cb) => ipcRenderer.on('app:openFile', (_e, path) => cb(path)),
  /** Explorador de arquivos do sistema: devolve o caminho escolhido (ou null). */
  openDialog: (o) => ipcRenderer.invoke('dialog:open', o),
  saveDialog: (o) => ipcRenderer.invoke('dialog:save', o),
});
