import {
  type Adapter,
  type BodyInput,
  defineAdapter,
  readStreamToBytes,
  StorageError,
  type StorageItemMeta,
} from '@storagesdk/core/adapter';

/**
 * storagesdk adapter backed by an R2 bucket bound to the Worker. No API keys,
 * no S3 signing; calls go straight through the binding. `raw` is the
 * `R2Bucket`, which the drive uses for streaming reads and native multipart.
 */
export function r2Binding(bucket: R2Bucket): Adapter<R2Bucket> {
  const notSupported = (): never => {
    throw new StorageError({
      code: 'NotSupported',
      message: 'snapshots and forks are not supported by the r2-binding adapter',
    });
  };

  const meta = (o: R2Object): StorageItemMeta => ({
    path: o.key,
    size: o.size,
    contentType: o.httpMetadata?.contentType ?? 'application/octet-stream',
    etag: o.etag,
    lastModified: o.uploaded,
    ...(o.customMetadata ? { metadata: o.customMetadata } : {}),
  });

  const notFound = (path: string): never => {
    throw new StorageError({ code: 'NotFound', message: `not found: ${path}` });
  };

  return defineAdapter<R2Bucket>({
    name: 'r2-binding',
    raw: bucket,

    async upload(path, body: BodyInput, opts) {
      const value =
        body instanceof ReadableStream ? await readStreamToBytes(body) : body;
      const out = await bucket.put(path, value, {
        httpMetadata: {
          ...(opts?.contentType ? { contentType: opts.contentType } : {}),
          ...(opts?.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        },
        ...(opts?.metadata ? { customMetadata: opts.metadata } : {}),
      });
      return meta(out!);
    },

    async download(path, opts) {
      const o = await bucket.get(
        path,
        opts?.range ? { range: { offset: opts.range.offset, length: opts.range.length } } : {}
      );
      if (!o) return notFound(path);
      const body = new Uint8Array(await o.arrayBuffer());
      return { ...meta(o), size: body.byteLength, body };
    },

    async head(path) {
      const o = await bucket.head(path);
      if (!o) return notFound(path);
      return meta(o);
    },

    async list(opts) {
      const out = await bucket.list({
        ...(opts?.prefix ? { prefix: opts.prefix } : {}),
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
        ...(opts?.delimiter ? { delimiter: opts.delimiter } : {}),
        limit: opts?.limit ?? 1000,
        include: ['httpMetadata'],
      });
      const items = out.objects.map(meta);
      return out.truncated ? { items, cursor: out.cursor } : { items };
    },

    async delete(path) {
      await bucket.delete(path);
    },

    async copy(from, to) {
      const o = await bucket.get(from);
      if (!o) return notFound(from);
      await bucket.put(to, o.body, {
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
      });
    },

    async move(from, to) {
      const o = await bucket.get(from);
      if (!o) return notFound(from);
      await bucket.put(to, o.body, {
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
      });
      await bucket.delete(from);
    },

    url: notSupported,
    uploadUrl: notSupported,

    snapshots: {
      create: notSupported,
      list: async () => [],
      head: notSupported,
      delete: notSupported,
      get: notSupported,
    },
    forks: {
      create: notSupported,
      list: async () => [],
      head: notSupported,
      delete: notSupported,
      get: notSupported,
      merge: notSupported,
      rebase: notSupported,
      diff: notSupported,
    },
  });
}
