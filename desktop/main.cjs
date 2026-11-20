// Music Labs como app desktop: janela sem borda nativa (a barra de título é
// desenhada pela interface), servidor local iniciado com o Node do Electron.
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.MUSICLABS_PORT || 7717);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

app.setName('MusicLabs');

// Abrir arquivos pelo sistema (duplo clique num .mlstudio ou .flp): a interface pergunta
// antes de descartar alterações. Uma instância só: abrir outro arquivo vai para a janela aberta.
const PROJECT_FILE = /\.(mlstudio|flp)$/i;
const fileArg = (argv) => {
  const f = argv.slice(1).find((a) => PROJECT_FILE.test(a) && require('node:fs').existsSync(a));
  return f ? path.resolve(f) : null;
};
let pendingFile = fileArg(process.argv);
if (!process.env.MUSICLABS_SHOT && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_e, argv) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const f = fileArg(argv);
  if (f) win.webContents.send('app:openFile', f);
});
ipcMain.handle('app:pendingFile', () => {
  const f = pendingFile;
  pendingFile = null;
  return f;
});
// Latência: pede ao PulseAudio/PipeWire blocos pequenos (o padrão do sistema costuma
// ser 1024 amostras ≈ 21 ms, o que atrasa o retorno e a gravação). Vale só para o app.
if (!process.env.PULSE_LATENCY_MSEC) process.env.PULSE_LATENCY_MSEC = '8';
// som sem precisar de clique (é um app de áudio)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function ping() {
  return new Promise((resolve) => {
    http
      .get(`${URL}/api/status`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      })
      .on('error', () => resolve(false));
  });
}

/** Sobe o servidor dentro do próprio app (a menos que já haja um rodando, ex.: iniciado pelo MCP). */
let serverMod = null; // o servidor que roda dentro deste app (null se outro processo já servia)
let quitting = false; // já gravou o projeto e soltou o teclado RGB: pode sair
async function ensureServer() {
  if (await ping()) return;
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(ROOT, 'build/server.mjs')).href);
  try {
    await mod.startServer(PORT);
    serverMod = mod;
  } catch (e) {
    // outro processo pegou a porta no meio do caminho: usa o dele
    if (!(await ping())) throw e;
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1600, width),
    height: Math.min(1000, height),
    minWidth: 1024,
    minHeight: 600,
    frame: false,
    backgroundColor: '#121618',
    title: 'Music Labs',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (process.env.MUSICLABS_SHOT) return; // verificação: não aparece na tela
    win.maximize();
    win.show();
  });
  win.on('maximize', () => win.webContents.send('win:state', true));
  win.on('unmaximize', () => win.webContents.send('win:state', false));
  // a janela só mostra o app local; links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // microfone (gravação) e MIDI só para o próprio app
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'midi', 'midiSysex'].includes(permission) && wc.getURL().startsWith(URL));
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) e.preventDefault();
  });
  win.loadURL(URL);
  // Verificação automática: MUSICLABS_SHOT=/caminho.png carrega escondido, tira um print e sai.
  if (process.env.MUSICLABS_SHOT) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('node:fs').writeFileSync(process.env.MUSICLABS_SHOT, img.toPNG());
        const info = await win.webContents.executeJavaScript(`(async () => {
          const hit = (await (await fetch('/api/search?q=kick&limit=1')).json())[0];
          const smp = hit ? await fetch('/api/sample?path=' + encodeURIComponent(hit.path)) : null;
          return JSON.stringify({ controles: !!document.querySelector('.wctl'), carregado: document.querySelector('.loading') === null, largura: innerWidth, sample: hit ? hit.name + ' -> HTTP ' + smp.status + ', ' + (await smp.arrayBuffer()).byteLength + ' bytes' : 'nenhum na biblioteca' });
        })()`);
        console.log('verificação:', info);
        app.quit();
      }, 4000),
    );
  }
}

ipcMain.on('win', (e, cmd) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (cmd === 'min') w.minimize();
  else if (cmd === 'max') (w.isMaximized() ? w.unmaximize() : w.maximize());
  else if (cmd === 'close') w.close();
});
// O código do servidor foi atualizado (build novo): reinicia o app para ele subir com a
// versão nova. Só se o servidor for deste app — se outro processo serve (ex.: o MCP),
// reiniciar o app não adiantaria.
ipcMain.handle('app:relaunch', () => {
  if (!serverMod) return false;
  // grava o projeto e solta o teclado RGB antes de reiniciar
  quitting = true;
  Promise.resolve(serverMod.shutdown ? serverMod.shutdown() : serverMod.flushState?.())
    .catch(() => {})
    .finally(() => {
      // sem o arquivo da linha de comando: ao reiniciar, segue o projeto atual (autosave)
      app.relaunch({ args: process.argv.slice(1).filter((a) => !PROJECT_FILE.test(a)) });
      app.exit(0);
    });
  return true;
});
ipcMain.handle('win:isMax', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

app.whenReady().then(async () => {
  await ensureServer();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// Antes de sair: grava o projeto e devolve o teclado RGB (OpenRGB) ao que era.
app.on('before-quit', (e) => {
  if (quitting || !serverMod?.shutdown) return;
  e.preventDefault();
  quitting = true;
  Promise.resolve(serverMod.shutdown())
    .catch(() => {})
    .finally(() => app.quit());
});
