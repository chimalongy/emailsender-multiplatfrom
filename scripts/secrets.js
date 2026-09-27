import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('Admin password (visible; use a private terminal): '); rl.close();
if (password.length < 14) throw new Error('Use at least 14 characters');
const salt = randomBytes(16).toString('hex');
console.log(`ADMIN_PASSWORD_HASH=${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
for (const key of ['SESSION_SECRET', 'CREDENTIALS_KEY', 'INBOUND_SECRET']) console.log(`${key}=${randomBytes(32).toString('hex')}`);
