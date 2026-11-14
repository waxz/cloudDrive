import { Storage } from '@storagesdk/core';
import type { Adapter } from '@storagesdk/core/adapter';
import { type Backend, BACKEND_TYPES, type Env } from './config.js';
import { r2Binding } from './r2-binding.js';

const cache = new Map<string, { sig: string; storage: Storage }>();

async function buildAdapter(env: Env, b: Backend): Promise<Adapter> {
  const c = b.config;
  switch (b.type) {
    case 'r2-binding': {
      const binding = (env as unknown as Record<string, unknown>)[c.binding || 'BUCKET'];
      if (!binding) throw new Error(`R2 binding "${c.binding || 'BUCKET'}" is not configured`);
      return r2Binding(binding as R2Bucket);
    }
    case 'r2': {
      const { r2 } = await import('@storagesdk/adapters/r2');
      return r2({
        bucket: c.bucket!,
        accountId: c.accountId!,
        accessKeyId: c.accessKeyId!,
        secretAccessKey: c.secretAccessKey!,
        ...(c.endpoint ? { endpoint: c.endpoint } : {}),
      });
    }
    case 's3': {
      const { s3 } = await import('@storagesdk/adapters/s3');
      return s3({
        bucket: c.bucket!,
        region: c.region || 'us-east-1',
        ...(c.endpoint ? { endpoint: c.endpoint } : {}),
        credentials: { accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey! },
        forcePathStyle: c.forcePathStyle === 'true',
      });
    }
    case 'minio': {
      const { minio } = await import('@storagesdk/adapters/minio');
      return minio({
        bucket: c.bucket!,
        endpoint: c.endpoint!,
        accessKeyId: c.accessKeyId!,
        secretAccessKey: c.secretAccessKey!,
      });
    }
    case 'backblaze': {
      const { backblaze } = await import('@storagesdk/adapters/backblaze');
      return backblaze(s3Like(c));
    }
    case 'wasabi': {
      const { wasabi } = await import('@storagesdk/adapters/wasabi');
      return wasabi(s3Like(c));
    }
    case 'spaces': {
      const { spaces } = await import('@storagesdk/adapters/spaces');
      return spaces(s3Like(c));
    }
    case 'webdav': {
      const { webdav } = await import('@storagesdk/adapters/webdav');
      return webdav({
        baseUrl: c.baseUrl!,
        root: c.root || '/',
        folder: c.folder!,
        ...(c.username ? { username: c.username, password: c.password ?? '' } : {}),
        authType: c.username ? 'basic' : 'none',
      });
    }
    case 'vercel': {
      const { vercel } = await import('@storagesdk/adapters/vercel');
      return vercel({
        bucket: c.bucket!,
        token: c.token!,
        access: c.access === 'private' ? 'private' : 'public',
      });
    }
    default:
      throw new Error(`unknown backend type: ${b.type}`);
  }
}

function s3Like(c: Record<string, string>) {
  return {
    bucket: c.bucket!,
    region: c.region!,
    accessKeyId: c.accessKeyId!,
    secretAccessKey: c.secretAccessKey!,
  };
}

/** Returns a `Storage` for the backend, reusing it while the backend's config is unchanged. */
export async function storageFor(env: Env, b: Backend): Promise<Storage> {
  if (!BACKEND_TYPES[b.type]) throw new Error(`unknown backend type: ${b.type}`);
  const sig = JSON.stringify(b);
  const hit = cache.get(b.id);
  if (hit && hit.sig === sig) return hit.storage;
  const storage = new Storage({ adapter: await buildAdapter(env, b) });
  cache.set(b.id, { sig, storage });
  return storage;
}

/** The bound R2 bucket behind a storage, when there is one. Lets the drive stream and use native multipart. */
export function r2Raw(storage: Storage): R2Bucket | undefined {
  const raw = storage.raw as { put?: unknown; createMultipartUpload?: unknown } | undefined;
  return raw && typeof raw.createMultipartUpload === 'function' ? (raw as R2Bucket) : undefined;
}
