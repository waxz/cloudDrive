import { type Storage, StorageError, type StorageItemMeta } from '@storagesdk/core';
import { r2Raw, storageFor } from './backends.js';
import { addUsage, type Env, type Mount, type Settings, type User } from './config.js';
import { joinKey } from './util.js';

export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Maps a storagesdk error to a DriveError so protocol handlers can answer with the right status. */
export function fromStorageError(err: unknown): DriveError | undefined {
  if (!(err instanceof StorageError)) return undefined;
  const map: Record<string, [number, string]> = {
    NotFound: [404, 'NotFound'],
    Unauthorized: [502, 'BackendUnauthorized'],
    InvalidArgument: [400, 'InvalidArgument'],
    Conflict: [409, 'Conflict'],
    NotSupported: [501, 'NotImplemented'],
    Aborted: [499, 'Aborted'],
  };
  const [status, code] = map[err.code] ?? [502, 'BackendError'];
  return new DriveError(status, code, err.message);
}

export const notFound = (what: string) => new DriveError(404, 'NotFound', `not found: ${what}`);

/** Marker object that makes an otherwise empty folder exist. */
export const DIR_MARKER = '.keep';
/** Where in-progress S3 multipart parts live (non-R2 backends). */
export const UPLOADS_DIR = '.cfdrive-uploads';

export function isHidden(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return (
    base === DIR_MARKER ||
    base === '.storagesdk.metadata.json' ||
    rel === UPLOADS_DIR ||
    rel.startsWith(`${UPLOADS_DIR}/`)
  );
}

export function isMarker(rel: string): boolean {
  return rel === DIR_MARKER || rel.endsWith(`/${DIR_MARKER}`);
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  lastModified: Date;
  etag: string;
  contentType: string;
}

/** Download in slices of this size so big files stream instead of sitting in memory. */
const READ_CHUNK = 8 * 1024 * 1024;
/** Bodies at or below this size are buffered and sent in a single PUT. */
const BUFFER_LIMIT = 5 * 1024 * 1024;
/** Upper bound on backend list calls for one folder listing. */
const MAX_LIST_PAGES = 40;

const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', xml: 'application/xml',
  csv: 'text/csv', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  avif: 'image/avif', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export class Drive {
  constructor(
    readonly env: Env,
    readonly settings: Settings,
    readonly user: User
  ) {}

  mounts(): Mount[] {
    return this.user.mounts.filter((m) => m.read || m.write);
  }

  async open(name: string): Promise<MountHandle> {
    const mount = this.mounts().find((m) => m.name === name);
    if (!mount) throw new DriveError(404, 'NoSuchBucket', `no such drive: ${name}`);
    const backend = this.settings.backends.find((b) => b.id === mount.backend);
    if (!backend) throw new DriveError(500, 'Provider', `backend "${mount.backend}" is missing`);
    return new MountHandle(this, mount, await storageFor(this.env, backend));
  }

  /** Throws when `size` more bytes (replacing `replacing` bytes) would break the user's limits. */
  checkLimits(size: number, replacing = 0, usage?: number): void {
    const u = this.user;
    if (u.maxFileBytes > 0 && size > u.maxFileBytes) {
      throw new DriveError(413, 'EntityTooLarge', `file exceeds the ${u.maxFileBytes} byte limit`);
    }
    if (u.quotaBytes > 0 && usage !== undefined && usage - replacing + size > u.quotaBytes) {
      throw new DriveError(507, 'QuotaExceeded', 'storage quota exceeded');
    }
  }

  async usage(): Promise<number> {
    return Number((await this.env.CONFIG.get(`usage:${this.user.username}`)) ?? 0);
  }

  addUsage(delta: number): Promise<void> {
    return addUsage(this.env, this.user.username, delta);
  }
}

export class MountHandle {
  readonly r2: R2Bucket | undefined;

  constructor(
    readonly drive: Drive,
    readonly mount: Mount,
    readonly storage: Storage
  ) {
    this.r2 = r2Raw(storage);
  }

  get backendId(): string {
    return this.mount.backend;
  }

  require(perm: 'read' | 'write' | 'delete'): void {
    if (!this.mount[perm]) {
      throw new DriveError(403, 'AccessDenied', `no ${perm} permission on ${this.mount.name}`);
    }
  }

  key(rel: string): string {
    // Keep a trailing slash: S3-style backends can hold `folder/` objects.
    return joinKey(this.mount.prefix, rel) + (rel.endsWith('/') ? '/' : '');
  }

  rel(key: string): string {
    const p = joinKey(this.mount.prefix);
    return p ? key.slice(p.length + 1) : key;
  }

