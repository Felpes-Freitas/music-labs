import { getSet } from '../src/server/sampleset.ts';
import { noteName } from '../src/core/model.ts';
const P = process.env.HOME + '/.wine/drive_c/Program Files/Image-Line/FL Studio 2025/Data/Patches/Packs/Instruments/';
for (const d of process.argv.slice(2)) {
  const b = await getSet(P + d);
  console.log(d, b.info.rootSource, 'loop', b.info.hasLoop, b.info.zones!.map((x) => `${noteName(Math.round(x.root))}[${x.lo}-${x.hi}]${x.vlo > 0 || x.vhi < 1 ? `v${x.vlo.toFixed(2)}` : ''}`).join(' '));
}
