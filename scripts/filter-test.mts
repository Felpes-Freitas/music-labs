// Testa o filtro do Prisma na tela: atualização imediata, criar nó, arrastar, espectrograma.
import { chromium } from 'playwright-core';
const B = process.argv[2] ?? 'http://127.0.0.1:7799';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, deviceScaleFactor: 2 });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForTimeout(900);
await page.click('.audio-hint');
await page.dblclick('.rack-row:has-text("Prisma") .ch-name');
await page.waitForTimeout(600);
const sum = (): Promise<number> =>
  page.evaluate(`(() => { const c = document.querySelector('.pz-graph'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 13) s = (s * 31 + d[i]) >>> 0; return s; })()`);
// 1) trocar o tipo do nó 1 e ver se o gráfico muda logo
const before = await sum();
await page.selectOption('.pz-nodes select', 'highpass');
await page.waitForTimeout(80);
const after = await sum();
console.log(`trocar o tipo do nó: gráfico ${before !== after ? 'mudou em 80 ms' : 'NÃO mudou'}`);
await page.selectOption('.pz-nodes select', 'lowpass');
await page.waitForTimeout(80);
// 2) duplo clique cria nó 2 (pico) e 3) arrastar
const g = (await page.locator('.pz-graph').boundingBox())!;
const fx = (f: number) => g.x + (Math.log(f / 20) / Math.log(1000)) * g.width;
const yDb = (db: number) => g.y + 8 + ((24 - db) / 72) * (g.height - 24);
await page.mouse.dblclick(fx(300), yDb(9));
await page.waitForTimeout(150);
const proj = async () => (await (await fetch(B + '/api/project')).json()).project.channels.find((c: any) => c.name === 'Prisma').params;
let pp = await proj();
console.log('nó 2 criado:', pp.f2_type, Math.round(pp.f2_freq), 'Hz', pp.f2_gain, 'dB');
await page.mouse.move(fx(300), yDb(9));
await page.mouse.down();
await page.mouse.move(fx(1500), yDb(-12), { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
pp = await proj();
console.log('nó 2 arrastado:', Math.round(pp.f2_freq), 'Hz', pp.f2_gain, 'dB');
// 4) roda do mouse no nó: intensidade
await page.mouse.move(fx(1500), yDb(-12));
await page.mouse.wheel(0, 300);
await page.waitForTimeout(100);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(150);
pp = await proj();
console.log('intensidade do nó 2 depois da roda:', pp.f2_amt);
// 5) tocar uma nota e ver o espectrograma ao vivo
await page.keyboard.down('q');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/pz-filter.png', clip: { x: g.x - 20, y: g.y - 60, width: g.width + 200, height: g.height + 80 } });
await page.keyboard.up('q');
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
