/**
 * ------------------------------------------------------------------
 *  Title    |  UI screenshots on current Chrome
 *  Ref      |  tools/cdp.mjs, tools/zoo/run.mjs
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Photograph the extension's own pages: popup, panel,
 *           |  chooser, welcome. shot.mjs relied on --load-extension,
 *           |  which Chrome removed, so this side-loads over CDP.
 *  How      |  Fresh profile, two seeded sessions with a few cookies,
 *           |  then each page opened at a set size and captured.
 *  Note     |  node tools/ui-shot.mjs <outdir> [page.html[?query]:WxH ...]
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserEndpoint, connect, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, process.env.UI_DIST ?? 'dist');
const CHROME = `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
const out = resolve(process.argv[2] ?? 'shots');
const wanted = process.argv.slice(3);
const pages = wanted.length
  ? wanted
  : ['popup.html:380x600', 'panel.html:1280x800', 'chooser.html?tab=1&url=https%3A%2F%2Fmail.google.com%2F:1280x800', 'welcome.html:1280x800'];
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'nvx-ui-'));
const port = 9900 + Math.floor(Math.random() * 90);
const child = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-device-scale-factor=2',
  'about:blank',
], { stdio: 'ignore' });

try {
  const v = await browserEndpoint(port);
  const browser = await connect(v.webSocketDebuggerUrl, { timeout: 30_000 });
  const loaded = await loadUnpacked(browser, DIST);
  if (!loaded.id) throw new Error(loaded.error);
  const id = loaded.id;

  // Seed through the worker so the pages have something real to draw.
  let sid = null;
  for (let i = 0; i < 30 && !sid; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
    if (w) {
      const r = await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: true });
      sid = r.sessionId;
    } else await sleep(300);
  }
  const ev = (expression) =>
    browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId: sid, timeout: 15_000 });
  for (let i = 0; i < 40; i++) {
    const r = await ev('typeof globalThis.__nvx').catch(() => null);
    if (r?.result?.value === 'object') break;
    await sleep(250);
  }
  if (!process.env.UI_NOSEED) {
    await ev(`(async () => {
      await __nvx.whenReady();
      await __nvx.createSession('Work', ['google.com', 'slack.com']);
      await __nvx.createSession('Personal', ['google.com']);
      await __nvx.createSession('Client QA', ['vercel.com']);
    })()`).catch((e) => console.error('seed:', e.message));
  }

  for (const spec of pages) {
    const cut = spec.lastIndexOf(':');
    const path = spec.slice(0, cut);
    const [w, h] = spec.slice(cut + 1).split('x').map(Number);
    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/${path}`, newWindow: true, width: w, height: h });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }, { sessionId });
    await sleep(1800);
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, { sessionId });
    const name = path.split(/[?#]/)[0].replace(/\.html$/, '');
    const file = join(out, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(file);
    await browser.send('Target.closeTarget', { targetId });
  }
  browser.close();
} catch (e) {
  console.error(e.stack ?? e);
  process.exitCode = 1;
} finally {
  try {
    process.kill(child.pid);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 1000);
}
