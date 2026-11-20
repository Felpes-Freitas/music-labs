// Iluminação RGB pelo OpenRGB (https://openrgb.org): o OpenRGB controla teclados (e outros
// dispositivos) de muitas marcas e tem um servidor "SDK" na rede local (porta 6742). Este
// módulo fala esse protocolo (sem dependências): acha os teclados, guarda o modo e as cores
// que cada um tinha, assume o controle ("custom"/direto) e pinta as teclas conforme a
// interface pede — o "piano" do teclado do computador para instrumentos e as cores dos pads
// no Soundpad. Ao terminar (desligar a opção, a última janela fechar, o app sair), devolve
// cada teclado ao modo e às cores de antes.
//
// Protocolo: cabeçalho de 16 bytes ("ORGB", índice do dispositivo, id do pacote, tamanho)
// + dados, tudo little-endian. Usamos a versão 3 do protocolo (OpenRGB 0.8+); servidores
// mais novos respondem na versão pedida.

import { Socket, connect } from 'node:net';
import { installOpenRgb, needsDeviceAccess, openRgbExe, openRgbOutdated, openRgbState, startOpenRgb, stopOpenRgb } from './openrgb.js';

const PROTOCOL = 3;
const PKT = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  UPDATE_LEDS: 1050,
  SET_CUSTOM_MODE: 1100,
  UPDATE_MODE: 1101,
} as const;
const DEVICE_KEYBOARD = 5;

export interface RgbDevice {
  index: number;
  type: number;
  name: string;
  activeMode: number;
  /** Bytes da descrição de cada modo (para devolver o modo original exatamente como era). */
  modes: { name: string; raw: Buffer }[];
  leds: string[];
  colors: number[];
}

/** Cor 0xRRGGBB → formato do OpenRGB (bytes R, G, B, 0). */
const toOrgb = (rgb: number) => ((rgb >> 16) & 0xff) | (((rgb >> 8) & 0xff) << 8) | ((rgb & 0xff) << 16);

export class OpenRgbClient {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private waiting = new Map<number, ((d: Buffer) => void)[]>();
  protocol = 0;
  onClose: () => void = () => {};

  async connect(host: string, port: number, name: string, timeoutMs = 1500) {
    await new Promise<void>((ok, fail) => {
      const s = connect({ host, port });
      const t = setTimeout(() => (s.destroy(), fail(new Error('OpenRGB não respondeu'))), timeoutMs);
      s.once('connect', () => (clearTimeout(t), ok()));
      s.once('error', (e) => (clearTimeout(t), fail(e)));
      this.sock = s;
    });
    const s = this.sock!;
    s.setNoDelay(true);
    s.on('data', (d: Buffer) => this.onData(d));
    s.on('close', () => {
      this.sock = null;
      for (const list of this.waiting.values()) for (const f of list) f(Buffer.alloc(0));
      this.waiting.clear();
      this.onClose();
    });
    s.on('error', () => {});
    const v = await this.request(PKT.REQUEST_PROTOCOL_VERSION, 0, u32(PROTOCOL));
    this.protocol = Math.min(PROTOCOL, v.length >= 4 ? v.readUInt32LE(0) : 0);
    this.send(PKT.SET_CLIENT_NAME, 0, Buffer.from(name + '\0', 'utf8'));
  }

  get connected() {
    return !!this.sock && !this.sock.destroyed;
  }

  close() {
    this.sock?.end();
    this.sock?.destroy();
    this.sock = null;
  }

  private send(id: number, dev: number, data: Buffer = Buffer.alloc(0)) {
    if (!this.sock) throw new Error('OpenRGB desconectado');
    const h = Buffer.alloc(16);
    h.write('ORGB', 0, 'ascii');
    h.writeUInt32LE(dev, 4);
    h.writeUInt32LE(id, 8);
    h.writeUInt32LE(data.length, 12);
    this.sock.write(Buffer.concat([h, data]));
  }

