/* ============================================================
   EverFlo ingest Worker.

   The device POSTs a JPEG with metadata in the query string. This Worker
   stores the image in R2, writes a row to D1, and returns 204.

   Deliberately NOT behind Cloudflare Access: Access challenges every
   request, and an ESP32 cannot complete an interactive login. The device
   authenticates with a bearer token instead. The admin UI is a separate
   Worker and that one can use Access.

   The detection engine does not run here. Running it would need a second
   JPEG decoder whose pixels may differ from the browser's, and the
   calibration and quality gates are tuned on browser-decoded pixels with
   a test suite that is not in this repo. Until that path is validated
   against the labelled set, `flow` stays NULL and the image is the record.
   ============================================================ */

const MAX_IMAGE_BYTES = 200 * 1024;   // a VGA JPEG at quality 12 is ~30 kB
const REASONS = new Set(['periodic', 'press', 'boot']);

/** Timing-safe compare, so a wrong token cannot be guessed byte by byte. */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(request, env) {
  // No token configured means misconfigured, not open. Fail closed.
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return tokenMatches(header.slice(prefix.length), env.INGEST_TOKEN);
}

/** Integer query param, or null when absent or malformed. Signed: the press
    turn arrives as -80 or +39. */
function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/* Milliseconds are part of the key on purpose: two uploads in the same
   second would otherwise overwrite each other, losing an image silently. */
function imageKey(now, reason) {
  const iso = now.toISOString();                 // 2026-08-15T13:49:35.996Z
  const day = iso.slice(0, 10).replace(/-/g, '/');
  const stamp = iso.slice(0, 23).replace(/[:.]/g, '-');
  return `${day}/${stamp}-${reason}.jpg`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Unauthenticated liveness probe. Says nothing about the device.
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok\n', { headers: { 'content-type': 'text/plain' } });
    }

    /* --- Over-the-air update, pull side -------------------------------
       The device asks; the cloud never pushes. And it is told about a build
       only when a human has armed one, which is a separate command from
       publishing it. See the firmware table in schema.sql. */
    if (request.method === 'GET' && url.pathname === '/firmware') {
      if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
      const row = await env.DB.prepare(
        'SELECT version, md5, size FROM firmware WHERE armed_at IS NOT NULL LIMIT 1'
      ).first();
      // 204 also covers "the armed build is the one already running", so a
      // device that has just updated is told nothing rather than told to
      // install what it is already running.
      if (!row || row.version === url.searchParams.get('fw')) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(row),
        { headers: { 'content-type': 'application/json' } });
    }

    if (request.method === 'GET' && url.pathname === '/firmware.bin') {
      if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
      // The version is required and must still be the armed one: disarming
      // between the two requests must stop the download, not serve a build
      // nobody is standing behind any more.
      const row = await env.DB.prepare(
        'SELECT r2_key, md5, size FROM firmware WHERE armed_at IS NOT NULL AND version = ?'
      ).bind(url.searchParams.get('v') || '').first();
      if (!row) return new Response('not armed', { status: 404 });
      const object = await env.IMAGES.get(row.r2_key);
      if (!object) return new Response('firmware object missing', { status: 404 });
      // The length comes from the object, never from the row: a content-length
      // that disagrees with the body truncates or hangs the transfer before
      // the MD5 is ever checked, turning a bad publish into a mystery. If the
      // two disagree the publish itself is inconsistent — refuse it loudly
      // rather than hand a device something nobody can account for.
      if (object.size !== row.size) {
        return new Response('firmware size does not match the published record',
                            { status: 500 });
      }
      return new Response(object.body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(object.size),
          'x-MD5': row.md5,            // the header HTTPUpdate verifies against
        },
      });
    }

    if (url.pathname !== '/ingest') return new Response('not found', { status: 404 });
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
    }
    if (!authorized(request, env)) return new Response('forbidden', { status: 403 });

    const reason = url.searchParams.get('reason') || 'periodic';
    if (!REASONS.has(reason)) return new Response('bad reason', { status: 400 });

    // Reject on the declared length before reading, so an oversized body is
    // never pulled into memory. The check after the read still stands for
    // clients that send no content-length.
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      return new Response('image too large', { status: 413 });
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_IMAGE_BYTES) {
      return new Response('image too large', { status: 413 });
    }

    const now = new Date();
    let key = null;
    if (body.byteLength > 0) {
      key = imageKey(now, reason);
      await env.IMAGES.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
    }

    await env.DB.prepare(
      `INSERT INTO readings
         (received_at, reason, image_key, flow, state,
          position, step_degrees, press_degrees, uptime_s, rssi, fw, engine)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      now.toISOString(),
      reason,
      key,
      intParam(url, 'position'),
      intParam(url, 'steg'),
      intParam(url, 'tryck'),   // signed, only sent for a press
      intParam(url, 'uptime'),
      intParam(url, 'rssi'),
      (url.searchParams.get('fw') || '').slice(0, 32) || null,
      // Content hash of the engine the device was serving. Validated to the
      // shape build_webui.mjs produces rather than stored as sent: it is
      // joined against analyses.engine, and a junk value there would quietly
      // match nothing forever instead of failing loudly.
      /^[0-9a-f]{1,16}$/.test(url.searchParams.get('motor') || '')
        ? url.searchParams.get('motor') : null
    ).run();

    /* An update that has landed is no longer pending. Disarming on the
       device's own report — rather than when the download finished — means
       "armed" ends only once the new firmware has actually booted and phoned
       home, which is the event worth recording. A build that bricks the unit
       therefore stays armed, and that is correct: it never landed. */
    const fw = (url.searchParams.get('fw') || '').slice(0, 32);
    if (fw) {
      await env.DB.prepare(
        'UPDATE firmware SET armed_at = NULL WHERE armed_at IS NOT NULL AND version = ?'
      ).bind(fw).run();
    }

    return new Response(null, { status: 204 });
  },
};
