import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { candidateSources, scanLibrary, findFlInstall, categoryFor } from '../src/server/library.ts';

function fakeHome() {
  const h = mkdtempSync(join(tmpdir(), 'mlabs-home-'));
  const files = [
    '.wine/drive_c/Program Files/Image-Line/FL Studio 21/Data/Patches/Packs/Drums/Kicks/Grv Kick 01.wav',
    '.wine/drive_c/Program Files/Image-Line/FL Studio 21/Data/Patches/Packs/Drums/Snares/Snare 2.wav',
    ...[1, 2, 3, 4].map((i) => `.wine/drive_c/Program Files/Image-Line/FL Studio 21/Data/Patches/Packs/Instruments/Orchestral/Strings/Strings (${i}).wav`),
    ...['C2', 'C3', 'C4', 'C5'].map((n) => `.wine/drive_c/users/fulano/Documents/Ableton/User Library/Samples/Keys/Piano ${n}.wav`),
    '.local/share/bottles/bottles/Musica/drive_c/Program Files/Ableton/Live 12 Suite/Resources/Core Library/Samples/Loops/Beat 120 bpm.wav',
    'Música/Samples/vocal chop.wav',
    'Música/Samples/notas.txt',
  ];
  for (const f of files) {
    mkdirSync(dirname(join(h, f)), { recursive: true });
    writeFileSync(join(h, f), '');
  }
  return h;
}

test('biblioteca: acha DAWs no Wine, no Bottles e pastas do usuário (Linux)', async () => {
  const home = fakeHome();
  try {
    const env = { home, platform: 'linux' as const, env: {} };
    const sources = candidateSources(env);
    const labels = sources.map((s) => s.label);
    assert.ok(labels.some((l) => l.startsWith('FL Studio (Wine)')), labels.join(' | '));
    assert.ok(labels.some((l) => l.startsWith('Ableton (biblioteca do usuário) (Wine)')), labels.join(' | '));
    assert.ok(labels.some((l) => l.includes('Wine: Musica') && l.includes('Live 12 Suite')), labels.join(' | '));
    assert.ok(labels.includes('Música › Samples'));
    const ix = await scanLibrary(sources, env);
    assert.equal(ix.files.length, 12, 'só arquivos de áudio');
    const cat = (name: string) => ix.files.find((f) => f.p.endsWith(name))!.c;
    assert.equal(cat('Grv Kick 01.wav'), 'drum');
    assert.equal(cat('Beat 120 bpm.wav'), 'loop');
    assert.equal(cat('Piano C3.wav'), 'instrument');
    const inst = ix.instruments.map((i) => i.name).sort();
    assert.deepEqual(inst, ['Keys', 'Strings'], 'pasta com notas no nome e pasta em /Instruments/');
    assert.ok(findFlInstall(env)!.endsWith('FL Studio 21'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('biblioteca: categorias por caminho', () => {
  assert.equal(categoryFor('/x/Packs/SFX/Risers/up.wav'), 'fx');
  assert.equal(categoryFor('/x/Vocals/hey.wav'), 'vocal');
  assert.equal(categoryFor('/x/random/thing.wav'), 'other');
});
