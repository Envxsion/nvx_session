/**
 * ------------------------------------------------------------------
 *  Title    |  Surface screenshots
 *  Ref      |  cdp.mjs, popup.html, diagnostics.html
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Screenshot the control panel, or the toolbar popup.
 *  How      |  Typechecking says nothing about two labels collapsing
 *           |  into one word, or a quiet button reading as disabled;
 *           |  both shipped and were only caught by looking. Loads the
 *           |  built extension, opens the surface, writes a png.
 *  Note     |  The popup cannot be opened from the toolbar here, so it
 *           |  loads as a page at the browser's width: same document
 *           |  and stylesheet, but not the height, which is why the
 *           |  popup caps itself rather than trusting the chrome.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, process.argv.includes('--mv2') ? 'dist-mv2' : 'dist');
const FIXTURE = 'http://localhost:8787';

const BROWSERS = {
  opera: [`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`],
  chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
};

const which = process.argv[2] ?? 'opera';
const out = resolve(process.argv[3] ?? 'panel.png');
const seed = process.argv.includes('--seed');
const popup = process.argv.includes('--popup');
// Which view to photograph. The popup is one surface with several, and the
// interesting layout problems are in the ones that widen.
const view = (process.argv.find((a) => a.startsWith('--view=')) ?? '').split('=')[1] ?? '';
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Any other page in the package, for surfaces that are
 *           |  neither the panel nor the popup: setup and the guide.
 *  Note     |  Both are full-width documents with no state to seed, so
 *           |  photographing them is the whole of checking them.
 * ------------------------------------------------------------------
 */
