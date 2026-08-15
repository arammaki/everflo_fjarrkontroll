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

/** Integer query param, or null when absent or malformed. */
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
          position, step_degrees, uptime_s, rssi, fw)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
    ).bind(
      now.toISOString(),
      reason,
      key,
      intParam(url, 'position'),
      intParam(url, 'steg'),
      intParam(url, 'uptime'),
      intParam(url, 'rssi'),
      (url.searchParams.get('fw') || '').slice(0, 32) || null
    ).run();

    return new Response(null, { status: 204 });
  },
};
