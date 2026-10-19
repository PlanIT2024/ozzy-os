import fs from 'node:fs';
import { defineConfig } from 'vite';
export default defineConfig({
 plugins: [{ name:'bit-reference-dev', configureServer(server) { server.middlewares.use('/bit-reference.html', (_req,res) => { res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(new URL('../../bit/persona/reference/bit-orb-reference.html',import.meta.url))); }); } }],
 esbuild: { jsx: 'automatic' },
 server: { host: '127.0.0.1' },
 preview: { host: '127.0.0.1' },
});
