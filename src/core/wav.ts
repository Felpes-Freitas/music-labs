// Leitura e escrita de WAV (PCM 8/16/24/32 e float 32/64).

import type { SampleData } from './instruments.js';

export function decodeWav(buf: Uint8Array): SampleData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Não é WAV');
  let o = 12;
  let fmt = 1, chans = 1, sr = 44100, bits = 16;
  let data: [number, number] | null = null;
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
      break;
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
  return { sr, ch };
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
