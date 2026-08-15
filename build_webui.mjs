#!/usr/bin/env node
/* ============================================================
   Inlines balldetector.js into the two companion HTML pages.

       node build_webui.mjs           write the pages
       node build_webui.mjs --check   verify only, exit 1 if out of date

   The pages must stay self-contained single files: they are opened
   straight from the filesystem on a phone, where a relative
   <script src> does not load reliably. So the engine is duplicated
   into them on purpose — but generated, never hand-maintained.

   Edit the engine in balldetector.js. Everything between the markers
   in the HTML files is overwritten without warning.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = 'balldetector.js';
const TARGETS = ['everflo_kontrollpanel.html', 'everflo_bilddiagnostik.html'];

const BEGIN = '/* === ENGINE:BEGIN — generated from balldetector.js, do not edit here === */';
const END = '/* === ENGINE:END === */';

const check = process.argv.includes('--check');
const engine = readFileSync(join(here, SOURCE), 'utf8').replace(/\n+$/, '\n');

let stale = 0;
for (const name of TARGETS) {
  const path = join(here, name);
  const html = readFileSync(path, 'utf8');

  const from = html.indexOf(BEGIN);
  const to = html.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    console.error(`${name}: markers missing or reversed — refusing to touch the file.`);
    process.exit(2);
  }

  const wanted = html.slice(0, from + BEGIN.length) + '\n' + engine + html.slice(to);
  if (wanted === html) {
    console.log(`${name}: up to date`);
    continue;
  }
  stale++;
  if (check) {
    console.error(`${name}: OUT OF DATE — run: node build_webui.mjs`);
    continue;
  }
  writeFileSync(path, wanted);
  console.log(`${name}: updated`);
}

if (check && stale) process.exit(1);

// Belt and braces: the engine must be byte-identical in both pages.
if (!check) {
  const cut = (s) => s.slice(s.indexOf(BEGIN), s.indexOf(END) + END.length);
  const [a, b] = TARGETS.map((n) => cut(readFileSync(join(here, n), 'utf8')));
  if (a !== b) {
    console.error('MISMATCH: the inlined engines differ between the two pages.');
    process.exit(3);
  }
  console.log('engine byte-identical in both pages');
}
