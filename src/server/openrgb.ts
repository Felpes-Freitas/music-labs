// OpenRGB "de fábrica": o Music Labs baixa a versão oficial do OpenRGB (programa livre,
// GPL-2.0, https://openrgb.org) para a pasta de dados dele, conferindo o SHA-256, e o
// roda como servidor SDK invisível enquanto o app está aberto (rgb.ts conversa com ele).
// Se já houver um OpenRGB do usuário rodando, usa esse e não inicia outro. No Linux, se o
// sistema não der acesso aos dispositivos USB, instala as regras udev oficiais pedindo a
// senha pela janela de autenticação do sistema (pkexec).
//
// O OpenRGB roda como programa separado (só conversa por rede local), então não há mistura
// de licenças com o Music Labs.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './store.js';

const VERSION = '1.1';
// MUSICLABS_OPENRGB_URL: só para testes (servidor local); o SHA-256 continua exigido
const BASE = process.env.MUSICLABS_OPENRGB_URL ?? 'https://codeberg.org/OpenRGB/OpenRGB/releases/download/release_1.1';
/**
 * Arquivos oficiais da versão 1.1 com o SHA-256 conferido. (A 0.9 não conhecia o protocolo
 * novo de teclados como o SteelSeries Apex Pro TKL com firmware ≥ 1.19.7 — aceitava as cores
 * e o teclado não mudava — nem o modo "Onboard" que devolve a iluminação do próprio teclado.)
 */
const FILES = {
  'linux-x64': { url: `${BASE}/OpenRGB_1.1_x86_64_8e16de2.AppImage`, sha256: 'd556c2273b0ef863dbee7ffdb438304b382add5d685c93c60758b42de3b0268d', size: 37528768, kind: 'appimage' },
  'win32-x64': { url: `${BASE}/OpenRGB_1.1_Windows_64_8e16de2.zip`, sha256: '63291726c6fc84eb479ef2ee752e97e1187f6ce9c49fd27eee40ded588a8172a', size: 22019605, kind: 'zip' },
} as const;
/** Regras udev oficiais (a 1.1 não publica o arquivo; as da 1.0rc3.1 são as mais novas). */
const RULES = {
  url: process.env.MUSICLABS_OPENRGB_URL ? `${BASE}/60-openrgb.rules` : 'https://codeberg.org/OpenRGB/OpenRGB/releases/download/release_candidate_1.0rc3.1/60-openrgb.rules',
  sha256: '0ebb492fd5f510fef964ab5a09a254586db864daedf3e9e012104c3c80644546',
};

const DIR = join(STATE_DIR, 'openrgb');
const VERSION_FILE = join(DIR, 'version');

/** Versão instalada pelo app (vazio se não há, ou se é de antes de o app gravar a versão). */
const installedVersion = () => {
  try {
    return readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return '';
  }
};
/** Há um OpenRGB do app, mas de uma versão antiga (atualiza sozinho). */
export const openRgbOutdated = () => !!openRgbExe() && installedVersion() !== VERSION;
const platformKey = `${process.platform}-${process.arch}` as keyof typeof FILES;

export const openRgbSupported = () => platformKey in FILES;

/** Programa do OpenRGB instalado pelo Music Labs (ou null). */
export function openRgbExe(): string | null {
  if (process.platform === 'linux') {
    const p = join(DIR, 'squashfs-root', 'AppRun');
    return existsSync(p) ? p : null;
  }
  if (process.platform === 'win32') {
    const find = (d: string, depth: number): string | null => {
      if (!existsSync(d) || depth > 3) return null;
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (f.toLowerCase() === 'openrgb.exe') return p;
        if (statSync(p).isDirectory()) {
          const r = find(p, depth + 1);
          if (r) return r;
        }
      }
      return null;
    };
    return find(DIR, 0);
  }
  return null;
}

let install: { state: 'none' | 'downloading' | 'installing' | 'installed' | 'error'; progress: number; error?: string } = { state: openRgbExe() ? 'installed' : 'none', progress: 0 };
let child: ChildProcess | null = null;

export const openRgbState = () => ({
  platform: process.platform,
  supported: openRgbSupported(),
  version: VERSION,
  installed: !!openRgbExe(),
  installedVersion: installedVersion() || (openRgbExe() ? 'antiga' : ''),
  install,
  managed: !!child,
  needsAccess: needsDeviceAccess(),
  hint: rgbHardwareHint(),
});

