// Segura uma tecla do teclado do computador e mede o master pelo medidor do osciloscópio.
import { chromium } from 'playwright-core';
const B = 'http://127.0.0.1:7717';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForTimeout(800);
await page.waitForSelector('.loading', { state: 'detached', timeout: 30000 });
await page.click(`.rack-row:has-text("${process.argv[2] ?? 'OSTR C1'}") .ch-name`);
await page.waitForTimeout(1500); // tempo para carregar o sample
const level = () =>
  page.evaluate(() => {
    const c = document.querySelector('.scope') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(c.width - 14, 0, 14, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 150 || d[i] > 200) n++;
    return n; // pixels acesos no medidor (L/R)
  });
await page.keyboard.down('q');
const samples: number[] = [];
for (let t = 0; t < 8; t++) {
  await page.waitForTimeout(500);
  samples.push(await level());
}
await page.keyboard.up('q');
await page.waitForTimeout(1500);
const after = await level();
console.log('segurando (a cada 0,5 s):', samples.join(' '), '| 1,5 s depois de soltar:', after);
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
