// Testa: tela de carregamento + áudio ligado no fim, playlist ao fundo, Tab,
// botão do meio no knob e teclado preso ao instrumento depois de clicar em controles.
import { chromium } from 'playwright-core';
const B = process.argv[2] ?? 'http://127.0.0.1:7799';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForSelector('.loading', { timeout: 3000 });
await page.waitForTimeout(250);
const progress = await page.textContent('.loading-label');
await page.screenshot({ path: '/tmp/loading.png' });
const t0 = Date.now();
await page.waitForSelector('.loading', { state: 'detached', timeout: 60000 });
console.log(`tela de carregamento: "${progress}" · sumiu em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('áudio ligado sem clique:', await page.evaluate(`document.querySelector('.audio-hint') === null`), '| conn:', await page.textContent('.conn'));
// playlist maximizada e no fundo
const z = await page.evaluate(`[...document.querySelectorAll('.win')].map(w => w.className.match(/win-(\\w+)/)[1] + ':' + w.style.zIndex + ':' + Math.round(w.getBoundingClientRect().width))`);
console.log('janelas (id:z:largura):', z);
await page.click('.win-playlist .pl-canvas', { position: { x: 1000, y: 650 } });
const zAfter = await page.evaluate(`[document.querySelector('.win-playlist').style.zIndex, document.querySelector('.win-rack').style.zIndex]`);
console.log('depois de clicar na playlist (playlist, rack):', zAfter);
// Tab alterna
const top = () => page.evaluate(`[...document.querySelectorAll('.win')].sort((a,b)=>b.style.zIndex-a.style.zIndex)[0].className.match(/win-(\\w+)/)[1]`);
const seq = [await top()];
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Tab');
  seq.push(await top());
}
console.log('Tab:', seq.join(' → '));
// rack na frente antes de mexer no knob
for (let i = 0; i < 4 && (await top()) !== 'rack'; i++) await page.keyboard.press('Tab');
console.log('playlist depois que o foco passou (z):', await page.evaluate(`document.querySelector('.win-playlist').style.zIndex`));
// botão do meio no knob de volume do canal 1
const knob = page.locator('.rack-row').first().locator('.knob svg').nth(1);
const before = await (await fetch(B + '/api/project')).json().then((d: any) => d.project.channels[0].volume);
const kb = (await knob.boundingBox())!;
await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
await page.mouse.down();
await page.mouse.move(kb.x + kb.width / 2, kb.y - 60, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(150);
const moved = await (await fetch(B + '/api/project')).json().then((d: any) => d.project.channels[0].volume);
await page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2, { button: 'middle' });
await page.waitForTimeout(150);
const reset = await (await fetch(B + '/api/project')).json().then((d: any) => d.project.channels[0].volume);
console.log(`knob: ${before.toFixed(2)} → arrastado ${moved.toFixed(2)} → botão do meio ${reset.toFixed(2)}`);
// teclado preso ao instrumento: seleciona o Pad, abre o canal, clica num knob e numa lista, depois toca
await page.dblclick('.rack-row:has-text("Pad") .ch-name');
await page.waitForTimeout(400);
await page.click('.pz-row .knob svg');
await page.selectOption('.pz-nodes select', 'peak');
await page.waitForTimeout(100);
const active = await page.evaluate(`document.activeElement.tagName`);
await page.keyboard.down('w');
await page.waitForTimeout(300);
const lit: number = await page.evaluate(`(() => { const c = document.querySelector('.chpiano-keys'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for (let i=0;i<d.length;i+=4) if (d[i]>230 && d[i+1]>150 && d[i+1]<215 && d[i+2]<140) n++; return n; })()`);
await page.keyboard.up('w');
console.log(`depois de clicar em knob e lista: foco em ${active}; tecla W acendeu o teclado do instrumento: ${lit > 0 ? 'sim' : 'NÃO'} (${lit} px)`);
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
