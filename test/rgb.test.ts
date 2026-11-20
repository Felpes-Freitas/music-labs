// Teclado RGB: um servidor OpenRGB falso (formato do protocolo v3 da documentação do SDK)
// confere o que o Music Labs manda — modo direto, cores das teclas e, ao soltar, as cores e
// o modo originais exatamente como eram.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { parseDevice, rgbConfigure, rgbRelease, rgbScene, rgbStatus, sceneColors } from '../src/server/rgb.ts';

const str = (s: string) => {
  const b = Buffer.from(s + '\0', 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16LE(b.length);
  return Buffer.concat([l, b]);
};
const u16 = (v: number) => (((b) => (b.writeUInt16LE(v), b))(Buffer.alloc(2)));
const u32 = (v: number) => (((b) => (b.writeUInt32LE(v), b))(Buffer.alloc(4)));
const i32 = (v: number) => (((b) => (b.writeInt32LE(v), b))(Buffer.alloc(4)));
const color = (rgb: number) => u32(((rgb >> 16) & 255) | (((rgb >> 8) & 255) << 8) | ((rgb & 255) << 16));

function mode(name: string, value: number, colors: number[]) {
  return Buffer.concat([str(name), i32(value), u32(0), u32(0), u32(4), u32(0), u32(100), u32(0), u32(1), u32(2), u32(100), u32(0), u32(1), u16(colors.length), ...colors.map(color)]);
}
const LEDS = ['Key: Escape', 'Key: 1', 'Key: 2', 'Key: Q', 'Key: W', 'Key: A', 'Key: Z', 'Key: X', 'Key: S', 'Key: ,'];
const ORIGINAL = LEDS.map((_, i) => 0x102030 + i);
const MODES = [mode('Direct', 0, []), mode('Spectrum', 7, [0xff0000, 0x00ff00])];

function deviceData(type: number, name: string) {
  const body = Buffer.concat([
    i32(type),
    str(name),
    str('SteelSeries'),
    str('teclado de teste'),
    str('1.0'),
    str('ABC'),
    str('HID: /dev/hidraw9'),
    u16(MODES.length),
    i32(1), // modo ativo: Spectrum
    ...MODES,
    u16(1),
    Buffer.concat([str('Keyboard'), i32(2), u32(LEDS.length), u32(LEDS.length), u32(LEDS.length), u16(8 + 4 * 2), u32(1), u32(2), u32(0), u32(1)]),
    u16(LEDS.length),
    ...LEDS.map((n, i) => Buffer.concat([str(n), u32(i)])),
    u16(ORIGINAL.length),
    ...ORIGINAL.map(color),
  ]);
  return Buffer.concat([u32(body.length + 4), body]);
}

/** Servidor SDK falso: responde versão, contagem e dados; guarda os pacotes recebidos. */
function fakeServer(devices: Buffer[]) {
  const got: { id: number; dev: number; data: Buffer }[] = [];
  const socks = new Set<Socket>();
  const srv = createServer((s) => {
    socks.add(s);
    let buf = Buffer.alloc(0);
    const reply = (id: number, dev: number, data: Buffer) => s.write(Buffer.concat([Buffer.from('ORGB'), u32(dev), u32(id), u32(data.length), data]));
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const dev = buf.readUInt32LE(4), id = buf.readUInt32LE(8), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const data = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        got.push({ id, dev, data: Buffer.from(data) });
        if (id === 40) reply(40, 0, u32(4));
        else if (id === 0) reply(0, 0, u32(devices.length));
        else if (id === 1) reply(1, dev, devices[dev]);
      }
    });
    s.on('close', () => socks.delete(s));
  });
  return new Promise<{ port: number; got: typeof got; close: () => void }>((ok) =>
    srv.listen(0, '127.0.0.1', () => ok({ port: (srv.address() as { port: number }).port, got, close: () => (socks.forEach((x) => x.destroy()), srv.close()) })),
  );
}

const ledColors = (data: Buffer) => {
  const n = data.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => {
    const v = data.readUInt32LE(6 + i * 4);
    return ((v & 255) << 16) | (((v >> 8) & 255) << 8) | ((v >> 16) & 255);
  });
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await wait(20);
}

