// Music Labs como app desktop: janela sem borda nativa (a barra de título é
// desenhada pela interface), servidor local iniciado com o Node do Electron.
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.MUSICLABS_PORT || 7717);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

app.setName('MusicLabs');
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
async function ensureServer() {
  if (await ping()) return;
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(ROOT, 'build/server.mjs')).href);
  try {
    await mod.startServer(PORT);
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
ipcMain.handle('win:isMax', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

app.whenReady().then(async () => {
  await ensureServer();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
