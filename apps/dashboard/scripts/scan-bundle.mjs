import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function scanBundle(directory) {
 const forbidden = ['sb_secret_', 'service_role', 'SUPABASE_SERVICE_ROLE_KEY'];
 async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
   const path = join(dir, entry.name);
   if (entry.isDirectory()) await walk(path);
   else if (entry.isFile()) { const content = await readFile(path, 'utf8'); if (forbidden.some(marker => content.includes(marker))) throw new Error(`Forbidden credential marker in ${path}`); }
  }
 }
 await walk(directory);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 scanBundle(resolve(process.argv[2] || 'dist')).then(() => console.log('Bundle credential scan: PASS')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