test('lê a descrição do dispositivo (protocolo v3)', () => {
  const d = parseDevice(deviceData(5, 'Apex de teste'), 0, 3);
  assert.equal(d.name, 'Apex de teste');
  assert.equal(d.type, 5);
  assert.equal(d.activeMode, 1);
  assert.deepEqual(d.modes.map((m) => m.name), ['Direct', 'Spectrum']);
  assert.deepEqual(d.leds, LEDS);
  assert.deepEqual(d.colors, ORIGINAL);
  assert.ok(MODES[1].equals(d.modes[1].raw), 'bytes do modo guardados exatamente');
});

test('pinta as teclas da cena e, ao soltar, devolve cores e modo originais', async () => {
  const srv = await fakeServer([deviceData(6, 'Mouse'), deviceData(5, 'Apex de teste')]);
  try {
    await rgbConfigure({ enabled: true, host: '127.0.0.1', port: srv.port, brightness: 1 });
    rgbScene({ keys: { q: 0xe5484d, '1': 0x3e8ed0, ',': 0xffffff }, base: 0x080808, pressed: [] });
    await until(() => srv.got.some((p) => p.id === 1050));
    assert.equal(rgbStatus().state, 'on');
    assert.deepEqual(rgbStatus().devices, ['Apex de teste'], 'só teclados');
    const custom = srv.got.find((p) => p.id === 1100);
    assert.equal(custom?.dev, 1, 'modo direto no teclado (não no mouse)');
    const leds = srv.got.filter((p) => p.id === 1050).pop()!;
    assert.equal(leds.dev, 1);
    const c = ledColors(leds.data);
    assert.equal(leds.data.readUInt32LE(0), leds.data.length, 'data_size conta o pacote inteiro');
    assert.equal(c[LEDS.indexOf('Key: Q')], 0xe5484d);
    assert.equal(c[LEDS.indexOf('Key: 1')], 0x3e8ed0);
    assert.equal(c[LEDS.indexOf('Key: ,')], 0xffffff);
    assert.equal(c[LEDS.indexOf('Key: Escape')], 0x080808, 'resto no fundo');
    // tecla apertada acende (mais clara)
    rgbScene({ pressed: ['q'] });
    const before = srv.got.length;
    await until(() => srv.got.length > before);
    const lit = ledColors(srv.got.filter((p) => p.id === 1050).pop()!.data)[LEDS.indexOf('Key: Q')];
    assert.ok(((lit >> 8) & 255) > 0x80, `acesa: ${lit.toString(16)}`);
    // soltar (fechar o app): cores originais e o modo Spectrum, byte a byte
    await rgbRelease();
    await wait(50);
    const after = srv.got.slice(srv.got.findIndex((p) => p === srv.got.filter((x) => x.id === 1050).pop()));
    const restoreLeds = srv.got.filter((p) => p.id === 1050).pop()!;
    assert.deepEqual(ledColors(restoreLeds.data), ORIGINAL, 'cores originais');
    const um = srv.got.filter((p) => p.id === 1101).pop()!;
    assert.equal(um.dev, 1);
    assert.equal(um.data.readInt32LE(4), 1, 'modo original (Spectrum)');
    assert.ok(um.data.subarray(8).equals(MODES[1]), 'descrição do modo igual à original');
    assert.equal(um.data.readUInt32LE(0), um.data.length);
    assert.equal(rgbStatus().state, 'off');
    void after;
  } finally {
    await rgbRelease();
    srv.close();
  }
});

test('sem OpenRGB rodando: não quebra e explica', async () => {
  await rgbConfigure({ enabled: true, host: '127.0.0.1', port: 1, brightness: 1 });
  rgbScene({ keys: { q: 0xff0000 } });
  await until(() => rgbStatus().state === 'missing');
  assert.equal(rgbStatus().state, 'missing');
  assert.match(rgbStatus().error ?? '', /OpenRGB/);
  await rgbConfigure({ enabled: false });
});

test('brilho escala as cores', () => {
  const c = sceneColors({ leds: ['Key: Q'] }, { keys: { q: 0xff8040 }, base: 0, pressed: [] }, 0.5);
  assert.equal(c[0], 0x804020);
});
