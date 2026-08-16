/* ============================================================
   EverFlo admin UI.

   Shows the latest frame the device uploaded, the recent history, and
   the gaps. It never talks to the device, and it never touches R2.

   It does write to D1, but only ever INSERTs into `analyses`, never a
   single column of `readings`. Nothing the device recorded can be altered
   from here, so a bug in this file can produce a wrong reading but cannot
   destroy the record the reading was derived from. That boundary is
   deliberate; keep it.

   A frame has one reading PER ENGINE, not one reading. Recomputing later with
   a recalibrated engine adds a row beside the old one rather than replacing
   it, so "what did engine A say about this frame" stays answerable forever.

   What the page CANNOT tell you is what the patient's phone showed when the
   frame arrived. Nothing records which engine was live then: `readings.fw` is
   the firmware version, and the engine is bundled into a firmware build but
   never reported separately. So the older column is labelled "Tidigare motor",
   not "då" — it means an earlier engine looked at this frame, which is only
   the same thing as history if someone analysed it back then.

   Guarded by Cloudflare Access (enabled on the Worker 2026-08-15, policy:
   members of this Cloudflare account). Access authenticates before the
   request reaches this code, so there is no password here to get wrong.

   The header check below is not authentication — Access already did that.
   It is a fail-closed guard: if Access is ever removed from this Worker,
   the page refuses to serve rather than silently becoming public. Someone
   who can reach the Worker with Access disabled could forge the header,
   so it protects against accident, not against an attacker.

   The reading is computed IN THE BROWSER (added 2026-08-16), by the same
   engine the phone runs, served at /motor.js. That is the one place the
   calibration is valid: it was fitted on browser-decoded pixels. Running
   it server-side would need a second JPEG decoder proven to agree, which
   is why the ingest Worker still stores `flow` as NULL and the image
   stays the record.

   Every stored reading carries the content hash of the engine that made
   it, so recomputing an old frame with a newer engine is visible rather
   than silent — the page marks rows whose reading came from a different
   engine than the one now loaded.

   MIND THE ORIENTATION. Uploaded frames are the raw sensor image, 640x480
   landscape. The calibration is bound to the canvas the two pages build:
   mirrored, then rotated 270, giving 480x640. Feeding the raw frame to
   the engine scores about 0.07 on registration and reads nothing at all —
   which is exactly the wrong turn taken on 2026-08-16 while debugging a
   real outage, and it looked like the camera had moved.
   ============================================================ */

import { ENGINE, ENGINE_VERSION } from './engine.js';

const PAGE_SIZE = 200;
const STATES = new Set(['ok', 'max', 'below', 'uncertain', 'no-reading']);

