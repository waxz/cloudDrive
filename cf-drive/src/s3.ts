import { StorageError, type StorageItemMeta } from '@storagesdk/core';
import { type Env, loadSettings } from './config.js';
import { DIR_MARKER, Drive, DriveError, fromStorageError, isHidden, type MountHandle, UPLOADS_DIR } from './drive.js';
import { awsChunkedDecoder, EMPTY_SHA256, S3Error, type Signed, sha256Verifier, verify } from './sigv4.js';
import { parseRange, uriEncode, xmlEscape, xmlUnescape } from './util.js';

const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function xml(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { 'content-type': 'application/xml', ...headers },
  });
}

function errorResponse(req: Request, status: number, code: string, message: string, resource: string): Response {
  if (req.method === 'HEAD') return new Response(null, { status, headers: { 'x-amz-error-code': code } });
  return xml(
    `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message><Resource>${xmlEscape(resource)}</Resource><RequestId>${crypto.randomUUID()}</RequestId></Error>`,
    status
  );
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');

/** The request body (decoded from aws-chunked if needed, hash-checked if signed) and its size. */
function payload(req: Request, sig: Signed): { body: ReadableStream<Uint8Array> | null; size: number | undefined } {
  const h = sig.payloadHash;
  const len = req.headers.get('content-length');
  if (h.startsWith('STREAMING-')) {
    const decoded = req.headers.get('x-amz-decoded-content-length');
    return {
      body: req.body ? req.body.pipeThrough(awsChunkedDecoder(sig)) : null,
      size: decoded !== null ? Number(decoded) : undefined,
    };
  }
  const size = len !== null ? Number(len) : undefined;
  if (h === 'UNSIGNED-PAYLOAD' || !req.body) return { body: req.body, size };
  if (h === EMPTY_SHA256 && size === 0) return { body: null, size: 0 };
  return { body: req.body.pipeThrough(sha256Verifier(h)), size };
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : '';
}

function userMetadata(req: Request): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of req.headers) if (k.startsWith('x-amz-meta-')) out[k.slice(11)] = v;
  return Object.keys(out).length ? out : undefined;
}

function objectHeaders(meta: StorageItemMeta): Headers {
  const h = new Headers({
    'content-type': meta.contentType,
    'last-modified': meta.lastModified.toUTCString(),
    'accept-ranges': 'bytes',
    etag: `"${meta.etag}"`,
  });
  for (const [k, v] of Object.entries(meta.metadata ?? {})) h.set(`x-amz-meta-${k}`, v);
  return h;
}

// ---------- listing ----------

interface ListParams {
  prefix: string;
  delimiter: string;
  maxKeys: number;
  after: string;
  cursor?: string;
}

interface ListOut {
  contents: StorageItemMeta[];
  prefixes: string[];
  truncated: boolean;
  next?: { cursor?: string; after: string };
  last?: string;
}

/**
 * S3-style listing over storagesdk's flat `list`. Continuation tokens carry
 * the backend cursor plus the last key/prefix returned, so a page that stops
 * partway through a backend page resumes from that page.
 */
async function listObjects(h: MountHandle, p: ListParams): Promise<ListOut> {
  const out: ListOut = { contents: [], prefixes: [], truncated: false };
  if (p.maxKeys <= 0) return out;
  // Real folders and marker-only folders both show up as `dir/` keys.
  const dirMarkerSuffix = `/${DIR_MARKER}`;
  // List from the deepest complete folder in the prefix so marker objects for
  // `prefix` itself are seen.
  const scan = p.prefix.slice(0, p.prefix.lastIndexOf('/') + 1);
  let cursor = p.cursor;
  let last = p.after;
  for (let pages = 0; pages < 20; pages++) {
    const pageCursor = cursor;
    const page = await h.page(scan, pageCursor);
    for (const item of page.items) {
      let key = item.path;
      if (key.endsWith(dirMarkerSuffix) || key === DIR_MARKER) key = key.slice(0, -DIR_MARKER.length);
      else if (isHidden(key)) continue;
      if (!key || !key.startsWith(p.prefix)) continue;
      let name = key;
      let isPrefix = false;
      if (p.delimiter) {
        const i = key.indexOf(p.delimiter, p.prefix.length);
        if (i >= 0) {
          name = key.slice(0, i + p.delimiter.length);
          isPrefix = true;
        }
      }
      if (last && name <= last) continue;
      if (out.contents.length + out.prefixes.length >= p.maxKeys) {
        out.truncated = true;
        out.next = { ...(pageCursor ? { cursor: pageCursor } : {}), after: last };
        out.last = last;
        return out;
      }
      if (isPrefix) out.prefixes.push(name);
      else out.contents.push({ ...item, path: key, size: key.endsWith('/') ? 0 : item.size });
      last = name;
    }
    if (!page.cursor) return { ...out, last };
    cursor = page.cursor;
  }
  return { ...out, truncated: true, next: { cursor: cursor!, after: last }, last };
}