  private request(id: number, dev: number, data?: Buffer, timeoutMs = 2000): Promise<Buffer> {
    return new Promise((ok, fail) => {
      const list = this.waiting.get(id) ?? [];
      const t = setTimeout(() => {
        const l = this.waiting.get(id);
        if (l) l.splice(l.indexOf(done), 1);
        fail(new Error(`OpenRGB não respondeu (pacote ${id})`));
      }, timeoutMs);
      const done = (d: Buffer) => (clearTimeout(t), ok(d));
      list.push(done);
      this.waiting.set(id, list);
      this.send(id, dev, data);
    });
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 16) {
      if (this.buf.toString('ascii', 0, 4) !== 'ORGB') {
        this.buf = Buffer.alloc(0); // fora de sincronia: descarta
        return;
      }
      const id = this.buf.readUInt32LE(8), size = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + size) return;
      const data = this.buf.subarray(16, 16 + size);
      this.buf = this.buf.subarray(16 + size);
      const f = this.waiting.get(id)?.shift();
      if (f) f(Buffer.from(data));
      // DEVICE_LIST_UPDATED e outros avisos: ignorados (a lista é relida ao reconectar)
    }
  }

  async devices(): Promise<RgbDevice[]> {
    const c = await this.request(PKT.REQUEST_CONTROLLER_COUNT, 0);
    const n = c.length >= 4 ? c.readUInt32LE(0) : 0;
    const out: RgbDevice[] = [];
    for (let i = 0; i < n; i++) {
      const d = await this.request(PKT.REQUEST_CONTROLLER_DATA, i, u32(this.protocol));
      out.push(parseDevice(d, i, this.protocol));
    }
    return out;
  }

  /** Modo "custom"/direto: o dispositivo passa a mostrar as cores que mandarmos. */
  setCustomMode(dev: number) {
    this.send(PKT.SET_CUSTOM_MODE, dev);
  }

  /** Cores de todos os LEDs (0xRRGGBB). */
  updateLeds(dev: number, colors: number[]) {
    const b = Buffer.alloc(4 + 2 + colors.length * 4);
    b.writeUInt32LE(b.length, 0);
    b.writeUInt16LE(colors.length, 4);
    colors.forEach((c, i) => b.writeUInt32LE(toOrgb(c), 6 + i * 4));
    this.send(PKT.UPDATE_LEDS, dev, b);
  }

  /** Volta um modo exatamente como ele foi descrito pelo dispositivo. */
  updateMode(dev: number, modeIndex: number, raw: Buffer) {
    const b = Buffer.alloc(8 + raw.length);
    b.writeUInt32LE(b.length, 0);
    b.writeInt32LE(modeIndex, 4);
    raw.copy(b, 8);
    this.send(PKT.UPDATE_MODE, dev, b);
  }

  /** Espera os pacotes já escritos saírem (antes de fechar o app). */
  flush(): Promise<void> {
    const s = this.sock;
    if (!s) return Promise.resolve();
    return new Promise((ok) => (s.writableLength === 0 ? ok() : s.once('drain', () => ok())));
  }
}

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
};

/** Lê a descrição de um dispositivo (formato do protocolo 1..3). */
export function parseDevice(d: Buffer, index: number, protocol: number): RgbDevice {
  let o = 4; // data_size
  const i32 = () => ((o += 4), d.readInt32LE(o - 4));
  const r32 = () => ((o += 4), d.readUInt32LE(o - 4));
  const r16 = () => ((o += 2), d.readUInt16LE(o - 2));
  const str = () => {
    const n = r16();
    const s = d.toString('utf8', o, o + Math.max(0, n - 1));
    o += n;
    return s;
  };
  const type = i32();
  const name = str();
  if (protocol >= 1) str(); // fabricante
  str(); // descrição
  str(); // versão
  str(); // serial
  str(); // local
  const nModes = r16();
  const activeMode = i32();
  const modes: RgbDevice['modes'] = [];
  for (let m = 0; m < nModes; m++) {
    const start = o;
    const mname = str();
    o += 4 + 4 + 4 + 4; // value, flags, speed_min, speed_max
    if (protocol >= 3) o += 8; // brightness_min/max
    o += 4 + 4 + 4; // colors_min, colors_max, speed
    if (protocol >= 3) o += 4; // brightness
    o += 4 + 4; // direction, color_mode
    const nc = r16();
    o += nc * 4;
    modes.push({ name: mname, raw: Buffer.from(d.subarray(start, o)) });
  }
  const nZones = r16();
  for (let z = 0; z < nZones; z++) {
    str();
    o += 4 + 4 + 4 + 4; // type, leds_min, leds_max, leds_count
    const matrix = r16();
    o += matrix; // matriz (altura, largura, mapa)
    if (protocol >= 4) {
      const ns = r16();
      for (let s = 0; s < ns; s++) {
        str();
        o += 12;
      }
    }
  }
  const nLeds = r16();
  const leds: string[] = [];
  for (let l = 0; l < nLeds; l++) {
    leds.push(str());
    o += 4; // value
  }
  const nColors = r16();
  const colors: number[] = [];
  for (let c = 0; c < nColors; c++) {
    const v = r32();
    colors.push(((v & 0xff) << 16) | (((v >> 8) & 0xff) << 8) | ((v >> 16) & 0xff));
  }
  return { index, type, name, activeMode, modes, leds, colors };
}

// ---------------------------------------------------------------- iluminação do app