function requireAccess(request) {
  if (request.headers.get('cf-access-jwt-assertion')) return null;
  return new Response(
    'Den här sidan ska skyddas av Cloudflare Access, men anropet kom fram utan ' +
    'Access-identitet. Sidan visas inte förrän det är utrett.',
    { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
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

/** What the table shows for a stored reading. Same shape as the client's. */
function label(flow, state) {
  if (!state) return '·';
  if (state === 'ok') return flow == null ? '?' : flow.toFixed(2);
  if (state === 'max') return 'Max';
  if (state === 'below') return 'Under 0,3';
  if (state === 'uncertain') return 'osäker';
  return 'nej';
}
const good = (state) => state === 'ok' || state === 'max' || state === 'below';

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

  const list = rows.map((r, i) => {
    // Signed, so the direction of the turn reads at a glance.
    const turn = r.press_degrees == null ? '—'
      : `<span class="${r.press_degrees > 0 ? 'up' : 'down'}">` +
        `${r.press_degrees > 0 ? '+' : ''}${r.press_degrees}°</span>`;
    const daText = label(r.flow_da, r.state_da);
    const nuText = label(r.flow_nu, r.state_nu);
    // Only interesting when a recalibration actually changed the answer.
    // engine_da is a different engine by construction, so a difference here is
    // always a recalibration changing the answer for an unchanged picture.
    const changed = r.state_da && r.state_nu && daText !== nuText;
    return `<tr tabindex="-1" data-i="${i}" data-id="${r.id}"
      data-key="${escapeHtml(r.image_key || '')}"
      data-nu="${r.state_nu ? '1' : ''}"
      data-tid="${escapeHtml(r.received_at)}" data-orsak="${escapeHtml(r.reason)}"
      data-vrid="${r.press_degrees == null ? '' : r.press_degrees}"
      data-lage="${r.position ?? ''}" data-rssi="${r.rssi ?? ''}"
      data-fw="${escapeHtml(r.fw ?? '')}">
      <td class="t">${escapeHtml(r.received_at.replace('T', ' ').slice(0, 19))}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td class="num">${turn}</td>
      <td class="num">${r.rssi ?? '—'}</td>
      <td class="avl da ${r.state_da ? (good(r.state_da) ? 'good' : 'bad') : ''}"
          title="${r.engine_da ? 'Motor ' + escapeHtml(r.engine_da) : ''}"
          >${escapeHtml(daText)}</td>
      <td class="avl nu ${r.state_nu ? (good(r.state_nu) ? 'good' : 'bad') : ''} ${changed ? 'andrad' : ''}"
          title="${changed ? 'Ändrat: motor ' + escapeHtml(r.engine_da) + ' gav ' + escapeHtml(daText) : ''}"
          >${escapeHtml(nuText)}</td>
    </tr>`;
  }).join('');

  const pending = rows.filter((r) => r.image_key && !r.state_nu).length;

  return `<!DOCTYPE html><html lang="sv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EverFlo — logg</title>
<style>
 :root{--ok:#1c6b3c;--warn:#a33;--line:#ddd;--muted:#666}
 *{box-sizing:border-box}
 body{font-family:-apple-system,Helvetica,Arial,sans-serif;margin:0 auto;padding:16px;
      max-width:1080px;background:#f4f4f2;color:#222}
 h1{font-size:1.2rem;margin:0 0 8px}
 .ok{color:var(--ok)} .warn{color:var(--warn);font-weight:700}
 .liten{font-size:.85rem;color:var(--muted)}
 /* Preview on the left, everything the engine says on the right. */
 .top{display:flex;gap:18px;align-items:flex-start;margin:10px 0 6px}
 .shot{flex:0 0 290px}
 canvas{width:100%;height:auto;border-radius:12px;background:#000;display:block}
 .info{flex:1 1 auto;min-width:0}
 #flow{font-size:2.6rem;font-weight:800;color:var(--ok);line-height:1.05}
 #flow.none{color:var(--warn);font-size:1.5rem}
 #flow.warn{color:#b8860b}
 #flow small{font-size:1rem;color:var(--muted);font-weight:400}
 #reason{margin:4px 0 10px;color:var(--warn);min-height:1.2em;font-size:.9rem}
 #meta{color:var(--muted);font-size:.85rem;margin-bottom:10px}
 .chips{display:flex;flex-wrap:wrap;gap:6px}
 .chip{font-size:.78rem;background:#fff;border:1px solid var(--line);border-radius:20px;
       padding:4px 10px;font-variant-numeric:tabular-nums}
 .chip b{font-weight:700;color:var(--warn)}
 .bar{display:flex;gap:8px;align-items:center;margin:10px 0 4px;flex-wrap:wrap}
 button{font:inherit;padding:6px 12px;border:1px solid var(--line);background:#fff;
        border-radius:8px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 table{border-collapse:collapse;width:100%;margin-top:6px;font-size:.9rem}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
 th{color:var(--muted);font-weight:600;position:sticky;top:0;background:#f4f4f2}
 tbody tr{cursor:pointer}
 tbody tr:hover{background:#ececea}
 tbody tr.sel{background:#dfe9e2;box-shadow:inset 3px 0 0 var(--ok)}
 td.num,td.avl{text-align:right;font-variant-numeric:tabular-nums}
 td.t{white-space:nowrap}
 td.avl{color:var(--muted)}
 td.avl.bad{color:var(--warn)} td.avl.good{color:var(--ok);font-weight:600}
 /* The historical reading is context, not the answer, so it sits back. */
 td.avl.da{opacity:.6;font-style:italic}
 /* A frame that reads differently now than it did then. */
 td.avl.andrad{box-shadow:inset 0 -2px 0 #b8860b}
 .wrap{max-height:58vh;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
 @media (max-width:720px){ .top{flex-direction:column} .shot{flex:1 1 auto;width:100%;max-width:320px} }
</style></head><body>
<h1>EverFlo — logg</h1>
${banner}

<div class="top">
  <div class="shot"><canvas id="cv" width="480" height="640"></canvas></div>
  <div class="info">
    <div id="flow">–<small> L/min</small></div>
    <div id="reason"></div>
    <div id="meta"></div>
    <div class="chips" id="chips"></div>
  </div>
</div>

<div class="bar">
  <button id="prev">↑ Föregående</button>
  <button id="next">↓ Nästa</button>
  <button id="all">${pending ? `Analysera ${pending} rader` : 'Alla är analyserade'}</button>
  <button id="allt">Räkna om alla</button>
  <span class="liten" id="progress"></span>
</div>
<p class="liten">Klicka på en rad eller stega med piltangenterna. Avläsningen räknas ut
här i webbläsaren av motorn <code>${ENGINE_VERSION}</code> och sparas per motorversion.
<em>Tidigare motor</em> är tom tills en annan motorversion analyserat samma bild — den
visar inte vad enheten läste när bilden kom in, för det vet sidan inte. Gul understrykning
betyder att en omkalibrering ändrat svaret för en bild som inte ändrats.</p>

<div class="wrap">
<table>
<thead><tr><th>Tid (UTC)</th><th>Orsak</th><th>Vridning</th><th>RSSI</th>
<th title="Äldsta värdet från en ANNAN motorversion. Tomt om bara en motor sett bilden.">Tidigare motor</th>
<th title="Värdet från motorn som körs nu">Avläst</th></tr></thead>
<tbody id="rows">
${list}
</tbody>
</table>
</div>

<p class="liten">Bilden är facit. Siffran är en bekvämlighet ovanpå den, och motorn
säger hellre ifrån än gissar.</p>

<script src="/motor.js?v=${ENGINE_VERSION}"></script>
<script>
const MOTOR=${JSON.stringify(ENGINE_VERSION)};
const cv=document.getElementById('cv'), ctx=cv.getContext('2d',{willReadFrequently:true});
const rows=[...document.querySelectorAll('#rows tr')];
let sel=-1, refReady=false;

/* The uploaded frames are the RAW sensor image, 640x480 landscape. The
   calibration is bound to the canvas both pages build — mirrored, rotated 270
   — so the same transform has to happen here or every frame scores 0.07 on
   registration and nothing reads. It is also what makes the preview upright. */
function orient(img){
  const t=document.createElement('canvas');
  t.width=img.naturalHeight; t.height=img.naturalWidth;
  const tx=t.getContext('2d',{willReadFrequently:true});
  tx.translate(t.width/2,t.height/2);
  tx.scale(-1,1);
  tx.rotate(270*Math.PI/180);
  tx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);
  return t;
}
const load=(key)=>new Promise((res,rej)=>{
  const im=new Image(); im.onload=()=>res(im); im.onerror=()=>rej(new Error('bild saknas'));
  im.src='/image/'+key.split('/').map(encodeURIComponent).join('/');
});
function show(text,unit,cls){
  const el=document.getElementById('flow');
  el.className=cls||''; el.innerHTML=text+(unit?'<small> '+unit+'</small>':'');
}
function chips(r){
  const f=(name,val,ok)=>'<span class="chip">'+name+' '+(ok?val:'<b>'+val+'</b>')+'</span>';
  document.getElementById('chips').innerHTML=
    f('kontrast',r.peak.toFixed(3),r.peak>=T.contrast)+
    f('entydighet',r.margin.toFixed(1)+'×',r.margin>=T.margin)+
    f('passning',r.reg.toFixed(2),r.reg>=T.reg)+
    f('skift',r.dx.toFixed(1)+'/'+r.dy.toFixed(1)+' px',Math.abs(r.dx)<=20&&Math.abs(r.dy)<=20)+
    f('lutning',(r.tilt*57.3).toFixed(1)+'°',true)+
    f('utbredning',r.spread,r.spread<=T.spread);
}
/* One shape for both the table cell and the row written to the database. */
function verdict(r,b){
  if(!b.ok) return {state:b.title==='Osäker avläsning'?'uncertain':'no-reading',
                    flow:null, txt:b.title==='Osäker avläsning'?'osäker':'nej', cls:'bad'};
  if(b.maxState)    return {state:'max',   flow:null, txt:b.label, cls:'good'};
  if(b.bottomState) return {state:'below', flow:null, txt:b.label, cls:'good'};
  return {state:'ok', flow:r.flow, txt:r.flow.toFixed(2), cls:'good'};
}
async function analyse(tr,{draw}={}){
  const im=await load(tr.dataset.key);
  const t=orient(im);
  if(draw){ ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(t,0,0,480,640); }
  const src=(draw?ctx:t.getContext('2d',{willReadFrequently:true})).getImageData(0,0,480,640);
  const r=analyze(src);
  return {r, b:judge(r)};
}
function paint(tr,v){
  const td=tr.querySelector('.avl.nu');
  td.textContent=v.txt; td.className='avl nu '+v.cls;
  /* Never write into the earlier column. It holds what a DIFFERENT engine
     said, and this engine analysing a frame for the first time is not that —
     filling it in would manufacture a comparison that never happened. */
  const da=tr.querySelector('.avl.da');
  const before=da.textContent.trim();
  if(before!=='·' && before!==v.txt){
    td.classList.add('andrad');
    td.title='Ändrat: en tidigare motor gav '+before;   // the marker is a colour otherwise
  }
  tr.dataset.nu='1';
}
/* Saved in batches: 200 rows would otherwise be 200 round trips. */
let queue=[];
async function flush(){
  if(!queue.length) return;
  const batch=queue; queue=[];
  try{
    await fetch('/analys',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(batch)});
  }catch(e){ /* the reading is still on screen; the next run retries */ }
}
function remember(tr,r,v){
  queue.push({id:Number(tr.dataset.id), flow:v.flow, state:v.state, engine:MOTOR,
    quality:{reg:+r.reg.toFixed(3), peak:+r.peak.toFixed(3), margin:+r.margin.toFixed(1),
             dx:+r.dx.toFixed(1), dy:+r.dy.toFixed(1), spread:r.spread}});
  if(queue.length>=25) flush();
}
async function select(i,{scroll}={}){
  if(i<0||i>=rows.length) return;
  rows.forEach(t=>t.classList.remove('sel'));
  const tr=rows[i]; tr.classList.add('sel'); sel=i;
  if(scroll) tr.scrollIntoView({block:'nearest'});
  document.getElementById('meta').textContent=
    tr.dataset.tid.replace('T',' ').slice(0,19)+' UTC · '+tr.dataset.orsak+
    (tr.dataset.vrid?' · vridning '+(tr.dataset.vrid>0?'+':'')+tr.dataset.vrid+'°':'')+
    (tr.dataset.rssi?' · '+tr.dataset.rssi+' dBm':'')+
    (tr.dataset.fw?' · v'+tr.dataset.fw:'');
  document.getElementById('reason').textContent='';
  if(!tr.dataset.key){ show('–','','none');
    document.getElementById('reason').textContent='Raden har ingen bild.';
    document.getElementById('chips').innerHTML=''; return; }
  show('…','','');
  try{
    if(!refReady){ await loadRef(); refReady=true; }
    const {r,b}=await analyse(tr,{draw:true});
    chips(r);
    document.getElementById('reason').textContent=b.reason||'';
    const v=verdict(r,b);
    if(!b.ok) show(b.title,'','none');
    else if(b.maxState) show(b.label,'över skalans slut','warn');
    else if(b.bottomState) show(b.label,'L/min','warn');
    else show(r.flow.toFixed(2),'L/min'+(b.extrapolated?' (osäkert)':''));
    paint(tr,v); remember(tr,r,v); flush();
  }catch(e){
    show('Ingen avläsning','','none');
    document.getElementById('reason').textContent='Bilden kunde inte läsas eller analyseras.';
    document.getElementById('chips').innerHTML='';
  }
}
rows.forEach((tr,i)=>tr.addEventListener('click',()=>select(i)));
document.getElementById('prev').onclick=()=>select(sel-1,{scroll:true});
document.getElementById('next').onclick=()=>select(sel+1,{scroll:true});
addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='j'){ e.preventDefault(); select(sel+1,{scroll:true}); }
  if(e.key==='ArrowUp'||e.key==='k'){ e.preventDefault(); select(sel-1,{scroll:true}); }
});
/* Sequential on purpose: the flatfield is real work and firing 200 of them at
   once would lock the tab. Skips rows this engine has already done, unless
   asked to redo everything. */
async function sweep(force){
  const a=document.getElementById('all'), b=document.getElementById('allt');
  const prog=document.getElementById('progress');
  a.disabled=b.disabled=true;
  if(!refReady){ await loadRef(); refReady=true; }
  const todo=rows.filter(tr=>tr.dataset.key && (force || !tr.dataset.nu));
  let n=0, failed=0;
  for(const tr of todo){
    prog.textContent=(++n)+' / '+todo.length;
    try{
      const {r,b:jb}=await analyse(tr);
      const v=verdict(r,jb);
      paint(tr,v); remember(tr,r,v);
      if(!jb.ok) failed++;
    }catch(e){
      const td=tr.querySelector('.avl.nu'); td.textContent='fel'; td.className='avl nu bad';
      failed++;
    }
    await new Promise(r=>setTimeout(r,0));   // let the page repaint
  }
  await flush();
  prog.textContent=todo.length+' analyserade, '+failed+' utan avläsning';
  a.disabled=b.disabled=false; a.textContent='Alla är analyserade';
}
document.getElementById('all').onclick=()=>sweep(false);
document.getElementById('allt').onclick=()=>sweep(true);
addEventListener('beforeunload',()=>{ if(queue.length) navigator.sendBeacon('/analys',
  new Blob([JSON.stringify(queue)],{type:'application/json'})); });
if(rows.length) select(0);
</script>
</body></html>`;
}

/* Rebuilt field by field rather than stored as the client sent it. Truncating
   a JSON string to a length limit can cut it mid-value, and this column exists
   to be read back during an investigation months later — corrupt JSON there
   fails exactly when it is needed. Six known numbers are bounded by
   construction and always parse. */
const QUALITY = { reg: 3, peak: 3, margin: 1, dx: 1, dy: 1, spread: 0 };
function cleanQuality(q) {
  if (!q || typeof q !== 'object') return null;
  const out = {};
  for (const [k, dp] of Object.entries(QUALITY)) {
    const v = q[k];
    if (Number.isFinite(v) && Math.abs(v) < 1e6) out[k] = Number(v.toFixed(dp));
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Validates one client-supplied reading. Anything odd is dropped, not stored. */
function clean(x) {
  if (!x || !Number.isInteger(x.id) || x.id <= 0) return null;
  if (!STATES.has(x.state)) return null;
  const flow = x.flow == null ? null
    : (Number.isFinite(x.flow) && x.flow >= -1 && x.flow <= 20 ? x.flow : null);
  if (x.state === 'ok' && flow == null) return null;
  // The build hash, nothing else: `engine` is the dimension the whole
  // then-versus-now comparison is indexed by, and a junk value there is a
  // phantom engine that never existed.
  const engine = typeof x.engine === 'string' && /^[0-9a-f]{1,16}$/.test(x.engine)
    ? x.engine : null;
  if (!engine) return null;
  return { id: x.id, flow, state: x.state, engine, quality: cleanQuality(x.quality) };
}

export default {
  async fetch(request, env) {
    const denied = requireAccess(request);
    if (denied) return denied;

    const url = new URL(request.url);

    /* The detection engine, straight from the bundle. Versioned in the URL so a
       rebuild reaches the browser, immutable so it is fetched once — the same
       trick the device uses for its own copy. */
    if (url.pathname === '/motor.js') {
      return new Response(ENGINE, {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    }

    /* Readings computed in the browser, written back. Only these five columns,
       only by row id — see the note at the top of the file. */
    if (url.pathname === '/analys') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
      }
      /* Access says WHO the caller is, not which page made the call. Without
         this, a site the logged-in operator happens to visit could post
         readings with their session. sendBeacon sends Origin too, so the
         flush on unload still works; non-browser callers must set it. */
      if (request.headers.get('origin') !== url.origin) {
        return new Response('bad origin', { status: 403 });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
      if (!Array.isArray(body) || body.length > 300) {
        return new Response('bad body', { status: 400 });
      }
      const items = body.map(clean).filter(Boolean);
      if (!items.length) return new Response(null, { status: 204 });
      const now = new Date().toISOString();
      /* Upsert on (reading_id, engine): re-running the same engine refreshes
         its row, a different engine gets its own. Never touches `readings`. */
      const stmt = env.DB.prepare(
        `INSERT INTO analyses (reading_id, engine, flow, state, quality, analysed_at)
              VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(reading_id, engine) DO UPDATE SET
              flow = excluded.flow, state = excluded.state,
              quality = excluded.quality, analysed_at = excluded.analysed_at`
      );
      await env.DB.batch(items.map((i) =>
        stmt.bind(i.id, i.engine, i.flow, i.state, i.quality, now)));
      return new Response(JSON.stringify({ stored: items.length }), {
        headers: { 'content-type': 'application/json' },
      });
    }

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

    /* Two readings per row: what this engine says, and the earliest reading
       from some OTHER engine. The `engine <> ?1` matters — without it a frame
       analysed once fills both columns with the same number, which reads as
       "it said this then and says this now" when nothing was ever compared. */
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.received_at, r.reason, r.image_key,
              r.position, r.press_degrees, r.rssi, r.fw,
              n.flow AS flow_nu, n.state AS state_nu,
              f.flow AS flow_da, f.state AS state_da, f.engine AS engine_da
         FROM readings r
         LEFT JOIN analyses n ON n.reading_id = r.id AND n.engine = ?1
         LEFT JOIN analyses f ON f.reading_id = r.id AND f.engine <> ?1
              AND f.analysed_at = (SELECT MIN(analysed_at) FROM analyses
                                    WHERE reading_id = r.id AND engine <> ?1)
        ORDER BY r.received_at DESC LIMIT ?2`
    ).bind(ENGINE_VERSION, PAGE_SIZE).all();

    return new Response(renderPage(results, Date.now()), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};
