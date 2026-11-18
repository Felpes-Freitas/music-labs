// Screenshot de verificação da interface (Chrome headless).
import { chromium } from 'playwright-core';
const url = process.argv[2] ?? 'http://127.0.0.1:7717';
const out = process.argv[3] ?? '/tmp/musiclabs.png';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: Number(process.env.DSF ?? 1) });
const errors: string[] = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(1200);
for (const a of process.argv.slice(4)) {
  if (a.startsWith('key:')) await page.keyboard.press(a.slice(4));
  else if (a.startsWith('click:')) await page.click(a.slice(6));
  else if (a.startsWith('wait:')) await page.waitForTimeout(Number(a.slice(5)));
  else if (a.startsWith('eval:')) console.log(await page.evaluate(a.slice(5)));
}
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log('erros:', errors.length ? errors.join('\n') : 'nenhum');
await browser.close();