/** O que a interface quer no teclado: cor por tecla (caractere minúsculo), fundo e teclas apertadas. */
export interface RgbScene {
  keys: Record<string, number>;
  base: number;
  pressed: string[];
}

export interface RgbConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** 0..1 */
  brightness: number;
}

/** Nome do LED do OpenRGB para uma tecla ("q" → "key: q", "," → "key: ,"). */
export const ledKey = (name: string) => name.toLowerCase().replace(/^key:\s*/, '');

let cfg: RgbConfig = { enabled: true, host: '127.0.0.1', port: 6742, brightness: 1 };
let client: OpenRgbClient | null = null;
let keyboards: (RgbDevice & { byKey: Map<string, number[]> })[] = [];
let scene: RgbScene = { keys: {}, base: 0, pressed: [] };
let status: { state: 'off' | 'connecting' | 'on' | 'missing' | 'error'; devices: string[]; error?: string } = { state: 'off', devices: [] };
let connecting: Promise<void> | null = null;
let retryAt = 0;
let pushTimer: NodeJS.Timeout | null = null;
let active = false; // assumimos os teclados (e devemos devolver)

export const rgbStatus = () => ({ ...status, enabled: cfg.enabled, host: cfg.host, port: cfg.port, openrgb: openRgbState() });

let retryTimer: NodeJS.Timeout | null = null;
/** Tenta de novo sozinho em `ms` (o OpenRGB pode estar subindo ou detectando os dispositivos). */
function retryIn(ms: number) {
  retryAt = Date.now() + ms;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (cfg.enabled) schedule();
  }, ms + 20);
  retryTimer.unref?.();
}
let launchedAt = 0; // quando o app iniciou o OpenRGB dele (tentativas rápidas enquanto ele detecta)
const justLaunched = () => Date.now() - launchedAt < 30000;

/** Liga/ajusta (chamado pela interface). Desligar devolve os teclados ao que eram. */
export async function rgbConfigure(c: Partial<RgbConfig>) {
  const prev = cfg;
  cfg = { ...cfg, ...c };
  if (!cfg.enabled) return rgbShutdown();
  if (prev.host !== cfg.host || prev.port !== cfg.port) {
    await rgbRelease();
    retryAt = 0;
  }
  schedule();
}

/** Nova cena vinda da interface (instrumento selecionado, teclas apertadas). */
export function rgbScene(s: Partial<RgbScene>) {
  scene = { ...scene, ...s };
  if (cfg.enabled) schedule();
}

function schedule() {
  if (pushTimer) return;
  // junta mudanças seguidas (teclas rápidas) em um envio a cada ~16 ms
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void push();
  }, 16);
}

async function ensure() {
  if (client?.connected && active) return true;
  if (Date.now() < retryAt) return false;
  connecting ??= (async () => {
    status = { state: 'connecting', devices: [] };
    const c = new OpenRgbClient();
    try {
      await c.connect(cfg.host, cfg.port, 'Music Labs');
      const devs = await c.devices();
      keyboards = devs
        .filter((d) => d.type === DEVICE_KEYBOARD && d.leds.length)
        .map((d) => {
          const byKey = new Map<string, number[]>();
          d.leds.forEach((n, i) => {
            const k = ledKey(n);
            byKey.set(k, [...(byKey.get(k) ?? []), i]);
          });
          return { ...d, byKey };
        });
      if (!keyboards.length) {
        c.close();
        const access = needsDeviceAccess();
        status = {
          state: 'missing',
          devices: devs.map((d) => d.name),
          error: access ? 'o sistema não dá acesso aos dispositivos USB: use "Dar acesso aos dispositivos"' : devs.length ? 'o OpenRGB não encontrou nenhum teclado' : 'o OpenRGB não encontrou dispositivos',
        };
        // recém-iniciado, o OpenRGB ainda pode estar detectando: tenta de novo logo
        retryIn(justLaunched() ? 2500 : 15000);
        return;
      }
      c.onClose = () => {
        // o OpenRGB fechou: tenta de novo depois (as cores originais ficaram com ele)
        active = false;
        client = null;
        status = { state: 'error', devices: [], error: 'o OpenRGB fechou a conexão' };
        retryIn(5000);
      };
      for (const k of keyboards) {
        c.setCustomMode(k.index);
        // SetCustomMode só marca o modo no OpenRGB; quem manda o teclado entrar no controle
        // direto é o UpdateMode (é o que a janela do OpenRGB faz) — sem isso alguns teclados
        // (ex.: SteelSeries Apex) aceitam as cores no OpenRGB mas não mudam de verdade
        const direct = directMode(k);
        if (direct >= 0) c.updateMode(k.index, direct, k.modes[direct].raw);
      }
      client = c;
      active = true;
      status = { state: 'on', devices: keyboards.map((k) => k.name) };
    } catch (e) {
      c.close();
      const refused = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
      // ninguém servindo: se o app tem o OpenRGB dele, inicia (só no próprio computador)
      const local = cfg.host === '127.0.0.1' || cfg.host === 'localhost';
      if (refused && local && openRgbOutdated()) {
        // o OpenRGB do app é de uma versão antiga: atualiza (conferido) e tenta de novo
        status = { state: 'connecting', devices: [], error: 'atualizando o OpenRGB…' };
        installOpenRgb()
          .then(() => retryIn(300))
          .catch((err) => (status = { state: 'error', devices: [], error: `não deu para atualizar o OpenRGB: ${(err as Error).message}` }));
        retryAt = Date.now() + 3600_000; // até a atualização terminar
      } else if (refused && local && openRgbExe() && startOpenRgb(cfg.port)) {
        if (!justLaunched()) launchedAt = Date.now();
        status = { state: 'connecting', devices: [], error: 'iniciando o OpenRGB…' };
        retryIn(1500);
      } else {
        status = { state: 'missing', devices: [], error: refused ? 'o OpenRGB não está rodando (ou o servidor SDK está desligado)' : (e as Error).message };
        retryIn(10000);
      }
    }
  })().finally(() => (connecting = null));
  await connecting;
  return !!client?.connected && active;
}

