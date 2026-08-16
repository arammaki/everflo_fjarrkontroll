#!/usr/bin/env node
/* ============================================================
   Runs the real balldetector.js against a directory of labelled
   images and reports the error against the label in each filename.

       node tools/validate_engine.mjs ~/Downloads

   Run this after ANY change to balldetector.js. The engine reads oxygen
   flow for a patient; a refactor that looks harmless can move a number or
   silently disable a quality gate, and neither shows up in a diff.

   Requires macOS `sips` (built in) and nothing else — no npm packages,
   no browser. Files must be named bild_<flow>L_<timestamp>.jpg, where
   <flow> is the reading, optionally followed by "max" for the frame
   with the knob at its stop, which must read as Max and not as a number.

   Two honest limitations:

   - The JPEG is decoded by sips, not by a browser. Measured 2026-08-15
     the difference does not matter (mean error 0.045, worst 0.133 against
     the labels, same ballpark as the browser-based suite), but this is
     not proof that the two decoders agree everywhere.
   - The embedded reference image was built from a sweep that includes
     these frames, so this is not leave-one-out. It catches regressions;
     it does not measure generalisation.

   Exits non-zero when an image is rejected or read more than 0.2 L/min
   off its label, so it works as a gate before committing.
   ============================================================ */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const TOLERANCE = 0.2;
const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, '..', 'balldetector.js');

const imageDir = process.argv[2];
if (!imageDir) {
  console.error('Usage: node tools/validate_engine.mjs <directory with bild_*.jpg>');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'everflo-validate-'));
const toBmp = (src, name) => {
  const out = join(work, name + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', out], { stdio: 'ignore' });
  return out;
};

/* The engine file is used as-is. It only gets a REF setter appended,
   because loadRef() needs Image and canvas, which Node does not have. */
const src = readFileSync(ENGINE, 'utf8');
writeFileSync(join(work, 'engine.mjs'), src +
  '\nexport function __setREF(r){ REF = r; }\n' +
  'export { T,toGray,flatfield,buildRef,analyze,judge };\n');
const E = await import(pathToFileURL(join(work, 'engine.mjs')).href);

/** 24-bit uncompressed BMP, either row order. */
function readBmp(path) {
  const d = readFileSync(path);
  const off = d.readUInt32LE(10);
  const w = d.readInt32LE(18);
  const hRaw = d.readInt32LE(22);
  const bpp = d.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`${path}: ${bpp} bpp, expected 24`);
  const h = Math.abs(hRaw), topDown = hRaw < 0;
  const stride = Math.ceil((w * 3) / 4) * 4;
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

// Rebuild REF the way loadRef() does, from the engine's own embedded PNG.
const refPng = join(work, 'ref.png');
writeFileSync(refPng, Buffer.from(
  src.match(/const REF_PNG="data:image\/png;base64,([^"]+)"/)[1], 'base64'));
E.__setREF(E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(refPng, 'ref'))))));

const files = readdirSync(imageDir)
  .filter((f) => /^bild_([0-9.]+)(?:max)?L_.*\.jpe?g$/i.test(f)).sort();
if (!files.length) {
  console.error(`No bild_*.jpg found in ${imageDir}`);
  process.exit(2);
}

console.log('label   read   diff  | contrast  unamb  match  shift  spread | verdict');
let sum = 0, n = 0, worst = 0, failures = 0;

for (const f of files) {
  const m = f.match(/^bild_([0-9.]+)(max)?L_/i);
  const label = m[1], isMax = !!m[2];
  const r = E.analyze(readBmp(toBmp(join(imageDir, f), label)));
  const b = E.judge(r);
  const verdict = !b.ok ? 'REJECTED' : b.maxState ? 'Max' : b.bottomState ? 'Below 0.5' : 'ok';

  let diff = '';
  if (!isMax) {
    if (verdict !== 'ok') { failures++; }
    else {
      const d = r.flow - Number(label);
      diff = (d >= 0 ? '+' : '') + d.toFixed(2);
      sum += Math.abs(d); n++; worst = Math.max(worst, Math.abs(d));
      if (Math.abs(d) > TOLERANCE) failures++;
    }
  } else if (verdict !== 'Max') {
    failures++;   // the top mark must read as Max, never as a number
  }

  console.log(
    `${label.padEnd(6)} ${verdict === 'ok' ? r.flow.toFixed(2).padStart(5) : '  -  '} ${diff.padStart(6)} |` +
    ` ${r.peak.toFixed(3).padStart(8)} ${r.margin.toFixed(1).padStart(5)}x ${r.reg.toFixed(2).padStart(6)}` +
    ` ${r.dy.toFixed(1).padStart(6)} ${String(r.spread).padStart(7)} | ${verdict}` +
    (verdict === 'REJECTED' ? ' - ' + b.reason.slice(0, 50) : ''));
}

console.log(`\nmean ${(sum / n).toFixed(3)} L/min, worst ${worst.toFixed(3)}, ` +
            `${n} read, ${failures} outside tolerance or rejected`);
process.exit(failures ? 1 : 0);
