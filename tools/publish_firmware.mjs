#!/usr/bin/env node
/* ============================================================
   Publishes a firmware build so the unit can pull it over the air, and arms
   it so it actually will.

       node tools/publish_firmware.mjs publish <build.bin> <version>
       node tools/publish_firmware.mjs arm     <version>
       node tools/publish_firmware.mjs disarm
       node tools/publish_firmware.mjs status

   Two verbs, not one, on purpose. Publishing is safe — the build sits in R2
   and the device is never told about it. Arming is the act that lets a unit
   at a patient's home replace its own firmware, and it should cost a separate
   deliberate command. A single "deploy" would make the dangerous thing the
   easy thing.

   The device does the rest by itself: it asks once every 15 minutes, installs
   only an armed build whose version differs from its own, verifies the MD5,
   and reboots. When the new firmware boots and reports in, the ingest handler
   disarms. So a build that bricks the unit stays armed — it never landed.

   Recovery has no OTA path. There is no bootloader rollback, so a firmware
   that does not boot is fixed over USB, at her home. Before arming, flash the
   same .bin over the cable or over ArduinoOTA at least once and watch it come
   up. This tool is for the second unit-visit you avoid, not the first.

   The version MUST equal the FW_VERSION compiled into the .bin, because that
   is what the device compares against and what the disarm-on-report matches.
   The mismatch is checked below rather than trusted.
   ============================================================ */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLOUD = join(here, '..', 'cloud');
const SKETCH = join(here, '..', 'everflo_remote_control.ino');
const BUCKET = 'everflo-images';

const wrangler = (args, opts = {}) =>
  execFileSync('npx', ['wrangler', ...args], { cwd: CLOUD, encoding: 'utf8', ...opts });

/** Runs SQL and returns the rows. */
function sql(command) {
  const out = wrangler(['d1', 'execute', 'everflo', '--remote', '--json', '--command', command],
                       { stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

/** Single-quoted SQL literal. Values here are version strings and hex digests,
    but quoting them properly costs one line and removes the question. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const [verb, ...rest] = process.argv.slice(2);

if (verb === 'status') {
  const rows = sql('SELECT version, size, md5, uploaded_at, armed_at FROM firmware ORDER BY uploaded_at DESC');
  if (!rows.length) { console.log('No firmware published.'); process.exit(0); }
  console.log('version   size      uploaded              armed');
  for (const r of rows) {
    console.log(`${String(r.version).padEnd(9)} ${String(r.size).padStart(8)}  ` +
                `${r.uploaded_at.slice(0, 19).replace('T', ' ')}   ` +
                (r.armed_at ? `ARMED ${r.armed_at.slice(0, 19).replace('T', ' ')}` : '-'));
  }
  process.exit(0);
}

if (verb === 'disarm') {
  sql('UPDATE firmware SET armed_at = NULL WHERE armed_at IS NOT NULL');
  console.log('Disarmed. The device will not be offered an update.');
  process.exit(0);
}

if (verb === 'arm') {
  const version = rest[0];
  if (!version) { console.error('Usage: arm <version>'); process.exit(2); }
  const row = sql(`SELECT version FROM firmware WHERE version = ${q(version)}`)[0];
  if (!row) { console.error(`Version ${version} has not been published.`); process.exit(2); }
  // Only one row may be armed — the schema enforces it, so clear first rather
  // than collide with the unique index.
  sql('UPDATE firmware SET armed_at = NULL WHERE armed_at IS NOT NULL');
  sql(`UPDATE firmware SET armed_at = ${q(new Date().toISOString())} WHERE version = ${q(version)}`);
  console.log(`Armed ${version}.`);
  console.log('The unit will pick it up within 15 minutes and reboot into it.');
  console.log('It disarms itself once the new firmware reports in. If it never');
  console.log('does, the update did not land and recovery is over USB.');
  process.exit(0);
}

if (verb !== 'publish') {
  console.error('Usage: publish <build.bin> <version> | arm <version> | disarm | status');
  process.exit(2);
}

const [binPath, version] = rest;
if (!binPath || !version) { console.error('Usage: publish <build.bin> <version>'); process.exit(2); }

const bin = readFileSync(binPath);

/* The version the device will compare against is the one compiled into the
   image. Getting these out of step means either an update that installs
   forever or one that never installs, so check rather than trust. */
const compiled = readFileSync(SKETCH, 'utf8').match(/#define\s+FW_VERSION\s+"([^"]+)"/)?.[1];
if (compiled !== version) {
  console.error(`Refusing: FW_VERSION in the sketch is ${compiled}, you said ${version}.`);
  console.error('Publish the version that is actually compiled into the .bin.');
  process.exit(2);
}
if (!bin.subarray(0, 64 * 1024).includes(Buffer.from(version, 'ascii'))) {
  console.error(`Refusing: the string "${version}" does not appear in the image header.`);
  console.error('That usually means the .bin is stale — rebuild before publishing.');
  process.exit(2);
}

const md5 = createHash('md5').update(bin).digest('hex');
const key = `firmware/everflo-${version}.bin`;

console.log(`Uploading ${bin.length} bytes to ${key} ...`);
// Absolute: wrangler runs with cwd set to cloud/, so a path the user typed
// relative to the repo root would resolve somewhere else entirely.
wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '-J', 'eu', '--remote',
          '--file', resolve(binPath), '--content-type', 'application/octet-stream'],
         { stdio: 'inherit' });

sql(`INSERT INTO firmware (version, r2_key, md5, size, uploaded_at, armed_at)
     VALUES (${q(version)}, ${q(key)}, ${q(md5)}, ${bin.length}, ${q(new Date().toISOString())}, NULL)
     ON CONFLICT(version) DO UPDATE SET
       r2_key = excluded.r2_key, md5 = excluded.md5,
       size = excluded.size, uploaded_at = excluded.uploaded_at`);

console.log(`Published ${version}, md5 ${md5}. NOT armed.`);
console.log(`Flash it once by cable or ArduinoOTA and watch it boot, then:`);
console.log(`  node tools/publish_firmware.mjs arm ${version}`);
