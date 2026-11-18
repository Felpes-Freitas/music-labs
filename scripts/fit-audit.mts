// Auditoria de layout numa resolução: o que está cortado (scrollWidth > clientWidth).
import { chromium } from 'playwright-core';
const B = process.argv[2] ?? 'http://127.0.0.1:7799';
const W = Number(process.argv[3] ?? 1366), H = Number(process.argv[4] ?? 720);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(B);
await page.waitForSelector('.loading', { state: 'detached', timeout: 30000 });
const audit = async (tag: string) => {
  const cut: string[] = await page.evaluate(`(() => {
    const out = [];
    const sel = '.win-bar, .titlebar, .toolbar, .tb-panel, .win-title, .win-tools, .tgroup, .pz-head, .chset-head, .cfx, .cfx-slot, .rack-foot, .fx-head, .strip, .pz-row, .pz-nodes, .gear-row, .menubar';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const over = el.scrollWidth - el.clientWidth;
      const offscreen = r.right > innerWidth + 1;
      if (over > 2 || offscreen) out.push((el.className || el.tagName).toString().split(' ').slice(0,2).join('.') + (over > 2 ? ' corta ' + over + 'px' : '') + (offscreen ? ' sai da tela' : ''));
    }
    return out;
  })()`);
  console.log(`[${tag}]`, cut.length ? cut.join(' | ') : 'nada cortado');
  await page.screenshot({ path: `/tmp/fit-${tag}.png` });
};
await audit('inicio');
await page.keyboard.press('F7');
await page.waitForTimeout(300);
await audit('pianoroll');
await page.keyboard.press('F7');
await page.keyboard.press('F9');
await page.waitForTimeout(300);
await audit('mixer');
await page.keyboard.press('F9');
await page.dblclick('.rack-row:has-text("Pad") .ch-name');
await page.waitForTimeout(500);
await audit('prisma');
await page.keyboard.press('Escape');
await page.evaluate(`document.querySelector('.win-channel .win-close').click()`);
await page.dblclick('.rack-row:has-text("Strings") .ch-name');
await page.waitForTimeout(400);
await page.click('.gear-btn');
await page.waitForTimeout(300);
await audit('sampler-gear');
await browser.close();

