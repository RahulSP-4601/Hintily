export interface DodoProduct {
  productId: string;
  sessions: number;
  unlimited: boolean;
  interval?: 'month' | 'quarter' | 'year' | 'lifetime';
  amountMinor: number;
  checkoutUrl?: string;
}

const PRODUCT_SPECS: Record<string, Omit<DodoProduct, 'productId' | 'checkoutUrl'>> = {
  session_1: { sessions: 1, unlimited: false, amountMinor: 49_900 },
  session_3: { sessions: 3, unlimited: false, amountMinor: 109_900 },
  session_7: { sessions: 7, unlimited: false, amountMinor: 189_900 },
  session_12: { sessions: 12, unlimited: false, amountMinor: 279_900 },
  unlimited_monthly: { sessions: 0, unlimited: true, interval: 'month', amountMinor: 339_900 },
  unlimited_quarterly: { sessions: 0, unlimited: true, interval: 'quarter', amountMinor: 749_700 },
  unlimited_yearly: { sessions: 0, unlimited: true, interval: 'year', amountMinor: 2_518_800 },
  unlimited_lifetime: { sessions: 0, unlimited: true, interval: 'lifetime', amountMinor: 3_500_000 },
};

const legacyPrefix = (code: string) => code
  .replace(/^session_/, 'SESSION_PACK_')
  .replace(/^unlimited_/, 'UNLIMITED_')
  .toUpperCase();

export const productMap = (): Record<string, DodoProduct> => {
  const raw = Deno.env.get('DODO_PRODUCT_MAP')
    || Deno.env.get('HINTILY_DODO_PRODUCTS_JSON')
    || Deno.env.get('HINTLY_DODO_PRODUCTS_JSON');
  let parsed: Record<string, unknown> = {};
  if (raw) {
    const candidate = JSON.parse(raw);
    if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') {
      throw new Error('dodo_product_map_invalid');
    }
    parsed = candidate as Record<string, unknown>;
  }
  const output: Record<string, DodoProduct> = {};
  for (const [code, spec] of Object.entries(PRODUCT_SPECS)) {
    const configured = parsed[code];
    const item = configured && typeof configured === 'object'
      ? configured as Record<string, unknown>
      : {};
    const prefix = legacyPrefix(code);
    const productId = String(
      item.productId
      || Deno.env.get(`HINTILY_${prefix}_DODO_PRODUCT_ID`)
      || Deno.env.get(`HINTLY_${prefix}_DODO_PRODUCT_ID`)
      || '',
    ).trim();
    const checkoutUrl = String(
      item.checkoutUrl
      || Deno.env.get(`HINTILY_${prefix}_CHECKOUT_URL`)
      || Deno.env.get(`HINTLY_${prefix}_CHECKOUT_URL`)
      || '',
    ).trim();
    if (!productId) continue;
    if (checkoutUrl && !checkoutUrl.startsWith('https://')) {
      throw new Error('dodo_checkout_url_invalid');
    }
    output[code] = {
      productId,
      ...spec,
      ...(checkoutUrl ? { checkoutUrl } : {}),
    };
  }
  if (Object.keys(output).length === 0) throw new Error('dodo_product_map_missing');
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
