/**
 * Does the mark come off when the extension goes away.
 *
 * The session mark is a `link rel=icon` this extension puts into the page, so
 * it belongs to the document rather than to the extension. Removing the
 * extension therefore does not remove it: every managed tab keeps wearing a
 * coloured dot with nothing left to explain it, which is what was reported. And
 * there is no uninstall hook that could tidy it afterwards, because by then
 * nothing of ours is running.
 *
 * The only moment left is the port disconnecting, so that is what this drives:
 * mark a tab, disable the extension out from under it, and read the page's
 * favicon back.
 *
 *   node tools/fixture/server.mjs
 *   node tools/uninstall.mjs
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

const profile = mkdtempSync(join(tmpdir(), 'nvx-uninstall-'));
const PORT = 9760 + Math.floor(Math.random() * 90);
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
  ],
  { stdio: 'ignore' }
);

let failures = 0;
const check = (what, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `   ${detail}` : ''}`);
};

const endpoint = await browserEndpoint(PORT);
const browser = await connect(endpoint.webSocketDebuggerUrl);
await browser.send('Target.setDiscoverTargets', { discover: true });
const loaded = await loadUnpacked(browser, DIST);
await new Promise((r) => setTimeout(r, 2500));

async function worker() {
  for (let i = 0; i < 30; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.id));
    if (w) {
      const r = await browser
        .send('Target.attachToTarget', { targetId: w.targetId, flatten: true })
        .catch(() => null);
      if (r) return r.sessionId;
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
let wsid = await worker();

// A tab, bound, wearing a mark.
const page = await browser.send('Target.createTarget', { url: `${FIXTURE}/page?mark=1` });
const psid = (await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }))
  .sessionId;
await new Promise((r) => setTimeout(r, 2000));



/**
 * The agent is registered only for hosts a session cares about, and a content
 * script only enters a document as it loads. So the session has to exist, the
 * registration has to land, and only then can the page be loaded into it.
 * Skipping that leaves a page with no agent in it, which reads exactly like a
 * mark that failed rather than one that was never asked for.
 */
await browser.send(
  'Runtime.evaluate',
  {
    expression: `(async () => {
       const nvx = globalThis.__nvx;
       await nvx.whenReady();
       await nvx.createSession('marked', ['localhost']);
       await nvx.registerAgent();
       return true;
     })()`,
    returnByValue: true,
    awaitPromise: true,
  },
  { sessionId: wsid, timeout: 30000 }
);
await new Promise((r) => setTimeout(r, 1200));
await browser.send('Page.reload', {}, { sessionId: psid }).catch(() => undefined);
await new Promise((r) => setTimeout(r, 2500));

/**
 * The fixture serves no icon and the compositor needs one to draw onto, so the
 * page is given one. A raster icon, drawn here rather than written as an SVG
 * literal: the compositing happens in a worker, which has no SVG decoder, so an
 * SVG icon is skipped and this probe would be measuring that instead of what it
 * came to measure.
 */
await browser.send(
  'Runtime.evaluate',
  {
    expression: `(() => {
       const c = document.createElement('canvas');
       c.width = 32;
       c.height = 32;
       const g = c.getContext('2d');
       g.fillStyle = '#4488cc';
       g.fillRect(0, 0, 32, 32);
       const l = document.createElement('link');
       l.rel = 'icon';
       l.type = 'image/png';
       l.href = c.toDataURL('image/png');
       document.head.append(l);
       return l.href.slice(0, 24);
     })()`,
    returnByValue: true,
  },
  { sessionId: psid, timeout: 8000 }
);
await new Promise((r) => setTimeout(r, 1500));

