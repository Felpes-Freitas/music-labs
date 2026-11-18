import { demoSong } from '../test/engine.test.ts';
import { renderProject } from '../src/server/render.ts';
const p = demoSong();
for (const keep of ['all', 'Kick', 'Hat', 'Clap', 'Sub Bass', 'Warm Pad']) {
  const q = JSON.parse(JSON.stringify(p));
  if (keep !== 'all') q.channels.forEach((c: any) => (c.mute = c.name !== keep));
  const t = performance.now(); await renderProject(q, { tailSeconds: 0 }); console.log(keep, (performance.now() - t).toFixed(0), 'ms');
}
