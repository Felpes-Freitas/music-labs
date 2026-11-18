// Teste de interação do piano roll com mouse real (Chrome headless).
import { chromium } from 'playwright-core';
const B = 'http://127.0.0.1:7717';
const notesOf = async () => {
  const d = await (await fetch(`${B}/api/project`)).json();
  const p = d.project;
  const pat = p.patterns.find((x: any) => x.name === 'PRTest');
  const ch = p.channels.find((c: any) => c.name === 'Lead');
  return (pat?.notes[ch.id] ?? []).map((n: any) => `${n.key}@${n.pos}+${n.len}${n.mute ? 'M' : ''}`).join(' ');
};
await fetch(`${B}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actions: [{ name: 'addPattern', args: { name: 'PRTest' } }] }) });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 860 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(B);
await page.waitForTimeout(800);
await page.waitForSelector('.loading', { state: 'detached', timeout: 30000 });
await page.click('.picker .pk:has-text("PRTest")');
await page.click('.rack-row:has-text("Lead") .ch-name');
await page.keyboard.press('F7');
await page.waitForTimeout(400);
const box = (await page.locator('.pr-canvas').boundingBox())!;
const X = (t: number) => box.x + 66 + t * 0.6 + 2; // KEYS + tick*zx
const rowAt = async () => box.y + 24 + 100; // uma linha qualquer da grade
const y = await rowAt();
// 1) clique cria nota
await page.mouse.click(X(0), y);
await page.waitForTimeout(150);
console.log('criou:', await notesOf());
// 2) redimensiona pela borda direita (len 48 -> arrasta +96 ticks)
await page.mouse.move(X(48) - 3, y);
await page.mouse.down();
await page.mouse.move(X(48) - 3 + 96 * 0.6, y, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(150);
console.log('redimensionou:', await notesOf());
// 3) move uma linha para cima e 1 tempo à direita
await page.mouse.move(X(20), y);
await page.mouse.down();
await page.mouse.move(X(20) + 96 * 0.6, y - 15, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(150);
console.log('moveu:', await notesOf());
// 4) pincel
await page.keyboard.press('b');
await page.mouse.move(X(384), y + 60);
await page.mouse.down();
await page.mouse.move(X(384 + 200), y + 60, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
console.log('pincel:', await notesOf());
// 5) fatiar a primeira nota
await page.keyboard.press('c');
await page.mouse.click(X(96 + 48), y - 15 + 5);
await page.waitForTimeout(150);
console.log('fatiou:', await notesOf());
// 6) mute em uma nota do pincel
await page.keyboard.press('t');
await page.mouse.click(X(384 + 10), y + 60 + 5);
await page.waitForTimeout(150);
console.log('mute:', await notesOf());
// 7) direito apaga
await page.keyboard.press('p');
await page.mouse.click(X(384 + 10), y + 60 + 5, { button: 'right' });
await page.waitForTimeout(150);
console.log('apagou:', await notesOf());
// 8) Ctrl+A, Ctrl+D duplica tudo
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);
console.log('duplicou:', (await notesOf()).split(' ').length, 'notas');
await page.screenshot({ path: '/tmp/n3.png' });
console.log('erros:', errs.join('\n') || 'nenhum');
await browser.close();
