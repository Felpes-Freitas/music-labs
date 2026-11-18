// Sons padrão a partir dos samples da instalação local do FL Studio (Wine).
// Só referencia caminhos no disco do usuário: nada é copiado nem redistribuído.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FL_DIR } from './samples.js';

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

/** Samples de bateria disponíveis na instalação local (vazio se não houver FL). */
export function localKit(): LocalSample[] {
  if (cached) return cached;
  cached = [];
  for (const [name, list] of Object.entries(CANDIDATES)) {
    const hit = list.map((r) => join(DRUMS, r)).find((p) => existsSync(p));
    if (hit) cached.push({ name, path: hit, cut: /hat/i.test(name) ? 1 : undefined });
  }
  return cached;
}

export function localSample(name: string): LocalSample | undefined {
  return localKit().find((s) => s.name.toLowerCase() === name.toLowerCase());
}
