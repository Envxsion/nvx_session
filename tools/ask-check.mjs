/**
 * ------------------------------------------------------------------
 *  Title    |  New-site question check
 *  Ref      |  src/bg/index.ts (routeUnboundTab, typedNavigation)
 *  ID       |  tool (ask-check)
 * ------------------------------------------------------------------
 *  Purpose  |  Prove in a real browser that a site the user goes to
 *           |  themselves is asked about, and one a page sends them
 *           |  to is not.
 *  How      |  Loads the build, starts the zoo server for real pages
 *           |  (its /z/link route), then drives tabs over CDP.
 *           |  Page.navigate is browser-initiated, like the address
 *           |  bar; a scripted click is page-initiated, like a link.
 *           |  www.bing.com is mapped to the zoo too, so a search
 *           |  result click is a real click on a real bing.com origin.
 *  Usage    |  node tools/build.mjs && node tools/ask-check.mjs
 *           |  NVX_BROWSER=<exe> for another Chromium browser,
 *           |  NVX_DIST=dist-mv2 for the MV2 build, NVX_LOAD_FLAG=1
 *           |  for a browser without Extensions.loadUnpacked.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserEndpoint, connect, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.NVX_BROWSER ?? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
/** Which build to load: dist (MV3) by default, NVX_DIST=dist-mv2 for the MV2 build. */
const DIST = join(ROOT, process.env.NVX_DIST ?? 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'nvx-ask-'));
const port = 9800 + Math.floor(Math.random() * 90);
const ZOO = 'http://127.0.0.1:18788';

const zoo = spawn(process.execPath, [join(ROOT, 'tools', 'zoo', 'server.mjs')], {
  stdio: 'ignore',
  env: { ZOO_LATENCY: '0', ...process.env },
});
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP *.test 127.0.0.1:18443, MAP www.bing.com 127.0.0.1:18443',
    '--ignore-certificate-errors',
    '--no-first-run',
    ...(process.env.NVX_LOAD_FLAG ? [`--load-extension=${DIST}`] : []),
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let failed = 0;
function expect(name, ok, got) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (tab at ${got})`}`);
  if (!ok) failed++;
}

try {
  for (let i = 0; i < 40; i++) {
    if (await fetch(`${ZOO}/health`).then((r) => r.ok, () => false)) break;
    await sleep(150);
  }
  const v = await browserEndpoint(port);
  const browser = await connect(v.webSocketDebuggerUrl, { timeout: 30_000 });
  const loaded = await loadUnpacked(browser, DIST);
  if (!loaded.id && process.env.NVX_LOAD_FLAG) {
    // Browsers without Extensions.loadUnpacked load it from the flag instead;
    // the id is read off the extension's own background target.
    for (let i = 0; i < 40 && !loaded.id; i++) {
      const { targetInfos } = await browser.send('Target.getTargets');
      const bg = targetInfos.find(
        (t) =>
          (t.type === 'service_worker' || t.type === 'background_page') &&
          /src\/bg\/index\.js|background\.html/.test(t.url)
      );
      if (bg) loaded.id = new URL(bg.url).host;
      else await sleep(250);
    }
  }
  if (!loaded.id) throw new Error(loaded.error);
  await sleep(2500);

  const urlOf = async (targetId) => {
    const { targetInfos } = await browser.send('Target.getTargets');
    return targetInfos.find((t) => t.targetId === targetId)?.url ?? '';
  };
  const open = async (url) => {
    const { targetId } = await browser.send('Target.createTarget', { url });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, { sessionId });
    await sleep(800);
    return { targetId, sessionId };
  };
  const asked = (u) => u.includes('/chooser.html');
  const click = (sessionId) =>
    browser.send('Runtime.evaluate', { expression: 'document.getElementById("l").click()', userGesture: true }, { sessionId });
  const linkPage = (host, to) => `https://${host}/z/link?to=${encodeURIComponent(to)}`;

  // The pages a link is clicked from are sites the user has already answered
  // "no session, never ask" for, so they load and the click is what is tested.
  const popup = await open(`chrome-extension://${loaded.id}/popup.html`);
  await browser.send(
    'Runtime.evaluate',
    { expression: `chrome.runtime.sendMessage({ cmd: 'setSettings', quiet: ['bing.com', 'start.test'] })`, awaitPromise: true },
    { sessionId: popup.sessionId }
  );

  // 1. New tab, type an address.
  const a = await open('chrome://newtab/');
  await sleep(1200);
  // Edge serves its new-tab page from ntp.msn.com; it must load, not be asked about.
  expect('the browser new-tab page itself is not asked about', !asked(await urlOf(a.targetId)), await urlOf(a.targetId));
  await browser.send('Page.navigate', { url: 'https://first.test/z/link' }, { sessionId: a.sessionId });
  await sleep(1500);
  expect('typed address in a new tab is asked about', asked(await urlOf(a.targetId)), await urlOf(a.targetId));

  // 2. A link on a page goes to a new site: not asked.
  const b = await open('about:blank');
  await browser.send('Page.navigate', { url: linkPage('start.test', 'https://linked.test/z/link') }, { sessionId: b.sessionId });
  await sleep(1500);
  await click(b.sessionId);
  await sleep(1500);
  const bu = await urlOf(b.targetId);
  expect('a followed link is not asked about', !asked(bu) && bu.startsWith('https://linked.test'), bu);

  // 3. Reloading that unmanaged site: not asked.
  await browser.send('Page.reload', {}, { sessionId: b.sessionId });
  await sleep(1500);
  const br = await urlOf(b.targetId);
  expect('a reload of an unmanaged site is not asked about', !asked(br), br);

  // 4. Typing a different site into that same tab: asked.
  await browser.send('Page.navigate', { url: 'https://typed.test/z/link' }, { sessionId: b.sessionId });
  await sleep(1500);
  expect('typed address in a used tab is asked about', asked(await urlOf(b.targetId)), await urlOf(b.targetId));

  // 5. A result clicked on a search engine is the user choosing a site: asked.
  const c = await open('about:blank');
  await browser.send('Page.navigate', { url: linkPage('www.bing.com', 'https://result.test/z/link') }, { sessionId: c.sessionId });
  await sleep(1500);
  const cu = await urlOf(c.targetId);
  expect('the search engine itself, once marked never-ask, loads', cu.startsWith('https://www.bing.com'), cu);
  await click(c.sessionId);
  await sleep(1500);
  expect('a search result clicked is asked about', asked(await urlOf(c.targetId)), await urlOf(c.targetId));

  browser.close();
} catch (e) {
  console.error(e.stack ?? e);
  failed++;
} finally {
  for (const p of [child, zoo]) {
    try {
      process.kill(p.pid);
    } catch {}
  }
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 1000);
  process.exitCode = failed ? 1 : 0;
}
