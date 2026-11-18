// Mede a responsividade do piano roll e da playlist (servidor de teste isolado).
import { chromium } from 'playwright-core';
const B = process.argv[2] ?? 'http://127.0.0.1:7799';
const post = (path: string, body: unknown) => fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const proj = (await (await fetch(B + '/api/project')).json()).project;
const ch = proj.channels.find((c: any) => c.type !== 'drum') ?? proj.channels[0];
await post('/api/actions', { actions: [{ name: 'addPattern', args: { name: 'LagTest' } }, { name: 'addNotes', args: { pattern: 'LagTest', channel: ch.id, notes: [{ note: 'C5', start: 0, length: 0.5 }] } }] });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForTimeout(1000);
await page.waitForSelector('.loading', { state: 'detached', timeout: 30000 });
// medidor de quadros
await page.evaluate(`(() => {
  window.__ft = [];
  let last = performance.now();
  const loop = (t) => { window.__ft.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})()`);
const sum = (sel: string, x: number, y: number, w: number, h: number): Promise<number> =>
  page.evaluate(`new Promise((res) => requestAnimationFrame(() => {
    const c = document.querySelector(${JSON.stringify(sel)});
    const dpr = c.width / c.getBoundingClientRect().width;
    const d = c.getContext('2d').getImageData(${x} * dpr, ${y} * dpr, ${w} * dpr, ${h} * dpr).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 7) s = (s * 31 + d[i]) >>> 0;
    res(s);
  }))`);

// ---- piano roll: redimensionar sem soltar o mouse
await page.click('.picker .pk:has-text("LagTest")');
await page.click(`.rack-row:has-text("${ch.name}") .ch-name`);
await page.keyboard.press('F7');
await page.waitForTimeout(500);
const box = (await page.locator('.pr-canvas').boundingBox())!;
const yNote = 24 + Math.max(100, (box.height - 24 - 86) / 2) + 7; // linha da nota (centralizada)
const xEdge = 66 + 48 * 0.6 - 2;
await page.mouse.move(box.x + xEdge, box.y + yNote);
await page.mouse.down();
let changed = 0;
let prev = await sum('.pr-canvas', 66, yNote - 8, 400, 16);
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(box.x + xEdge + i * 14.4, box.y + yNote); // +1 step por movimento
  const now = await sum('.pr-canvas', 66, yNote - 8, 400, 16);
  if (now !== prev) changed++;
  prev = now;
}
await page.mouse.up();
console.log(`piano roll: ${changed}/10 movimentos atualizaram a tela no quadro seguinte`);

// ---- playlist: criar clip e ver aparecer
await page.keyboard.press('F7'); // fecha o piano roll
await page.keyboard.press('F5'); // traz a playlist para a frente
await page.waitForTimeout(300);
const pl = (await page.locator('.pl-canvas').boundingBox())!;
// acha um ponto vazio e visível: track visível, compasso sem clip
const pj = (await (await fetch(B + '/api/project')).json()).project;
const zx = 0.12, rowH = 34, bar = 384;
const visTracks = Math.floor((pl.height - 22) / rowH);
let cx = 0, cy = 0, found = false;
for (let t = 0; t < visTracks && !found; t++)
  for (let b = 0; b < Math.floor((pl.width - 120) / (bar * zx)) - 1 && !found; b++) {
    const busy = pj.clips.some((c: any) => c.track === t && c.pos < (b + 1) * bar && c.pos + c.len > b * bar);
    if (!busy) {
      cx = 120 + b * bar * zx + 10;
      cy = 22 + t * rowH + rowH / 2;
      found = true;
    }
  }
const n0 = pj.clips.length;
const before = await sum('.pl-canvas', cx - 5, cy - 8, 40, 16);
await page.mouse.click(pl.x + cx, pl.y + cy);
const after = await sum('.pl-canvas', cx - 5, cy - 8, 40, 16);
const n1 = (await (await fetch(B + '/api/project')).json()).project.clips.length;
console.log(`playlist: clips ${n0} -> ${n1}; o clip ${before !== after ? 'apareceu' : 'NÃO apareceu'} no quadro seguinte ao clique`);

const ft: number[] = await page.evaluate('window.__ft.slice(5)');
ft.sort((a, b) => a - b);
console.log(`quadros: mediana ${ft[Math.floor(ft.length / 2)].toFixed(1)} ms, p95 ${ft[Math.floor(ft.length * 0.95)].toFixed(1)} ms, máx ${ft[ft.length - 1].toFixed(1)} ms`);
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
