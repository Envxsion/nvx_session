/**
 * ------------------------------------------------------------------
 *  Title    |  Sign-in loop detector probe
 *  Ref      |  fixture/server.mjs, /loop, releaseSite
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the loop detector fires, and stays quiet when
 *           |  it should.
 *  How      |  Three cases. A managed tab in an endless loop ->
 *           |  released, tabs handed back. A managed tab signing in
 *           |  normally -> untouched. An unmanaged tab in the same
 *           |  loop -> untouched.
 *  Note     |  Both halves matter: firing on an ordinary federated
 *           |  sign-in would take a working login away.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const FIXTURE = 'http://localhost:8787';
const binary = `${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`;

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('dist is not built. run: node tools/build.mjs');
  process.exit(1);
}
try {
  const probe = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' });
  if (!probe.ok) throw new Error();
} catch {
  console.error('fixture is not answering. run: node tools/fixture/server.mjs');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nvx-loop-'));
const PORT = 9680 + Math.floor(Math.random() * 90);
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
    '--disable-background-timer-throttling',
  ],
  { stdio: 'ignore' }
);

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `   ${detail}` : ''}`);
};
const fact = (what, value) => console.log(`   .    ${what}   ${value}`);

const endpoint = await browserEndpoint(PORT);
const browser = await connect(endpoint.webSocketDebuggerUrl);
await browser.send('Target.setDiscoverTargets', { discover: true });
const loaded = await loadUnpacked(browser, DIST);
await new Promise((r) => setTimeout(r, 2500));

let wsid = null;
async function attach() {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.id));
    if (w) {
      const r = await browser
        .send('Target.attachToTarget', { targetId: w.targetId, flatten: true })
        .catch(() => null);
      if (r) {
        wsid = r.sessionId;
        return;
      }
    }
    const t = await browser
      .send('Target.createTarget', { url: `${FIXTURE}/page?wake=1` })
      .catch(() => null);
    if (t) {
      await new Promise((r) => setTimeout(r, 600));
      await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no worker');
}
await attach();

const evaluate = async (expression, ms = 60_000, sid = wsid) => {
  const r = await browser.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    { sessionId: sid, timeout: ms }
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return r.result.value;
};

const drive = (body, ms = 60_000) =>
  evaluate(
    `(async () => {
       const nvx = globalThis.__nvx;
       await nvx.whenReady();
       return JSON.stringify(await (${body})(nvx));
     })()`,
    ms
  ).then(JSON.parse);

const heartbeat = setInterval(() => {
  browser
    .send(
      'Runtime.evaluate',
      { expression: 'chrome.storage.local.get("nvx.keepalive")' },
      { sessionId: wsid, timeout: 5000 }
    )
    .catch(() => undefined);
}, 8000);

/** Opens a tab, optionally binds it, drives it at a url, reports what happened. */
async function run(label, { bind, url }) {
  const page = await browser.send('Target.createTarget', { url: 'about:blank' });
  const psid = (
    await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  ).sessionId;
  await new Promise((r) => setTimeout(r, 900));

  const tabId = await drive(
    `async (nvx) => {
       const tabs = await chrome.tabs.query({});
       const t = tabs.find((x) => (x.url || '') === 'about:blank');
       if (${Boolean(bind)}) {
         await nvx.createSession(${JSON.stringify(String(bind))}, ['localhost']);
         await nvx.bind(t.id, ${JSON.stringify(String(bind))}, 'http://localhost:8787/page', t.windowId);
       }
       return t.id;
     }`
  );

  await browser
    .send('Page.navigate', { url }, { sessionId: psid, timeout: 20_000 })
    .catch(() => undefined);
  // Long enough for a loop to run past every threshold, and for the browser's
  // own redirect limit to be reached.
  await new Promise((r) => setTimeout(r, 20_000));

  const after = await drive(
    `async (nvx) => ({
       released: nvx.released,
       loop: nvx.loop,
       stillBound: Boolean(nvx.registry.binding(${tabId})),
     })`
  );
  console.log(`\n${label}\n`);
  return after;
}

// ------------------------------------------------------------ the loop
const looping = await run('a managed tab in an endless loop', {
  bind: 'loopy',
  url: `${FIXTURE}/loop?n=0`,
});
fact('released', JSON.stringify(looping.released));
fact('reported', looping.loop ? `${looping.loop.domain}, ${looping.loop.freed} tab(s) freed` : 'nothing');
check('the loop is detected and the site released', looping.released.includes('localhost'), JSON.stringify(looping.released));
check('and it is reported so the panel can explain it', Boolean(looping.loop));
check('and the tab is handed back to the browser', looping.stillBound === false);

// Put it back before the next case, or every later check inherits the release.
await drive(`async (nvx) => nvx.releaseSite('localhost', false)`);

// --------------------------------------------------- an ordinary sign-in
const normal = await run('a managed tab signing in normally, five hops', {
  bind: 'fine',
  url: `${FIXTURE}/loop?n=0&stop=5`,
});
fact('released', JSON.stringify(normal.released));
check(
  'a sign-in that completes is left alone',
  !normal.released.includes('localhost'),
  JSON.stringify(normal.released)
);
check('and the tab keeps its session', normal.stillBound === true);

// ------------------------------------------------------- not our problem
const unmanaged = await run('an unmanaged tab in the same loop', {
  bind: null,
  url: `${FIXTURE}/loop?n=0`,
});
fact('released', JSON.stringify(unmanaged.released));
check(
  'an unmanaged tab looping is not blamed on this extension',
  !unmanaged.released.includes('localhost'),
  JSON.stringify(unmanaged.released)
);

clearInterval(heartbeat);
console.log(`\n${failures ? `${failures} failed` : 'passed'}\n`);
try {
  process.kill(child.pid);
} catch {
  /* already gone */
}
process.exit(failures ? 1 : 0);
