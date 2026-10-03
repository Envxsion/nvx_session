/**
 * ------------------------------------------------------------------
 *  Title    |  Sign-in pattern zoo runner
 *  Ref      |  tools/zoo/server.mjs, tools/cdp.mjs
 *  ID       |  tools (zoo)
 * ------------------------------------------------------------------
 *  Purpose  |  Prove every sign-in mechanism behaves inside NVX the
 *           |  way it does in plain Chrome, with two accounts at once.
 *  How      |  Two browsers. A baseline with no extension runs each
 *           |  scenario once, which proves the scenario itself. Then
 *           |  a browser with NVX runs it in two sessions side by side
 *           |  and asks each afterwards who it is signed in as, which
 *           |  proves both the flow and the isolation.
 *  Note     |  node tools/zoo/run.mjs [scenario ...] [--keep] [--nvx-only]
 *           |  Needs dist built (node tools/build.mjs).
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserEndpoint, connect, loadUnpacked } from '../cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST = join(ROOT, 'dist');
const CONTROL = 'http://127.0.0.1:18788';
const CHROME = `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const nvxOnly = args.includes('--nvx-only');
const only = args.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------- server

async function ensureServer() {
  const up = async () => fetch(`${CONTROL}/health`).then((r) => r.ok, () => false);
  if (await up()) return null;
  const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    stdio: 'ignore',
    env: { ...process.env, ZOO_LATENCY: process.env.ZOO_LATENCY ?? '40' },
  });
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (await up()) return child;
  }
  throw new Error('zoo server did not start');
}

/** Waits for a verdict, then a little longer in case a retry turns it around. */
async function result(t, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const run = await fetch(`${CONTROL}/result?t=${t}`).then((r) => r.json(), () => null);
    if (run?.result?.ok) return run;
    if (run?.result && Date.now() - run.result.at > 6000) return run;
    await sleep(150);
  }
  return (await fetch(`${CONTROL}/result?t=${t}`).then((r) => r.json(), () => null)) ?? { steps: [], result: null };
}

// --------------------------------------------------------------- browser

async function launch(withExtension) {
  const profile = mkdtempSync(join(tmpdir(), withExtension ? 'nvx-zoo-' : 'nvx-zoo-base-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--enable-unsafe-extension-debugging',
      '--host-resolver-rules=MAP *.test 127.0.0.1:18443',
      '--ignore-certificate-errors',
      '--disable-popup-blocking',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const v = await browserEndpoint(port);
  const browser = await connect(v.webSocketDebuggerUrl, { timeout: 30_000 });
  await browser.send('Target.setDiscoverTargets', { discover: true });
  const stop = () => {
    browser.close();
    try {
      process.kill(child.pid);
    } catch {}
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }, 1000);
  };
  return { browser, stop, version: v.Browser };
}

async function pages(browser) {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page');
}

/** Closes every page but one blank one, so scenarios cannot see each other's tabs. */
async function tidy(browser) {
  const all = await pages(browser);
  const keepOne = all.find((p) => p.url === 'about:blank') ?? null;
  if (!keepOne) await browser.send('Target.createTarget', { url: 'about:blank' });
  for (const p of all) {
    if (keepOne && p.targetId === keepOne.targetId) continue;
    await browser.send('Target.closeTarget', { targetId: p.targetId }).catch(() => undefined);
  }
}

// ------------------------------------------------------------- the worker

async function attachWorker(browser, id) {
  for (let round = 0; round < 30; round++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const workers = targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
    for (const w of workers.reverse()) {
      const r = await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: true }).catch(() => null);
      if (!r) continue;
      const probe = await browser
        .send('Runtime.evaluate', { expression: 'typeof globalThis.__nvx', returnByValue: true }, { sessionId: r.sessionId, timeout: 5000 })
        .catch(() => null);
      if (probe?.result?.value === 'object') return r.sessionId;
    }
    // A stopped worker only wakes on one of its events; a navigation is one.
    const t = await browser.send('Target.createTarget', { url: 'https://app.test/favicon.ico' }).catch(() => null);
    await sleep(600);
    if (t) await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  }
  throw new Error('no worker exposed __nvx');
}

function workerEval(browser, getSession, reattach) {
  return async (expression) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await browser.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          { sessionId: getSession(), timeout: 30_000 }
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      } catch (e) {
        if (attempt > 1) throw e;
        await reattach();
      }
    }
  };
}

// ---------------------------------------------------------------- scenarios

const { names, identity } = await (async () => {
  await ensureServer();
  return fetch(`${CONTROL}/scenarios`).then((r) => r.json());
})();
const chosen = only.length ? names.filter((n) => only.includes(n)) : names;

const startUrl = (name, t, u) => {
  // The console host sets a cookie for its own domain and every region under
  // it, which only that host may do.
  const host = name === 'deep' ? 'console.svc.test' : name === 'xdomain' ? 'a.test' : 'app.test';
  return `https://${host}/z/${name}/start?t=${t}&u=${u}`;
};

const report = { started: new Date().toISOString(), baseline: {}, nvx: {} };

// ----------------------------------------------------------------- baseline

