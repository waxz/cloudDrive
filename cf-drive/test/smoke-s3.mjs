// End-to-end check of the S3 API using the official AWS SDK.
// Usage: CFD_URL=http://127.0.0.1:8787 CFD_KEY=... CFD_SECRET=... CFD_BUCKET=home node test/smoke-s3.mjs
import assert from 'node:assert/strict';
import {
  CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand,
  HeadObjectCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const Bucket = process.env.CFD_BUCKET ?? 'home';
const s3 = new S3Client({
  endpoint: process.env.CFD_URL ?? 'http://127.0.0.1:8787',
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.CFD_KEY, secretAccessKey: process.env.CFD_SECRET },
});
const p = `smoke-${Date.now()}`;
const text = async (out) => out.Body.transformToString();

const buckets = await s3.send(new ListBucketsCommand({}));
assert.ok(buckets.Buckets.some((b) => b.Name === Bucket), 'bucket listed');

await s3.send(new PutObjectCommand({ Bucket, Key: `${p}/a.txt`, Body: 'hello', ContentType: 'text/plain', Metadata: { k: 'v' } }));
await s3.send(new PutObjectCommand({ Bucket, Key: `${p}/sub/b.txt`, Body: 'world' }));
await s3.send(new PutObjectCommand({ Bucket, Key: `${p}/empty/`, Body: '' }));
await s3.send(new PutObjectCommand({ Bucket, Key: `${p}/sp ace+ü.txt`, Body: 'odd' }));

const head = await s3.send(new HeadObjectCommand({ Bucket, Key: `${p}/a.txt` }));
assert.equal(head.ContentLength, 5);
assert.equal(head.ContentType, 'text/plain');
assert.equal(head.Metadata.k, 'v');

assert.equal(await text(await s3.send(new GetObjectCommand({ Bucket, Key: `${p}/a.txt` }))), 'hello');
assert.equal(await text(await s3.send(new GetObjectCommand({ Bucket, Key: `${p}/a.txt`, Range: 'bytes=1-3' }))), 'ell');
assert.equal(await text(await s3.send(new GetObjectCommand({ Bucket, Key: `${p}/sp ace+ü.txt` }))), 'odd');

const l1 = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `${p}/`, Delimiter: '/' }));
assert.deepEqual((l1.Contents ?? []).map((c) => c.Key).sort(), [`${p}/a.txt`, `${p}/sp ace+ü.txt`]);
assert.deepEqual((l1.CommonPrefixes ?? []).map((c) => c.Prefix).sort(), [`${p}/empty/`, `${p}/sub/`]);

// Pagination with small pages.
const seen = [];
let token;
do {
  const out = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `${p}/`, MaxKeys: 1, ContinuationToken: token }));
  seen.push(...(out.Contents ?? []).map((c) => c.Key));
  token = out.NextContinuationToken;
} while (token);
assert.deepEqual(seen.sort(), [`${p}/a.txt`, `${p}/empty/`, `${p}/sp ace+ü.txt`, `${p}/sub/b.txt`].sort());

await s3.send(new CopyObjectCommand({ Bucket, Key: `${p}/copy.txt`, CopySource: `${Bucket}/${encodeURIComponent(`${p}/a.txt`)}` }));
assert.equal(await text(await s3.send(new GetObjectCommand({ Bucket, Key: `${p}/copy.txt` }))), 'hello');

const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: `${p}/a.txt` }), { expiresIn: 60 });
assert.equal(await (await fetch(url)).text(), 'hello');
const bad = await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)));
assert.equal(bad.status, 403);

// Multipart upload (3 parts of 5 MB + tail).
const big = new Uint8Array(5 * 1024 * 1024 * 2 + 1234).map((_, i) => i % 251);
await new Upload({ client: s3, params: { Bucket, Key: `${p}/big.bin`, Body: big }, partSize: 5 * 1024 * 1024 }).done();
const got = await (await s3.send(new GetObjectCommand({ Bucket, Key: `${p}/big.bin` }))).Body.transformToByteArray();
assert.equal(got.length, big.length);
assert.ok(got.every((b, i) => b === big[i]), 'multipart content matches');

const del = await s3.send(new DeleteObjectsCommand({
  Bucket, Delete: { Objects: [`a.txt`, `sub/b.txt`, `empty/`, `sp ace+ü.txt`, `copy.txt`].map((k) => ({ Key: `${p}/${k}` })) },
}));
assert.equal(del.Errors?.length ?? 0, 0);
await s3.send(new DeleteObjectCommand({ Bucket, Key: `${p}/big.bin` }));
const left = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `${p}/` }));
assert.equal(left.KeyCount, 0);

const wrong = new S3Client({ ...s3.config, credentials: { accessKeyId: process.env.CFD_KEY, secretAccessKey: 'nope' } });
await assert.rejects(new S3Client({
  endpoint: process.env.CFD_URL ?? 'http://127.0.0.1:8787', region: 'auto', forcePathStyle: true,
  credentials: { accessKeyId: process.env.CFD_KEY, secretAccessKey: 'wrong' },
}).send(new ListBucketsCommand({})), /signature/i);
void wrong;

console.log('S3 smoke test passed');
