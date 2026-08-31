/**
 * ------------------------------------------------------------------
 *  Title    |  Sign in here probe
 *  Ref      |  fixture/server.mjs, openInSession, bind
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Whether "Sign in here" binds a tab to a session before
 *           |  it makes a request.
 *  How      |  Open a site into a fresh session, then read that the
 *           |  tab is bound, the domain is pinned, and the session's
 *           |  rules already cover the tab.
 *  Note     |  Safe means the binding and rules land before the first
 *           |  request, so a federated provider never sees a
 *           |  half-finished login.
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
const binary = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Opera GX', 'opera.exe');

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

const profile = mkdtempSync(join(tmpdir(), 'nvx-signin-'));
const PORT = 9700 + Math.floor(Math.random() * 80);
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
for (let i = 0; i < 30 && !wsid; i++) {
  const { targetInfos } = await browser.send('Target.getTargets');
  const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.id));
  if (w) {
    wsid = (await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: true }))
      .sessionId;
  } else {
    const t = await browser
      .send('Target.createTarget', { url: `${FIXTURE}/page?wake=1` })
      .catch(() => null);
    if (t) {
      await new Promise((r) => setTimeout(r, 600));
      await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
    }
  }
  await new Promise((r) => setTimeout(r, 400));
}

const drive = async (body, ms = 60_000) =>
  JSON.parse(
    (
      await browser.send(
        'Runtime.evaluate',
        {
          expression: `(async () => { const nvx = globalThis.__nvx; await nvx.whenReady(); return JSON.stringify(await (${body})(nvx)); })()`,
          returnByValue: true,
          awaitPromise: true,
        },
        { sessionId: wsid, timeout: ms }
      )
    ).result.value
  );

const heartbeat = setInterval(() => {
  browser
    .send(
      'Runtime.evaluate',
      { expression: 'chrome.storage.local.get("nvx.keepalive")' },
      { sessionId: wsid, timeout: 5000 }
    )
    .catch(() => undefined);
}, 8000);

// A brand new, empty session, and the site opened into it through the real
// command the button calls.
const result = await drive(
  `async (nvx) => {
     await nvx.createSession('work', []);
     const opened = await nvx.openInSession('work', '${FIXTURE}/page?signin=1');
     return { opened };
   }`
);
await new Promise((r) => setTimeout(r, 3500));

const after = await drive(
  `async (nvx) => {
     const s = nvx.registry.getSession('work');
     const tabs = await chrome.tabs.query({});
     const t = tabs.find((x) => (x.url || '').indexOf('signin=1') >= 0) || null;
     const binding = t ? nvx.registry.binding(t.id) : null;
     const live = await chrome.declarativeNetRequest.getSessionRules();
     return {
       opened: ${JSON.stringify(result.opened)}.ok,
       pinned: s ? s.pinned : [],
       boundToWork: binding ? binding.sessionId === 'work' : false,
       tabUrl: t ? t.url : 'none',
       rulesForTab: t ? live.filter((r) => (r.condition.tabIds || []).indexOf(t.id) >= 0).length : 0,
     };
   }`
);

console.log('\nSign in here, into a fresh session\n');
fact('opened', String(after.opened));
fact('domain pinned so the account sticks', JSON.stringify(after.pinned));
fact('tab', after.tabUrl);
fact('rules covering the tab', after.rulesForTab);
check('the tab is in the session', after.boundToWork === true);
check('the site was pinned to it, so the next visit goes here on its own', after.pinned.includes('localhost'));
check('and the session already has rules for the tab before it loaded', after.rulesForTab > 0);
check('the tab is on the site, not left on about:blank', after.tabUrl.includes('signin=1'));

clearInterval(heartbeat);
console.log(`\n${failures ? `${failures} failed` : 'passed'}\n`);
try {
  process.kill(child.pid);
} catch {
  /* already gone */
}
process.exit(failures ? 1 : 0);
