// Utilitário de engenharia reversa: estatísticas de eventos de um .flp.
import { readFileSync } from 'node:fs';
import { readFlp, flpText, EV } from '../src/core/flp.ts';
const files = process.argv.slice(2);
const counts = new Map<number, number>();
const ev22 = new Map<number, number>(); const vel = new Map<number, number>(); const pan = new Map<number,number>();
for (const path of files) {
  const f = readFlp(readFileSync(path));
  let inCh = false; let chName = ''; const rows: string[] = [];
  for (const e of f.events) {
    counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    if (e.id === EV.ChannelNew) { inCh = true; }
    if (e.id === EV.PatternNew) inCh = false;
    if (e.id === 22 && inCh) ev22.set(e.data[0], (ev22.get(e.data[0]) ?? 0) + 1);
    if (e.id === EV.PatternNotes) for (let o = 0; o + 24 <= e.data.length; o += 24) { vel.set(e.data[o+21], (vel.get(e.data[o+21])??0)+1); pan.set(e.data[o+20], (pan.get(e.data[o+20])??0)+1); }
    if (process.env.V && [EV.PluginInternalName, EV.PluginName, EV.ChannelSamplePath, EV.InsertName].includes(e.id as any)) rows.push(`${e.id} ${flpText(e.data)}`);
    if (process.env.V && e.id === 22) rows.push(`22 => ${e.data[0]}`);
  }
  if (process.env.V) console.log(path, f.ppq, '\n' + rows.join('\n'));
}
const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('ev22', top(ev22)); console.log('vel', top(vel)); console.log('pan', top(pan));
console.log('ids', [...counts.keys()].sort((a,b)=>a-b).join(' '));