const encodeToken = (t: { cursor?: string; after: string }) => btoa(JSON.stringify(t));
function decodeToken(s: string): { cursor?: string; after: string } {
  try {
    return JSON.parse(atob(s));
  } catch {
    throw new S3Error(400, 'InvalidArgument', 'The continuation token provided is incorrect');
  }
}

async function handleList(bucket: string, h: MountHandle, q: URLSearchParams): Promise<Response> {
  h.require('read');
  const v2 = q.get('list-type') === '2';
  const urlEnc = q.get('encoding-type') === 'url';
  const enc = (s: string) => xmlEscape(urlEnc ? uriEncode(s, true) : s);
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter') ?? '';
  const maxKeys = Math.min(1000, Number(q.get('max-keys') ?? '1000'));
  const token = v2 ? q.get('continuation-token') : null;
  const t = token ? decodeToken(token) : undefined;
  const after = t?.after ?? (v2 ? q.get('start-after') : q.get('marker')) ?? '';
  const res = await listObjects(h, { prefix, delimiter, maxKeys, after, ...(t?.cursor ? { cursor: t.cursor } : {}) });

  const parts = [
    `<ListBucketResult xmlns="${NS}">`,
    `<Name>${xmlEscape(bucket)}</Name><Prefix>${enc(prefix)}</Prefix><MaxKeys>${maxKeys}</MaxKeys>`,
    delimiter ? `<Delimiter>${enc(delimiter)}</Delimiter>` : '',
    urlEnc ? '<EncodingType>url</EncodingType>' : '',
    `<IsTruncated>${res.truncated}</IsTruncated>`,
  ];
  if (v2) {
    parts.push(`<KeyCount>${res.contents.length + res.prefixes.length}</KeyCount>`);
    if (token) parts.push(`<ContinuationToken>${xmlEscape(token)}</ContinuationToken>`);
    if (q.get('start-after')) parts.push(`<StartAfter>${enc(q.get('start-after')!)}</StartAfter>`);
    if (res.truncated && res.next) parts.push(`<NextContinuationToken>${xmlEscape(encodeToken(res.next))}</NextContinuationToken>`);
  } else {
    parts.push(`<Marker>${enc(q.get('marker') ?? '')}</Marker>`);
    if (res.truncated && res.last) parts.push(`<NextMarker>${enc(res.last)}</NextMarker>`);
  }
  for (const c of res.contents) {
    parts.push(
      `<Contents><Key>${enc(c.path)}</Key><LastModified>${iso(c.lastModified)}</LastModified><ETag>"${xmlEscape(c.etag)}"</ETag><Size>${c.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
    );
  }
  for (const p of res.prefixes) parts.push(`<CommonPrefixes><Prefix>${enc(p)}</Prefix></CommonPrefixes>`);
  parts.push('</ListBucketResult>');
  return xml(parts.join(''));
}

// ---------- multipart ----------

const pad = (n: number) => String(n).padStart(5, '0');

async function createMultipart(req: Request, bucket: string, key: string, h: MountHandle): Promise<Response> {
  h.require('write');
  const contentType = req.headers.get('content-type') ?? undefined;
  let uploadId: string;
  if (h.r2) {
    const mpu = await h.r2.createMultipartUpload(h.key(key), {
      httpMetadata: { contentType: contentType ?? 'application/octet-stream' },
      ...(userMetadata(req) ? { customMetadata: userMetadata(req)! } : {}),
    });
    uploadId = mpu.uploadId;
  } else {
    uploadId = crypto.randomUUID();
    await h.storage.upload(
      h.key(`${UPLOADS_DIR}/${uploadId}/meta.json`),
      JSON.stringify({ key, contentType, metadata: userMetadata(req) }),
      { contentType: 'application/json' }
    );
  }
  return xml(
    `<InitiateMultipartUploadResult xmlns="${NS}"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId></InitiateMultipartUploadResult>`
  );
}

async function uploadPart(req: Request, sig: Signed, key: string, h: MountHandle, uploadId: string, partNumber: number): Promise<Response> {
  h.require('write');
  if (!(partNumber >= 1 && partNumber <= 10000)) throw new S3Error(400, 'InvalidArgument', 'bad partNumber');
  if (req.headers.has('x-amz-copy-source')) throw new S3Error(501, 'NotImplemented', 'UploadPartCopy is not supported');
  const { body, size } = payload(req, sig);
  if (size === undefined) throw new S3Error(411, 'MissingContentLength', 'Content-Length required');
  h.drive.checkLimits(size);
  let etag: string;
  if (h.r2) {
    const mpu = h.r2.resumeMultipartUpload(h.key(key), uploadId);
    const part = await mpu.uploadPart(partNumber, (body ?? new Response('').body!).pipeThrough(new FixedLengthStream(size)));
    etag = part.etag;
  } else {
    if (!(await exists(h, `${UPLOADS_DIR}/${uploadId}/meta.json`))) {
      throw new S3Error(404, 'NoSuchUpload', 'The specified upload does not exist');
    }
    const data = size <= 5 * 1024 * 1024 ? new Uint8Array(await new Response(body).arrayBuffer()) : body!;
    const meta = await h.storage.upload(h.key(`${UPLOADS_DIR}/${uploadId}/${pad(partNumber)}`), data);
    etag = meta.etag || crypto.randomUUID().replace(/-/g, '');
  }
  return new Response(null, { headers: { etag: `"${etag}"` } });
}

async function exists(h: MountHandle, rel: string): Promise<boolean> {
  try {
    await h.storage.head(h.key(rel));
    return true;
  } catch (err) {
    if (err instanceof StorageError && err.code === 'NotFound') return false;
    throw err;
  }
}

async function completeMultipart(req: Request, sig: Signed, bucket: string, key: string, h: MountHandle, uploadId: string): Promise<Response> {
  h.require('write');
  const text = await readAll(payload(req, sig).body);
  const parts = [...text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
    partNumber: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1]!)?.[1]),
    etag: xmlUnescape(/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]!)?.[1] ?? '').replace(/"/g, ''),
  }));
  if (parts.length === 0) throw new S3Error(400, 'MalformedXML', 'no parts');
  const old = await h.stat(key);
  const usage = await h.drive.usage();
  let meta: StorageItemMeta;

  if (h.r2) {
    const mpu = h.r2.resumeMultipartUpload(h.key(key), uploadId);
    const o = await mpu.complete(parts);
    meta = { path: key, size: o.size, contentType: o.httpMetadata?.contentType ?? '', etag: o.etag, lastModified: o.uploaded };
    try {
      h.drive.checkLimits(o.size, old?.size ?? 0, usage);
    } catch (err) {
      await h.r2.delete(h.key(key));
      throw err;
    }
  } else {
    const dir = `${UPLOADS_DIR}/${uploadId}`;
    const info = JSON.parse(await h.storage.download(h.key(`${dir}/meta.json`), { as: 'text' }).catch(() => {
      throw new S3Error(404, 'NoSuchUpload', 'The specified upload does not exist');
    })) as { key: string; contentType?: string; metadata?: Record<string, string> };
    const metas: StorageItemMeta[] = [];
    for (const p of parts.sort((a, b) => a.partNumber - b.partNumber)) {
      const m = await h.storage.head(h.key(`${dir}/${pad(p.partNumber)}`)).catch(() => null);
      if (!m) throw new S3Error(400, 'InvalidPart', `part ${p.partNumber} not found`);
      metas.push({ ...m, path: `${dir}/${pad(p.partNumber)}` });
    }
    const total = metas.reduce((s, m) => s + m.size, 0);
    h.drive.checkLimits(total, old?.size ?? 0, usage);
    let i = 0;
    let current: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const raw = h.storage;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (!current) {
            if (i >= metas.length) return controller.close();
            const m = metas[i++]!;
            const item = await raw.download(h.key(m.path), { as: 'stream' });
            current = item.getReader();
          }
          const r = await current.read();
          if (r.done) {
            current = undefined;
            continue;
          }
          controller.enqueue(r.value);
          return;
        }
      },
    });
    const body = total <= 5 * 1024 * 1024 ? new Uint8Array(await new Response(stream).arrayBuffer()) : stream;
    meta = await h.storage.upload(h.key(key), body, {
      contentType: info.contentType ?? 'application/octet-stream',
      ...(info.metadata ? { metadata: info.metadata } : {}),
      ...(body instanceof ReadableStream ? { multipart: true, partSize: 16 * 1024 * 1024 } : {}),
    });
    for (const m of metas) await h.storage.delete(h.key(m.path));
    await h.storage.delete(h.key(`${dir}/meta.json`));
  }
  await h.drive.addUsage(meta.size - (old?.size ?? 0));
  return xml(
    `<CompleteMultipartUploadResult xmlns="${NS}"><Location>${xmlEscape(new URL(req.url).origin)}/${xmlEscape(bucket)}/${xmlEscape(key)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>"${xmlEscape(meta.etag)}"</ETag></CompleteMultipartUploadResult>`
  );
}

async function abortMultipart(key: string, h: MountHandle, uploadId: string): Promise<Response> {
  h.require('write');
  if (h.r2) {
    await h.r2.resumeMultipartUpload(h.key(key), uploadId).abort();
  } else {
    for await (const item of h.walk(`${UPLOADS_DIR}/${uploadId}/`)) await h.storage.delete(h.key(item.path));
  }
  return new Response(null, { status: 204 });
}

// ---------- objects ----------

async function getObject(req: Request, url: URL, key: string, h: MountHandle): Promise<Response> {
  h.require('read');
  const meta = key.endsWith('/') ? null : await h.stat(key);
  if (!meta) {
    if (key.endsWith('/') && (await h.isDir(key.slice(0, -1)))) {
      return new Response(req.method === 'HEAD' ? null : '', {
        headers: { 'content-type': 'application/x-directory', 'content-length': '0', etag: `"${EMPTY_SHA256.slice(0, 32)}"`, 'last-modified': new Date(0).toUTCString() },
      });
    }
    throw new DriveError(404, 'NoSuchKey', 'The specified key does not exist.');
  }
  const headers = objectHeaders(meta);
  const q = url.searchParams;
  for (const [param, header] of [
    ['response-content-type', 'content-type'],
    ['response-content-disposition', 'content-disposition'],
    ['response-cache-control', 'cache-control'],
    ['response-content-language', 'content-language'],
    ['response-expires', 'expires'],
    ['response-content-encoding', 'content-encoding'],
  ] as const) {
    const v = q.get(param);
    if (v) headers.set(header, v);
  }
  const inm = req.headers.get('if-none-match');
  if (inm && inm.replace(/"/g, '') === meta.etag) return new Response(null, { status: 304, headers });
  const im = req.headers.get('if-match');
  if (im && im.replace(/"/g, '') !== meta.etag) throw new S3Error(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold');
  const range = parseRange(req.headers.get('range'), meta.size);
  if (range === 'invalid') throw new S3Error(416, 'InvalidRange', 'The requested range is not satisfiable');
  headers.set('content-length', String(range ? range.length : meta.size));
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
  const status = range ? 206 : 200;
  if (req.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(await h.read(key, meta, range ?? undefined), { status, headers });
}

async function putObject(req: Request, sig: Signed, key: string, h: MountHandle): Promise<Response> {
  const { body, size } = payload(req, sig);
  if (key.endsWith('/')) {
    // Folder marker created by S3 clients ("New folder").
    await readAll(body);
    await h.mkdir(key.slice(0, -1));
    return new Response(null, { headers: { etag: `"${EMPTY_SHA256.slice(0, 32)}"` } });
  }
  const meta = await h.write(key, body, size, req.headers.get('content-type') ?? undefined, userMetadata(req));
  return new Response(null, { headers: { etag: `"${meta.etag}"` } });
}

async function copyObject(req: Request, drive: Drive, key: string, h: MountHandle): Promise<Response> {
  let src = decodeURIComponent(req.headers.get('x-amz-copy-source')!.split('?')[0]!);
  if (src.startsWith('/')) src = src.slice(1);
  const slash = src.indexOf('/');
  if (slash < 0) throw new S3Error(400, 'InvalidArgument', 'bad x-amz-copy-source');
  const srcBucket = src.slice(0, slash);
  const srcKey = src.slice(slash + 1);
  const sh = srcBucket === h.mount.name ? h : await drive.open(srcBucket);
  let meta: StorageItemMeta;
  if (sh === h && srcKey === key) {
    // Metadata-only "copy onto itself"; content is unchanged.
    h.require('write');
    const m = await h.stat(key);
    if (!m) throw new DriveError(404, 'NoSuchKey', 'The specified key does not exist.');
    meta = m;
  } else {
    meta = await sh.transfer(srcKey, h, key, false);
  }
  return xml(`<CopyObjectResult xmlns="${NS}"><LastModified>${iso(meta.lastModified)}</LastModified><ETag>"${xmlEscape(meta.etag)}"</ETag></CopyObjectResult>`);
}

async function deleteObject(key: string, h: MountHandle): Promise<void> {
  h.require('delete');
  if (key.endsWith('/')) {
    try {
      await h.storage.delete(h.key(`${key}${DIR_MARKER}`));
    } catch (err) {
      if (!(err instanceof StorageError && err.code === 'NotFound')) throw err;
    }
    return;
  }
  try {
    await h.remove(key);
  } catch (err) {
    if (!(err instanceof StorageError && err.code === 'NotFound')) throw err;
  }
}

async function deleteObjects(req: Request, sig: Signed, h: MountHandle): Promise<Response> {
  const text = await readAll(payload(req, sig).body);
  const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
  const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]!));
  const out: string[] = [];
  for (const k of keys) {
    try {
      await deleteObject(k, h);
      if (!quiet) out.push(`<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`);
    } catch (err) {
      const code = err instanceof DriveError || err instanceof S3Error ? err.code : 'InternalError';
      out.push(`<Error><Key>${xmlEscape(k)}</Key><Code>${code}</Code><Message>${xmlEscape(String((err as Error).message))}</Message></Error>`);
    }
  }
  return xml(`<DeleteResult xmlns="${NS}">${out.join('')}</DeleteResult>`);
}

// ---------- router ----------

export async function handleS3(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const resource = url.pathname;
  try {
    const settings = await loadSettings(env);
    const sig = await verify(req, url, settings);
    const drive = new Drive(env, settings, sig.user);
    const q = url.searchParams;
    const rest = url.pathname.slice(1);
    const slash = rest.indexOf('/');
    const bucket = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    const key = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1));
    if (key.split('/').some((s) => s === '..' || s === '.')) throw new S3Error(400, 'InvalidArgument', 'invalid key');
    const m = req.method;

    if (!bucket) {
      if (m !== 'GET') throw new S3Error(405, 'MethodNotAllowed', 'method not allowed');
      const buckets = drive
        .mounts()
        .map((b) => `<Bucket><Name>${xmlEscape(b.name)}</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>`)
        .join('');
      return xml(`<ListAllMyBucketsResult xmlns="${NS}"><Owner><ID>${xmlEscape(sig.user.username)}</ID><DisplayName>${xmlEscape(sig.user.username)}</DisplayName></Owner><Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`);
    }

    if (!key) {
      if (m === 'PUT') {
        if (drive.mounts().some((x) => x.name === bucket)) {
          throw new S3Error(409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
        }
        throw new S3Error(403, 'AccessDenied', 'buckets are managed in the admin panel');
      }
      const h = await drive.open(bucket);
      if (m === 'HEAD') return new Response(null, { headers: { 'x-amz-bucket-region': 'auto' } });
      if (m === 'POST' && q.has('delete')) return await deleteObjects(req, sig, h);
      if (m === 'DELETE') throw new S3Error(403, 'AccessDenied', 'buckets are managed in the admin panel');
      if (m === 'GET') {
        if (q.has('location')) return xml(`<LocationConstraint xmlns="${NS}">auto</LocationConstraint>`);
        if (q.has('versioning')) return xml(`<VersioningConfiguration xmlns="${NS}"/>`);
        if (q.has('uploads')) {
          return xml(`<ListMultipartUploadsResult xmlns="${NS}"><Bucket>${xmlEscape(bucket)}</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`);
        }
        for (const sub of ['acl', 'policy', 'cors', 'lifecycle', 'tagging', 'encryption', 'website', 'logging', 'notification', 'replication', 'object-lock', 'ownershipControls', 'publicAccessBlock', 'accelerate', 'requestPayment']) {
          if (q.has(sub)) throw new S3Error(501, 'NotImplemented', `${sub} is not supported`);
        }
        return await handleList(bucket, h, q);
      }
      throw new S3Error(405, 'MethodNotAllowed', 'method not allowed');
    }

    const h = await drive.open(bucket);
    const uploadId = q.get('uploadId');
    switch (m) {
      case 'GET':
      case 'HEAD':
        if (uploadId) throw new S3Error(501, 'NotImplemented', 'ListParts is not supported');
        return await getObject(req, url, key, h);
      case 'PUT':
        if (uploadId) return await uploadPart(req, sig, key, h, uploadId, Number(q.get('partNumber')));
        if (req.headers.has('x-amz-copy-source')) return await copyObject(req, drive, key, h);
        return await putObject(req, sig, key, h);
      case 'POST':
        if (q.has('uploads')) return await createMultipart(req, bucket, key, h);
        if (uploadId) return await completeMultipart(req, sig, bucket, key, h, uploadId);
        throw new S3Error(501, 'NotImplemented', 'not supported');
      case 'DELETE':
        if (uploadId) return await abortMultipart(key, h, uploadId);
        await deleteObject(key, h);
        return new Response(null, { status: 204 });
      default:
        throw new S3Error(405, 'MethodNotAllowed', 'method not allowed');
    }
  } catch (err) {
    if (err instanceof S3Error) return errorResponse(req, err.status, err.code, err.message, resource);
    if (!(err instanceof DriveError) && fromStorageError(err)) err = fromStorageError(err);
    if (err instanceof DriveError) {
      const map: Record<string, [number, string]> = {
        NotFound: [404, 'NoSuchKey'],
        NoSuchKey: [404, 'NoSuchKey'],
        NoSuchBucket: [404, 'NoSuchBucket'],
        AccessDenied: [403, 'AccessDenied'],
        EntityTooLarge: [400, 'EntityTooLarge'],
        QuotaExceeded: [403, 'QuotaExceeded'],
        InvalidArgument: [400, 'InvalidArgument'],
        NotImplemented: [501, 'NotImplemented'],
        Conflict: [409, 'OperationAborted'],
      };
      const [status, code] = map[err.code] ?? [err.status, err.code];
      return errorResponse(req, status, code, err.message, resource);
    }
    console.error(err);
    return errorResponse(req, 500, 'InternalError', 'We encountered an internal error. Please try again.', resource);
  }
}
