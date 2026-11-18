import { readdirSync } from 'node:fs';
import { decodeWav } from '../src/core/wav.ts';
import { detectPitch } from '../src/core/pitch.ts';
import { noteName } from '../src/core/model.ts';
import { toWavBytes, riffMetaOf } from '../src/server/samples.ts';
import { getSet } from '../src/server/sampleset.ts';
const P = process.env.HOME + '/.wine/drive_c/Program Files/Image-Line/FL Studio 2025/Data/Patches/Packs/Instruments/';
// 1) detector x smpl (verdade)
let ok = 0, tot = 0;
for (const d of ['Orchestral/Strings Section', 'Orchestral/Choir Ahh', 'Orchestral/Brass Section', 'Keyboard/Grand']) {
  for (const f of readdirSync(P + d).filter((x) => x.endsWith('.wav')).slice(0, 14)) {
    const full = P + d + '/' + f;
    const truth = riffMetaOf(full)?.root;
    const s = decodeWav(await toWavBytes(full));
    const mono = s.ch[0].map((v, k) => (v + (s.ch[1]?.[k] ?? v)) / 2);
    const r = detectPitch(mono, s.sr);
    tot++;
    const good = r && truth !== undefined && Math.abs(r.midi - truth) < 0.6;
    if (good) ok++;
    else console.log('  diverge', d, f, 'smpl', truth, 'detectado', r?.midi.toFixed(2), 'clareza', r?.clarity.toFixed(2));
  }
}
console.log(`detector bate com smpl: ${ok}/${tot}`);
// 2) conjuntos montados
for (const d of ['Orchestral/Woodwind Section', 'Bass/Acoustic', 'Guitar/Jazz', 'Keyboard/Close Grand', 'Keyboard/Rhodes', 'Orchestral/Strings Section']) {
  const t = performance.now();
  const b = await getSet(P + d);
  const z = b.info.zones!;
  console.log(d, `${(performance.now() - t).toFixed(0)}ms`, b.info.rootSource, 'loop', b.info.hasLoop, z.map((x) => `${x.file.replace(/\.wav$/, '').slice(-5)}=${noteName(Math.round(x.root))}`).join(' '));
}
