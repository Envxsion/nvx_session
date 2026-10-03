/**
 * ------------------------------------------------------------------
 *  Title    |  Build the extension
 *  Ref      |  tsc, dist/, manifest.json
 *  ID       |  build
 * ------------------------------------------------------------------
 *  Purpose  |  Assembles the loadable extension.
 *  How      |  tsc emits ES modules into dist/src that an MV3 worker
 *           |  declared type "module" loads directly. No bundler, so
 *           |  the unpacked build stays inspectable, no toolchain.
 *  Author   |  Ojas Kekre, 25/08/2026
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What the listing says. Bumped by hand, because a release is a decision. */
const STORE_VERSION = '1.0.0';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Two builds, one codebase.
 *  How      |  MV3 is the default and the Web Store target. MV2 is
 *           |  the Opera path: a persistent background page and a
 *           |  blocking listener, which drops the rule ceiling and
 *           |  the flush race. src/ is shared, chosen at runtime.
 *  Note     |  build.mjs -> dist/ ; build.mjs --mv2 -> dist-mv2/
 * ------------------------------------------------------------------
 */
const mv2 = process.argv.includes('--mv2');
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The listing build, as section 19 scoped it.
 *  How      |  Three store facts. `debugger` moves from permissions
 *           |  to optional_permissions (its prompt is the most
 *           |  scrutinised, only Exact mode uses it, off by default).
 *           |  The `key` comes out, since the store issues its own
 *           |  id. The version gets a real number, not 0.1.0.
 *  Note     |  node tools/build.mjs --store -> dist-store/
 * ------------------------------------------------------------------
 */
const store = process.argv.includes('--store');
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The Firefox package (addons.mozilla.org).
 *  How      |  The MV3 manifest, reshaped for Gecko: an event page
 *           |  (background.scripts) instead of a service worker, the
 *           |  blocking webRequest permission Firefox kept in MV3 (the
 *           |  worker then picks the blocking backend, see
 *           |  blockingIsReal), a gecko id, and no Chromium-only keys.
 *           |  Always a store-shaped build: no key, no debugger.
 *  Note     |  node tools/build.mjs --firefox -> dist-firefox/
 * ------------------------------------------------------------------
 */
const firefox = process.argv.includes('--firefox');
const DIST = join(ROOT, firefox ? 'dist-firefox' : mv2 ? 'dist-mv2' : store ? 'dist-store' : 'dist');

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The build tier, computed here because the compile
 *           |  step needs it and the manifest block stamps it.
 *  How      |  A Pro build swaps in the private overlay and points
 *           |  the gate at the submodule. An explicit NVX_TIER always
 *           |  wins; else --store is free, any other build is dev.
 * ------------------------------------------------------------------
 */
const explicitTier = process.env.NVX_TIER;
const tier =
  explicitTier === 'pro' ? 'pro' : explicitTier === 'free' ? 'free' : store || firefox ? 'free' : 'dev';

/**
 * What the worker needs to know about this build: tier, telemetry endpoint and
 * licence material. Written as a compiled module (dist/src/build-config.js),
 * not as manifest keys, which the browser lists as unrecognised.
 */
const BUILD_CONFIG = { tier, telemetryEndpoint: null, reportEndpoint: null, license: null };

// Problem reports. Set like the telemetry endpoint, and https only.
if (process.env.NVX_REPORT_URL) {
  if (!/^https:\/\//.test(process.env.NVX_REPORT_URL)) {
    throw new Error(`NVX_REPORT_URL must be https, got: ${process.env.NVX_REPORT_URL}`);
  }
  BUILD_CONFIG.reportEndpoint = process.env.NVX_REPORT_URL;
}
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the private `pro` submodule is checked out.
 *  Note     |  A free-only clone has an empty src/pro, so even a dev
 *           |  build there falls back to the free stubs rather than
 *           |  failing to find the overlay. This lets the public repo
 *           |  build with no submodule and no toolchain surprises.
 * ------------------------------------------------------------------
 */
const proPresent = existsSync(join(ROOT, 'src', 'pro', 'index.ts'));
const useProCode = (tier === 'pro' || tier === 'dev') && proPresent;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log(`compiling (tier ${tier}${useProCode ? ', pro code' : ', free code'})`);

