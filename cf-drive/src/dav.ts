import { checkPassword, type Env, loadSettings } from './config.js';
import { Drive, DriveError, type Entry, fromStorageError, type MountHandle } from './drive.js';
import { parseRange, xmlEscape } from './util.js';

export const DAV_ROOT = '/dav';

async function authenticate(req: Request, env: Env): Promise<Drive | null> {
  const h = req.headers.get('authorization');
  if (!h?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  const username = decoded.slice(0, i);
  const password = decoded.slice(i + 1);
  const settings = await loadSettings(env);
  const user = settings.users.find((u) => u.username === username && u.enabled);
  if (!user || !(await checkPassword(user, password))) return null;
  return new Drive(env, settings, user);
}

/** `/dav/<mount>/<a/b/c>` → `{ mount, rel }`. Throws on `..` segments. */
function splitPath(pathname: string): { mount: string; rel: string } {
  const rest = pathname.slice(DAV_ROOT.length);
  const segs = rest
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  if (segs.some((s) => s === '.' || s === '..')) {
    throw new DriveError(400, 'InvalidArgument', 'invalid path');
  }
  return { mount: segs[0] ?? '', rel: segs.slice(1).join('/') };
}

function href(mount: string, rel: string, dir: boolean): string {
  const parts = [mount, ...(rel ? rel.split('/') : [])].filter(Boolean).map(encodeURIComponent);
  const p = `${DAV_ROOT}/${parts.join('/')}`;
  return dir && !p.endsWith('/') ? `${p}/` : p;
}

function propResponse(
  hrefValue: string,
  e: { name: string; isDir: boolean; size: number; lastModified: Date; etag: string; contentType: string },
  extra = ''
): string {
  const props = [
    `<d:displayname>${xmlEscape(e.name)}</d:displayname>`,
    `<d:getlastmodified>${e.lastModified.toUTCString()}</d:getlastmodified>`,
    `<d:creationdate>${e.lastModified.toISOString()}</d:creationdate>`,
    e.isDir
      ? '<d:resourcetype><d:collection/></d:resourcetype>'
      : `<d:resourcetype/><d:getcontentlength>${e.size}</d:getcontentlength><d:getcontenttype>${xmlEscape(e.contentType)}</d:getcontenttype>${e.etag ? `<d:getetag>"${xmlEscape(e.etag)}"</d:getetag>` : ''}`,
    extra,
  ].join('');
  return `<d:response><d:href>${xmlEscape(hrefValue)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`, {
    status: 207,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

const dirEntry = (name: string): Entry => ({
  name, path: '', isDir: true, size: 0, lastModified: new Date(), etag: '', contentType: '',
});

async function quotaProps(drive: Drive): Promise<string> {
  const used = await drive.usage();
  const q = drive.user.quotaBytes;
  return `<d:quota-used-bytes>${used}</d:quota-used-bytes>${q > 0 ? `<d:quota-available-bytes>${Math.max(0, q - used)}</d:quota-available-bytes>` : ''}`;
}

async function propfind(req: Request, drive: Drive, mountName: string, rel: string): Promise<Response> {
  const depth = req.headers.get('depth') ?? '1';
  if (!mountName) {
    let out = propResponse(`${DAV_ROOT}/`, dirEntry(''), await quotaProps(drive));
    if (depth !== '0') {
      for (const m of drive.mounts()) out += propResponse(href(m.name, '', true), dirEntry(m.name));
    }
    return multistatus(out);
  }
  const h = await drive.open(mountName);
  h.require('read');
  const file = await h.stat(rel);
  if (file) {
    return multistatus(
      propResponse(href(mountName, rel, false), {
        name: rel.slice(rel.lastIndexOf('/') + 1), isDir: false, size: file.size,
        lastModified: file.lastModified, etag: file.etag, contentType: file.contentType,
      })
    );
  }
  const children = depth === '0' && rel ? null : await h.listDir(rel);
  if (rel && !(children ? children.length > 0 || (await h.isDir(rel)) : await h.isDir(rel))) {
    return new Response('Not Found', { status: 404 });
  }
  let out = propResponse(
    href(mountName, rel, true),
    dirEntry(rel ? rel.slice(rel.lastIndexOf('/') + 1) : mountName),
    rel ? '' : await quotaProps(drive)
  );
  if (depth !== '0' && children) {
    for (const c of children) out += propResponse(href(mountName, c.path, c.isDir), c);
  }
  return multistatus(out);
}

function htmlIndex(title: string, base: string, entries: { name: string; isDir: boolean; size: number; lastModified: Date }[]): Response {
  const rows = entries
    .map((e) => {
      const name = e.isDir ? `${e.name}/` : e.name;
      const link = base + encodeURIComponent(e.name) + (e.isDir ? '/' : '');
      return `<tr><td><a href="${xmlEscape(link)}">${xmlEscape(name)}</a></td><td>${e.isDir ? '' : e.size.toLocaleString()}</td><td>${e.isDir ? '' : e.lastModified.toISOString().slice(0, 16).replace('T', ' ')}</td></tr>`;
    })
    .join('');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${xmlEscape(title)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px auto;max-width:820px;padding:0 16px}td{padding:4px 12px 4px 0}a{text-decoration:none}</style>
<h3>${xmlEscape(title)}</h3><table><tr><td><a href="../">../</a></td></tr>${rows}</table>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function getFile(req: Request, h: MountHandle, rel: string, headOnly: boolean): Promise<Response> {
  h.require('read');
  const meta = await h.stat(rel);
  if (!meta) return new Response('Not Found', { status: 404 });
  const headers = new Headers({
    'content-type': meta.contentType,
    'last-modified': meta.lastModified.toUTCString(),
    'accept-ranges': 'bytes',
    ...(meta.etag ? { etag: `"${meta.etag}"` } : {}),
  });
  if (meta.etag && req.headers.get('if-none-match') === `"${meta.etag}"`) {
    return new Response(null, { status: 304, headers });
  }
  const range = parseRange(req.headers.get('range'), meta.size);
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${meta.size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('content-length', String(range ? range.length : meta.size));
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
  const status = range ? 206 : 200;
  if (headOnly) return new Response(null, { status, headers });
  return new Response(await h.read(rel, meta, range ?? undefined), { status, headers });
}

function destination(req: Request): { mount: string; rel: string } {
  const d = req.headers.get('destination');
  if (!d) throw new DriveError(400, 'InvalidArgument', 'missing Destination header');
  const path = new URL(d, req.url).pathname;
  if (!path.startsWith(`${DAV_ROOT}/`)) throw new DriveError(502, 'InvalidArgument', 'bad destination');
  return splitPath(path);
}

async function copyOrMove(req: Request, drive: Drive, src: MountHandle, rel: string, move: boolean): Promise<Response> {
  if (!rel) throw new DriveError(403, 'AccessDenied', 'cannot copy a whole drive');
  const to = destination(req);
  if (!to.rel) throw new DriveError(403, 'AccessDenied', 'invalid destination');
  const dest = to.mount === src.mount.name ? src : await drive.open(to.mount);
  const overwrite = (req.headers.get('overwrite') ?? 'T').toUpperCase() !== 'F';
  const file = await src.stat(rel);
  const destFile = await dest.stat(to.rel);
  const destDir = !destFile && (await dest.isDir(to.rel));
  const existed = !!destFile || destDir;
  if (existed && !overwrite) return new Response('Precondition Failed', { status: 412 });
  if (file) {
    if (destDir) await dest.removeTree(to.rel);
    await src.transfer(rel, dest, to.rel, move);
  } else if (await src.isDir(rel)) {
    if (`${to.mount}/${to.rel}/`.startsWith(`${src.mount.name}/${rel}/`)) {
      throw new DriveError(403, 'AccessDenied', 'cannot copy a folder into itself');
    }
    if (destFile) await dest.remove(to.rel);
    if (destDir) await dest.removeTree(to.rel);
    await src.transferTree(rel, dest, to.rel, move);
    await dest.mkdir(to.rel);
  } else {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(null, { status: existed ? 204 : 201 });
}

const LOCK_RESPONSE = (token: string, path: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken><d:lockroot><d:href>${xmlEscape(path)}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;

export async function handleDav(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        dav: '1, 2',
        allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
        'ms-author-via': 'DAV',
      },
    });
  }
  const drive = await authenticate(req, env);
  if (!drive) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="cf-drive", charset="UTF-8"' },
    });
  }

  try {
    const { mount, rel } = splitPath(url.pathname);
    const method = req.method;

    if (method === 'PROPFIND') return await propfind(req, drive, mount, rel);
    if (method === 'PROPPATCH') {
      return multistatus(`<d:response><d:href>${xmlEscape(url.pathname)}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    }
    if (method === 'LOCK') {
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      return new Response(LOCK_RESPONSE(token, url.pathname), {
        headers: { 'content-type': 'application/xml; charset=utf-8', 'lock-token': `<${token}>` },
      });
    }
    if (method === 'UNLOCK') return new Response(null, { status: 204 });

    if (!mount) {
      if (method === 'GET' || method === 'HEAD') {
        return htmlIndex(`${drive.user.username}'s drive`, `${DAV_ROOT}/`, drive.mounts().map((m) => ({ ...dirEntry(m.name), name: m.name })));
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    const h = await drive.open(mount);

    switch (method) {
      case 'GET':
      case 'HEAD': {
        if (rel && (await h.stat(rel))) return await getFile(req, h, rel, method === 'HEAD');
        h.require('read');
        if (rel && !(await h.isDir(rel))) return new Response('Not Found', { status: 404 });
        if (!url.pathname.endsWith('/')) return Response.redirect(`${url.origin}${url.pathname}/`, 301);
        return htmlIndex(`/${mount}/${rel}`, url.pathname, await h.listDir(rel));
      }
      case 'PUT': {
        if (!rel) return new Response('Conflict', { status: 409 });
        const len = req.headers.get('content-length');
        const existed = !!(await h.stat(rel));
        const meta = await h.write(rel, req.body, len !== null ? Number(len) : undefined, req.headers.get('content-type') ?? undefined);
        return new Response(null, { status: existed ? 204 : 201, headers: meta.etag ? { etag: `"${meta.etag}"` } : {} });
      }
      case 'DELETE': {
        if (!rel) return new Response('Forbidden', { status: 403 });
        if (await h.remove(rel)) return new Response(null, { status: 204 });
        if (await h.isDir(rel)) {
          await h.removeTree(rel);
          return new Response(null, { status: 204 });
        }
        return new Response('Not Found', { status: 404 });
      }
      case 'MKCOL': {
        if (!rel) return new Response('Method Not Allowed', { status: 405 });
        if ((await h.stat(rel)) || (await h.isDir(rel))) return new Response('Method Not Allowed', { status: 405 });
        await h.mkdir(rel);
        return new Response(null, { status: 201 });
      }
      case 'COPY':
      case 'MOVE':
        return await copyOrMove(req, drive, h, rel, method === 'MOVE');
      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  } catch (err) {
    const e = err instanceof DriveError ? err : fromStorageError(err);
    if (e) return new Response(e.message, { status: e.status });
    console.error(err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
