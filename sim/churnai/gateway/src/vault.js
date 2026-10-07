// AES-256-GCM envelope for provider credentials. The ciphertext is bound to the
// tenant and connection_ref (AAD), so a row copied to another tenant won't decrypt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function loadKey(b64) {
  const key = Buffer.from(b64 || '', 'base64');
  if (key.length !== 32) throw new Error('CHURNAI_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

export function encrypt(key, tenantId, ref, obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${tenantId}|${ref}`));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(key, tenantId, ref, blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('unsupported ciphertext version');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(`${tenantId}|${ref}`));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

export const hashApiKey = (k) => createHash('sha256').update(k).digest('hex');
export const newApiKey = () => 'chk_' + randomBytes(24).toString('base64url');
export const newRef = (tenantId, source) => `${tenantId}.${source}.${randomBytes(6).toString('hex')}`;
