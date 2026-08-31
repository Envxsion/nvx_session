/**
 * ------------------------------------------------------------------
 *  Title    |  Bulk tab move probe
 *  Ref      |  fixture/server.mjs, moveTabs
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a bulk move lands every tab in the session,
 *           |  and the guard stops a request leaking mid-move.
 *  How      |  The move installs a block naming every moving tab,
 *           |  holds it across the recompile, and lifts it once the
 *           |  new rules are live. Checks the block is present during
 *           |  the window and gone after.
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

const profile = mkdtempSync(join(tmpdir(), 'nvx-move-'));
const PORT = 9720 + Math.floor(Math.random() * 70);
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

const drive = async (body, ms = 90_000) =>
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

// Ten tabs, unbound, and a session to move them into.
const setup = await drive(
  `async (nvx) => {
     await nvx.createSession('work', []);
     const ids = [];
     for (let i = 0; i < 10; i++) {
       const t = await chrome.tabs.create({ url: '${FIXTURE}/page?n=' + i, active: false });
       ids.push(t.id);
     }
     return { ids };
   }`
);
await new Promise((r) => setTimeout(r, 3000));

// Move all ten at once, and while the move runs, sample the live rules to see
// the block. The move is awaited by drive; to catch the window, kick it off
// without awaiting and poll.
// Kick the move off without awaiting it, park the promise, and poll the live
// rules from here, which is a genuinely separate process and so cannot miss a
// short-lived rule the way an in-worker timer did.
await drive(
  `async (nvx) => {
     const ids = ${JSON.stringify(setup.ids)};
     globalThis.__mv = { done: false, result: null };
     nvx.moveTabs(ids, 'work').then((r) => { globalThis.__mv.result = r; globalThis.__mv.done = true; });
     return true;
   }`
);
let sawBlock = false;
for (let i = 0; i < 400; i++) {
  const snap = await drive(
    `async () => {
       const live = await chrome.declarativeNetRequest.getSessionRules();
       return { block: live.some((r) => r.id === 30 && r.action.type === 'block'), done: globalThis.__mv.done };
     }`,
    8000
  ).catch(() => ({ block: false, done: false }));
  if (snap.block) sawBlock = true;
  if (snap.done) break;
  await new Promise((r) => setTimeout(r, 4));
}
const moved = await drive(
  `async (nvx) => {
     const ids = ${JSON.stringify(setup.ids)};
     const after = await chrome.declarativeNetRequest.getSessionRules();
     const bound = ids.filter((id) => nvx.registry.binding(id)?.sessionId === 'work').length;
     return {
       result: globalThis.__mv.result,
       bound,
       sawBlockDuringMove: ${sawBlock},
       blockGoneAfter: !after.some((x) => x.id === 30),
     };
   }`
);

console.log('\nmoving ten tabs at once\n');
fact('move result', JSON.stringify(moved.result));
fact('now bound to work', `${moved.bound} of 10`);
check('all ten landed in the session', moved.bound === 10, `${moved.bound}/10`);
check('the move reported success', moved.result.ok === true);
check('a block was live during the move, so nothing could leak', moved.sawBlockDuringMove === true);
check('and the block is gone once the move is done', moved.blockGoneAfter === true);

// A second move racing the first must serialise, not corrupt.
const race = await drive(
  `async (nvx) => {
     const ids = ${JSON.stringify(setup.ids)};
     const a = nvx.moveTabs(ids.slice(0, 5), 'work');
     const b = nvx.moveTabs(ids.slice(5), null);
     const [ra, rb] = await Promise.all([a, b]);
     const first5 = ids.slice(0, 5).filter((id) => nvx.registry.binding(id)?.sessionId === 'work').length;
     const last5 = ids.slice(5).filter((id) => !nvx.registry.binding(id)).length;
     return { ra, rb, first5, last5 };
   }`
);
console.log('\ntwo moves at once\n');
fact('outcome', `${race.first5}/5 bound, ${race.last5}/5 unbound`);
check('overlapping moves both complete cleanly', race.first5 === 5 && race.last5 === 5, JSON.stringify(race));

clearInterval(heartbeat);
console.log(`\n${failures ? `${failures} failed` : 'passed'}\n`);
try {
  process.kill(child.pid);
} catch {
  /* already gone */
}
process.exit(failures ? 1 : 0);
