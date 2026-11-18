import { readFileSync } from 'node:fs';
import { readFlp } from '../src/core/flp.ts';
const f = readFlp(readFileSync(process.argv[2]));
const out: string[] = [];
f.events.slice(0, Number(process.argv[3] ?? 60)).forEach((e, i) => {
  const d = e.data;
  let v = '';
  if (d.length === 1) v = String(d[0]);
  else if (d.length === 2) v = String(d[0] | (d[1] << 8));
  else if (d.length === 4) {
    const dv = new DataView(d.buffer, d.byteOffset, 4);
    v = `${dv.getUint32(0, true)} f=${dv.getFloat32(0, true).toPrecision(6)}`;
  } else v = `[${d.length}] ${[...d.slice(0, 24)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`;
  out.push(`#${i} id${e.id}: ${v}`);
});
console.log(out.join('\n'));