// A Pro or dev build with the submodule present compiles the real feature code:
// the gate points at the submodule, and the two standalone MAIN-world scripts
// (the shim's IndexedDB isolation and the mask's persona fabrication, which
// cannot import and so cannot be seamed) are swapped in from src/pro/overlay.
// The swap is temporary and restored in the finally below, so the committed
// working tree stays the free product even if the build throws. A free or store
// build, or any build with no submodule, compiles the free tree and then strips
// src/pro from the output, so it cannot carry Pro code even as dead modules.
const PRO_GATE = "export * from '../pro/index.js';\n";
let swaps = [];
if (useProCode) {
  try {
    swaps = [
      ['src/kernel/pro.ts', PRO_GATE],
      ['src/content/shim.ts', readFileSync(join(ROOT, 'src/pro/overlay/content/shim.ts'), 'utf8')],
      ['src/mask/index.ts', readFileSync(join(ROOT, 'src/pro/overlay/mask/index.ts'), 'utf8')],
    ];
  } catch (e) {
    throw new Error(
      `Pro build: a src/pro/overlay file is missing, check the pro submodule (${e.message})`
    );
  }
}
const savedSwaps = swaps.map(([p]) => [p, readFileSync(join(ROOT, p), 'utf8')]);

try {
  // The swap writes live inside the try so a mid-loop failure is still undone by
  // the finally, which restores every saved original.
  for (const [p, content] of swaps) writeFileSync(join(ROOT, p), content);
  // Invoking the compiler through node rather than a shim keeps this working the
  // same way on every platform and shell. outDir is passed explicitly rather
  // than taken from tsconfig, which pins it to dist/. Without this the MV2 build
  // stages an empty extension and says so only by reporting zero modules.
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', join(DIST, 'src')],
    { cwd: ROOT, stdio: 'inherit' }
  );
} finally {
  // Restore the committed free versions no matter what, so a failed build never
  // leaves Pro code swapped into the working tree.
  for (const [p, orig] of savedSwaps) writeFileSync(join(ROOT, p), orig);
}

if (!useProCode) {
  // Provably Pro-free output: the free gate re-exports the stub and never
  // imports these, so they are dead in the bundle. Removing them means a free
  // or store build cannot carry the licence or sync client at all.
  rmSync(join(DIST, 'src', 'pro'), { recursive: true, force: true });
}

console.log(`staging (manifest v${mv2 ? 2 : 3})`);
cpSync(join(ROOT, 'extension'), DIST, { recursive: true });

// Exactly one manifest ships, and the other variant's entry point goes with it.
if (mv2) {
  cpSync(join(DIST, 'manifest.mv2.json'), join(DIST, 'manifest.json'));
} else {
  rmSync(join(DIST, 'background.html'), { force: true });
}
rmSync(join(DIST, 'manifest.mv2.json'), { force: true });

if (firefox) {
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.background = { scripts: ['src/bg/index.js'], type: 'module' };
  // Chromium-only, or meaningless on Firefox: the pinned id key, the Chrome
  // version floor, website messaging (Firefox has no externally_connectable,
  // so the site's one-click key handoff falls back to pasting the key), and
  // the debugger (no such API on Firefox).
  for (const k of ['key', '_comment_key', '_comment_commands', 'minimum_chrome_version', 'externally_connectable']) {
    delete m[k];
  }
  m.permissions = [
    ...new Set([
      ...(m.permissions ?? []).filter((x) => x !== 'debugger' && x !== 'declarativeNetRequestFeedback'),
      'webRequestBlocking',
    ]),
  ];
  const optional = (m.optional_permissions ?? []).filter((x) => x !== 'debugger');
  if (optional.length) m.optional_permissions = optional;
  else delete m.optional_permissions;
  if (m.commands) delete m.commands['open-panel'];
  m.version = STORE_VERSION;
  m.browser_specific_settings = {
    gecko: {
      id: 'session@nvx.sh',
      // 128: scripting world MAIN, storage.session and DNR session rules with
      // tab ids, all of which the worker uses. Ed25519 (licence tokens) needs
      // 129; on 128 a token simply does not verify and the install stays free.
      strict_min_version: '128.0',
      // AMO's required declaration. Nothing is collected unless the user opts
      // in to anonymous telemetry, which is technical and interaction data.
      data_collection_permissions: {
        required: ['none'],
        optional: ['technicalAndInteraction'],
      },
    },
  };
  const endpoint = process.env.NVX_TELEMETRY_URL;
  if (endpoint) {
    if (!/^https:\/\//.test(endpoint)) throw new Error(`NVX_TELEMETRY_URL must be https, got: ${endpoint}`);
    BUILD_CONFIG.telemetryEndpoint = endpoint;
  }
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`firefox manifest: event page, blocking webRequest, gecko id ${m.browser_specific_settings.gecko.id}, v${m.version}`);
}