  async stat(rel: string): Promise<StorageItemMeta | null> {
    if (!rel || (isHidden(rel) && !isMarker(rel))) return null;
    try {
      return await this.storage.head(this.key(rel));
    } catch (err) {
      if (err instanceof StorageError && err.code === 'NotFound') return null;
      throw err;
    }
  }

  async isDir(rel: string): Promise<boolean> {
    if (!rel) return true;
    const page = await this.storage.list({ prefix: `${this.key(rel)}/`, limit: 1 });
    return page.items.length > 0;
  }

  /** One page of raw backend objects under `relPrefix`, with paths relative to the mount. */
  async page(
    relPrefix: string,
    cursor?: string,
    limit = 1000
  ): Promise<{ items: StorageItemMeta[]; cursor?: string }> {
    const base = joinKey(this.mount.prefix);
    const prefix = base ? `${base}/${relPrefix}` : relPrefix;
    const out = await this.storage.list({
      ...(prefix ? { prefix } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    });
    return {
      items: out.items.map((i) => ({ ...i, path: this.rel(i.path) })),
      ...(out.cursor ? { cursor: out.cursor } : {}),
    };
  }

  /** Every object under `relPrefix` (including hidden markers). */
  async *walk(relPrefix: string): AsyncGenerator<StorageItemMeta> {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await this.page(relPrefix, cursor);
      yield* p.items;
      cursor = p.cursor;
      if (++pages >= MAX_LIST_PAGES) break;
    } while (cursor);
  }

