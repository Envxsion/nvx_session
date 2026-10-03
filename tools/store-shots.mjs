/**
 * ------------------------------------------------------------------
 *  Title    |  Store assets
 *  Ref      |  tools/ui-shot.mjs, src/pro/STORE.md
 *  ID       |  tool (store-shots)
 * ------------------------------------------------------------------
 *  Purpose  |  The Chrome Web Store images, made from the real UI of
 *           |  the store build: five 1280x800 screenshots, the small
 *           |  promo tile (440x280) and the marquee (1400x560).
 *  How      |  Builds the Pro store package, writes two helper pages
 *           |  into dist-store (a caption frame around the real popup,
 *           |  and the tile), loads it into a throwaway Chrome profile,
 *           |  seeds sessions and tabs through the worker, and captures
 *           |  each page at device scale 1 so the PNGs are exactly the
 *           |  size the store asks for. The helper pages never reach
 *           |  extension/ or a release zip: package.mjs rebuilds.
 *  Usage    |  node tools/store-shots.mjs [outdir]
 *           |  -> release/store-assets/*.png ; SKIP_BUILD=1 to reuse
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserEndpoint, connect, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-store');
const CHROME = process.env.NVX_BROWSER ?? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;
const OUT = resolve(process.argv[2] ?? join(ROOT, 'release', 'store-assets'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.SKIP_BUILD) {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build.mjs'), '--store'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NVX_TIER: process.env.NVX_TIER ?? 'pro' },
  });
}
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ helper pages

const FRAME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>NVX Session</title>
<link rel="stylesheet" href="ui/tokens.css" />
<style>
  html, body { margin: 0; height: 100%; }
  body {
    width: 1280px; height: 800px; overflow: hidden; position: relative;
    background: var(--void); color: var(--fg); font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  .glow {
    position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(620px 520px at 78% 52%, rgba(220, 234, 79, 0.10), transparent 70%),
      radial-gradient(520px 420px at 12% 88%, rgba(79, 214, 234, 0.06), transparent 70%);
  }
  .grain {
    position: absolute; inset: 0; pointer-events: none; opacity: 0.05;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  }
  .copy { position: absolute; left: 96px; top: 50%; transform: translateY(-50%); width: 520px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
  .brand-name { font-family: var(--font-display); font-weight: 650; font-size: 20px; letter-spacing: -0.01em; }
  .brand-name span { color: var(--mute); font-weight: 400; }
  h1 {
    font-family: var(--font-display); font-weight: 700; font-stretch: 112%;
    font-size: 54px; line-height: 1.02; letter-spacing: -0.03em; margin: 0 0 22px;
    text-wrap: balance;
  }
  h1 em { font-style: normal; color: var(--signal); }
  p { font-size: 19px; line-height: 1.5; color: var(--mute); margin: 0; max-width: 470px; text-wrap: pretty; }
  .shell {
    position: absolute; right: 110px; top: 50%; transform: translateY(-50%);
    width: 480px; height: 600px; border-radius: 18px; overflow: hidden;
    background: var(--chrome); border: 1px solid var(--edge);
    box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 120px -40px rgba(220, 234, 79, 0.25);
  }
  iframe { width: 480px; height: 600px; border: 0; display: block; background: var(--void); }
</style></head>
<body>
  <div class="glow"></div><div class="grain"></div>
  <div class="copy">
    <div class="brand"><span id="mark"></span><span class="brand-name">NVX <span>Session</span></span></div>
    <h1 id="h"></h1>
    <p id="s"></p>
  </div>
  <div class="shell"><iframe id="f"></iframe></div>
  <script src="ui/mark.js"></script>
  <script src="store-frame.js"></script>
</body></html>`;

const FRAME_JS = `const q = new URLSearchParams(location.search);
document.getElementById('h').innerHTML = q.get('h') || '';
document.getElementById('s').textContent = q.get('s') || '';
globalThis.mountMark?.(document.getElementById('mark'), { size: 34, state: 'live' });
const f = document.getElementById('f');
f.src = 'popup.html?view=' + encodeURIComponent(q.get('view') || 'home');
f.addEventListener('load', () => {
  // The popup is as tall as its content, up to the browser's 600 limit, so the
  // shell follows it rather than framing empty space.
  const fit = () => {
    const d = f.contentDocument;
    if (!d) return;
    const h = Math.min(600, Math.max(380, d.body.scrollHeight));
    f.style.height = h + 'px';
    document.querySelector('.shell').style.height = h + 'px';
  };
  setTimeout(fit, 300);
  setTimeout(fit, 1000);
  const sel = q.get('scroll');
  if (!sel) return;
  const tryScroll = (n) => {
    const el = f.contentDocument && f.contentDocument.querySelector(sel);
    if (el) (el.closest('section') || el).scrollIntoView({ block: 'start' });
    else if (n > 0) setTimeout(() => tryScroll(n - 1), 150);
  };
  setTimeout(() => tryScroll(20), 400);
});
`;

const TILE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>NVX Session</title>
<link rel="stylesheet" href="ui/tokens.css" />
<style>
  html, body { margin: 0; }
  body {
    overflow: hidden; position: relative; background: var(--void); color: var(--fg);
    font-family: var(--font-sans); -webkit-font-smoothing: antialiased;
  }
  .glow { position: absolute; inset: 0; background: radial-gradient(60% 90% at 82% 50%, rgba(220, 234, 79, 0.14), transparent 70%); }
  .grain {
    position: absolute; inset: 0; opacity: 0.05;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  }
  .wrap { position: absolute; inset: 0; display: flex; align-items: center; }
  .name { font-family: var(--font-display); font-weight: 700; font-stretch: 112%; letter-spacing: -0.03em; line-height: 1; }
  .name span { color: var(--mute); font-weight: 400; font-stretch: 100%; }
  .tag { color: var(--mute); line-height: 1.35; }
  .tag b { color: var(--fg); font-weight: 600; }
  .rings { position: absolute; }
  .swatches { display: flex; gap: 8px; margin-top: 18px; }
  .swatches i { width: 10px; height: 10px; border-radius: 3px; display: block; }
  body.small { width: 440px; height: 280px; }
  body.small .wrap { padding: 0 34px; }
  body.small .name { font-size: 40px; margin: 16px 0 10px; }
  body.small .tag { font-size: 15px; max-width: 250px; }
  body.small .rings { right: -40px; top: 50%; transform: translateY(-50%); }
  body.marquee { width: 1400px; height: 560px; }
  body.marquee .wrap { padding: 0 110px; }
  body.marquee .name { font-size: 96px; margin: 26px 0 22px; }
  body.marquee .tag { font-size: 26px; max-width: 780px; }
  body.marquee .rings { right: 120px; top: 50%; transform: translateY(-50%); }
</style></head>
<body>
  <div class="glow"></div><div class="grain"></div>
  <div class="rings" id="big"></div>
  <div class="wrap"><div>
    <span id="mark"></span>
    <div class="name">NVX <span>Session</span></div>
    <div class="tag"><b>Several accounts on one site,</b> each tab in its own session.</div>
    <div class="swatches"><i style="background:var(--s-jade)"></i><i style="background:var(--s-azure)"></i><i style="background:var(--s-amber)"></i><i style="background:var(--s-coral)"></i></div>
  </div></div>
  <script src="ui/mark.js"></script>
  <script src="store-tile.js"></script>
</body></html>`;

// Extension pages refuse inline script (MV3 CSP), so the page logic is a file.
const TILE_JS = `const kind = new URLSearchParams(location.search).get('kind') || 'small';
document.body.className = kind;
globalThis.mountMark?.(document.getElementById('mark'), { size: kind === 'small' ? 30 : 52, state: 'live' });
globalThis.mountMark?.(document.getElementById('big'), { size: kind === 'small' ? 230 : 380, state: 'idle' });
document.getElementById('big').style.opacity = kind === 'small' ? '0.22' : '0.3';
`;

writeFileSync(join(DIST, 'store-frame.html'), FRAME);
writeFileSync(join(DIST, 'store-frame.js'), FRAME_JS);
writeFileSync(join(DIST, 'store-tile.html'), TILE);
writeFileSync(join(DIST, 'store-tile.js'), TILE_JS);

// ---------------------------------------------------------------- browser

const profile = mkdtempSync(join(tmpdir(), 'nvx-store-'));
const port = 9500 + Math.floor(Math.random() * 90);
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--force-device-scale-factor=1',
    // Seeded tabs point at real site names; nothing should actually load.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const made = [];
try {
  const v = await browserEndpoint(port);
  const browser = await connect(v.webSocketDebuggerUrl, { timeout: 30_000 });
  const loaded = await loadUnpacked(browser, DIST);
  if (!loaded.id) throw new Error(loaded.error);
  const id = loaded.id;

  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const w = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(id));
    if (w) sid = (await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: true })).sessionId;
    else await sleep(250);
  }
  const ev = async (expression, sessionId = sid) => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { sessionId, timeout: 30_000 }
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  };
  for (let i = 0; i < 40; i++) {
    if ((await ev('typeof globalThis.__nvx').catch(() => '')) === 'object') break;
    await sleep(250);
  }

  // Settings go through an extension page, the way the popup sends them.
  const ctl = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  const cs = (await browser.send('Target.attachToTarget', { targetId: ctl.targetId, flatten: true })).sessionId;
  await sleep(1000);
  await ev(`chrome.runtime.sendMessage({ cmd: 'setSettings', askNewSites: false })`, cs);

  // Sessions with a little history, so no view is empty.
  await ev(`(async () => {
    await __nvx.whenReady();
    await __nvx.createSession('Work', ['google.com', 'slack.com', 'atlassian.net']);
    await __nvx.createSession('Personal', ['google.com', 'youtube.com']);
    await __nvx.createSession('Client QA', ['vercel.com', 'github.com']);
    const jar = {
      'Work': ['https://mail.google.com/', 'https://app.slack.com/', 'https://acme.atlassian.net/'],
      'Personal': ['https://mail.google.com/', 'https://www.youtube.com/'],
      'Client QA': ['https://vercel.com/', 'https://github.com/'],
    };
    for (const [s, urls] of Object.entries(jar)) {
      for (const u of urls) {
        for (const n of ['SID', 'HSID', 'pref']) {
          await __nvx.seed(s, u, n + '=' + Math.random().toString(36).slice(2) + '; Path=/; Secure; Max-Age=86400').catch(() => 0);
        }
      }
    }
  })()`);

  const sites = [
    ['https://mail.google.com/mail/u/0/', 'Work'],
    ['https://app.slack.com/client', 'Work'],
    ['https://acme.atlassian.net/jira', 'Work'],
    ['https://mail.google.com/mail/u/0/', 'Personal'],
    ['https://www.youtube.com/', 'Personal'],
    ['https://vercel.com/dashboard', 'Client QA'],
    ['https://news.ycombinator.com/', null],
  ];
  for (const [u] of sites) await browser.send('Target.createTarget', { url: u });
  await sleep(1500);
  const { first: firstTab, unbound } = await ev(`(async () => {
    const tabs = await chrome.tabs.query({});
    const plan = ${JSON.stringify(sites)};
    const used = new Set();
    let first = null;
    const unbound = [];
    for (const [u, s] of plan) {
      const t = tabs.find((x) => !used.has(x.id) && (x.url || x.pendingUrl || '').startsWith(u.slice(0, 22)));
      if (!t) continue;
      used.add(t.id);
      first ??= t.id;
      if (s) await __nvx.bind(t.id, s, u);
      else unbound.push(t.id);
    }
    return { first, unbound };
  })()`);

  // A tab opened beside a session tab inherits it as its opener's child; the
  // last one is meant to show an unmanaged tab, so it is taken back out. Then
  // the question about new sites goes back on, as it ships.
  for (const tabId of unbound) await ev(`chrome.runtime.sendMessage({ cmd: 'unbind', tabId: ${tabId} })`, cs);
  await ev(`chrome.runtime.sendMessage({ cmd: 'setSettings', askNewSites: true, quiet: ['news.ycombinator.com'] })`, cs);

  async function shot(name, url, w, h, wait = 1800) {
    const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true, width: w, height: h });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false },
      { sessionId }
    );
    await sleep(wait);
    const png = await browser.send('Page.captureScreenshot', { format: 'png' }, { sessionId });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(png.data, 'base64'));
    made.push(file);
    console.log(file);
    await browser.send('Target.closeTarget', { targetId });
  }

  const base = `chrome-extension://${id}`;
  const frame = (view, h, s, scroll = '') =>
    `${base}/store-frame.html?view=${view}&h=${encodeURIComponent(h)}&s=${encodeURIComponent(s)}${
      scroll ? `&scroll=${encodeURIComponent(scroll)}` : ''
    }`;

  await shot(
    '1-ask-before-load',
    `${base}/chooser.html?tab=${firstTab}&url=${encodeURIComponent('https://mail.google.com/')}`,
    1280,
    800,
    2200
  );
  await shot(
    '2-sessions',
    frame(
      'sessions',
      'Several accounts on <em>one site</em>, side by side.',
      'Each session keeps its own cookies and its own site storage, so Work and Personal stay signed in at the same time in one window.'
    ),
    1280,
    800,
    2600
  );
  await shot(
    '3-tabs',
    frame(
      'tabs',
      'Every tab knows <em>which account</em> it is.',
      'See which session each tab is in and move one across in a click. The toolbar icon takes the colour of the session you are looking at.'
    ),
    1280,
    800,
    2600
  );
  await shot(
    '4-new-sites',
    frame(
      'settings',
      'Asked <em>before</em> a new site loads.',
      'Open a site no session knows yet and NVX asks which one it belongs to, so nothing signs in to the wrong account by accident.',
      '#asknew'
    ),
    1280,
    800,
    2800
  );
  await shot(
    '5-journal',
    frame(
      'journal',
      'It shows its work, <em>on your machine</em>.',
      'A plain record of every tab it placed and every sign-in it helped through. No cookie values, no page contents, nothing sent anywhere.'
    ),
    1280,
    800,
    2600
  );
  await shot('promo-small-440x280', `${base}/store-tile.html?kind=small`, 440, 280, 1500);
  await shot('promo-marquee-1400x560', `${base}/store-tile.html?kind=marquee`, 1400, 560, 1500);

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