if (store) {
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));

  // Ask for nothing the package cannot use, since an unused permission is a
  // standard rejection reason. The rule-match feedback API is never called. The
  // debugger only serves Pro features, so a free package drops it outright; a Pro
  // store package keeps it optional, never granted at install.
  m.permissions = m.permissions.filter((x) => x !== 'debugger' && x !== 'declarativeNetRequestFeedback');
  const optional = (m.optional_permissions ?? []).filter((x) => x !== 'debugger');
  if (tier === 'pro') optional.push('debugger');
  if (optional.length) m.optional_permissions = optional;
  else delete m.optional_permissions;

  // The diagnostics page drives a local fixture server, so its shortcut is a
  // developer affordance that would only open a failing page for a user.
  if (m.commands) delete m.commands['open-panel'];

  delete m.key;
  delete m._comment_key;
  delete m._comment_commands;
  m.version = STORE_VERSION;

  /**
   * The telemetry endpoint, and the only place it is ever set.
   *
   * Read from the environment at package time, so it lives in the release
   * pipeline and never in the source tree. It is a public ingest URL, not a
   * credential: the real database secrets sit on the server behind it, never in
   * this bundle. Absent, the field is omitted and the shipped extension sends
   * nothing, which is also the state of every developer build. Must be https,
   * because a telemetry POST over http is a plaintext leak of its own. See
   * TELEMETRY.md.
   */
  const endpoint = process.env.NVX_TELEMETRY_URL;
  if (endpoint) {
    if (!/^https:\/\//.test(endpoint)) {
      throw new Error(`NVX_TELEMETRY_URL must be https, got: ${endpoint}`);
    }
    BUILD_CONFIG.telemetryEndpoint = endpoint;
  }

  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  console.log(
    `store manifest: ${tier === 'pro' ? 'debugger optional' : 'no debugger'}, no key, v${m.version}` +
      (endpoint ? ', telemetry endpoint set' : ', no telemetry endpoint')
  );
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The Pro tier gate, stamped into the manifest for
 *           |  every build.
 *  How      |  Section 30 ships one package with free and Pro code,
 *           |  switched by a licence check. The manifest states the
 *           |  tier; a free build's entitlement module is inert, so
 *           |  no token unlocks anything. Default free; a tester or
 *           |  Pro store build sets NVX_TIER=pro.
 *  Note     |  Licence endpoint and public keys are injected like the
 *           |  telemetry endpoint: public material, private signing
 *           |  key only on the server. Absent them, a pro build runs
 *           |  but activates nothing, the safe degradation.
 * ------------------------------------------------------------------
 */
{
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));

  /**
   * Three tiers, and a fourth only a developer ever builds.
   *
   * `pro` is a tester or the eventual paid store build, gated by a licence.
   * `free` is the store listing today, provably Pro-free. `dev` is the plain
   * unpacked build a developer loads: it unlocks every Pro feature without a
   * licence, so the features and the in-extension self-tests can be exercised
   * locally without standing up a licence server. It never ships, because the
   * store build is `--store` (free) or an explicit `NVX_TIER=pro`. An explicit
   * `NVX_TIER` always wins, so a developer can still build a real free or pro
   * package to test the gate itself.
   */
  // tier is computed once near the top, because the compile step needs it too.
  delete m.nvx_tier;
  delete m.nvx_telemetry;

  if (tier === 'pro') {
    const url = process.env.NVX_LICENSE_URL;
    if (url && !/^https:\/\//.test(url)) {
      throw new Error(`NVX_LICENSE_URL must be https, got: ${url}`);
    }
    const keysRaw = process.env.NVX_LICENSE_KEYS;
    let keys;
    if (keysRaw) {
      try {
        keys = JSON.parse(keysRaw);
      } catch {
        throw new Error('NVX_LICENSE_KEYS must be JSON, a { kid: base64url_pubkey } map');
      }
    }
    if (url || keys) {
      BUILD_CONFIG.license = { ...(url ? { endpoint: url } : {}), ...(keys ? { keys } : {}) };
    }
    // The CDP features (exact mode, worker isolation) need the debugger permission
    // GRANTED, because nothing requests it at runtime, so it stays in `permissions`
    // (from the base manifest) rather than moving to optional. It is also removed
    // from optional_permissions if anything put it there, since Chrome rejects a
    // permission listed in both. The prompt shows it; that is honest for a build
    // whose Pro features attach a debugger. Making it a clean optional prompt is a
    // pre-store-submission refinement: add a chrome.permissions.request when the
    // user turns exact mode on, then move it back to optional here.
    // Optional, and requested when somebody turns on a feature that attaches
    // one (exact mode, worker isolation). A required debugger permission is a
    // frightening install prompt and a harder store review for a capability
    // most people never use.
    m.permissions = (m.permissions ?? []).filter((x) => x !== 'debugger');
    if (!firefox) m.optional_permissions = [...new Set([...(m.optional_permissions ?? []), 'debugger'])];
  } else if (tier === 'dev') {
    // Dev unlocks every feature and needs the debugger granted for exact mode's
    // CDP attach, the same as pro, so it stays in `permissions`, not optional.
    delete m.nvx_license;
    m.permissions = [...new Set([...(m.permissions ?? []), 'debugger'])];
    m.optional_permissions = (m.optional_permissions ?? []).filter((x) => x !== 'debugger');
  } else {
    // Provably free: no endpoint, no keys, tier stated. Even a pasted token is
    // inert because the entitlement module refuses to honour one in a free build.
    delete m.nvx_license;
  }

  delete m.nvx_license;
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(
    join(DIST, 'src', 'build-config.js'),
    `// Written by tools/build.mjs. See src/build-config.ts.\nexport const BUILD = ${JSON.stringify(BUILD_CONFIG)};\n`
  );
  console.log(
    `tier: ${tier}` +
      (tier === 'pro'
        ? `${process.env.NVX_LICENSE_URL ? ', license endpoint set' : ', no license endpoint'}` +
          `${process.env.NVX_LICENSE_KEYS ? ', keys embedded' : ', no keys'}`
        : tier === 'dev'
          ? ', all features unlocked (never shipped)'
          : '')
  );
}

