#!/usr/bin/env node
/* ============================================================
   Scores balldetector.js against the frames the device has actually
   uploaded — the second test set, complementing the labelled sweep that
   tools/validate_engine.mjs uses.

       node tools/score_uploads.mjs <dir>            score as committed
       node tools/score_uploads.mjs <dir> '{"YTOP":110}'   score a candidate

   <dir> holds the downloaded frames as <reading id>.jpg plus a meta.json
   listing {id, received_at, reason} — see "Fetching" below.

   Why this exists: the sweep is 25 frames from one calm morning. The uploads
   are hundreds of frames across days, lighting, and weather, and they are the
   ones that fail. But they carry no labels — so this uses the three checks the
   device's own log makes possible:

     regression  frames that read before must still read the same. Any move is
                 suspect; the picture did not change.
     anchored    between two `press` rows the knob has not moved, so a frame
                 that was refused has a known value if a neighbour in the same
                 span did read. CAUTION: this is a hypothesis, not a label.
                 A span whose value jumps with no press means the knob was
                 turned BY HAND, and then the engine is right and the anchor is
                 wrong — that happened on 2026-08-16 13:09 UTC. Look at any
                 frame this flags before believing it.
     agreement   every accepted frame within one span must agree with the
                 others. Tolerance is ~0.05 L/min, not zero: the ball floats
                 and genuinely bobs that much.

   The baseline the first two compare against is the committed engine, scored
   in the same run, so a candidate is never compared against stale numbers.

   Requires macOS `sips` and nothing else, same as validate_engine.mjs.

   Fetching (from cloud/, needs wrangler auth; -J eu and --remote are both
   required for R2 or the download silently writes empty files):

     npx wrangler d1 execute everflo --remote --json \
       --command "SELECT id, received_at, reason, image_key FROM readings" \
       | sed -n '/^\[/,$p' > meta-raw.json
     # keep the .results array as meta.json, then per row:
     npx wrangler r2 object get everflo-images/<image_key> -J eu --remote \
       --file <dir>/<id>.jpg
   ============================================================ */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const BOB = 0.05;          // how much the ball floats on its own, L/min
const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, '..', 'balldetector.js');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node tools/score_uploads.mjs <dir with <id>.jpg + meta.json> [patch]');
  process.exit(2);
}
const patch = JSON.parse(process.argv[3] || '{}');
const work = mkdtempSync(join(tmpdir(), 'everflo-uploads-'));

