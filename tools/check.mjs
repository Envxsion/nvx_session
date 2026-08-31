/**
 * ------------------------------------------------------------------
 *  Title    |  Syntax gate
 *  Ref      |  node --check, probes/ tools/ packages/ extension/
 *  ID       |  build
 * ------------------------------------------------------------------
 *  Purpose  |  Parse-check every script before a browser loads it.
 *  How      |  A parse error in a service worker fails silently: the
 *           |  worker never registers and every API probe reports
 *           |  absent, which looks like a browser lacking the API.
 *           |  Also runs the em dash sweep.
 *  Note     |  The sweep lives here, not in a one-off script, because
 *           |  the one-off looked for the character and reported zero
 *           |  while DESIGN.html carried dozens of em-dash entities
 *           |  that render as exactly that character.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
/**
 * ------------------------------------------------------------------
 *  Purpose  |  extension/ is checked for the same reason the worker
 *           |  is.
 *  Note     |  panel.js and chooser.js load as classic scripts, and a
 *           |  parse error in either is silent. The picker failing to
 *           |  parse leaves a held tab with no options and no way
 *           |  forward, worse than never holding.
 * ------------------------------------------------------------------
 */
const ROOTS = ['probes', 'tools', 'packages', 'extension'];
const SKIP = new Set(['node_modules', '.git', 'dist']);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (['.js', '.mjs'].includes(extname(e.name))) out.push(p);
  }
  return out;
}

const files = (await Promise.all(ROOTS.map((r) => walk(r)))).flat();
let failed = 0;

for (const f of files) {
  try {
    await run(process.execPath, ['--check', f]);
    console.log(`  ok    ${f}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${f}\n${e.stderr ?? e.message}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} parsed`);

// ------------------------------------------------------------- the dash sweep

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Every form that renders as an em dash, the thing
 *           |  being banned.
 *  Note     |  The en dash is left alone: it is a range, `T0-T2` or
 *           |  `300-800 MB`, and reads as one.
 * ------------------------------------------------------------------
 */
const DASHES = /—|―|&#8212;|&#x2014;|&mdash;/gi;
const TEXT = ['.md', '.html', '.css', '.js', '.mjs', '.ts', '.json'];

async function walkText(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name === 'dist-mv2') continue;
    // This file is the only one that has to contain every banned form, because
    // it is the file that lists them. Scanning it finds its own pattern.
    if (e.name === 'check.mjs') continue;
    // Inbound material rather than anything this project ships. The sweep is a
    // house style rule for text written here, and applying it to notes taken
    // from somewhere else would mean editing a source to match a preference,
    // which is the one thing a research file must not have done to it.
    if (dir === '.' && (e.name === 'docs' || e.name === 'research') && e.isDirectory()) continue;
    // The private pro submodule. It carries its own docs (some written
    // elsewhere) and verbatim overlay copies of public files; the house dash
    // style is a rule for the public tree, and the pro repo is not shipped in
    // the free build at all. Absent entirely from a free-only checkout.
    if (dir === 'src' && e.name === 'pro' && e.isDirectory()) continue;
    // The strategy plan, for the same reason: it was written elsewhere and is
    // read rather than shipped. What this project keeps of it lives in
    // DESIGN.html section 28, which the sweep does cover.
    if (dir === '.' && e.name === 'nvx_master_plan.md') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkText(p, out);
    else if (TEXT.includes(extname(e.name))) out.push(p);
  }
  return out;
}

const text = await walkText('.');
let dashes = 0;
for (const f of text) {
  const found = ((await readFile(f, 'utf8')).match(DASHES) ?? []).length;
  if (!found) continue;
  dashes += found;
  console.error(`  DASH  ${f}  ${found}`);
}
console.log(`${dashes === 0 ? '0 em dashes' : `${dashes} em dashes`} in ${text.length} text files`);

process.exit(failed || dashes ? 1 : 0);