// The panel links the shared token sheet rather than carrying a copy, so the
// extension and anything else built on packages/ui cannot drift apart.
mkdirSync(join(DIST, 'ui'), { recursive: true });
cpSync(join(ROOT, 'packages', 'ui', 'tokens.css'), join(DIST, 'ui', 'tokens.css'));
cpSync(join(ROOT, 'packages', 'ui', 'fonts'), join(DIST, 'ui', 'fonts'), { recursive: true });
cpSync(join(ROOT, 'packages', 'ui', 'mark.js'), join(DIST, 'ui', 'mark.js'));

// Every relative import tsc emits must already carry a .js extension, because
// the browser resolves module specifiers literally. A missing extension fails
// at load with no diagnostic beyond a dead service worker.
let checked = 0;
const bad = [];
for (const file of walk(join(DIST, 'src'))) {
  if (!file.endsWith('.js')) continue;
  checked++;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const spec = m[1];
    if (!spec.endsWith('.js')) bad.push(`${file}: ${spec}`);
  }
}

if (bad.length) {
  console.error('extensionless relative imports would break the module graph:');
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}

// A store package ships no source maps: they are debugging aids for this repo,
// not for users, and roughly double the download. The trailing pointer comment
// goes too, or DevTools would report a missing map on every module.
if (store) {
  for (const f of [...walk(DIST)]) {
    if (f.endsWith('.map')) rmSync(f, { force: true });
    else if (f.endsWith('.js')) {
      const text = readFileSync(f, 'utf8');
      const stripped = text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
      if (stripped !== text) writeFileSync(f, stripped);
    }
  }
}

const size = totalSize(DIST);
console.log(`ok. ${checked} modules, ${(size / 1024).toFixed(1)} KB`);
console.log(`load unpacked: ${DIST}`);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function totalSize(dir) {
  let n = 0;
  for (const f of walk(dir)) n += statSync(f).size;
  return n;
}
