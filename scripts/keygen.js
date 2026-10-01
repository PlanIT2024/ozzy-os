import path from 'node:path';
import { ROOT } from '../src/shared.js';
import { loadKey, publicHex } from '../src/transport/crypto.js';
const args = process.argv.slice(2); const role = args[args.indexOf('--role') + 1] || 'node';
if (!['brain', 'node'].includes(role)) throw new Error('Use --role brain or --role node');
const file = process.env.BIT_KEY_FILE || path.join(ROOT, 'data/keys', `${role}.json`);
console.log(publicHex(loadKey(file, true)));
