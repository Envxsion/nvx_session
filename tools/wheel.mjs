/**
 * Does a wheel over the list actually scroll the view.
 *
 * Separate from every other probe because it has to arrive as input rather than
 * as an assignment. `scrollTop = 120` moves whichever element you name and says
 * nothing about which element the browser would have chosen; a wheel has to be
 * routed, and routing is what was broken. Driven through Input.dispatchMouseEvent
 * so the browser does that routing itself.
 *
 * It exists because a reported bug survived a passing suite. Every list in the
 * popup carried the shared `[data-scrollable]` token, which grants both
 * `overflow-y: auto` and `overscroll-behavior: contain`, while sitting inside a
 * stage that carried the same token. Each list was therefore a scroll container
 * nested in one that had been told not to chain: the inner had nothing to
 * scroll, the outer never heard about it, and the view sat still under a wheel
 * while the scrollbar rail worked perfectly. Assignment moves whichever element
 * you name, so nothing that scrolled by assignment could ever see it.
 *
 *   node tools/fixture/server.mjs
 *   node tools/wheel.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked } from './cdp.mjs';

const DIST = 'C:\\Users\\cyn0v\\Documents\\GitHub\\nvx_session\\dist';
const profile = mkdtempSync(join(tmpdir(), 'nvx-wheel-'));
const PORT = 9971;
const child = spawn(`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging', `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check',
  'http://localhost:8787/page',
], { stdio: 'ignore' });

const v = await browserEndpoint(PORT);
const browser = await connect(v.webSocketDebuggerUrl);
await browser.send('Target.setDiscoverTargets', { discover: true });
const loaded = await loadUnpacked(browser, DIST);
await new Promise((r) => setTimeout(r, 2500));

const t = await browser.send('Target.createTarget', { url: `chrome-extension://${loaded.id}/popup.html` });
const s = (await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
await new Promise((r) => setTimeout(r, 2000));

// Enough sessions that every list is longer than the stage.
await browser.send('Runtime.evaluate', {
  expression: `(async()=>{for(let i=0;i<14;i++){await send({cmd:'createSession',label:'Session number '+i,pinned:['localhost']});}await refresh();paintHome(true);})()`,
  awaitPromise: true,
}, { sessionId: s, timeout: 30000 }).catch((e) => console.log('seed failed', e.message));
await new Promise((r) => setTimeout(r, 1500));

const at = async () =>
  JSON.parse((await browser.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      view: document.body.dataset.view,
      stage: document.getElementById('stage').scrollTop,
      canScroll: document.getElementById('stage').scrollHeight > document.getElementById('stage').clientHeight,
      innerScrollers: [...document.querySelectorAll('.view [data-scrollable]')]
        .filter((n) => getComputedStyle(n).overflowY !== 'visible').map((n) => n.id),
    })`, returnByValue: true }, { sessionId: s, timeout: 8000 })).result.value);

async function wheel(y = 300) {
  // Over the middle of the list rather than the middle of the window, which is
  // the point: the element under the pointer is what decides where this goes.
  const box = JSON.parse((await browser.send('Runtime.evaluate', {
    expression: `(() => {
      // The stage's visible box, not the view's. A view is as tall as its
      // content, so its midpoint on a long list is below the bottom of the
      // window, and a wheel dispatched there lands outside the popup and does
      // nothing. That produced a DID NOT MOVE against a view that scrolls
      // perfectly, which is the probe lying in the same direction as the bug it
      // was written to catch.
      const st = document.getElementById('stage');
      const r = st.getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + Math.min(r.height, window.innerHeight - r.top) / 2),
      });
    })()`,
    returnByValue: true }, { sessionId: s, timeout: 8000 })).result.value);
  // The pointer has to be over the thing first. Chromium routes a wheel to the
  // element under the cursor, and a wheel with no preceding move can arrive
  // before the compositor has a scroll node for the target at all.
  await browser.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: box.x, y: box.y, pointerType: 'mouse',
  }, { sessionId: s, timeout: 8000 });
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 4; i++) {
    await browser.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: y, pointerType: 'mouse',
    }, { sessionId: s, timeout: 8000 });
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 500));
}

let bad = 0;
for (const view of ['sessions', 'tabs', 'trail', 'parties', 'journal', 'guide']) {
  await browser.send('Runtime.evaluate', { expression: `go('${view}')` }, { sessionId: s, timeout: 8000 });
  await new Promise((r) => setTimeout(r, 900));
  const before = await at();
  await wheel(300);
  let after = await at();
  // One retry, and only for a view that should have moved and did not.
  //
  // Not papering over a failure: the first wheel dispatched into a freshly
  // created target is occasionally dropped while the compositor is still
  // building a scroll node for it, which is a property of driving input over
  // the debugger rather than anything a user would meet. A second wheel that
  // also does nothing is a real failure and still reported as one. Measured:
  // three consecutive green runs after this, against one intermittent before.
  if (before.canScroll && after.stage <= before.stage) {
    await wheel(300);
    after = await at();
  }
  const moved = after.stage - before.stage;
  const verdict = !before.canScroll ? 'fits, nothing to scroll' : moved > 0 ? `moved ${moved}px` : 'DID NOT MOVE';
  if (before.canScroll && moved <= 0) bad++;
  if (after.innerScrollers.length) bad++;
  console.log(
    `${view.padEnd(9)} ${verdict}` +
      (after.innerScrollers.length ? `  nested scrollers still live: ${after.innerScrollers}` : '')
  );
}

console.log(bad ? `\n${bad} problem(s)` : '\nevery view that can scroll, scrolls from a wheel');
try { process.kill(child.pid); } catch {}
process.exit(bad ? 1 : 0);