if (!nvxOnly) {
  const base = await launch(false);
  console.log(`baseline: ${base.version}`);
  try {
    for (const name of chosen) {
      const t = token();
      await base.browser.send('Target.createTarget', { url: startUrl(name, t, 'alice') });
      const run = await result(t, name === 'manyhosts' ? 60_000 : 20_000);
      const ok = Boolean(run.first?.ok) && run.result.user === 'alice';
      report.baseline[name] = { ok, ...run.result, steps: run.steps };
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${run.result?.why ?? 'no result'}`}`);
      await tidy(base.browser);
    }
  } finally {
    if (!keep) base.stop();
  }
}

// ---------------------------------------------------------------------- nvx

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('dist is not built. run: node tools/build.mjs');
  process.exit(1);
}

const nvx = await launch(true);
console.log(`\nnvx: ${nvx.version}`);
let failures = 0;
let recovered = 0;
try {
  const loaded = await loadUnpacked(nvx.browser, DIST);
  if (!loaded.id) throw new Error(`side-load failed: ${loaded.error}`);
  let sid = await attachWorker(nvx.browser, loaded.id);
  const ev = workerEval(nvx.browser, () => sid, async () => {
    sid = await attachWorker(nvx.browser, loaded.id);
  });
  await ev(`__nvx.whenReady()`);
  await ev(`Promise.all([__nvx.createSession('alice'), __nvx.createSession('bob')])`);

  for (const name of chosen) {
    const ta = token();
    const tb = token();
    // Both at once, so a leak between them has every chance to show.
    await ev(`Promise.all([
      __nvx.openInSession('alice', ${JSON.stringify(startUrl(name, ta, 'alice'))}),
      __nvx.openInSession('bob', ${JSON.stringify(startUrl(name, tb, 'bob'))}),
    ])`);
    const wait = name === 'manyhosts' ? 60_000 : 20_000;
    const [ra, rb] = await Promise.all([result(ta, wait), result(tb, wait)]);
    const flow = (r, who) => Boolean(r.result?.ok) && r.result.user === who;
    const clean = (r, who) => flow(r, who) && r.first?.ok && (r.tries ?? 1) === 1;
    let detail = '';
    if (!flow(ra, 'alice')) detail += ` alice: ${ra.result?.why || `signed in as "${ra.result?.user ?? '?'}"`}`;
    if (!flow(rb, 'bob')) detail += ` bob: ${rb.result?.why || `signed in as "${rb.result?.user ?? '?'}"`}`;

    // Afterwards, each session is asked who it is, on the scenario's own host.
    let iso = 'skipped';
    const id = identity[name];
    if (id) {
      const wa = token();
      const wb = token();
      await ev(`Promise.all([
        __nvx.openInSession('alice', 'https://${id[0]}/z/whoami?t=${wa}&c=${id[1]}'),
        __nvx.openInSession('bob', 'https://${id[0]}/z/whoami?t=${wb}&c=${id[1]}'),
      ])`);
      const [wA, wB] = await Promise.all([result(wa), result(wb)]);
      const good = wA.result?.user === 'alice' && wB.result?.user === 'bob';
      iso = good ? 'isolated' : `alice sees "${wA.result?.user || 'nobody'}", bob sees "${wB.result?.user || 'nobody'}"`;
      if (!good) detail += ` isolation: ${iso}`;
    }

    const ok = !detail;
    const firstTry = clean(ra, 'alice') && clean(rb, 'bob');
    if (!ok) failures++;
    else if (!firstTry) recovered++;
    const why = [ra, rb].map((r) => r.first?.why).filter(Boolean)[0] ?? '';
    report.nvx[name] = { ok, clean: firstTry, detail: detail.trim(), alice: ra, bob: rb, isolation: iso };
    if (!ok) {
      const open = (await pages(nvx.browser)).map((p) => p.url.replace(/[?&]t=[^&]+/, '').slice(0, 90));
      const held = await ev('__nvx.held').catch(() => []);
      report.nvx[name].tabs = open;
      report.nvx[name].held = held;
      if (process.env.ZOO_JOURNAL) {
        const j = await ev('__nvx.journal()').catch(() => []);
        report.nvx[name].journal = j.slice(-60);
        console.log((j.slice(-40)).map((e) => `        ${e.area}/${e.event} ${JSON.stringify(e.fields ?? e.detail ?? '').slice(0, 160)}`).join(String.fromCharCode(10)));
      }
      if (process.env.ZOO_VERBOSE) console.log('      tabs:', open.join(' | '), held.length ? `held: ${JSON.stringify(held)}` : '');
    }
    const label = !ok ? 'FAIL' : firstTry ? 'PASS' : 'RECOV';
    console.log(`  ${label.padEnd(5)}  ${name}${!ok ? ` ${detail}` : firstTry ? '' : `  first try: ${why}`}`);
    await tidy(nvx.browser);
  }
} catch (e) {
  failures++;
  console.error(`\nrunner error: ${e.stack ?? e}`);
} finally {
  const dir = join(HERE, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `zoo-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n${chosen.length - failures - recovered} clean, ${recovered} recovered, ${failures} failed of ${chosen.length}. report: ${file}`);
  if (!keep) nvx.stop();
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
}
