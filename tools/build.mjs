/**
 * Assembles the loadable extension.
 *
 * tsc emits ES modules into dist/src, which an MV3 service worker declared
 * with type "module" can load directly. No bundler is involved, so the
 * unpacked build stays inspectable and loads with no toolchain.
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
 * Two builds, one codebase.
 *
 * MV3 is the default and the Chrome Web Store target. MV2 is the Opera path:
 * it swaps a service worker for a persistent background page and declarative
 * rules for a blocking listener, which removes the rule ceiling and the flush
 * race. Everything under src/ is shared and chooses at runtime.
 *
 *   node tools/build.mjs          -> dist/
 *   node tools/build.mjs --mv2    -> dist-mv2/
 */
const mv2 = process.argv.includes('--mv2');
/**
 * The listing build, as section 19 scoped it.
 *
 * Three differences from the unpacked build, and each one is a store fact
 * rather than a preference:
 *
 * `debugger` moves from `permissions` to `optional_permissions`. It is the most
 * scrutinised permission in the catalogue, it puts "attach a debugger to every
 * page you visit" in the install prompt, and the only thing that uses it is
 * Exact mode, which is off by default and which section 26 records as unable to
 * withhold a cookie. Optional rather than absent, so the prompt goes quiet and
 * review gets easier without closing the door on tier 2.
 *
 * The `key` comes out. It pins the extension id for an unpacked build, which is
 * what stops a rebuild looking like a new install; the store issues its own id
 * from the uploaded package, and shipping a key alongside it is at best
 * confusing and at worst a rejection.
 *
 * And the version gets a real number, because 0.1.0 is not a thing to publish.
 *
 *   node tools/build.mjs --store  -> dist-store/
 */
const store = process.argv.includes('--store');
const DIST = join(ROOT, mv2 ? 'dist-mv2' : store ? 'dist-store' : 'dist');

/**
 * The build tier, computed here because the compile step below needs it (a Pro
 * build swaps in the private overlay and points the gate at the submodule) and
 * the manifest block near the end stamps it. An explicit NVX_TIER always wins;
 * otherwise a --store build is free and any other build is a developer build.
 */
const explicitTier = process.env.NVX_TIER;
const tier =
  explicitTier === 'pro' ? 'pro' : explicitTier === 'free' ? 'free' : store ? 'free' : 'dev';
/**
 * Whether the private `pro` submodule is actually checked out. A public
 * free-only clone has an empty src/pro, so even a dev build there falls back to
 * the free stubs and the free feature files rather than failing to find the
 * overlay. This is the property that lets the open-source repository build with
 * no submodule and no toolchain surprises.
 */
const proPresent = existsSync(join(ROOT, 'src', 'pro', 'index.ts'));
const useProCode = (tier === 'pro' || tier === 'dev') && proPresent;

/**
 * Whether the listing build carries Persona.
 *
 * Section 19 says it should not: it scopes `nvx-store` to Mirror and
 * Standardize on single-purpose and framing grounds, since "session isolation
 * plus fingerprint control" can read to a reviewer as two products, and
 * anti-detect language invites rejection.
 *
 * Persona is the one posture no competitor offers honestly: a machine per
 * session, stated rather than silently faked. It is the strongest version of
 * the fingerprint story, but it is not the whole of it.
 *
 * Off for the first submission, and this is the corrected call. The earlier note
 * reasoned that shipping it and being asked to remove it costs "one flag", but
 * that assumes a reviewer who negotiates. The store more often rejects a first
 * submission outright with a policy citation, and a posture that fabricates a
 * per-session fingerprint reads as a second purpose, anti-detection, on top of
 * the single purpose this listing claims, which is cookie session isolation.
 * That is the shape that draws a single-purpose rejection, and a rejection on a
 * new account costs the whole review cycle and some trust. Mirror and Standardize
 * still ship, so the free build is still per-session isolation with a validated,
 * honest fingerprint posture, which is the differentiator. Persona returns as a
 * normal feature update once the listing exists. Reversible in one constant.
 */
const STORE_INCLUDES_PERSONA = false;

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

if (store) {
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));

  m.permissions = m.permissions.filter((x) => x !== 'debugger');
  m.optional_permissions = [...new Set([...(m.optional_permissions ?? []), 'debugger'])];

  delete m.key;
  delete m._comment_key;
  m.version = STORE_VERSION;

  if (!STORE_INCLUDES_PERSONA) m.nvx_postures = ['mirror', 'standardize'];

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
    m.nvx_telemetry = { endpoint };
  }

  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
  console.log(
    `store manifest: debugger optional, no key, v${m.version}` +
      (STORE_INCLUDES_PERSONA ? ', persona on' : ', persona off') +
      (endpoint ? ', telemetry endpoint set' : ', no telemetry endpoint')
  );
}

/**
 * The Pro tier gate, stamped into the manifest for every build.
 *
 * Section 30 ships one package carrying free and Pro code, switched by a licence
 * check rather than by installing a different extension. This is the build half
 * of the belt-and-braces: the manifest states the tier, and a `free` build's
 * entitlement module is inert, so no token however valid unlocks anything. The
 * default is `free`, which is what the store lists today; a tester or the
 * eventual Pro store build sets `NVX_TIER=pro`.
 *
 * The licence endpoint and the public keys are injected here the same way the
 * telemetry endpoint is, and for the same reason: they are public material (an
 * https URL and Ed25519 public keys), the private signing key lives only on the
 * server, and nothing secret enters the bundle. Absent them, a pro build still
 * runs but can activate nothing, which is the safe degradation.
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
  m.nvx_tier = tier;

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
      m.nvx_license = { ...(url ? { endpoint: url } : {}), ...(keys ? { keys } : {}) };
    }
    // The CDP features (exact mode, worker isolation) need the debugger permission
    // GRANTED, because nothing requests it at runtime, so it stays in `permissions`
    // (from the base manifest) rather than moving to optional. It is also removed
    // from optional_permissions if anything put it there, since Chrome rejects a
    // permission listed in both. The prompt shows it; that is honest for a build
    // whose Pro features attach a debugger. Making it a clean optional prompt is a
    // pre-store-submission refinement: add a chrome.permissions.request when the
    // user turns exact mode on, then move it back to optional here.
    m.permissions = [...new Set([...(m.permissions ?? []), 'debugger'])];
    m.optional_permissions = (m.optional_permissions ?? []).filter((x) => x !== 'debugger');
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

  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
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
