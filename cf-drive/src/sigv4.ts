import type { Settings, User } from './config.js';
import { hmac, safeEqual, sha256Hex, toHex, uriEncode } from './util.js';

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface Signed {
  user: User;
  amzDate: string;
  scope: string;
  signingKey: Uint8Array;
  signature: string;
  /** `x-amz-content-sha256` value (or `UNSIGNED-PAYLOAD` for presigned URLs). */
  payloadHash: string;
}

export function isSigV4(req: Request, url: URL): boolean {
  return (
    (req.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256') ||
    url.searchParams.has('X-Amz-Algorithm')
  );
}

function parseQuery(raw: string): [string, string][] {
  if (!raw) return [];
  return raw
    .split('&')
    .filter((p) => p.length > 0)
    .map((p) => {
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      const v = i < 0 ? '' : p.slice(i + 1);
      return [decodeURIComponent(k), decodeURIComponent(v)];
    });
}

function canonicalUri(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => uriEncode(decodeURIComponent(s)))
    .join('/');
}

function canonicalQuery(pairs: [string, string][]): string {
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function amzToDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

export async function signingKey(secret: string, date: string, region: string, service: string) {
  const kDate = await hmac(`AWS4${secret}`, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Verifies an AWS Signature V4 request (Authorization header or presigned URL). */
export async function verify(req: Request, url: URL, settings: Settings): Promise<Signed> {
  const auth = req.headers.get('authorization');
  const rawQuery = url.search.slice(1);
  let query = parseQuery(rawQuery);
  let credential: string;
  let signedHeaders: string[];
  let signature: string;
  let amzDate: string;
  let payloadHash: string;

  if (auth) {
    const m = /^AWS4-HMAC-SHA256\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth.trim());
    if (!m) throw new S3Error(400, 'AuthorizationHeaderMalformed', 'malformed Authorization header');
    credential = m[1]!;
    signedHeaders = m[2]!.split(';');
    signature = m[3]!;
    amzDate = req.headers.get('x-amz-date') ?? '';
    payloadHash = req.headers.get('x-amz-content-sha256') ?? EMPTY_SHA256;
    if (!amzDate) {
      const d = req.headers.get('date');
      amzDate = d ? new Date(d).toISOString().replace(/[-:]|\.\d{3}/g, '') : '';
    }
    const t = amzToDate(amzDate);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 15 * 60_000) {
      throw new S3Error(403, 'RequestTimeTooSkewed', 'request time too skewed');
    }
  } else {
    const q = new Map(query);
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
      throw new S3Error(400, 'InvalidArgument', 'unsupported algorithm');
    }
    credential = q.get('X-Amz-Credential') ?? '';
    signedHeaders = (q.get('X-Amz-SignedHeaders') ?? 'host').split(';');
    signature = q.get('X-Amz-Signature') ?? '';
    amzDate = q.get('X-Amz-Date') ?? '';
    payloadHash = 'UNSIGNED-PAYLOAD';
    const t = amzToDate(amzDate);
    const expires = Number(q.get('X-Amz-Expires') ?? '0');
    if (!Number.isFinite(t) || Date.now() > t + expires * 1000 || t - Date.now() > 15 * 60_000) {
      throw new S3Error(403, 'AccessDenied', 'Request has expired');
    }
    query = query.filter(([k]) => k !== 'X-Amz-Signature');
  }

  const [accessKeyId, date, region, service, term] = credential.split('/');
  if (!accessKeyId || !date || !region || !service || term !== 'aws4_request') {
    throw new S3Error(400, 'AuthorizationHeaderMalformed', 'bad credential scope');
  }
  const user = settings.users.find((u) => u.accessKeyId === accessKeyId && u.enabled);
  if (!user) throw new S3Error(403, 'InvalidAccessKeyId', 'The access key ID you provided does not exist');

  const headerLines = signedHeaders
    .map((name) => {
      let v = name === 'host' ? (req.headers.get('host') ?? url.host) : (req.headers.get(name) ?? '');
      v = v.trim().replace(/\s+/g, ' ');
      return `${name}:${v}\n`;
    })
    .join('');

  const canonical = [
    req.method,
    canonicalUri(url.pathname),
    canonicalQuery(query),
    headerLines,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`;
  const key = await signingKey(user.secretAccessKey, date, region, service);
  const expected = toHex(await hmac(key, toSign));
  if (!safeEqual(expected, signature)) {
    throw new S3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided');
  }
  return { user, amzDate, scope, signingKey: key, signature, payloadHash };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Decodes an `aws-chunked` body. For signed variants every chunk signature is
 * checked against the seed signature chain; a bad chunk errors the stream.
 */
export function awsChunkedDecoder(sig: Signed): TransformStream<Uint8Array, Uint8Array> {
  const verifyChunks = sig.payloadHash.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD');
  let buf: Uint8Array = new Uint8Array();
  let prev = sig.signature;
  let done = false;
  const dec = new TextDecoder();

  async function drain(controller: TransformStreamDefaultController<Uint8Array>) {
    while (!done) {
      const nl = buf.findIndex((b, i) => b === 13 && buf[i + 1] === 10);
      if (nl < 0) return;
      const header = dec.decode(buf.subarray(0, nl));
      const [sizeHex, ...ext] = header.split(';');
      const size = parseInt(sizeHex!.trim(), 16);
      if (!Number.isFinite(size)) throw new S3Error(400, 'IncompleteBody', 'bad chunk header');
      const start = nl + 2;
      if (size > 0 && buf.length < start + size + 2) return;
      const data = buf.slice(start, start + size);
      if (verifyChunks) {
        const chunkSig = ext.map((e) => e.trim()).find((e) => e.startsWith('chunk-signature='))?.slice(16) ?? '';
        const toSign = `AWS4-HMAC-SHA256-PAYLOAD\n${sig.amzDate}\n${sig.scope}\n${prev}\n${EMPTY_SHA256}\n${await sha256Hex(data)}`;
        const expected = toHex(await hmac(sig.signingKey, toSign));
        if (!safeEqual(expected, chunkSig)) throw new S3Error(403, 'SignatureDoesNotMatch', 'chunk signature mismatch');
        prev = expected;
      }
      if (size === 0) {
        done = true; // Trailers (checksums) follow; ignored.
        return;
      }
      controller.enqueue(data);
      buf = buf.slice(start + size + 2);
    }
  }

  return new TransformStream({
    async transform(chunk, controller) {
      if (done) return;
      buf = concat(buf, chunk);
      await drain(controller);
    },
    async flush(controller) {
      await drain(controller);
      if (!done) throw new S3Error(400, 'IncompleteBody', 'truncated aws-chunked body');
    },
  });
}

/** Passes bytes through and errors at the end if their SHA-256 differs from `expected`. */
export function sha256Verifier(expected: string): TransformStream<Uint8Array, Uint8Array> {
  const digest = new crypto.DigestStream('SHA-256');
  const writer = digest.getWriter();
  return new TransformStream({
    async transform(chunk, controller) {
      await writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await writer.close();
      const got = toHex(await digest.digest);
      if (got !== expected) throw new S3Error(400, 'XAmzContentSHA256Mismatch', 'payload hash mismatch');
    },
  });
}
