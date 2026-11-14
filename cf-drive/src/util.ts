const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PBKDF2_ITERATIONS = 100_000; // Workers' maximum.

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

export function randomString(length: number, alphabet: string): string {
  const out: string[] = [];
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const b of bytes) out.push(alphabet[b % alphabet.length]!);
  return out.join('');
}

export const ALNUM_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  );
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** RFC 3986 encoding as S3 SigV4 expects it. */
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const byte of enc.encode(s)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Parses an HTTP `Range` header against a known size. Returns null when absent or unsatisfiable. */
export function parseRange(
  header: string | null,
  size: number
): { offset: number; length: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

export function joinKey(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
}