  /** Immediate children of a folder. */
  async listDir(rel: string): Promise<Entry[]> {
    const prefix = rel ? `${rel}/` : '';
    const files: Entry[] = [];
    const dirs = new Map<string, Entry>();
    const addDir = (name: string, at: Date) => {
      const d = dirs.get(name);
      if (!d) {
        dirs.set(name, {
          name, path: prefix + name, isDir: true, size: 0, lastModified: at, etag: '',
          contentType: 'httpd/unix-directory',
        });
      } else if (at > d.lastModified) d.lastModified = at;
    };

    if (this.r2) {
      // The binding returns folders directly, so no full walk is needed.
      const base = this.key(rel);
      const full = base ? `${base}/` : '';
      let cursor: string | undefined;
      do {
        const out = await this.r2.list({
          prefix: full, delimiter: '/', include: ['httpMetadata'],
          ...(cursor ? { cursor } : {}),
        });
        for (const p of out.delimitedPrefixes) {
          const name = p.slice(full.length, -1);
          if (!isHidden(prefix + name)) addDir(name, new Date());
        }
        for (const o of out.objects) {
          const name = o.key.slice(full.length);
          if (!name || isHidden(prefix + name)) continue;
          files.push({
            name, path: prefix + name, isDir: false, size: o.size, lastModified: o.uploaded,
            etag: o.etag, contentType: o.httpMetadata?.contentType ?? guessType(name),
          });
        }
        cursor = out.truncated ? out.cursor : undefined;
      } while (cursor);
    } else {
      for await (const item of this.walk(prefix)) {
        const rest = item.path.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash >= 0) {
          const name = rest.slice(0, slash);
          if (!isHidden(prefix + name)) addDir(name, item.lastModified);
        } else if (!isHidden(item.path)) {
          files.push({
            name: rest, path: item.path, isDir: false, size: item.size,
            lastModified: item.lastModified, etag: item.etag,
            contentType: item.contentType === 'application/octet-stream' ? guessType(rest) : item.contentType,
          });
        }
      }
    }
    return [...dirs.values(), ...files];
  }

  /** Streams a file, or a slice of it. */
  async read(
    rel: string,
    meta: StorageItemMeta,
    range?: { offset: number; length: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const key = this.key(rel);
    if (this.r2) {
      const o = await this.r2.get(key, range ? { range } : {});
      if (!o) throw notFound(rel);
      return o.body;
    }
    const start = range?.offset ?? 0;
    const end = range ? range.offset + range.length : meta.size;
    if (end - start <= READ_CHUNK) {
      if (end === start) return new Response('').body!;
      const item = await this.storage.download(key, { range: { offset: start, length: end - start } });
      return new Response(item.body).body!;
    }
    let pos = start;
    const storage = this.storage;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pos >= end) return controller.close();
        const length = Math.min(READ_CHUNK, end - pos);
        const item = await storage.download(key, { range: { offset: pos, length } });
        pos += length;
        controller.enqueue(item.body);
        if (pos >= end) controller.close();
      },
    });
  }

  /**
   * Writes a file. `size` is the body length when known. Checks the user's
   * limits and updates their usage.
   */
  async write(
    rel: string,
    body: ReadableStream<Uint8Array> | Uint8Array | null,
    size: number | undefined,
    contentType?: string,
    metadata?: Record<string, string>
  ): Promise<StorageItemMeta> {
    this.require('write');
    if (!rel || (isHidden(rel) && !isMarker(rel))) throw new DriveError(400, 'InvalidArgument', `invalid name: ${rel}`);
    const drive = this.drive;
    const old = await this.stat(rel);
    const usage = await drive.usage();
    if (size !== undefined) drive.checkLimits(size, old?.size ?? 0, usage);
    const type = contentType || guessType(rel);
    const key = this.key(rel);

    let data: ReadableStream<Uint8Array> | Uint8Array = body ?? new Uint8Array();
    if (data instanceof ReadableStream && (size === undefined || size <= BUFFER_LIMIT)) {
      data = new Uint8Array(await new Response(data).arrayBuffer());
    }
    if (size === undefined) {
      size = (data as Uint8Array).byteLength;
      drive.checkLimits(size, old?.size ?? 0, usage);
    }

    let meta: StorageItemMeta;
    if (this.r2 && data instanceof ReadableStream) {
      const o = await this.r2.put(key, data.pipeThrough(new FixedLengthStream(size)), {
        httpMetadata: { contentType: type },
        ...(metadata ? { customMetadata: metadata } : {}),
      });
      meta = { path: key, size: o!.size, contentType: type, etag: o!.etag, lastModified: o!.uploaded };
    } else {
      meta = await this.storage.upload(key, data, {
        contentType: type,
        ...(metadata ? { metadata } : {}),
      });
    }
    await drive.addUsage(meta.size - (old?.size ?? 0));
    return meta;
  }

  async mkdir(rel: string): Promise<void> {
    this.require('write');
    await this.storage.upload(this.key(`${rel}/${DIR_MARKER}`), new Uint8Array(), {
      contentType: 'application/x-directory',
    });
  }

  async remove(rel: string): Promise<boolean> {
    this.require('delete');
    const old = await this.stat(rel);
    if (!old) return false;
    await this.storage.delete(this.key(rel));
    await this.drive.addUsage(-old.size);
    return true;
  }

  /** Deletes a folder and everything in it. */
  async removeTree(rel: string): Promise<void> {
    this.require('delete');
    let freed = 0;
    // Collect first: deleting while paging can skip entries on some backends.
    const keys: StorageItemMeta[] = [];
    for await (const item of this.walk(`${rel}/`)) keys.push(item);
    for (const item of keys) {
      await this.storage.delete(this.key(item.path));
      freed += item.size;
    }
    await this.drive.addUsage(-freed);
  }

  /** Copies (or moves) one file to another mount/path. */
  async transfer(rel: string, dest: MountHandle, destRel: string, move: boolean): Promise<StorageItemMeta> {
    this.require('read');
    if (move) this.require('delete');
    dest.require('write');
    const meta = await this.stat(rel);
    if (!meta) throw notFound(rel);
    if (dest === this || dest.backendId === this.backendId) {
      const old = await dest.stat(destRel);
      if (!move) this.drive.checkLimits(meta.size, old?.size ?? 0, await this.drive.usage());
      if (move) await this.storage.move(this.key(rel), dest.key(destRel));
      else await this.storage.copy(this.key(rel), dest.key(destRel));
      await this.drive.addUsage((move ? 0 : meta.size) - (old?.size ?? 0));
      return { ...meta, path: dest.key(destRel) };
    }
    const out = await dest.write(destRel, await this.read(rel, meta), meta.size, meta.contentType);
    if (move) await this.remove(rel);
    return out;
  }

  /** Copies or moves a folder tree. */
  async transferTree(rel: string, dest: MountHandle, destRel: string, move: boolean): Promise<void> {
    const items: StorageItemMeta[] = [];
    for await (const item of this.walk(`${rel}/`)) items.push(item);
    for (const item of items) {
      const sub = item.path.slice(rel.length + 1);
      if (item.path.endsWith(`/${DIR_MARKER}`)) {
        dest.require('write');
        await dest.storage.upload(dest.key(`${destRel}/${sub}`), new Uint8Array());
        if (move) await this.storage.delete(this.key(item.path));
        continue;
      }
      if (isHidden(item.path)) continue;
      await this.transfer(item.path, dest, `${destRel}/${sub}`, move);
    }
  }
}