const toBmp = (src, name) => {
  const out = join(work, name + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', out], { stdio: 'ignore' });
  return out;
};

function readBmp(path) {
  const d = readFileSync(path), off = d.readUInt32LE(10);
  const w = d.readInt32LE(18), hRaw = d.readInt32LE(22), bpp = d.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`${path}: ${bpp} bpp, expected 24`);
  const h = Math.abs(hRaw), topDown = hRaw < 0, stride = Math.ceil((w * 3) / 4) * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = row + x * 3, t = (y * w + x) * 4;
      data[t] = d[s + 2]; data[t + 1] = d[s + 1]; data[t + 2] = d[s]; data[t + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/* Uploads are the raw landscape frame; the calibration is bound to the canvas
   the pages analyse, which is mirrored and rotated 270. Same transform as the
   admin page's orient(): canvas(xc,yc) = image(w-1-yc, h-1-xc). Feeding the
   raw frame straight in gives dx=40, dy=-40, reg 0.07 and looks exactly like a
   camera that has fallen off the wall. */
function orient(im) {
  const W = im.height, H = im.width, out = new Uint8ClampedArray(W * H * 4);
  for (let yc = 0; yc < H; yc++) for (let xc = 0; xc < W; xc++) {
    const s = ((im.height - 1 - xc) * im.width + (im.width - 1 - yc)) * 4, t = (yc * W + xc) * 4;
    out[t] = im.data[s]; out[t + 1] = im.data[s + 1]; out[t + 2] = im.data[s + 2]; out[t + 3] = 255;
  }
  return { data: out, width: W, height: H };
}

/* Rewrites one constant in the engine source.

   Only `const` declaration lines are eligible. The obvious version of this —
   one regex over the whole file — silently patches the FIRST match, and the
   comments around these constants quote them by name and value ("the old
   YTOP=60"). It then reports a candidate's numbers while running the committed
   ones. Requiring exactly one hit on a declaration line makes that impossible
   rather than merely unlikely. */
function setConst(src, name, value) {
  const lit = Array.isArray(value) ? JSON.stringify(value) : String(value);
  const re = new RegExp(`(\\b${name}\\s*=\\s*)(-?[0-9.]+(?:e[+-]?\\d+)?|\\[[^\\]]*\\])`);
  const lines = src.split('\n');
  const hits = lines.map((l, i) => (/^\s*const\b/.test(l) && re.test(l) ? i : -1))
                    .filter((i) => i >= 0);
  if (hits.length !== 1)
    throw new Error(`${name}: expected exactly one const declaration, found ${hits.length}`);
  lines[hits[0]] = lines[hits[0]].replace(re, (_, a) => a + lit);
  return lines.join('\n');
}

/** Loads the engine, optionally with constants overridden, and primes REF. */
async function load(overrides, tag) {
  let src = readFileSync(ENGINE, 'utf8');
  for (const [k, v] of Object.entries(overrides)) src = setConst(src, k, v);
  writeFileSync(join(work, `engine-${tag}.mjs`), src +
    '\nexport function __setREF(r){ REF = r; }\n' +
    'export { T,toGray,flatfield,buildRef,analyze,judge };\n');
  const E = await import(pathToFileURL(join(work, `engine-${tag}.mjs`)).href);
  const refPng = join(work, `ref-${tag}.png`);
  writeFileSync(refPng, Buffer.from(
    src.match(/const REF_PNG="data:image\/png;base64,([^"]+)"/)[1], 'base64'));
  E.__setREF(E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(refPng, 'ref' + tag))))));
  return E;
}

const meta = Object.fromEntries(
  JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).map((r) => [r.id, r]));
const ids = readdirSync(dir).filter((f) => /^\d+\.jpe?g$/.test(f))
  .map((f) => Number(f.replace(/\.jpe?g$/, ''))).sort((a, b) => a - b);
if (!ids.length) { console.error(`No <id>.jpg found in ${dir}`); process.exit(2); }