const page = (process.argv.find((a) => a.startsWith('--page=')) ?? '').split('=')[1] ?? '';
const binary = (BROWSERS[which] ?? []).find((p) => existsSync(p));
if (!binary) {
  console.error(`no binary for ${which}`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nvx-shot-'));

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The first free port, not a random one.
 *  Note     |  A random port collides often enough to matter for
 *           |  back-to-back shots, and a collision connects to the
 *           |  browser still shutting down from the last run and
 *           |  photographs whatever it had on screen, a wrong answer
 *           |  that wastes an hour because nothing looks like an error.
 * ------------------------------------------------------------------
 */
async function freePort(from) {
  for (let p = from; p < from + 40; p++) {
    const taken = await fetch(`http://127.0.0.1:${p}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!taken) return p;
  }
  throw new Error(`no free debugging port from ${from}`);
}
const PORT = await freePort(9860);

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
    `${FIXTURE}/page?shot=1`,
  ],
  { stdio: 'ignore' }
);

const shutdown = (code) => {
  try {
    process.kill(child.pid);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 600);
};

try {
  const v = await browserEndpoint(PORT);
  const browser = await connect(v.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });
  const loaded = await loadUnpacked(browser, DIST);
  if (!loaded.id) throw new Error(`side-load failed: ${loaded.error}`);

  if (seed) {
    // A panel with nothing in it hides exactly the layout problems worth
    // catching, so the shot is taken against a populated one.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const { targetInfos } = await browser.send('Target.getTargets');
      const worker = targetInfos.find(
        (t) => t.type === 'service_worker' && t.url.includes(loaded.id)
      );
      if (!worker) continue;
      const { sessionId } = await browser.send('Target.attachToTarget', {
        targetId: worker.targetId,
        flatten: true,
      });
      const evaluate = (expression) =>
        browser.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          { sessionId, timeout: 30_000 }
        );
      const probe = await evaluate('typeof globalThis.__nvx').catch(() => null);
      if (probe?.result?.value !== 'object') continue;
      await evaluate(`(async () => {
        await __nvx.createSession('shot_work', ['vercel.com']);
        await __nvx.createSession('shot_personal', ['github.com']);
        await __nvx.seed('shot_work', '${FIXTURE}/', 'sid=WORK; Path=/');
        await __nvx.seed('shot_personal', '${FIXTURE}/', 'sid=PERSONAL; Path=/');
        // The active tab, so the popup's hero is populated rather than showing
        // the unmanaged state every time.
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active) await __nvx.bind(active.id, 'shot_work', active.url || '${FIXTURE}/page', active.windowId);
        __nvx.registry.getSession('shot_work').danger = 'block';
        // Through the real classifier, so what the screenshot shows is what the
        // catalog actually says rather than three hand-written strings.
        const hits = [
          ['https://api.vercel.com/v9/projects/prj_9k2', 'DELETE', 'shot_work', 'block'],
          ['https://api.github.com/repos/acme/site', 'DELETE', 'shot_personal', 'warn'],
          ['https://acme.dev/api/drafts/41', 'DELETE', 'shot_personal', 'warn'],
        ];
        let t = Date.now() - 600000;
        for (const [url, method, id, danger] of hits) {
          const s = __nvx.registry.getSession(id);
          __nvx.guard.note({ url, method }, { id, label: s.label, danger }, t);
          t += 240000;
        }
        // Third parties, so the list and the control that acts on it can be
        // looked at. One session blocking and one allowing, because the two
        // states are the whole point of the view.
        __nvx.registry.getSession('shot_personal').thirdParty = 'allow';
        for (const [id, party, via, blocked] of [
          ['shot_work', 'doubleclick.net', 'vercel.com', true],
          ['shot_work', 'googletagmanager.com', 'vercel.com', true],
          ['shot_personal', 'doubleclick.net', 'github.com', false],
          ['shot_personal', 'hm.baidu.com', 'github.com', false],
        ]) __nvx.note(id, party, via, blocked);
        ${
          process.argv.includes('--leak')
            ? `
        // The one state that cannot be reached by arranging the world: a
        // foreign cookie means something outside the extension wrote to a
        // managed tab's jar, and there is no way to stage that on purpose.
        for (let i = 0; i < 2; i++) {
          __nvx.desync.observed();
          __nvx.desync.record({
            kind: 'foreign', url: '${FIXTURE}/echo', tabId: -1,
            sessionId: 'shot_work', context: 'first-party',
            names: ['sid'], at: Date.now(),
          });
        }`
            : ''
        }
      })()`);
      break;
    }
  }

  const { targetId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${loaded.id}/${page || (popup ? 'popup.html' : 'diagnostics.html')}`,
  });
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.send('Page.enable', {}, { sessionId });
  // Longer for anything that has to ask a cold worker before it has content.
  await new Promise((r) => setTimeout(r, page ? 6000 : 2500));

  // The popup reads whichever tab is active, and opening it as a page makes it
  // the active tab, so it would photograph itself reporting that there is
  // nothing here. Activating the site again and reloading puts it back in the
  // situation it is actually built for: a real page in front, popup behind.
  if (popup) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const site = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(FIXTURE));
    if (site) {
      const a = await browser
        .send('Target.attachToTarget', { targetId: site.targetId, flatten: true })
        .catch(() => ({}));
      if (a.sessionId) await browser.send('Page.bringToFront', {}, { sessionId: a.sessionId });
      await browser.send('Page.reload', {}, { sessionId });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /**
   * Foreground before driving anything, not just before capturing.
   *
   * The block above deliberately activates the site so the popup reads a real
   * tab, which leaves the popup in the background. A backgrounded page is
   * throttled, and a control that saves and repaints did not finish inside the
   * wait: the posture control photographed as though the press had done
   * nothing, three times, while a probe against a foregrounded popup showed it
   * working perfectly. By here the popup has already read the tab, so bringing
   * it forward changes nothing about what is on it.
   */
  if (popup) await browser.send('Page.bringToFront', {}, { sessionId }).catch(() => {});

  if (popup && view) {
    await browser.send(
      'Runtime.evaluate',
      { expression: `document.querySelector('.nav-b[data-go="${view}"]').click()` },
      { sessionId }
    );
    await new Promise((r) => setTimeout(r, 900));
  }

  // A sheet is where the controls that need the most looking at live, and it
  // only exists once something opens it.
  if (process.argv.includes('--sheet')) {
    await browser.send(
      'Runtime.evaluate',
      { expression: `document.querySelector('.row--session .btn--quiet').click()` },
      { sessionId }
    );
    await new Promise((r) => setTimeout(r, 900));
  }

  // Anything else worth photographing is behind a button, and naming the button
  // is cheaper than a flag per sheet. --click=adopt is the one that matters:
  // the adoption sheet is the densest surface in the product and the only one
  // whose defects have all been found by looking rather than by a suite.
  const click = (process.argv.find((a) => a.startsWith('--click=')) ?? '').split('=')[1] ?? '';
  if (click) {
    await browser.send(
      'Runtime.evaluate',
      { expression: `document.getElementById(${JSON.stringify(click)})?.click()` },
      { sessionId }
    );
    await new Promise((r) => setTimeout(r, 1800));
  }

  // Some states are only reachable by pressing something that has no id, and
  // the armed delete is one worth being able to look at: it is the only
  // irreversible control in the product.
  const press = (process.argv.find((a) => a.startsWith('--press=')) ?? '').split('=')[1] ?? '';
  if (press) {
    await browser.send(
      'Runtime.evaluate',
      { expression: `document.querySelector(${JSON.stringify(press)})?.click()` },
      { sessionId }
    );
    // Long enough for a control that saves and repaints. 700 photographed the
    // state before the repaint landed and looked like the press did nothing.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // The popup caps its own height and hides the overflow, so the layout metric
  // reports the document rather than what the browser would show. Asking the
  // body is the only number that matches the real thing.
  // Animations off before measuring. Entry animations make two shots of the
  // same state differ, and a width transition on the body fights the metrics
  // override hard enough that the capture times out.
  await browser.send(
    'Runtime.evaluate',
    {
      expression:
        "const s=document.createElement('style');s.textContent='*,*::before,*::after{animation:none !important;transition:none !important}';document.head.append(s);",
    },
    { sessionId }
  );
  await new Promise((r) => setTimeout(r, 250));

  /**
   * The popup sets its own width per view and its own height from its content,
   * which is the whole point of both, so the override has to follow the
   * document rather than pin it.
   *
   * Then it pins it. A viewport override on a document whose height is
   * content-driven, holding a position: fixed sheet sized from that same
   * viewport, is a loop: the override resizes the viewport, the sheet resizes,
   * layout settles at a different height, and the capture never gets a stable
   * frame. It timed out every time with a sheet open and intermittently
   * without one. Stamping the measured height on the body before capturing
   * breaks the dependency, and since the numbers came from the live layout the
   * photograph is still of the real thing.
   */
  const measured = popup
    ? await browser.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const sheet = [...document.querySelectorAll('.sheet')].find((n) => !n.hidden);
            const body = document.body.getBoundingClientRect();
            const h = Math.min(584, Math.ceil(Math.max(
              body.height,
              sheet ? sheet.querySelector('.sheet-body').scrollHeight : 0
            )));
            document.body.style.height = h + 'px';
            return JSON.stringify({ w: Math.ceil(body.width), h });
          })()`,
          returnByValue: true,
        },
        { sessionId }
      )
    : null;
  const box = measured ? JSON.parse(measured.result.value) : null;
  const metrics = await browser.send('Page.getLayoutMetrics', {}, { sessionId });
  const h = Math.ceil(box?.h || metrics.cssContentSize?.height || 900);
  // The popup is a fixed width by definition, and screenshotting it any wider
  // measures a layout the user will never see.
  const w = box?.w || (popup ? 400 : 960);

  /**
   * Two goes, at two pixel ratios.
   *
   * A retina capture is worth having: half the defects found by looking at
   * these were a hairline that turned out to be a border nobody could see, and
   * at 1x a hairline is a hairline whether it renders or not.
   *
   * But asking for it through deviceScaleFactor hangs. A tall popup at
   * deviceScaleFactor 2 asks the compositor for a surface it never produces a
   * frame for, and captureScreenshot then waits forever rather than failing:
   * forty seconds of waiting proved it is stuck, not slow. The shorter views
   * came back and every view over about 500 pixels tall did not, which is why
   * it looked intermittent for a while.
   *
   * So the viewport stays at 1 and the scale goes on the clip instead. Same
   * pixels, no oversized surface. 1x is still the fallback, because a softer
   * photograph of the right layout beats no photograph at all.
   *
   * captureBeyondViewport is for the page, which is taller than any window.
   * The popup must never use it: the override below already sizes the viewport
   * to the whole surface.
   */
  /**
   * Foreground the surface being photographed.
   *
   * The popup reads whichever tab is active, so the block above deliberately
   * activates the site and leaves the popup in the background. That is right
   * for what the popup reads and wrong for capturing it: a backgrounded
   * renderer stops producing frames, and Page.captureScreenshot then waits for
   * one that never comes rather than returning an error. It looked like a
   * scale problem for a while because the short views happened to still have a
   * warm surface and the tall ones did not.
   *
   * By here the popup has already read the tab and painted, so bringing it
   * forward changes nothing about what is on it.
   */
  await browser.send('Page.bringToFront', {}, { sessionId }).catch(() => {});

  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    { sessionId }
  );
  await new Promise((r) => setTimeout(r, 600));

  /** Scale lives on the clip, not on the viewport. See above. */
  function capture(scale) {
    return browser.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: !popup,
        ...(popup ? { clip: { x: 0, y: 0, width: w, height: h, scale } } : {}),
      },
      { sessionId, timeout: 12_000 }
    );
  }

  let shot = null;
  let scale = 2;
  try {
    shot = await capture(2);
  } catch {
    scale = 1;
    console.error(`2x capture did not return a frame at ${w}x${h}; falling back to 1x`);
    shot = await capture(1);
  }

  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`${out}  ${w}x${h}${scale === 1 ? "  (1x)" : ""}`);
  shutdown(0);
} catch (e) {
  console.error(`shot failed: ${e.message}`);
  shutdown(2);
}
