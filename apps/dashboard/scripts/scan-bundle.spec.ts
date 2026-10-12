import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanBundle } from './scan-bundle.mjs';
it('rejects planted fake secrets recursively and fails the CLI', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'dashboard-scan-'));
 try {
  await mkdir(join(dir, 'assets')); const path = join(dir, 'assets', 'fake.js');
  await writeFile(path, 'safe bundle'); await expect(scanBundle(dir)).resolves.toBeUndefined();
  for (const marker of ['sb_secret_', 'service_role', 'SUPABASE_SERVICE_ROLE_KEY']) {
   await writeFile(path, marker + 'FAKE_TEST_ONLY'); await expect(scanBundle(dir)).rejects.toThrow('Forbidden credential marker');
   expect(spawnSync(process.execPath, ['scripts/scan-bundle.mjs', dir]).status).toBe(1);
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
