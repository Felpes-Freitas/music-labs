// Sons padrão a partir dos samples da instalação local do FL Studio (Wine).
// Só referencia caminhos no disco do usuário: nada é copiado nem redistribuído.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FL_DIR } from './samples.js';
import { library } from './library.js';

const DRUMS = join(FL_DIR, 'Data/Patches/Packs/Drums');

const CANDIDATES: Record<string, string[]> = {
  Kick: ['Kicks/Grv Kick 03.wav', 'Kicks/909 Kick.wav', 'Kicks/FPC 1 Kick.wav'],
  Clap: ['Percussion/Grv Clap 01.wav', 'Percussion/909 Clap.wav'],
  Hat: ['Hats/Grv CH 01.wav', 'Hats/909 CH 1.wav', 'Hats/808 CH.wav'],
  Snare: ['Snares/FPC Snare 1.wav', 'Snares/909 Snare.wav', 'Snares/808 Snare.wav'],
  'Open Hat': ['Hats/Grv OH 01.wav', 'Hats/909 OH.wav', 'Hats/808 OH.wav'],
  '808 Kick': ['Kicks/808 Kick.wav'],
  '909 Kick': ['Kicks/909 Kick.wav'],
  '808 Snare': ['Snares/808 Snare.wav'],
  '909 Snare': ['Snares/909 Snare.wav'],
  Rim: ['Snares/909 Rim.wav', 'Snares/FPC Rim.wav'],
  Crash: ['Cymbals/Grv Crash 01.wav', 'Cymbals/909 Crash.wav'],
  Ride: ['Cymbals/Grv Ride 01.wav', 'Cymbals/909 Ride.wav'],
  Tom: ['Toms/909 Tom.wav', 'Toms/808 Tom.wav'],
  Conga: ['Percussion/808 Conga.wav'],
  Cowbell: ['Percussion/808 Cowbell.wav'],
};

export interface LocalSample {
  name: string;
  path: string;
  cut?: number;
}

let cached: LocalSample[] | null = null;
let cachedFor: string | null = null;

// Para máquinas sem FL: acha a peça pelo nome entre os samples de bateria indexados.
const BY_NAME: Record<string, RegExp> = {
  Kick: /\bkick\b|\bbd\b|bass ?drum/i,
  Clap: /\bclap/i,
  Hat: /closed ?hat|\bch\b|hi-?hat(?!.*open)|\bhat\b(?!.*open)/i,
  Snare: /\bsnare|\bsd\b/i,
  'Open Hat': /open ?hat|\boh\b/i,
  Rim: /\brim/i,
  Crash: /crash/i,
  Ride: /\bride\b/i,
  Tom: /\btom\b/i,
};

/** Bateria padrão: samples de fábrica do FL se houver; senão, da biblioteca indexada. */
export function localKit(): LocalSample[] {
  const ix = library();
  const key = ix?.scannedAt ?? 'sem-indice';
  if (cached && cachedFor === key) return cached;
  cachedFor = key;
  cached = [];
  for (const [name, list] of Object.entries(CANDIDATES)) {
    const hit = list.map((r) => join(DRUMS, r)).find((p) => existsSync(p));
    if (hit) cached.push({ name, path: hit, cut: /hat/i.test(name) ? 1 : undefined });
  }
  if (ix)
    for (const [name, re] of Object.entries(BY_NAME)) {
      if (cached.some((c) => c.name === name)) continue;
      const f = ix.files.find((x) => x.c === 'drum' && re.test(x.p.split(/[\\/]/).pop()!));
      if (f) cached.push({ name, path: f.p, cut: /hat/i.test(name) ? 1 : undefined });
    }
  return cached;
}

export function localSample(name: string): LocalSample | undefined {
  return localKit().find((s) => s.name.toLowerCase() === name.toLowerCase());
}
