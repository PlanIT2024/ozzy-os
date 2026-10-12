import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function containsSecret(content) {
 if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(content) || content.includes('SUPABASE_SERVICE_ROLE_KEY')) return true;
 // JWTs use base64url segments. Decode only the payload; never log token contents.
 for (const match of content.matchAll(/\beyJ[A-Za-z0-9_-]*\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*/g)) {
  try {
   if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role') return true;
  } catch { /* Malformed token-like text is not a service-role JWT. */ }
 }
 return false;
}

export async function scanBundle(directory) {
 async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
   const path = join(dir, entry.name);
   if (entry.isDirectory()) await walk(path);
   else if (entry.isFile() && containsSecret(await readFile(path, 'utf8'))) {
    throw new Error(`Forbidden credential marker in ${path}`);
   }
  }
 }
 await walk(directory);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 scanBundle(resolve(process.argv[2] || 'dist')).then(() => console.log('Bundle credential scan: PASS')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