/** Modo de controle direto do dispositivo (o que o OpenRGB usa para cores por LED). */
export function directMode(d: { modes: { name: string }[] }) {
  for (const re of [/^direct$/i, /^custom$/i, /direct/i, /^static$/i]) {
    const i = d.modes.findIndex((m) => re.test(m.name));
    if (i >= 0) return i;
  }
  return -1;
}

/** Modo em que o próprio dispositivo cuida da iluminação (perfil salvo nele), se houver. */
export function hardwareMode(d: { modes: { name: string }[] }) {
  return d.modes.findIndex((m) => /^(onboard|hardware|profile|default)$/i.test(m.name) || /onboard/i.test(m.name));
}

const scale = (c: number, k: number) => (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
/** Mistura com branco (tecla apertada). */
const lighten = (c: number, t: number) => {
  const m = (v: number) => Math.round(v + (255 - v) * t);
  return (m((c >> 16) & 255) << 16) | (m((c >> 8) & 255) << 8) | m(c & 255);
};

/** Cores de cada LED de um teclado para a cena atual. */
export function sceneColors(kb: { leds: string[]; byKey?: Map<string, number[]> }, s: RgbScene, brightness = 1) {
  const colors = kb.leds.map(() => scale(s.base, brightness));
  const byKey = kb.byKey ?? new Map(kb.leds.map((n, i) => [ledKey(n), [i]]));
  for (const [k, c] of Object.entries(s.keys)) for (const i of byKey.get(k) ?? []) colors[i] = scale(c, brightness);
  for (const k of s.pressed) for (const i of byKey.get(k) ?? []) colors[i] = lighten(s.keys[k] ?? 0xffffff, 0.75);
  return colors;
}

async function push() {
  if (!cfg.enabled) return;
  if (!(await ensure())) return;
  const c = client!;
  for (const kb of keyboards) c.updateLeds(kb.index, sceneColors(kb, scene, cfg.brightness));
}

/** Ao fechar o app: devolve os teclados e encerra o OpenRGB que o app iniciou. */
export async function rgbShutdown() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  await rgbRelease().catch(() => {});
  stopOpenRgb();
}

/** Devolve cada teclado ao modo e às cores de antes e solta a conexão. */
export async function rgbRelease() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  if (connecting) await connecting.catch(() => {});
  const c = client;
  client = null;
  if (c?.connected && active) {
    for (const kb of keyboards) {
      try {
        // Se o teclado estava no modo direto (o OpenRGB recém-aberto começa assim, com as cores
        // que ele tem na memória — muitas vezes apagadas) e tem um modo de hardware, volta para
        // ele: é a iluminação do próprio teclado. Senão, cores e modo exatamente como eram.
        const hw = hardwareMode(kb);
        if (hw >= 0 && kb.activeMode === directMode(kb)) c.updateMode(kb.index, hw, kb.modes[hw].raw);
        else {
          if (kb.colors.length) c.updateLeds(kb.index, kb.colors);
          const m = kb.modes[kb.activeMode];
          if (m) c.updateMode(kb.index, kb.activeMode, m.raw);
        }
      } catch {
        /* segue para o próximo */
      }
    }
    await Promise.race([c.flush(), new Promise((r) => setTimeout(r, 300))]);
  }
  active = false;
  if (c) c.onClose = () => {}; // fechamento nosso, não é erro
  c?.close();
  status = { state: 'off', devices: [] };
}
