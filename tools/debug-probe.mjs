/**
 * ------------------------------------------------------------------
 *  Title    |  Probe worker debugger
 *  Ref      |  cdp.mjs, probes/capability
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Attaches to the probe's service worker and streams its
 *           |  console, exceptions and evaluation results.
 *  Note     |  An MV3 worker that throws at startup fails silently:
 *           |  the extension looks installed while every API reports
 *           |  absent. This is how you find out why.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked, findExtensionWorker } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'probes', 'capability');
const FIXTURE = 'http://localhost:8787';

const BROWSERS = {
  chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
  opera: [`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`],
};

const which = process.argv[2] ?? 'chrome';
const mv2 = process.argv.includes('--mv2');
const binary = (BROWSERS[which] ?? []).find((p) => existsSync(p));
if (!binary) {
  console.error(`no binary for ${which}`);
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'nvx-probe-'));
cpSync(PROBE, stage, { recursive: true });
if (mv2) cpSync(join(stage, 'manifest.mv2.json'), join(stage, 'manifest.json'));

const profile = mkdtempSync(join(tmpdir(), 'nvx-profile-'));
const PORT = 9700 + Math.floor(Math.random() * 200);

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
    `${FIXTURE}/page?debug=1`,
  ],
  { stdio: 'ignore' }
);

const die = (code) => {
  try {
    process.kill(child.pid);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 700);
};

console.log(`probe staged at ${stage}\ncdp port ${PORT}\n`);

const v = await browserEndpoint(PORT);
console.log(`connected to ${v.Browser}\n`);
const browser = await connect(v.webSocketDebuggerUrl);

await browser.send('Target.setDiscoverTargets', { discover: true });

const loaded = await loadUnpacked(browser, stage);
console.log(`sideload: ${loaded.id ? `id ${loaded.id}` : `FAILED ${loaded.error}`}\n`);

let sw = null;
for (let i = 0; i < 20 && !sw; i++) {
  await new Promise((r) => setTimeout(r, 500));
  sw = loaded.id
    ? await findExtensionWorker(browser, loaded.id)
    : null;
}

const { targetInfos } = await browser.send('Target.getTargets');
console.log('TARGETS');
for (const t of targetInfos) console.log(`  ${t.type.padEnd(16)} ${t.url}`);
console.log('');

if (!sw) {
  console.error(`no service worker for extension ${loaded.id}. it loaded but never started.`);
  die(2);
}
console.log(`attaching to ${sw.url}\n`);

const { sessionId } = await browser.send('Target.attachToTarget', {
  targetId: sw.targetId,
  flatten: true,
});

browser.on((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    console.log(`  [console.${msg.params.type}] ${args}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log(`  [EXCEPTION] ${d.text} ${d.exception?.description ?? ''}`);
    console.log(`              at ${d.url}:${d.lineNumber}:${d.columnNumber}`);
  }
  if (msg.method === 'Log.entryAdded') {
    console.log(`  [log.${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

await browser.send('Runtime.enable', {}, sessionId);
await browser.send('Log.enable', {}, sessionId).catch(() => {});

const evaluate = async (expression, label) => {
  try {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: 60000 },
      sessionId
    );
    if (r.exceptionDetails) {
      console.log(`${label}: THREW ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
      return null;
    }
    console.log(`${label}: ${JSON.stringify(r.result.value)}`);
    return r.result.value;
  } catch (e) {
    console.log(`${label}: send failed ${e.message}`);
    return null;
  }
};

console.log('SERVICE WORKER STATE');
await evaluate('typeof runStatic', '  runStatic defined');
await evaluate('typeof autorun', '  autorun defined');
await evaluate('autorunDone', '  autorunDone');
await evaluate('chrome.runtime.getManifest().manifest_version', '  manifest version');
await evaluate(
  "fetch('http://localhost:8787/echo').then(r=>r.status).catch(e=>'ERR '+e.message)",
  '  fixture reachable from SW'
);

console.log('\nFORCING A RUN');
await evaluate('autorunDone = false; autorun("forced").then(()=>"done")', '  autorun result');

await new Promise((r) => setTimeout(r, 3000));
console.log('\ndone. shutting down.');
die(0);
