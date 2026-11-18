// Leitura e escrita de WAV (PCM 8/16/24/32 e float 32/64).

import type { SampleData } from './instruments.js';

export function decodeWav(buf: Uint8Array): SampleData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Não é WAV');
  let o = 12;
  let fmt = 1, chans = 1, sr = 44100, bits = 16;
  let data: [number, number] | null = null;
  let root: number | undefined;
  let loop: [number, number] | undefined;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(o + 8, true);
      chans = dv.getUint16(o + 10, true);
      sr = dv.getUint32(o + 12, true);
      bits = dv.getUint16(o + 22, true);
      if (fmt === 0xfffe && size >= 26) fmt = dv.getUint16(o + 32, true);
    } else if (id === 'data') {
      // ffmpeg em pipe escreve tamanho 0xFFFFFFFF: usa o resto do arquivo.
      if (size === 0xffffffff || o + 8 + size > buf.length) size = buf.length - o - 8;
      data = [o + 8, size];
    } else if (id === 'smpl' && size >= 36 && o + 8 + 36 <= buf.length) {
      const unity = dv.getUint32(o + 8 + 12, true);
      const frac = dv.getUint32(o + 8 + 16, true);
      if (unity > 0 && unity < 128) root = unity + frac / 4294967296;
      if (dv.getUint32(o + 8 + 28, true) > 0 && o + 8 + 60 <= buf.length) {
        const ls = dv.getUint32(o + 8 + 36 + 8, true);
        const le = dv.getUint32(o + 8 + 36 + 12, true);
        if (le > ls + 16) loop = [ls, le];
      }
    }
    o += 8 + size + (size & 1);
  }
  if (!data) throw new Error('WAV sem bloco data');
  const bps = bits / 8;
  const frames = Math.floor(data[1] / (bps * chans));
  const ch = Array.from({ length: Math.min(chans, 2) }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch.length; c++) {
      const p = data[0] + (i * chans + c) * bps;
      let v = 0;
      if (fmt === 3) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) v = ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bits === 8) v = (buf[p] - 128) / 128;
      ch[c][i] = v;
    }
  }
  if (loop && loop[1] > frames) loop = loop[0] < frames - 16 ? [loop[0], frames] : undefined;
  return { sr, ch, ...(root !== undefined ? { root } : {}), ...(loop ? { loop } : {}) };
}

export function encodeWav(L: Float32Array, R: Float32Array, sr: number, bits: 16 | 24 | 32 = 24): Uint8Array {
  const frames = L.length;
  const bps = bits / 8;
  const dataLen = frames * 2 * bps;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, bits === 32 ? 3 : 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2 * bps, true);
  dv.setUint16(32, 2 * bps, true); dv.setUint16(34, bits, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (const x of [L[i], R[i]]) {
      if (bits === 32) dv.setFloat32(o, x, true);
      else {
        // dither TPDF leve para 16 bits
        const v = Math.max(-1, Math.min(1, x + (bits === 16 ? (Math.random() - Math.random()) / 65536 : 0)));
        if (bits === 16) dv.setInt16(o, Math.round(v * 32767), true);
        else {
          const n = Math.round(v * 8388607);
          buf[o] = n & 255; buf[o + 1] = (n >> 8) & 255; buf[o + 2] = (n >> 16) & 255;
        }
      }
      o += bps;
    }
  }
  return buf;
}

/** WAV float32 (1 ou 2 canais) com bloco smpl opcional (raiz e loop). */
export function encodeSampleWav(s: SampleData): Uint8Array {
  const chans = s.ch.length;
  const frames = s.ch[0].length;
  const dataLen = frames * chans * 4;
  const smplLen = s.root !== undefined || s.loop ? 36 + (s.loop ? 24 : 0) : 0;
  const total = 12 + 24 + 8 + dataLen + (smplLen ? 8 + smplLen : 0);
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  const w = (o: number, t: string) => { for (let i = 0; i < 4; i++) buf[o + i] = t.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, total - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, chans, true);
  dv.setUint32(24, s.sr, true); dv.setUint32(28, s.sr * chans * 4, true); dv.setUint16(32, chans * 4, true); dv.setUint16(34, 32, true);
  w(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < chans; c++, o += 4) dv.setFloat32(o, s.ch[c][i], true);
  if (smplLen) {
    w(o, 'smpl'); dv.setUint32(o + 4, smplLen, true);
    const p = o + 8;
    const root = s.root ?? 60;
    dv.setUint32(p + 12, Math.floor(root), true);
    dv.setUint32(p + 16, Math.round((root - Math.floor(root)) * 4294967295), true);
    dv.setUint32(p + 28, s.loop ? 1 : 0, true);
    if (s.loop) { dv.setUint32(p + 36 + 8, s.loop[0], true); dv.setUint32(p + 36 + 12, s.loop[1], true); }
  }
  return buf;
}
