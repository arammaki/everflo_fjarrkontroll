/* ============================================================
   EverFlo admin UI.

   Shows the latest frame the device uploaded, the recent history, and
   the gaps. Read-only: it never writes to D1 or R2 and never talks to
   the device, so the worst a bug here can do is show something wrong,
   not change anything.

   HTTP Basic auth against a Worker secret. Chosen over Cloudflare Access
   because Access needs Zero Trust onboarding in the dashboard, while this
   is fifteen lines with no session or cookie handling to get wrong. Over
   HTTPS the credentials are inside the TLS tunnel. Swapping to Access
   later means deleting requireAuth() and enabling it on the Worker.

   The page deliberately does NOT compute a flow reading. The detection
   engine is calibrated on browser-decoded pixels and validated by a test
   suite that is not in this repo; until that path is proven, the image is
   the record and a human reads it. Download a frame and drop it into
   everflo_image_diagnostics.html to get a number with the quality gates
   applied.
   ============================================================ */

const PAGE_SIZE = 60;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function requireAuth(request, env) {
  const unauthorized = new Response('Inloggning krävs', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="EverFlo", charset="UTF-8"' },
  });
  if (!env.ADMIN_PASSWORD) return unauthorized;   // unset means closed, not open
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return unauthorized;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized;
  }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(password, env.ADMIN_PASSWORD) ? null : unauthorized;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Swedish, like everything the operator reads. */
function humanGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min sedan`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} tim ${min % 60} min sedan`;
  return `${Math.floor(h / 24)} dygn ${h % 24} tim sedan`;
}

function renderPage(rows, now) {
  const latest = rows[0];
  const age = latest ? now - Date.parse(latest.received_at) : null;
  // Uploads are every 15 min; nothing for 40 means something is wrong.
  const stale = age === null || age > 40 * 60 * 1000;

  const banner = !latest
    ? '<p class="warn">Ingen bild har kommit in än.</p>'
    : stale
      ? `<p class="warn">Senaste bilden är ${escapeHtml(humanGap(age))}.
         Enheten eller nätet kan vara nere.</p>`
      : `<p class="ok">Senaste bilden ${escapeHtml(humanGap(age))}.</p>`;

  const img = latest?.image_key
    ? `<img src="/image/${encodeURI(latest.image_key)}" alt="Senaste kamerabild">
       <p class="liten"><a href="/image/${encodeURI(latest.image_key)}" download>Ladda ner bilden</a>
       — öppna den i everflo_image_diagnostics.html för att få ett avläst värde.</p>`
    : '';

  const list = rows.map((r) => {
    const link = r.image_key
      ? `<a href="/image/${encodeURI(r.image_key)}">bild</a>`
      : '—';
    return `<tr>
      <td>${escapeHtml(r.received_at.replace('T', ' ').slice(0, 19))}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${r.position ?? '—'}</td>
      <td>${r.rssi ?? '—'}</td>
      <td>${escapeHtml(r.fw ?? '—')}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="sv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EverFlo — logg</title>
<style>
 body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0 auto;padding:16px;
      max-width:760px;background:#f4f4f2;color:#222}
 h1{font-size:1.2rem}
 img{width:100%;max-width:480px;border-radius:12px;background:#000;display:block}
 .ok{color:#1c6b3c} .warn{color:#a33;font-weight:700}
 .liten{font-size:.85rem;color:#666}
 table{border-collapse:collapse;width:100%;margin-top:18px;font-size:.9rem}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd}
 th{color:#666;font-weight:600}
</style></head><body>
<h1>EverFlo — logg</h1>
${banner}
${img}
<table>
<tr><th>Tid (UTC)</th><th>Orsak</th><th>Läge</th><th>RSSI</th><th>Version</th><th></th></tr>
${list}
</table>
<p class="liten">Bilden är facit. Den här sidan räknar inte ut något flöde —
den visar vad enheten skickat och när.</p>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const denied = requireAuth(request, env);
    if (denied) return denied;

    const url = new URL(request.url);

    if (url.pathname.startsWith('/image/')) {
      const key = decodeURI(url.pathname.slice('/image/'.length));
      const object = await env.IMAGES.get(key);
      if (!object) return new Response('not found', { status: 404 });
      return new Response(object.body, {
        headers: {
          'content-type': 'image/jpeg',
          // Keys are unique per upload, so a stored frame never changes.
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    }

    if (url.pathname !== '/') return new Response('not found', { status: 404 });

    const { results } = await env.DB.prepare(
      `SELECT received_at, reason, image_key, flow, state, position, rssi, fw
         FROM readings ORDER BY received_at DESC LIMIT ?`
    ).bind(PAGE_SIZE).all();

    return new Response(renderPage(results, Date.now()), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
