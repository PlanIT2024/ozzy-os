import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanBundle } from './scan-bundle.mjs';
const jwt = (role: string) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.FAKE_SIGNATURE`;

it('rejects each planted secret recursively and fails the CLI without printing secrets', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'dashboard-scan-'));
 try {
  await mkdir(join(dir, 'assets')); const path = join(dir, 'assets', 'fake.js');
  for (const secret of ['sb_secret_Abcd0123_-Abcd0', 'sb_secret_Abcd0123_-Abcd01', jwt('service_role'), jwt('service_role').replace('FAKE_SIGNATURE', ''), 'SUPABASE_SERVICE_ROLE_KEY']) {
   // The first prefix candidate has only 15 suffix characters and must pass.
   await writeFile(path, `const key = "${secret}";`);
   if (secret === 'sb_secret_Abcd0123_-Abcd0') { await expect(scanBundle(dir)).resolves.toBeUndefined(); continue; }
   await expect(scanBundle(dir)).rejects.toThrow('Forbidden credential marker');
   const result = spawnSync(process.execPath, ['scripts/scan-bundle.mjs', dir], { encoding: 'utf8' });
   expect(result.status).toBe(1);
   expect(result.stderr).not.toContain(secret);
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it('allows the SDK prefix validator, bare role text, public JWTs and malformed token-like text', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'dashboard-scan-'));
 try {
  await writeFile(join(dir, 'sdk.js'), `const isKey = key => key.startsWith("sb_publishable_") || key.startsWith("sb_secret_");\nconst role = "service_role";\nconst anon = "${jwt('anon')}";\nconst authenticated = "${jwt('authenticated')}";\nconst malformed = "eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.signature";`);
  await expect(scanBundle(dir)).resolves.toBeUndefined();
  expect(spawnSync(process.execPath, ['scripts/scan-bundle.mjs', dir]).status).toBe(0);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
