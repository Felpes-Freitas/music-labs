// Prints da janela do canal: aba Instrumento com tecla acesa e aba de engrenagem.
import { chromium } from 'playwright-core';
const B = process.argv[2] ?? 'http://127.0.0.1:7799';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForTimeout(900);
await page.waitForSelector('.loading', { state: 'detached', timeout: 30000 });
await page.dblclick('.rack-row:has-text("Prisma Pad") .ch-name');
await page.waitForTimeout(700);
await page.keyboard.down('e'); // E4
await page.keyboard.down('t'); // G4
await page.waitForTimeout(400);
const lit = await page.evaluate(`(() => {
  const c = document.querySelector('.chpiano-keys');
  if (!c) return 'sem teclado';
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 150 && d[i + 1] < 215 && d[i + 2] < 140) n++;
  return n;
})()`);
console.log('pixels de tecla acesa no teclado:', lit);
await page.screenshot({ path: '/tmp/ch-inst.png' });
await page.keyboard.up('e');
await page.keyboard.up('t');
await page.click('.gear-btn');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/ch-gear.png' });
// recolhe o espectro e os gráficos
await page.click('.tabs button:first-child');
await page.waitForTimeout(200);
for (const sel of ['.pz-fold > .fold']) {
  const n = await page.locator(sel).count();
  for (let i = 0; i < n; i++) await page.locator(sel).nth(0).click().catch(() => {});
}
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/ch-folded.png' });
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
