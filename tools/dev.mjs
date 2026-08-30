/**
 * Launches a browser with the built extension loaded and leaves it running.
 *
 * Not the e2e harness: that creates throwaway sessions, proves things about
 * them and removes them again, which is the opposite of what you want when the
 * point is to look at it. This seeds enough state that every surface has
 * something in it, opens the panel, and gets out of the way.
 *
 * The profile is stable across runs, so sessions you make by hand survive a
 * relaunch. It is a scratch profile either way and never your real one.
 *
 *   node tools/dev.mjs            opera, dist/
 *   node tools/dev.mjs chrome     see the note below
 *   node tools/dev.mjs opera --mv2
 *   node tools/dev.mjs opera --bare      no seeding, just the extension
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mv2 = process.argv.includes('--mv2');
const bare = process.argv.includes('--bare');
const DIST = join(ROOT, mv2 ? 'dist-mv2' : 'dist');
const FIXTURE = 'http://localhost:8787';

const BROWSERS = {
  opera: [`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`],
  chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
};

const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'opera';
const binary = (BROWSERS[which] ?? []).find((p) => existsSync(p));
if (!binary) {
  console.error(`no binary for ${which}`);
  process.exit(1);
}
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error(`${DIST} is not built. run: npm run build${mv2 ? ':mv2' : ''}`);
  process.exit(1);
}

const fixtureUp = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' })
  .then((r) => r.ok)
  .catch(() => false);

// A stable scratch profile, so anything set up by hand survives a relaunch.
const profile = join(tmpdir(), `nvx-dev-${mv2 ? 'mv2' : 'mv3'}`);
mkdirSync(profile, { recursive: true });

/**
 * The service worker script is cached by the profile, and relaunching with
 * --load-extension does not reliably invalidate it. A worker running yesterday's
 * bytes while the files on disk hold today's is the worst possible development
 * state: every diagnostic reads the new source, the behaviour is the old one,
 * and hours go into explaining a bug that was fixed already. Measured exactly
 * once, which was enough.
 *
 * Dropping the cache costs a few hundred milliseconds on start. Session state
 * lives elsewhere and is untouched.
 */
let cacheHeld = false;
for (const dir of ['Service Worker', join('Default', 'Service Worker')]) {
  try {
    rmSync(join(profile, dir), { recursive: true, force: true });
  } catch {
    // A browser is already open on this profile and holding the files. `force`
    // does not cover EBUSY on Windows, so this threw and took the launcher with
    // it, which is a hard failure for what is only an optimisation. Noted and
    // carried on: the second window opens against the same profile, and the
    // warning below says why it might be running yesterday's worker.
    cacheHeld = true;
  }
}

/**
 * A port somebody else is already listening on is somebody else's browser, and
 * connecting to it reads a different profile's extensions while the window you
 * are looking at has no endpoint at all. Take the first free one instead.
 */
