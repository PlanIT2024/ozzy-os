import { randomBytes, createHash } from 'node:crypto';
const token = randomBytes(32).toString('hex');
console.log(JSON.stringify({ token, sha256: createHash('sha256').update(token).digest('hex') }, null, 2));
