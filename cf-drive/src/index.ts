import { handleAdmin } from './admin.js';
import type { Env } from './config.js';
import { DAV_ROOT, handleDav } from './dav.js';
import { handleS3 } from './s3.js';
import { isSigV4 } from './sigv4.js';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/admin' || p.startsWith('/admin/')) return handleAdmin(req, env);
    if (p === DAV_ROOT || p.startsWith(`${DAV_ROOT}/`)) return handleDav(req, env);
    if (isSigV4(req, url)) return handleS3(req, env);
    if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      return Response.redirect(`${url.origin}/admin`, 302);
    }
    // Unsigned request to the S3 endpoint.
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
      { status: 403, headers: { 'content-type': 'application/xml' } }
    );
  },
} satisfies ExportedHandler<Env>;
