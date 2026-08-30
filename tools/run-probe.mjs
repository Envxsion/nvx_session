/**
 * Unattended probe runner.
 *
 * Launches a Chromium browser into a throwaway profile, side-loads the
 * capability probe, opens its panel and drives it over CDP. The real profile
 * is never touched: every run gets its own --user-data-dir under temp.
 *
 * Driving the panel rather than waiting for the probe to phone home is
 * deliberate. An MV3 service worker is lazy: it does not start until an event
 * wakes it, so a background task that only runs on a timer may never run at
 * all. Messaging it from an extension page is a guaranteed wake, and it
 * exercises the same path a human clicking the button would.
 *
 *   node tools/run-probe.mjs chrome
 *   node tools/run-probe.mjs opera
 *   node tools/run-probe.mjs opera --mv2
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'probes', 'capability');
const REPORTS = join(ROOT, 'tools', 'fixture', 'reports');
const FIXTURE = 'http://localhost:8787';

const BROWSERS = {
  chrome: [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  opera: [
    `${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\Opera\\opera.exe`,
  ],
};

const which = process.argv[2] ?? 'chrome';
const mv2 = process.argv.includes('--mv2');
const keepOpen = process.argv.includes('--keep');

const binary = (BROWSERS[which] ?? []).find((p) => existsSync(p));
if (!binary) {
  console.error(`no binary found for "${which}"`);
  process.exit(1);
}

try {
  const r = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' });
  if (!r.ok) throw new Error();
} catch {
  console.error('fixture is not answering. start it: node tools/fixture/server.mjs');
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'nvx-probe-'));
cpSync(PROBE, stage, { recursive: true });
if (mv2) cpSync(join(stage, 'manifest.mv2.json'), join(stage, 'manifest.json'));

const profile = mkdtempSync(join(tmpdir(), 'nvx-profile-'));
const PORT = 9223 + Math.floor(Math.random() * 400);

/**
 * A fresh profile has developer mode off, and Chrome then loads an unpacked
 * extension but leaves it disabled: it gets an id, and its pages answer
 * ERR_BLOCKED_BY_CLIENT. Writing Preferences before first launch does not
 * survive, because Chrome rewrites the file with its own schema on startup.
 * So the profile is minted by a throwaway launch, patched, and reused.
 */
const prefsPath = join(profile, 'Default', 'Preferences');

async function mintProfile() {
  const warm = spawn(binary, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 40 && !existsSync(prefsPath); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(warm.pid);
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));

  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  } catch {}
  prefs.extensions = { ...(prefs.extensions ?? {}), ui: { ...(prefs.extensions?.ui ?? {}), developer_mode: true } };
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(prefsPath, JSON.stringify(prefs));
  console.log(`  developer mode enabled in minted profile\n`);
}

await mintProfile();

console.log(`launching ${which}${mv2 ? ' (mv2)' : ''}`);
console.log(`  binary  ${binary}`);
console.log(`  cdp     ${PORT}\n`);

const child = spawn(
  binary,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    `--load-extension=${stage}`,
    `--disable-extensions-except=${stage}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let settled = false;
function shutdown(code) {
  if (settled) return;
  settled = true;
  if (keepOpen) {
    console.log(`\nbrowser left open (pid ${child.pid})`);
    process.exit(code);
  }
  try {
    process.kill(child.pid);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 900);
}

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : '0%';
}

function summarise(report) {
  const line = '-'.repeat(78);
  const e = report.env;
  console.log(`\n${line}`);
  console.log(`${e.browser}${e.operaVersion ? ` ${e.operaVersion}` : ''}  chromium ${e.chromiumVersion}  manifest v${e.manifestVersion}`);
  console.log(line);

  for (const [title, rows] of [
    ['API SURFACE', report.static],
    ['FUNCTIONAL', report.live],
  ]) {
    const pass = rows.filter((x) => x.verdict === 'pass').length;
    console.log(`\n${title}  ${pass}/${rows.length} pass (${pct(pass, rows.length)})\n`);
    for (const x of rows) {
      const mark =
        x.verdict === 'pass' ? 'PASS' : x.verdict === 'fail' ? 'FAIL' : x.verdict === 'absent' ? '----' : '????';
      console.log(`  ${mark}  ${x.id.padEnd(30)} ${x.detail}`);
    }
  }
  console.log(`\n${line}`);
}

try {
  const v = await browserEndpoint(PORT);
  console.log(`  devtools ${v.Browser}`);
  const browser = await connect(v.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });

  const loaded = await loadUnpacked(browser, stage);
  if (!loaded.id) throw new Error(`side-load failed: ${loaded.error}`);
  console.log(`  extension ${loaded.id}\n`);

  const panelUrl = `chrome-extension://${loaded.id}/diagnostics.html`;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await browser.send('Runtime.enable', {}, { sessionId });
  await browser.send('Page.enable', {}, { sessionId }).catch(() => {});

  // The extension is registered before its pages are servable, so the first
  // navigation can land on chrome-error. Retrying is the fix; a longer fixed
  // sleep would only be a slower guess. Readiness is measured by the API
  // actually being present, not by a load event.
  let ready = false;
  for (let attempt = 0; attempt < 6 && !ready; attempt++) {
    const nav = await browser
      .send('Page.navigate', { url: panelUrl }, { sessionId })
      .catch((e) => ({ errorText: e.message }));
    if (nav?.errorText) console.error(`  navigate attempt ${attempt + 1}: ${nav.errorText}`);
    for (let i = 0; i < 12 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const probe = await browser
        .send(
          'Runtime.evaluate',
          {
            expression: "!!(globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage)",
            returnByValue: true,
          },
          { sessionId }
        )
        .catch(() => null);
      ready = probe?.result?.value === true;
    }
  }
  if (!ready) {
    const info = await browser.send('Target.getTargetInfo', { targetId }).catch(() => null);
    const all = await browser.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const href = await browser
      .send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, { sessionId })
      .catch((e) => ({ result: { value: `evaluate failed: ${e.message}` } }));
    console.error('\npanel diagnostics');
    console.error(`  target url   ${info?.targetInfo?.url}`);
    console.error(`  target type  ${info?.targetInfo?.type}`);
    console.error(`  location     ${href?.result?.value}`);
    console.error('  all targets:');
    for (const t of all.targetInfos ?? []) console.error(`    ${t.type.padEnd(16)} ${t.url}`);
    throw new Error('panel never acquired extension APIs');
  }

  const ask = async (cmd, label, ms) => {
    console.log(`  running ${label}`);
    const r = await browser.send(
      'Runtime.evaluate',
      {
        expression: `new Promise((res) => chrome.runtime.sendMessage(${JSON.stringify(cmd)}, res))`,
        awaitPromise: true,
        returnByValue: true,
      },
      { sessionId, timeout: ms }
    );
    if (r.exceptionDetails) {
      throw new Error(`${label}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  };

  const staticPart = await ask({ cmd: 'static' }, 'API surface', 60_000);
  const livePart = await ask({ cmd: 'live' }, 'functional tests', 240_000);

  const report = {
    env: staticPart.env,
    static: staticPart.results,
    live: livePart.results,
    at: new Date().toISOString(),
  };

  mkdirSync(REPORTS, { recursive: true });
  const file = join(
    REPORTS,
    `${report.env.browser.toLowerCase()}-mv${report.env.manifestVersion}-${Date.now()}.json`
  );
  writeFileSync(file, JSON.stringify(report, null, 2));

  summarise(report);
  console.log(`report: ${file}`);
  browser.close();
  shutdown(0);
} catch (e) {
  console.error(`\nrun failed: ${e.message}`);
  shutdown(2);
}
