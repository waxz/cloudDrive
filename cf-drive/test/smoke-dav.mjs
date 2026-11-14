// End-to-end check of the WebDAV API.
// Usage: CFD_URL=http://127.0.0.1:8787 CFD_USER=alice CFD_PASS=... CFD_DRIVE=home node test/smoke-dav.mjs
import assert from 'node:assert/strict';

const base = `${process.env.CFD_URL ?? 'http://127.0.0.1:8787'}/dav/${process.env.CFD_DRIVE ?? 'home'}`;
const auth = 'Basic ' + Buffer.from(`${process.env.CFD_USER}:${process.env.CFD_PASS}`).toString('base64');
const dav = (method, path, init = {}) =>
  fetch(base + path, { method, ...init, headers: { authorization: auth, ...init.headers } });
const hrefs = async (path, depth = '1') =>
  [...(await (await dav('PROPFIND', path, { headers: { depth } })).text()).matchAll(/<d:href>([^<]*)/g)].map((m) => decodeURIComponent(m[1]));

const p = `/smoke-${Date.now()}`;
assert.equal((await fetch(base + '/', { method: 'PROPFIND' })).status, 401);
assert.equal((await dav('MKCOL', p)).status, 201);
assert.equal((await dav('MKCOL', `${p}/empty`)).status, 201);
assert.equal((await dav('PUT', `${p}/a file.txt`, { body: 'hello webdav' })).status, 201);
assert.equal((await dav('PUT', `${p}/a file.txt`, { body: 'hello again' })).status, 204);
assert.equal(await (await dav('GET', `${p}/a file.txt`)).text(), 'hello again');
const part = await dav('GET', `${p}/a file.txt`, { headers: { range: 'bytes=6-' } });
assert.equal(part.status, 206);
assert.equal(await part.text(), 'again');

const listing = await hrefs(`${p}/`);
assert.ok(listing.some((h) => h.endsWith('/empty/')), 'empty folder listed');
assert.ok(listing.some((h) => h.endsWith('/a file.txt')), 'file listed');
assert.ok(!listing.some((h) => h.includes('.keep')), 'markers hidden');

assert.equal((await dav('COPY', `${p}/a file.txt`, { headers: { destination: `${base}${p}/sub/b.txt` } })).status, 201);
assert.equal((await dav('COPY', `${p}/a file.txt`, { headers: { destination: `${base}${p}/sub/b.txt`, overwrite: 'F' } })).status, 412);
assert.equal((await dav('MOVE', `${p}/sub`, { headers: { destination: `${base}${p}/moved` } })).status, 201);
assert.equal(await (await dav('GET', `${p}/moved/b.txt`)).text(), 'hello again');
assert.equal((await dav('GET', `${p}/sub/b.txt`)).status, 404);

assert.equal((await dav('DELETE', p)).status, 204);
assert.equal((await dav('PROPFIND', `${p}/`, { headers: { depth: '0' } })).status, 404);
console.log('WebDAV smoke test passed');