const missing = ids.filter((id) => !meta[id]);
if (missing.length) {
  console.error(`meta.json has no row for id ${missing.slice(0, 5).join(', ')}` +
                `${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
  process.exit(2);
}

const engines = [await load({}, 'base')];
if (Object.keys(patch).length) engines.push(await load(patch, 'cand'));

/* Both engines score each frame while it is decoded, then it is dropped. An
   oriented frame is 1.2 MB, so holding all of them would cost 200 MB at
   today's 164 and grow without limit as the log does. */
const runs = engines.map(() => []);
for (const id of ids) {
  const img = orient(readBmp(toBmp(join(dir, id + '.jpg'), String(id))));
  engines.forEach((E, i) => {
    const r = E.analyze(img), b = E.judge(r);
    runs[i].push({ id, at: meta[id].received_at, reason: meta[id].reason,
      ok: b.ok, title: b.title, label: b.label ?? null,
      flow: b.ok && !b.maxState && !b.bottomState ? r.flow : null,
      y: r.y, peak: r.peak, margin: r.margin, reg: r.reg, dx: r.dx, dy: r.dy, spread: r.spread });
  });
}
const base = runs[0], cand = runs[1] ?? runs[0];
const B = new Map(base.map((o) => [o.id, o])), C = new Map(cand.map((o) => [o.id, o]));

/* A span is a press frame and every non-press frame after it: one knob position. */
const spans = (rows) => {
  const out = []; let s = [];
  for (const o of rows) { if (o.reason === 'press' && s.length) { out.push(s); s = []; } s.push(o); }
  if (s.length) out.push(s);
  return out;
};

const anchor = new Map();   // id -> hypothesised truth, for frames the baseline refused
for (const s of spans(base)) {
  const ok = s.filter((o) => o.ok && o.flow != null);
  if (!ok.length) continue;
  const a = ok.reduce((t, o) => t + o.flow, 0) / ok.length;
  for (const o of s) if (!o.ok) anchor.set(o.id, a);
}

let moved = 0, worstMove = 0, worstMoveId = 0, lost = 0;
for (const [id, b] of B) {
  if (!b.ok || b.flow == null) continue;
  const c = C.get(id);
  if (!c.ok || c.flow == null) { lost++; console.log(`  LOST   id ${id} ${b.at} read ${b.flow.toFixed(2)}, now ${c.title}`); continue; }
  const d = Math.abs(c.flow - b.flow);
  if (d > 0.001) moved++;
  if (d > worstMove) { worstMove = d; worstMoveId = id; }
}

let read = 0, still = 0, sum = 0, worstErr = 0, worstErrId = 0;
const suspect = [];
for (const [id, truth] of anchor) {
  const c = C.get(id);
  if (!c.ok || c.flow == null) { still++; continue; }
  const d = Math.abs(c.flow - truth); read++; sum += d;
  if (d > worstErr) { worstErr = d; worstErrId = id; }
  if (d > 0.2) suspect.push({ id, at: c.at, truth, got: c.flow, margin: c.margin });
}

let worstSpread = 0, worstSpreadId = 0, checked = 0;
for (const s of spans(cand)) {
  const f = s.filter((o) => o.ok && o.flow != null).map((o) => o.flow);
  if (f.length < 2) continue;
  checked++;
  const sp = Math.max(...f) - Math.min(...f);
  if (sp > worstSpread) { worstSpread = sp; worstSpreadId = s[0].id; }
}

const acc = cand.filter((o) => o.ok);
const min = (sel) => acc.reduce((m, o) => Math.min(m, sel(o)), Infinity);
const max = (sel) => acc.reduce((m, o) => Math.max(m, sel(o)), -Infinity);

console.log(`\n${ids.length} uploaded frames` +
  (Object.keys(patch).length ? `, candidate ${JSON.stringify(patch)}` : ', engine as committed'));
console.log(`  read        ${acc.length}, refused ${cand.length - acc.length}` +
            ` (baseline refused ${base.filter((o) => !o.ok).length})`);
console.log(`  gates       ambiguity >= ${min((o) => o.margin).toFixed(2)}x, ` +
            `registration >= ${min((o) => o.reg).toFixed(3)}, ` +
            `contrast >= ${min((o) => o.peak).toFixed(3)}, extent <= ${max((o) => o.spread)}`);
console.log(`  regression  ${moved} of ${B.size} previously-read frames moved, ` +
            `worst ${worstMove.toFixed(3)} L/min (id ${worstMoveId}), lost ${lost}`);
console.log(`  anchored    ${anchor.size} refused frames have a same-span value: ` +
            `${read} now read, ${still} still refused` +
            (read ? `, mean |err| ${(sum / read).toFixed(3)}, worst ${worstErr.toFixed(3)} (id ${worstErrId})` : ''));
console.log(`  agreement   ${checked} spans, worst within-span spread ` +
            `${worstSpread.toFixed(3)} L/min (span starting id ${worstSpreadId})` +
            (worstSpread > BOB * 2 ? "  <- above what the ball's own bobbing explains" : ''));

if (suspect.length) {
  console.log(`\n  ${suspect.length} frame(s) disagree with their span by more than 0.2 L/min.`);
  console.log('  LOOK AT THESE PICTURES. Either the reading is wrong, or the knob was');
  console.log('  turned by hand inside the span and the anchor is the thing that is wrong.');
  for (const s of suspect)
    console.log(`    id ${s.id}  ${s.at}  span says ${s.truth.toFixed(2)}, ` +
                `engine says ${s.got.toFixed(2)} at ${s.margin.toFixed(1)}x ambiguity`);
}

/* Exit non-zero only on things that are wrong regardless of interpretation:
   a frame that used to read and no longer does, or a reading that moved on an
   unchanged picture. Anchored disagreements are printed, never fatal — the
   anchor is a hypothesis and only a human looking at the frame can settle it. */
process.exit(lost > 0 || worstMove > 0.2 ? 1 : 0);
