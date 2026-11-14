# cf-drive

A small cloud drive that runs as a single Cloudflare Worker. Files live in any
storage backend [storagesdk](https://github.com/waxz/storagesdk) supports, and
users reach them over **WebDAV** and an **S3-compatible API**. A minimal admin
panel at `/admin` manages backends, users, passwords, limits and permissions.

```
 WebDAV clients ──┐                         ┌── R2 (Worker binding, native)
 (Finder, rclone, │   ┌─────────────────┐   ├── R2 / S3 / MinIO / B2 / Wasabi / Spaces
  Cyberduck, …)   ├──▶│ Cloudflare      │──▶├── WebDAV server
 S3 clients ──────┤   │ Worker          │   └── Vercel Blob
 (aws, rclone, …) │   │  /dav  /  /admin│        (via @storagesdk adapters)
 Browser ─────────┘   └──────┬──────────┘
                             └── KV: settings, users, usage
```

## Deploy

```bash
npm install
```

```bash
npx wrangler secret put ADMIN_PASSWORD
```

```bash
npx wrangler deploy
```

`wrangler deploy` creates the `CONFIG` KV namespace and the `BUCKET` R2 bucket
for you (the bindings in `wrangler.toml` have no IDs on purpose). Open
`https://<your-worker>/admin`, sign in with the admin password, and you'll see
an `r2` backend already pointing at the bound bucket. Add a user and you're done.

Local development: `cp .dev.vars.example .dev.vars`, then `npm run dev`
(the local admin password is `admin`).

## Admin panel

- **Storage backends** — pick a type, fill in its fields, and use *Test* to
  check the connection. Secret fields are never sent back to the browser;
  leave them empty when editing to keep the stored value.

  | Type | Notes |
  | --- | --- |
  | `r2-binding` | R2 bucket bound to the Worker. No keys; streams natively and uses R2 multipart. |
  | `r2`, `s3`, `minio`, `backblaze`, `wasabi`, `spaces` | Any S3-style bucket via `@storagesdk/adapters`. |
  | `webdav` | Another WebDAV server as the backing store. |
  | `vercel` | Vercel Blob. |

- **Users** — username, password (stored as PBKDF2-SHA256), enable/disable,
  and two limits:
  - *Quota*: total bytes the user may store (0 = unlimited).
  - *Max file size*: largest single file (0 = unlimited).
- **Drives** — each user gets one or more drives. A drive is a backend plus a
  path prefix, with its own **read / write / delete** permissions. It shows up
  as a top-level folder in WebDAV and as a bucket in S3. Two users can share a
  drive by pointing at the same backend and prefix (e.g. a read-only `public`
  drive).
- **S3 credentials** are generated per user and can be rotated.
- **Recount** recomputes a user's usage from what's actually stored.

## Connecting

WebDAV: `https://<host>/dav/` with the user's username and password.

```bash
rclone config create mydrive webdav url=https://<host>/dav/ vendor=other user=alice pass=$(rclone obscure 'secret')
```

macOS Finder: *Go → Connect to Server* → `https://<host>/dav/`.
Windows: *Map network drive* → `https://<host>/dav/`.

S3: endpoint `https://<host>`, path-style addressing, any region (`auto`),
the user's access key and secret. Buckets are the user's drive names.

```bash
aws --endpoint-url https://<host> s3 ls s3://home/
```

```bash
rclone config create mys3 s3 provider=Other endpoint=https://<host> access_key_id=CFD... secret_access_key=... force_path_style=true
```

Supported S3 operations: ListBuckets, HeadBucket, GetBucketLocation,
ListObjects (v1/v2, delimiter, pagination, `encoding-type=url`), Get/Head
(ranges, conditional headers, `response-*` overrides), PutObject (signed,
unsigned and `aws-chunked` bodies, with chunk signatures verified),
CopyObject, DeleteObject(s), multipart upload, and presigned URLs.

## Tests

With `npm run dev` running and a user configured:

```bash
CFD_USER=alice CFD_PASS=... CFD_DRIVE=home node test/smoke-dav.mjs
```

```bash
CFD_KEY=... CFD_SECRET=... CFD_BUCKET=home node test/smoke-s3.mjs
```

## Limits worth knowing

- Cloudflare caps request bodies at 100 MB (more on Enterprise). Big files
  should go through S3 multipart (aws cli and rclone do this automatically).
  A single WebDAV PUT above the cap is rejected by Cloudflare.
- Downloads stream: R2-binding reads stream directly; other backends are read
  in 8 MB range slices.
- Folder listings on non-R2 backends walk the folder's whole subtree (the
  storagesdk `list` doesn't return common prefixes), capped at 40,000 objects.
- Empty folders are kept with a hidden `.keep` object.
- On non-R2 backends, multipart parts are staged under a hidden
  `.cfdrive-uploads/` folder in the drive and removed on complete/abort.
  Uploads that are never completed or aborted leave parts behind there.
- WebDAV locks are accepted but not enforced.
- Usage is tracked per user as files are written and deleted. With drives
  shared between users, numbers are approximate; use *Recount*.
- Password checks and signature verification use real CPU; the Workers paid
  plan is recommended over the free 10 ms CPU limit.
- The AWS SDK's browser build needs `DOMParser`, which Workers lack, so
  `wrangler.toml` aliases `@aws-sdk/xml-builder` to `shims/xml-builder.js`.