async function freePort(from) {
  for (let p = from; p < from + 20; p++) {
    const taken = await fetch(`http://127.0.0.1:${p}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!taken) return p;
  }
  throw new Error(`no free debugging port from ${from}`);
}
const PORT = await freePort(9222);

const child = spawn(
  binary,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    fixtureUp ? `${FIXTURE}/page?dev=1` : 'about:blank',
  ],
  { detached: true, stdio: 'ignore' }
);
// Detached and unreferenced, so the browser outlives this script. Killing it is
// the user closing the window, not this process exiting.
child.unref();

console.log(`${which}${mv2 ? ' (manifest v2)' : ''}  pid ${child.pid}`);
console.log(`profile   ${profile}`);
console.log(`extension ${DIST}`);
console.log(`devtools  127.0.0.1:${PORT}`);
if (cacheHeld) {
  console.log(`\na browser is already open on this profile, so the service worker cache`);
  console.log(`could not be cleared. if the extension behaves like an older build, close`);
  console.log(`every window on this profile and run this again.`);
}
if (!fixtureUp) {
  console.log(`\nthe fixture origin is not answering, so the in-panel suites will refuse.`);
  console.log(`start it with: npm run fixture`);
}

/**
 * Only --load-extension is used, never the CDP loadUnpacked the e2e harness
 * needs. Doing both loads the extension twice and leaves two service workers
 * under one id (§27 H1), which is confusing enough in a test run and would be
 * unusable in a browser somebody is clicking around in.
 */
async function attach() {
  const v = await browserEndpoint(PORT, { tries: 80 });
  const browser = await connect(v.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });

  /**
   * Every candidate, not the first one. Opera GX ships its own extensions and
   * they have workers too, so the first match is usually somebody else's and
   * taking only that one looks exactly like the extension never loading.
   */
  let seen = [];
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const workers = targetInfos.filter(
      (t) =>
        ['service_worker', 'background_page', 'worker', 'other'].includes(t.type) &&
        t.url.startsWith('chrome-extension://')
    );
    seen = workers.map((t) => new URL(t.url).host);
    for (const worker of workers) {
      const id = new URL(worker.url).host;
      const { sessionId } = await browser
        .send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
        .catch(() => ({}));
      if (!sessionId) continue;
      const probe = await browser
        .send(
          'Runtime.evaluate',
          { expression: 'typeof globalThis.__nvx', returnByValue: true },
          { sessionId, timeout: 20_000 }
        )
        .catch(() => null);
      if (probe?.result?.value === 'object') return { browser, sessionId, id };
      await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`the extension never came up. extension workers seen: ${seen.join(', ') || 'none'}`);
}

try {
  const { browser, sessionId, id } = await attach();
  console.log(`id        ${id}`);

  if (!bare) {
    const seed = `(async () => {
      if (__nvx.registry.listSessions().some((s) => s.id === 'dev_work')) return 'already seeded';

      await __nvx.createSession('dev_work', ['vercel.com', 'github.com']);
      await __nvx.createSession('dev_personal', ['github.com']);
      await __nvx.createSession('dev_client', ['vercel.com']);

      const w = __nvx.registry.getSession('dev_work');
      const p = __nvx.registry.getSession('dev_personal');
      const c = __nvx.registry.getSession('dev_client');
      w.label = 'work';
      p.label = 'personal';
      c.label = 'client prod';
      // One of each, so all three levels of the control are visible somewhere.
      c.danger = 'block';
      p.danger = 'off';

      await __nvx.seed('dev_work', '${FIXTURE}/', 'sid=WORK_ONLY; Path=/');
      await __nvx.seed('dev_personal', '${FIXTURE}/', 'sid=PERSONAL_ONLY; Path=/');
      await __nvx.seed('dev_client', '${FIXTURE}/', 'sid=CLIENT_ONLY; Path=/');

      // Through the real classifier, so the trail says what the catalog says.
      const hits = [
        ['https://api.vercel.com/v9/projects/prj_9k2', 'DELETE', 'dev_client'],
        ['https://api.github.com/repos/acme/site', 'DELETE', 'dev_work'],
        ['https://acme.dev/api/drafts/41', 'DELETE', 'dev_work'],
      ];
      let t = Date.now() - 900000;
      for (const [url, method, sid] of hits) {
        const s = __nvx.registry.getSession(sid);
        __nvx.guard.note({ url, method }, { id: sid, label: s.label, danger: s.danger }, t);
        t += 300000;
      }
      return 'seeded';
    })()`;
    const out = await browser.send(
      'Runtime.evaluate',
      { expression: seed, awaitPromise: true, returnByValue: true },
      { sessionId, timeout: 30_000 }
    );
    console.log(`state     ${out?.result?.value ?? 'unknown'}`);
  }

  await browser.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  browser.close();

  console.log(`\npanel is open. things worth trying:`);
  console.log(`  Edit on any session      the blast radius control, three levels`);
  console.log(`  bind a tab to a session  the Tabs list, then watch the favicon`);
  console.log(`  Storage / Guard          under Diagnostics, both need the fixture`);
  console.log(`\nclose the window when done. relaunching keeps this profile's state.`);
} catch (e) {
  console.error(`\nthe browser is running but could not be set up: ${e.message}`);
  console.error(`open the panel yourself with Alt+Shift+S.`);
}
