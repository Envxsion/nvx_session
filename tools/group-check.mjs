/**
 * ------------------------------------------------------------------
 *  Title    |  Native tab group check
 *  Ref      |  src/bg/index.ts (regroup, ungroupAll), popup setting
 *  ID       |  tool (group-check)
 * ------------------------------------------------------------------
 *  Purpose  |  Prove in a real Chrome that turning "Group tabs
 *           |  natively" on gathers each session's tabs into a group
 *           |  named after it, and turning it off takes them out.
 *  How      |  Loads dist, makes two sessions, binds tabs to them
 *           |  through the worker's diagnostic surface, then flips the
 *           |  setting from an extension page exactly as the popup does.
 *  Usage    |  node tools/build.mjs && node tools/group-check.mjs
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
const profile = mkdtempSync(join(tmpdir(), 'nvx-group-'));
const port = 9700 + Math.floor(Math.random() * 90);
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP *.test 127.0.0.1:18443',
    '--no-first-run',
    ...(process.env.NVX_LOAD_FLAG ? [`--load-extension=${DIST}`] : []),
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let failed = 0;
function expect(name, ok, got) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${JSON.stringify(got)})`}`);
  if (!ok) failed++;
}

try {
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
  const id = loaded.id;

  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const w = targetInfos.find((t) => (t.type === 'service_worker' || t.type === 'background_page') && t.url.includes(id));
    if (w) sid = (await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: true })).sessionId;
    else await sleep(250);
  }
  const ev = async (expression, sessionId = sid) => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { sessionId, timeout: 20_000 }
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  };
  for (let i = 0; i < 40; i++) {
    if ((await ev('typeof globalThis.__nvx').catch(() => '')) === 'object') break;
    await sleep(250);
  }

  // Flip settings the way the popup does: a message from an extension page.
  const page = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  const ps = (await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await sleep(1200);
  const send = (msg) => ev(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`, ps);
  // The new-site question would hold these tabs at the picker; this test is
  // about grouping, so it is turned off first.
  await send({ cmd: 'setSettings', askNewSites: false });

  // Four plain tabs, two per session.
  for (const u of ['https://a1.test/', 'https://a2.test/', 'https://b1.test/', 'https://b2.test/']) {
    await browser.send('Target.createTarget', { url: u });
  }
  await sleep(1500);
  const plan = await ev(`(async () => {
    await __nvx.whenReady();
    const work = await __nvx.createSession('Work');
    const home = await __nvx.createSession('Home');
    const tabs = await chrome.tabs.query({});
    const pick = (h) => tabs.find((t) => (t.url || t.pendingUrl || '').includes(h));
    for (const [h, s] of [['a1.test', work], ['a2.test', work], ['b1.test', home], ['b2.test', home]]) {
      const t = pick(h);
      // No window, as most real bindings are made (onBeforeNavigate has none).
      await __nvx.bind(t.id, s, t.url || t.pendingUrl);
    }
    return { work, home, available: typeof chrome.tabGroups === 'object' };
  })()`);
  if (!plan.available) {
    // MV2 builds and browsers without the API: the setting is shown disabled
    // ("This browser exposes no tab group API"), so there is nothing to test.
    console.log('SKIP  no tab group API here (MV2, or the browser has none); the setting is disabled');
    browser.close();
    process.exit(0);
  }
  expect('this browser has a tab group API', plan.available, plan);

  const groups = () =>
    ev(`(async () => {
      const tabs = await chrome.tabs.query({});
      const out = {};
      for (const t of tabs) {
        if (t.groupId === -1 || t.groupId === undefined) continue;
        const g = await chrome.tabGroups.get(t.groupId);
        (out[g.title] ??= []).push(new URL(t.url || t.pendingUrl).hostname);
      }
      for (const k in out) out[k].sort();
      return out;
    })()`);

  await send({ cmd: 'setSettings', group: true });
  await sleep(1500);
  let g = await groups();
  expect('Work is gathered into its own group', JSON.stringify(g.Work) === '["a1.test","a2.test"]', g);
  expect('Home is gathered into its own group', JSON.stringify(g.Home) === '["b1.test","b2.test"]', g);

  // A tab bound after the setting is on joins its group.
  await browser.send('Target.createTarget', { url: 'https://a3.test/' });
  await sleep(1000);
  await ev(`(async () => {
    const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl || '').includes('a3.test'));
    await __nvx.bind(t.id, ${JSON.stringify(plan.work)}, t.url || t.pendingUrl);
  })()`);
  await sleep(1500);
  g = await groups();
  expect('a tab added to Work later joins the group', (g.Work ?? []).includes('a3.test'), g);

  // A tab taken out of its session leaves the session's group.
  await browser.send('Target.createTarget', { url: 'https://loose.test/' });
  await sleep(1000);
  const looseId = await ev(`(async () => (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl || '').includes('loose.test')).id)()`);
  await send({ cmd: 'unbind', tabId: looseId });
  await sleep(1500);
  g = await groups();
  expect('a tab taken out of its session leaves the group', !Object.values(g).flat().includes('loose.test'), g);

  // An unmanaged tab dropped into Work's group (as the browser does with a tab
  // opened beside a grouped one) is taken back out.
  await ev(`(async () => {
    const tabs = await chrome.tabs.query({});
    const work = tabs.find((x) => (x.url || x.pendingUrl || '').includes('a1.test'));
    await chrome.tabs.group({ tabIds: [${looseId}], groupId: work.groupId });
  })()`);
  await sleep(1500);
  g = await groups();
  expect('an unmanaged tab put in a session group is taken out', !Object.values(g).flat().includes('loose.test'), g);

  await send({ cmd: 'setSettings', group: false });
  await sleep(1500);
  g = await groups();
  expect('turning it off ungroups every session tab', Object.keys(g).length === 0, g);

  browser.close();
} catch (e) {
  console.error(e.stack ?? e);
  failed++;
} finally {
  try {
    process.kill(child.pid);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 1000);
  process.exitCode = failed ? 1 : 0;
}
