export interface DodoProduct {
  productId: string;
  sessions: number;
  unlimited: boolean;
  interval?: 'month' | 'quarter' | 'year' | 'lifetime';
}

export const productMap = (): Record<string, DodoProduct> => {
  const raw = Deno.env.get('DODO_PRODUCT_MAP');
  if (!raw) throw new Error('dodo_product_map_missing');
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('dodo_product_map_invalid');
  const output: Record<string, DodoProduct> = {};
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9_-]{2,60}$/.test(code) || !value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const productId = String(item.productId || '');
    const sessions = Number(item.sessions || 0);
    const unlimited = item.unlimited === true;
    if (!productId || !Number.isInteger(sessions) || sessions < 0 || sessions > 100 ||
        (!unlimited && sessions === 0)) continue;
    output[code] = { productId, sessions, unlimited, interval: item.interval as DodoProduct['interval'] };
  }
  return output;
};

const bytes = (value: string) => new TextEncoder().encode(value);
const constantTimeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};
const decodeBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

export const verifyDodoSignature = async (
  rawBody: string, id: string, timestamp: string, signatures: string, secret: string,
) => {
  const epoch = Number(timestamp);
  if (!id || !Number.isFinite(epoch) || Math.abs(Date.now() / 1000 - epoch) > 300) return false;
  const secretBytes = decodeBase64(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(`${id}.${timestamp}.${rawBody}`)));
  return signatures.split(' ').some(candidate => {
    const encoded = candidate.startsWith('v1,') ? candidate.slice(3) : candidate;
    try { return constantTimeEqual(expected, decodeBase64(encoded)); } catch { return false; }
  });
};

export const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