const tabId = JSON.parse(
  (
    await browser.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
       const nvx = globalThis.__nvx;
       await nvx.whenReady();
       const tabs = await chrome.tabs.query({});
       const t = tabs.find((x) => (x.url || '').includes('mark=1'));
       await nvx.bind(t.id, 'marked', t.url, t.windowId);
       return JSON.stringify({ id: t.id });
     })()`,
        returnByValue: true,
        awaitPromise: true,
      },
      { sessionId: wsid, timeout: 30000 }
    )
  ).result.value
).id;
await new Promise((r) => setTimeout(r, 3500));

const icons = async () =>
  JSON.parse(
    (
      await browser.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
         const links = [...document.querySelectorAll('link[rel~="icon" i]')];
         return JSON.stringify({
           total: links.length,
           marked: links.filter((l) => l.hasAttribute('data-nvx-mark')).length,
           hrefs: links.map((l) => (l.getAttribute('href') || '').slice(0, 24)),
         });
       })()`,
          returnByValue: true,
        },
        { sessionId: psid, timeout: 8000 }
      )
    ).result.value
  );

const diag = (
  await browser.send(
    'Runtime.evaluate',
    { expression: `JSON.stringify({
        alive: document.documentElement.getAttribute('data-nvx-alive'),
        was: (document.querySelector('link[data-nvx-mark]') || {}).getAttribute
          ? document.querySelector('link[data-nvx-mark]').getAttribute('data-nvx-was')
          : null,
      })`, returnByValue: true },
    { sessionId: psid, timeout: 8000 }
  )
).result.value;
console.log(`   .    heartbeat and record   ${diag}`);

const before = await icons();
console.log(`\nwith the extension running\n`);
console.log(`   .    icons in the page   ${JSON.stringify(before)}`);
check('the tab is wearing a mark', before.marked === 1, JSON.stringify(before));
check('and the page is not showing two icons at once', before.total - before.marked <= 1, JSON.stringify(before));

/**
 * Out from under it. To the page an uninstall and a disable look the same: the
 * port drops and the isolated world is destroyed.
 *
 * Confirmed by the heartbeat rather than by the worker target. The first
 * version of this watched for the service worker disappearing and concluded the
 * extension was gone, which is wrong in the most ordinary way possible: an MV3
 * worker is terminated whenever it is idle, so that target is absent most of
 * the time on a healthy extension. The probe then declared success, never tried
 * the second removal method, and spent thirty seconds waiting for a watchdog
 * whose heartbeat was still merrily ticking. The agent stamping the document is
 * the only thing that means the agent is running.
 */
const stamp = async () => {
  // Tolerant, because uninstalling can take the debugger session with it and a
  // probe that dies at that moment reports nothing at all.
  try {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression: `document.documentElement.getAttribute('data-nvx-alive') || '0'`, returnByValue: true },
      { sessionId: psid, timeout: 8000 }
    );
    return Number(r.result.value);
  } catch {
    return -1;
  }
};

let gone = false;
for (const [method, params] of [
  // Disabling first. It is what a person does before removing, it produces the
  // identical teardown as far as any page is concerned, and it does not risk
  // taking this debugger session down with it.
  ['Extensions.setDisabled', { id: loaded.id, disabled: true }],
  ['Extensions.uninstall', { id: loaded.id }],
]) {
  if (gone) break;
  await browser.send(method, params).catch(() => undefined);
  const was = await stamp();
  // A stamp that has not moved across two intervals is a stamp nobody is
  // writing any more.
  await new Promise((r) => setTimeout(r, 9000));
  const now = await stamp();
  gone = now === was && was > 0;
}
check('the extension is actually gone, or this proves nothing', gone);

// The watchdog is deliberately slow: twenty seconds of a stopped heartbeat
// before it acts, checked every six. Waiting that out is the price of a
// threshold generous enough that a throttled background tab never trips it.
console.log('   .    waiting out the watchdog');
await new Promise((r) => setTimeout(r, 26_000));

const after = await icons();
console.log(`\nafter the extension goes away, with the page never reloaded\n`);
console.log(`   .    icons in the page   ${JSON.stringify(after)}`);
check(
  'the mark is gone rather than left on a tab nothing explains',
  after.marked === 0,
  `${after.marked} still marked`
);
check(
  'and the page is left with an icon of its own',
  after.total >= 1,
  JSON.stringify(after)
);

console.log(`\n${failures ? `${failures} failed` : 'passed'}\n`);
try {
  process.kill(child.pid);
} catch {
  /* already gone */
}
process.exit(failures ? 1 : 0);