async function download(url: string, onProgress?: (f: number) => void, expected = 0): Promise<Buffer> {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download falhou (HTTP ${r.status})`);
  const total = Number(r.headers.get('content-length')) || expected;
  const parts: Uint8Array[] = [];
  let got = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    parts.push(chunk);
    got += chunk.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  return Buffer.concat(parts);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<void>((ok, fail) => execFile(cmd, args, { cwd, timeout: 120000 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim())) : ok())));

/** Baixa e instala o OpenRGB (só da lista oficial, com o SHA-256 conferido). */
export async function installOpenRgb(): Promise<void> {
  if (install.state === 'downloading' || install.state === 'installing') return;
  stopOpenRgb(); // atualizando: o antigo não pode estar rodando enquanto os arquivos mudam
  const f = FILES[platformKey];
  if (!f) throw new Error('Sem OpenRGB automático para este sistema: instale pelo site openrgb.org');
  try {
    install = { state: 'downloading', progress: 0 };
    const data = await download(f.url, (p) => (install = { state: 'downloading', progress: p }), f.size);
    if (sha256(data) !== f.sha256) throw new Error('o arquivo baixado não confere com o oficial (SHA-256 diferente); nada foi instalado');
    install = { state: 'installing', progress: 1 };
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    if (f.kind === 'appimage') {
      const file = join(DIR, 'OpenRGB.AppImage');
      writeFileSync(file, data);
      chmodSync(file, 0o755);
      // extrai uma vez (assim não depende de FUSE no sistema) e apaga o AppImage
      await run(file, ['--appimage-extract'], DIR);
      rmSync(file, { force: true });
    } else {
      const zip = join(DIR, 'OpenRGB.zip');
      writeFileSync(zip, data);
      await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${DIR}'`]);
      rmSync(zip, { force: true });
    }
    if (!openRgbExe()) throw new Error('instalação incompleta (programa não encontrado depois de extrair)');
    writeFileSync(VERSION_FILE, VERSION);
    install = { state: 'installed', progress: 1 };
  } catch (e) {
    install = { state: 'error', progress: 0, error: (e as Error).message };
    throw e;
  }
}

/** Inicia o OpenRGB instalado pelo app como servidor SDK (sem janela). */
export function startOpenRgb(port: number): boolean {
  if (child) return true;
  const exe = openRgbExe();
  if (!exe) return false;
  child = spawn(exe, ['--server', '--server-port', String(port)], { stdio: 'ignore', windowsHide: true });
  child.on('exit', () => (child = null));
  child.on('error', () => (child = null));
  return true;
}

/** Encerra o OpenRGB que o app iniciou (o do usuário, se houver, fica). */
export function stopOpenRgb() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  c.kill('SIGTERM');
  setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 1500).unref();
}
process.once('exit', () => child?.kill('SIGKILL'));

// ---------------------------------------------------------------- acesso aos dispositivos (Linux)

/** No Linux: há dispositivos HID que o usuário não consegue abrir (falta a regra udev)? */
export function needsDeviceAccess(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const list = readdirSync('/dev').filter((f) => f.startsWith('hidraw'));
    if (!list.length) return false;
    return list.some((f) => {
      try {
        accessSync(join('/dev', f), constants.R_OK | constants.W_OK);
        return false;
      } catch {
        return true;
      }
    });
  } catch {
    return false;
  }
}

/** Instala as regras udev oficiais do OpenRGB (pede a senha pela janela do sistema). */
export async function installDeviceAccess(): Promise<void> {
  if (process.platform !== 'linux') return;
  const data = await download(RULES.url);
  if (sha256(data) !== RULES.sha256) throw new Error('as regras baixadas não conferem com as oficiais (SHA-256 diferente)');
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, '60-openrgb.rules');
  writeFileSync(file, data);
  await run('pkexec', ['sh', '-c', `install -m 644 '${file}' /etc/udev/rules.d/60-openrgb.rules && udevadm control --reload-rules && udevadm trigger`]);
}

// ---------------------------------------------------------------- tem algo RGB plugado?

/** Fabricantes comuns de periféricos RGB (vendor id USB → nome). */
const RGB_VENDORS: Record<string, string> = {
  '1038': 'SteelSeries',
  '1b1c': 'Corsair',
  '1532': 'Razer',
  '0b05': 'ASUS',
  '0951': 'HyperX',
  '03f0': 'HyperX',
  '1462': 'MSI',
  '31e3': 'Wooting',
  '1e7d': 'ROCCAT',
  '2516': 'Cooler Master',
  '320f': 'Glorious',
  '258a': 'Redragon',
  '04d9': 'Ducky/Holtek',
  '0c45': 'Redragon/Sonix',
  '3434': 'Keychron',
  '3233': 'Ducky',
  '2f68': 'Hator',
  '1a2c': 'Redragon',
  '28da': 'EVision',
  '046d': 'Logitech',
};

/** Periféricos de marcas RGB conhecidas plugados (Linux; vazio se não der para saber). */
export function rgbHardwareHint(): string[] {
  if (process.platform !== 'linux') return [];
  const out = new Set<string>();
  try {
    for (const d of readdirSync('/sys/bus/usb/devices')) {
      try {
        const v = readFileSync(join('/sys/bus/usb/devices', d, 'idVendor'), 'utf8').trim();
        const name = RGB_VENDORS[v];
        if (!name) continue;
        let product = '';
        try {
          product = readFileSync(join('/sys/bus/usb/devices', d, 'product'), 'utf8').trim();
        } catch {
          /* sem nome */
        }
        // Logitech faz muita coisa sem RGB: só conta se o nome sugerir teclado/gaming
        if (v === '046d' && !/G\d|keyboard|teclado|pro/i.test(product)) continue;
        out.add(product ? (product.toLowerCase().startsWith(name.toLowerCase().split('/')[0].toLowerCase()) ? product : `${name} ${product}`) : name);
      } catch {
        /* dispositivo sem vendor */
      }
    }
  } catch {
    /* sem sysfs */
  }
  return [...out];
}
