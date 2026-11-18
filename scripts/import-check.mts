import { readFileSync } from 'node:fs';
import { importFlp } from '../src/core/flp.ts';
for (const f of process.argv.slice(2)) {
  const { project, report } = importFlp(new Uint8Array(readFileSync(f)), 'x');
  console.log(f.split('/').pop(), '| bpm', project.bpm, '| travado', report.locked, '| tempo desconhecido', report.tempoUnknown, '| canais', report.channels, '| notas', report.notes, '| inserts', Math.max(...project.channels.map((c) => c.insert)), '| mutados', project.channels.filter((c) => c.mute).length);
}
