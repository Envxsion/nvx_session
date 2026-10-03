/**
 * ------------------------------------------------------------------
 *  Title    |  Store packages
 *  Ref      |  tools/build.mjs
 *  ID       |  package
 * ------------------------------------------------------------------
 *  Purpose  |  Upload-ready zips for every store, in one command.
 *  How      |  Builds each target fresh, then zips its folder with a
 *           |  minimal ZIP writer on node's own zlib (no dependency).
 *           |   chrome   dist-store    Chrome Web Store, Edge Add-ons,
 *           |                          Opera add-ons (MV3); Brave,
 *           |                          Vivaldi and Arc install from the
 *           |                          Chrome Web Store
 *           |   firefox  dist-firefox  addons.mozilla.org
 *           |  NVX_TIER=pro builds the Pro packages instead; the
 *           |  licence and telemetry env vars pass through to build.mjs.
 *  Usage    |  node tools/package.mjs [chrome] [firefox]
 *           |  -> release/nvx-session-<target>[-pro]-<version>.zip
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = {
  chrome: { flag: '--store', dir: 'dist-store' },
  firefox: { flag: '--firefox', dir: 'dist-firefox' },
};
const wanted = process.argv.slice(2).filter((a) => a in TARGETS);
const targets = wanted.length ? wanted : Object.keys(TARGETS);
const OUT = join(ROOT, 'release');
mkdirSync(OUT, { recursive: true });

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** DOS date and time for the ZIP headers. A fixed stamp keeps builds reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A plain ZIP (deflate, no zip64), which every store
 *           |  accepts.
 *  Note     |  Source maps are left out: they are for local debugging
 *           |  and only make the upload larger.
 * ------------------------------------------------------------------
 */
function zip(dir) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of walk(dir)) {
    if (file.endsWith('.map')) continue;
    const name = Buffer.from(relative(dir, file).split('\\').join('/'), 'utf8');
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const crc = crc32(data) >>> 0;

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // utf-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = central.length / 2;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdir, end]);
}

for (const target of targets) {
  const { flag, dir } = TARGETS[target];
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build.mjs'), flag], { cwd: ROOT, stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'manifest.json'), 'utf8'));
  const pro = process.env.NVX_TIER === 'pro' ? '-pro' : '';
  const file = join(OUT, `nvx-session-${target}${pro}-${manifest.version}.zip`);
  const bytes = zip(join(ROOT, dir));
  writeFileSync(file, bytes);
  console.log(`${target}: ${relative(ROOT, file)} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
