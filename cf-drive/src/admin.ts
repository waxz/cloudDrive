import { storageFor } from './backends.js';
import {
  type Backend,
  BACKEND_TYPES,
  type Env,
  getUsage,
  loadSettings,
  type Mount,
  newAccessKeys,
  saveSettings,
  setPassword,
  setUsage,
  type User,
} from './config.js';
import { Drive, isHidden } from './drive.js';
import { ADMIN_PAGE } from './ui.js';
import { hmac, safeEqual, sha256Hex, toHex } from './util.js';

const COOKIE = 'cfd_admin';
const SESSION_TTL = 12 * 3600;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MOUNT_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

async function sessionKey(env: Env): Promise<string> {
  return sha256Hex(`cf-drive-session\0${env.ADMIN_PASSWORD}`);
}

async function makeSession(env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return `${exp}.${toHex(await hmac(await sessionKey(env), String(exp)))}`;
}

async function validSession(req: Request, env: Env): Promise<boolean> {
  const cookie = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]+)`).exec(cookie);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return safeEqual(toHex(await hmac(await sessionKey(env), m[1]!)), m[2]!);
}

function maskBackend(b: Backend): Backend {
  const secret = new Set(BACKEND_TYPES[b.type]?.fields.filter((f) => f.secret).map((f) => f.key));
  return {
    ...b,
    config: Object.fromEntries(Object.entries(b.config).map(([k, v]) => [k, secret.has(k) && v ? '' : v])),
  };
}

function bindings(env: Env): string[] {
  return Object.entries(env)
    .filter(([, v]) => v && typeof (v as R2Bucket).createMultipartUpload === 'function')
    .map(([k]) => k);
}

async function state(env: Env) {
  const s = await loadSettings(env);
  return {
    types: BACKEND_TYPES,
    bindings: bindings(env),
    backends: s.backends.map(maskBackend),
    users: await Promise.all(
      s.users.map(async ({ salt: _s, passwordHash: _p, ...u }) => ({ ...u, usage: await getUsage(env, u.username) }))
    ),
  };
}

function cleanMounts(input: unknown, backends: Backend[]): Mount[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.map((raw: Partial<Mount>) => {
    const name = String(raw.name ?? '').trim();
    if (!MOUNT_RE.test(name)) throw new HttpError(400, `invalid drive name "${name}" (lowercase letters, digits, "." and "-")`);
    if (seen.has(name)) throw new HttpError(400, `duplicate drive name "${name}"`);
    seen.add(name);
    if (!backends.some((b) => b.id === raw.backend)) throw new HttpError(400, `unknown backend "${raw.backend}"`);
    const prefix = String(raw.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (prefix.split('/').some((p) => p === '..' || p === '.')) throw new HttpError(400, 'invalid prefix');
    return { name, backend: String(raw.backend), prefix, read: !!raw.read, write: !!raw.write, delete: !!raw.delete };
  });
}

const num = (v: unknown) => {
  const n = Math.floor(Number(v ?? 0));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'limits must be non-negative numbers');
  return n;
};

async function recount(env: Env, user: User): Promise<number> {
  const settings = await loadSettings(env);
  const drive = new Drive(env, settings, user);
  const seen = new Set<string>();
  let total = 0;
  for (const m of user.mounts.filter((x) => x.write)) {
    const id = `${m.backend}\0${m.prefix}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const h = await drive.open(m.name);
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await h.page('', cursor);
      for (const i of p.items) if (!isHidden(i.path)) total += i.size;
      cursor = p.cursor;
    } while (cursor && ++pages < 1000);
  }
  await setUsage(env, user.username, total);
  return total;
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;
  if (path === 'login' && method === 'POST') {
    const { password } = (await req.json()) as { password?: string };
    const ok = safeEqual(await sha256Hex(String(password ?? '')), await sha256Hex(env.ADMIN_PASSWORD!));
    if (!ok) return json({ error: 'wrong password' }, 401);
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=${await makeSession(env)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
  }
  if (path === 'logout') {
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }
  if (!(await validSession(req, env))) return json({ error: 'not signed in' }, 401);
  if (method !== 'GET' && !(req.headers.get('content-type') ?? '').includes('application/json')) {
    return json({ error: 'expected application/json' }, 415);
  }

  if (path === 'state' && method === 'GET') return json(await state(env));

  const settings = structuredClone(await loadSettings(env));
  const parts = path.split('/').map(decodeURIComponent);
  const body = method === 'PUT' || method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  if (parts[0] === 'backends' && parts[1]) {
    const id = parts[1];
    const idx = settings.backends.findIndex((b) => b.id === id);
    if (parts[2] === 'test' && method === 'POST') {
      const b = settings.backends[idx];
      if (!b) throw new HttpError(404, 'no such backend');
      try {
        const out = await (await storageFor(env, b)).list({ limit: 5 });
        return json({ ok: true, message: `connected, ${out.items.length}${out.cursor ? '+' : ''} object(s) visible` });
      } catch (err) {
        return json({ ok: false, message: String((err as Error).message ?? err) });
      }
    }
    if (method === 'PUT') {
      if (!NAME_RE.test(id)) throw new HttpError(400, 'invalid backend id');
      const type = String(body.type);
      const spec = BACKEND_TYPES[type];
      if (!spec) throw new HttpError(400, 'unknown backend type');
      const prev = idx >= 0 ? settings.backends[idx]! : undefined;
      const input = (body.config ?? {}) as Record<string, unknown>;
      const config: Record<string, string> = {};
      for (const f of spec.fields) {
        let v = String(input[f.key] ?? '').trim();
        if (f.secret && !v && prev?.type === type) v = prev.config[f.key] ?? '';
        if (f.required && !v) throw new HttpError(400, `${f.label} is required`);
        if (v) config[f.key] = v;
      }
      const next = { id, type, config };
      if (prev) settings.backends[idx] = next;
      else settings.backends.push(next);
      await saveSettings(env, settings);
      return json(await state(env));
    }
    if (method === 'DELETE') {
      const users = settings.users.filter((u) => u.mounts.some((m) => m.backend === id)).map((u) => u.username);
      if (users.length) throw new HttpError(409, `backend is used by: ${users.join(', ')}`);
      settings.backends = settings.backends.filter((b) => b.id !== id);
      await saveSettings(env, settings);
      return json(await state(env));
    }
  }

  if (parts[0] === 'users' && parts[1]) {
    const name = parts[1];
    const user = settings.users.find((u) => u.username === name);
    if (parts[2] === 'keys' && method === 'POST') {
      if (!user) throw new HttpError(404, 'no such user');
      Object.assign(user, newAccessKeys());
      await saveSettings(env, settings);
      return json(await state(env));
    }
    if (parts[2] === 'recount' && method === 'POST') {
      if (!user) throw new HttpError(404, 'no such user');
      await recount(env, user);
      return json(await state(env));
    }
    if (method === 'PUT') {
      if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid username (lowercase letters, digits, ".", "_" and "-")');
      const password = String(body.password ?? '');
      if (!user && !password) throw new HttpError(400, 'password is required for a new user');
      if (password && password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
      const next: User = user ?? {
        username: name, salt: '', passwordHash: '', ...newAccessKeys(),
        enabled: true, quotaBytes: 0, maxFileBytes: 0, mounts: [],
      };
      next.enabled = body.enabled !== false;
      next.quotaBytes = num(body.quotaBytes);
      next.maxFileBytes = num(body.maxFileBytes);
      next.mounts = cleanMounts(body.mounts, settings.backends);
      if (password) await setPassword(next, password);
      if (!user) settings.users.push(next);
      await saveSettings(env, settings);
      return json(await state(env));
    }
    if (method === 'DELETE') {
      settings.users = settings.users.filter((u) => u.username !== name);
      await saveSettings(env, settings);
      await env.CONFIG.delete(`usage:${name}`);
      return json(await state(env));
    }
  }
  return json({ error: 'not found' }, 404);
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!env.ADMIN_PASSWORD) {
    return new Response('Admin panel disabled: set the ADMIN_PASSWORD secret (wrangler secret put ADMIN_PASSWORD).', {
      status: 503,
    });
  }
  if (url.pathname.startsWith('/admin/api/')) {
    try {
      return await api(req, env, url.pathname.slice('/admin/api/'.length));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: String((err as Error).message ?? err) }, 500);
    }
  }
  return new Response(ADMIN_PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
