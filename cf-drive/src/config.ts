import { ALNUM, ALNUM_UPPER, hashPassword, randomString, sha256Hex } from './util.js';

export interface Env {
  CONFIG: KVNamespace;
  BUCKET?: R2Bucket;
  ADMIN_PASSWORD?: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

/** Backend types the admin panel can configure, and the fields each one takes. */
export const BACKEND_TYPES: Record<string, { label: string; fields: FieldSpec[] }> = {
  'r2-binding': {
    label: 'Cloudflare R2 (Worker binding)',
    fields: [{ key: 'binding', label: 'Binding name', placeholder: 'BUCKET' }],
  },
  r2: {
    label: 'Cloudflare R2 (API keys)',
    fields: [
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'accountId', label: 'Account ID', required: true },
      { key: 'accessKeyId', label: 'Access key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', required: true, secret: true },
      { key: 'endpoint', label: 'Endpoint (optional)' },
    ],
  },
  s3: {
    label: 'Amazon S3 / S3-compatible',
    fields: [
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'region', label: 'Region', placeholder: 'us-east-1' },
      { key: 'endpoint', label: 'Endpoint (optional)' },
      { key: 'accessKeyId', label: 'Access key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', required: true, secret: true },
      { key: 'forcePathStyle', label: 'Path-style (true/false)', placeholder: 'false' },
    ],
  },
  minio: {
    label: 'MinIO',
    fields: [
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'endpoint', label: 'Endpoint', required: true },
      { key: 'accessKeyId', label: 'Access key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', required: true, secret: true },
    ],
  },
  backblaze: {
    label: 'Backblaze B2',
    fields: [
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'region', label: 'Region', required: true, placeholder: 'us-west-004' },
      { key: 'accessKeyId', label: 'Key ID', required: true },
      { key: 'secretAccessKey', label: 'Application key', required: true, secret: true },
    ],
  },
  wasabi: {
    label: 'Wasabi',
    fields: [
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'region', label: 'Region', required: true, placeholder: 'us-east-1' },
      { key: 'accessKeyId', label: 'Access key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', required: true, secret: true },
    ],
  },
  spaces: {
    label: 'DigitalOcean Spaces',
    fields: [
      { key: 'bucket', label: 'Space', required: true },
      { key: 'region', label: 'Region', required: true, placeholder: 'nyc3' },
      { key: 'accessKeyId', label: 'Access key ID', required: true },
      { key: 'secretAccessKey', label: 'Secret key', required: true, secret: true },
    ],
  },
  webdav: {
    label: 'WebDAV server',
    fields: [
      { key: 'baseUrl', label: 'Server URL', required: true, placeholder: 'https://dav.example.com' },
      { key: 'root', label: 'Root path', placeholder: '/' },
      { key: 'folder', label: 'Folder', required: true, placeholder: 'drive' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  vercel: {
    label: 'Vercel Blob',
    fields: [
      { key: 'bucket', label: 'Path prefix', required: true },
      { key: 'token', label: 'Read-write token', required: true, secret: true },
      { key: 'access', label: 'Access (public/private)', placeholder: 'public' },
    ],
  },
};

export interface Backend {
  id: string;
  type: string;
  config: Record<string, string>;
}

/** A backend a user can reach. `name` is the WebDAV top-level folder and the S3 bucket name. */
export interface Mount {
  name: string;
  backend: string;
  prefix: string;
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface User {
  username: string;
  salt: string;
  passwordHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  enabled: boolean;
  /** Total bytes the user may store. 0 = unlimited. */
  quotaBytes: number;
  /** Largest single file. 0 = unlimited. */
  maxFileBytes: number;
  mounts: Mount[];
}

export interface Settings {
  backends: Backend[];
  users: User[];
}

const SETTINGS_KEY = 'settings';

let cache: { settings: Settings; at: number } | undefined;

export async function loadSettings(env: Env): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5_000) return cache.settings;
  const settings = (await env.CONFIG.get<Settings>(SETTINGS_KEY, 'json')) ?? {
    backends: env.BUCKET ? [{ id: 'r2', type: 'r2-binding', config: {} }] : [],
    users: [],
  };
  cache = { settings, at: Date.now() };
  return settings;
}

export async function saveSettings(env: Env, settings: Settings): Promise<void> {
  await env.CONFIG.put(SETTINGS_KEY, JSON.stringify(settings));
  cache = { settings, at: Date.now() };
}

export async function getUsage(env: Env, username: string): Promise<number> {
  return Number((await env.CONFIG.get(`usage:${username}`)) ?? 0);
}

export async function setUsage(env: Env, username: string, bytes: number): Promise<void> {
  await env.CONFIG.put(`usage:${username}`, String(Math.max(0, bytes)));
}

export async function addUsage(env: Env, username: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await setUsage(env, username, (await getUsage(env, username)) + delta);
}

export function newAccessKeys(): { accessKeyId: string; secretAccessKey: string } {
  return {
    accessKeyId: 'CFD' + randomString(17, ALNUM_UPPER),
    secretAccessKey: randomString(40, ALNUM),
  };
}

export async function setPassword(user: User, password: string): Promise<void> {
  user.salt = randomString(16, ALNUM);
  user.passwordHash = await hashPassword(password, user.salt);
}

// Password checks cost ~100k PBKDF2 rounds. WebDAV clients send Basic auth on
// every request, so remember recent successes for this isolate.
const verified = new Map<string, number>();

export async function checkPassword(user: User, password: string): Promise<boolean> {
  const memo = await sha256Hex(`${user.username}\0${user.passwordHash}\0${password}`);
  const at = verified.get(memo);
  if (at && Date.now() - at < 5 * 60_000) return true;
  const ok = (await hashPassword(password, user.salt)) === user.passwordHash;
  if (ok) {
    if (verified.size > 1000) verified.clear();
    verified.set(memo, Date.now());
  }
  return ok;
}
