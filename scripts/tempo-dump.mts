// Onde aparecem eventos de tempo nos .flp (para depurar BPM errado no import).
import { readFileSync } from 'node:fs';
import { readFlp, flpText } from '../src/core/flp.ts';
for (const path of process.argv.slice(2)) {
  const f = readFlp(readFileSync(path));
  let section = 'projeto';
  const hits: string[] = [];
  let version = '';
  f.events.forEach((e, i) => {
    if (e.id === 199) version = flpText(e.data);
    if (e.id === 64) section = 'canal';
    if (e.id === 65) section = 'pattern';
    if (e.id === 99) section = 'arranjo';
    if (e.id === 236 || e.id === 147) section = 'mixer';
    if ([66, 93, 156, 157].includes(e.id)) {
      const v = e.data.length === 4 ? new DataView(e.data.buffer, e.data.byteOffset, 4).getUint32(0, true) : e.data.length === 2 ? e.data[0] | (e.data[1] << 8) : e.data[0];
      hits.push(`#${i} id${e.id}=${v} (${section})`);
    }
  });
  console.log(path.split('/').pop(), version, '| ppq', f.ppq, '|', hits.slice(0, 8).join(', '), hits.length > 8 ? `… +${hits.length - 8}` : '');
}
