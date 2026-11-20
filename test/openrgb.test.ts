// OpenRGB de fábrica: arquivo que não confere com o oficial nunca é instalado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('download adulterado é recusado e nada é instalado', async () => {
  const srv = createServer((_q, r) => r.end(Buffer.alloc(1000, 7)));
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as { port: number }).port;
  const state = mkdtempSync(join(tmpdir(), 'mlt-orgb-'));
  process.env.MUSICLABS_STATE_DIR = state;
  process.env.MUSICLABS_HOME = state;
  process.env.MUSICLABS_OPENRGB_URL = `http://127.0.0.1:${port}`;
  const m = await import('../src/server/openrgb.ts');
  try {
    if (!m.openRgbSupported()) return; // sistema sem pacote automático
    await assert.rejects(m.installOpenRgb(), /SHA-256/);
    assert.equal(m.openRgbState().install.state, 'error');
    assert.equal(m.openRgbExe(), null);
    assert.equal(existsSync(join(state, 'openrgb', 'squashfs-root')), false);
    assert.equal(m.startOpenRgb(6742), false, 'sem programa, não inicia nada');
    assert.ok(Array.isArray(m.rgbHardwareHint()));
    assert.equal(typeof m.needsDeviceAccess(), 'boolean');
  } finally {
    srv.close();
  }
});
