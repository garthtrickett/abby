import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const prefix = process.env.ABBY_TEST_VERIFIER_PREFIX;
if (prefix !== '-' && prefix !== '_') throw Error('Synthetic verifier prefix required');
const randomBytes = crypto.randomBytes;
crypto.randomBytes = function(size, ...args) {
  const bytes = randomBytes.call(this, size, ...args);
  if (size === 32 && Buffer.isBuffer(bytes)) bytes[0] = (bytes[0] & 3) | (prefix === '-' ? 248 : 252);
  return bytes;
};
syncBuiltinESMExports();
