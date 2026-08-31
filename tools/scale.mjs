/**
 * ------------------------------------------------------------------
 *  Title    |  Scale probe
 *  Ref      |  fixture/server.mjs, adoptScan, adopt
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  What the extension does to a browser that was already
 *           |  being used.
 *  How      |  Builds a jar of thousands of cookies across hundreds
 *           |  of domains with fifty tabs open, then runs the install
 *           |  day path through it.
 *  Note     |  Looks not for correctness but for costs that appear
 *           |  only at scale: a slow scan, an exhausted rule budget, a
 *           |  mirror past quota, a payload rebuilt twice a second.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
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

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Synthetic hosts, each its own registrable domain.
 *  Bug-Fix  |  The first version put 400 subdomains under one zone,
 *           |  which is one registrable domain and one candidate. It
 *           |  also tripped Chromium's per-domain cookie cap and
 *           |  evicted all but 160 of the 1200 cookies. A used
 *           |  profile is wide, not deep.
 * ------------------------------------------------------------------
 */
const site = (n) => `www.nvx${n}.test`;
const account = (kind, n) => `${kind}-nvxa${n}.test`;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const TABS = arg('tabs', 50);
const DOMAINS = arg('domains', 400);
const keep = process.argv.includes('--keep');

const BROWSERS = {
  opera: [`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`],
  chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
};
const which = process.argv[2] ?? 'opera';
const binary = (BROWSERS[which] ?? []).find((p) => existsSync(p));
if (!binary) {
  console.error(`no binary for ${which}`);
  process.exit(1);
}
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('dist is not built. run: node tools/build.mjs');
  process.exit(1);
}
try {
  const probe = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' });
  if (!probe.ok) throw new Error();
} catch {
  console.error('fixture is not answering. run: node tools/fixture/server.mjs');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nvx-scale-'));
const PORT = 9840 + Math.floor(Math.random() * 120);

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
    // Everything answers from the fixture, so fifty tabs can sit on fifty real
    // origins without a single request leaving this machine.
    '--host-resolver-rules=MAP * 127.0.0.1:8787, EXCLUDE localhost',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
  ],
  { stdio: 'ignore' }
);

let done = false;
function shutdown(code) {
  if (done) return;
  done = true;
  if (keep) {
    console.log(`\nbrowser left open (pid ${child.pid})`);
    process.exit(code);
  }
  try {
    process.kill(child.pid);
  } catch {
    /* already gone */
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));

let failures = 0;
let passes = 0;
function check(what, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `   ${detail}` : ''}`);
}
function fact(what, value) {
  console.log(`   .    ${what}   ${value}`);
}

const endpoint = await browserEndpoint(PORT);
const browser = await connect(endpoint.webSocketDebuggerUrl);
await browser.send('Target.setDiscoverTargets', { discover: true });
const loaded = await loadUnpacked(browser, DIST);
await new Promise((r) => setTimeout(r, 2500));

let sessionId = null;
async function attach() {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const worker = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.includes(loaded.id)
    );
    if (worker) {
      const attached = await browser
        .send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
        .catch(() => null);
      if (attached) {
        sessionId = attached.sessionId;
        return;
      }
    }
    // The worker only exists while something needs it.
    const woken = await browser
      .send('Target.createTarget', { url: `${FIXTURE}/page?wake=1` })
      .catch(() => null);
    if (woken) {
      await new Promise((r) => setTimeout(r, 600));
      await browser.send('Target.closeTarget', { targetId: woken.targetId }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no worker target');
}
await attach();

const evaluate = async (expression, ms = 120_000, sid = null, awaitPromise = false) => {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await browser.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise },
        { sessionId: sid ?? sessionId, timeout: ms }
      );
    } catch (e) {
      if (attempt > 0 || sid) throw e;
      await attach();
      continue;
    }
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed'
      );
    }
    return r.result.value;
  }
};

/** Same shape as the e2e harness: kick off, park the result, poll for it. */
const drive = async (body, ms = 240_000) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const started = await evaluate(
      `(() => {
         const nvx = globalThis.__nvx;
         if (!nvx) return 'not-ready';
         const slot = { done: false, value: null, error: null };
         globalThis.__nvxScale = slot;
         Promise.resolve()
           .then(() => nvx.whenReady())
           .then(() => (${body})(nvx))
           .then(
             (val) => { slot.value = val; slot.done = true; },
             (e) => { slot.error = String(e && e.stack || e); slot.done = true; }
           );
         return 'started';
       })()`
    );
    if (started !== 'started') {
      await new Promise((r) => setTimeout(r, 400));
      await attach();
      continue;
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const state = await evaluate(
        `(() => {
           const slot = globalThis.__nvxScale;
           if (!slot) return 'lost';
           return slot.done ? JSON.stringify({ value: slot.value, error: slot.error }) : 'pending';
         })()`
      );
      if (state === 'lost') break;
      if (state !== 'pending') {
        const { value, error } = JSON.parse(state);
        if (error) throw new Error(error);
        return value;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await attach();
  }
  throw new Error('the worker never settled');
};

const heartbeat = setInterval(() => {
  browser
    .send(
      'Runtime.evaluate',
      { expression: 'chrome.storage.local.get("nvx.keepalive")' },
      { sessionId, timeout: 5000 }
    )
    .catch(() => undefined);
}, 8000);

console.log(`\nbuilding a used profile: ${DOMAINS} domains, ${TABS} tabs\n`);

// ------------------------------------------------------------------ the jar

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Seed through the browser's own cookie store, not the
 *           |  kernel, so the scan reads a real jar with real
 *           |  attributes.
 *  Note     |  Shape drawn from a real profile: mostly preference and
 *           |  analytics cookies, a minority with a readable identity,
 *           |  a handful of accounts spread across sibling domains.
 * ------------------------------------------------------------------
 */
const seeded = await drive(
  `async () => {
     const N = ${DOMAINS};
     const soon = Math.floor(Date.now() / 1000) + 30 * 86400;
     const b64 = (o) =>
       btoa(JSON.stringify(o)).split('+').join('-').split('/').join('_').split('=').join('');
     const jwt = (claims) => b64({ alg: 'none' }) + '.' + b64(claims) + '.sig';
     let count = 0;
     const set = async (host, name, value, extra) => {
       await chrome.cookies.set(
         Object.assign(
           { url: 'http://' + host + '/', name: name, value: value, domain: host, expirationDate: soon },
           extra || {}
         )
       );
       count++;
     };
     for (let i = 0; i < N; i++) {
       const host = 'www.nvx' + i + '.test';
       // The long tail: things that are not accounts.
       await set(host, 'prefs', 'theme=dark');
       await set(host, '_ga', 'GA1.2.' + i + '.' + (1700000000 + i));
       if (i % 3 === 0) await set(host, 'consent', 'v2');
       // A third of them look signed in.
       if (i % 3 === 1) {
         await set(host, 'session_id', 'sid_' + i, { httpOnly: true });
         await set(host, 'csrftoken', 'c_' + i);
       }
       // A tenth carry a token that literally says who you are.
       if (i % 10 === 4) {
         await set(host, 'id_token', jwt({ email: 'user' + i + '@mail.test', exp: soon }), {
           httpOnly: true,
         });
       }
     }
     // Six accounts, each spread across three sibling sites the way a real one
     // is. These are the groups the setup screen has to find and merge, and
     // each site is its own registrable domain, so nothing merges by accident.
     for (let a = 0; a < 6; a++) {
       const who = 'person' + a + '@mail.test';
       const kinds = ['portal', 'idp', 'apps'];
       for (const kind of kinds) {
         const host = kind + '-nvxa' + a + '.test';
         await set(host, 'auth_token', jwt({ email: who, exp: soon }), { httpOnly: true });
         await set(host, 'session_id', 'sid_a' + a, { httpOnly: true });
       }
     }
     const all = await chrome.cookies.getAll({});
     return { wrote: count, jar: all.length };
   }`
);
fact('cookies seeded', `${seeded.wrote} written, ${seeded.jar} in the jar`);

// ----------------------------------------------------------------- the tabs

const tabTargets = [];
for (let i = 0; i < TABS; i++) {
  // Fifty tabs across thirty odd origins, which is closer to a real window set
  // than fifty tabs on one host would be.
  const host = i % 5 === 0 ? account('portal', i % 6) : site(i * 7);
  const created = await browser
    .send('Target.createTarget', { url: `http://${host}/page?scale=${i}`, background: true })
    .catch(() => null);
  if (created) tabTargets.push(created.targetId);
}
await new Promise((r) => setTimeout(r, 5000));
fact('tabs opened', tabTargets.length);

// ------------------------------------------------------------- install day

const scan = await drive(
  `async (nvx) => {
     const t0 = Date.now();
     const first = await nvx.adoptScan();
     const scanMs = Date.now() - t0;
     const t1 = Date.now();
     const second = await nvx.adoptScan();
     const againMs = Date.now() - t1;
     const merged = first.groups.filter((g) => g.domains.length > 1);
     return {
       scanMs: scanMs,
       againMs: againMs,
       bytes: JSON.stringify(first).length,
       total: first.total,
       tabs: first.tabs,
       groups: first.groups.length,
       candidates: first.candidates.length,
       merged: merged.length,
       mergedSample: merged.slice(0, 3).map((g) => [g.label, g.domains.length]),
       ticked: first.groups.filter((g) => g.preselect).length,
       unfit: first.groups.filter((g) => !g.fits).length,
       stable:
         JSON.stringify(first.groups.map((g) => g.key)) ===
         JSON.stringify(second.groups.map((g) => g.key)),
     };
   }`
);

console.log(`\nreading a used profile\n`);
fact('domains holding cookies', scan.total);
fact('scan time', `${scan.scanMs}ms first, ${scan.againMs}ms again`);
fact('payload to the setup screen', `${(scan.bytes / 1024).toFixed(1)}kB`);
fact('groups offered', `${scan.groups} of ${scan.total}, ${scan.merged} merged across sites`);
fact('merged sample', JSON.stringify(scan.mergedSample));
fact('ticked by default', scan.ticked);
fact('groups too big for one session', scan.unfit);
fact('open tabs the scan counted', scan.tabs);
check(
  'the scan finishes fast enough to feel like a screen rather than a wait',
  scan.scanMs < 3000,
  `${scan.scanMs}ms over ${scan.total} domains`
);
check(
  'the list handed to the setup screen stays small however big the jar is',
  scan.groups <= 60 && scan.candidates <= 120,
  `groups=${scan.groups} candidates=${scan.candidates}`
);
check('the payload stays well under a megabyte', scan.bytes < 1_000_000, `${(scan.bytes / 1024).toFixed(1)}kB`);
check('two scans of an unchanged profile agree', scan.stable === true);
check(
  'accounts spread across sibling sites are offered as one thing',
  scan.merged >= 6,
  `${scan.merged} merged groups`
);
check(
  'the number ticked by default is a handful rather than everything',
  scan.ticked > 0 && scan.ticked <= 20,
  `${scan.ticked} ticked of ${scan.groups}`
);

// ---------------------------------------------------- adopting, in quantity

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Drive from a page, not the worker, the only way to
 *           |  reach the message API the setup screen uses.
 *  Note     |  Adopting from the inside would exercise a path the
 *           |  product does not have.
 * ------------------------------------------------------------------
 */
const pageTarget = await browser.send('Target.createTarget', {
  url: `chrome-extension://${loaded.id}/welcome.html`,
});
const pageSession = (
  await browser.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })
).sessionId;
await new Promise((r) => setTimeout(r, 3000));

const ADOPT = 14;
const adopted = await evaluate(
  `(async () => {
     const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
     const scan = await send({ cmd: 'adoptScan' });
     const want = scan.groups.slice(0, ${ADOPT});
     const out = [];
     const t0 = Date.now();
     for (const g of want) {
       const at = Date.now();
       const r = await send({ cmd: 'adopt', domains: g.domains, label: g.label, bindOpenTabs: true });
       out.push({
         label: g.label,
         ok: Boolean(r && r.ok),
         reason: (r && r.reason) || '',
         tabs: (r && r.tabs) || 0,
         ms: Date.now() - at,
       });
     }
     return JSON.stringify({ totalMs: Date.now() - t0, out: out });
   })()`,
  300_000,
  pageSession,
  true
).then(JSON.parse);

console.log(`\nadopting ${ADOPT} accounts in one sitting\n`);
const made = adopted.out.filter((r) => r.ok);
const slowest = adopted.out.reduce((n, r) => Math.max(n, r.ms), 0);
fact('sessions created', `${made.length} of ${adopted.out.length}`);
fact('time to adopt all of them', `${adopted.totalMs}ms, slowest ${slowest}ms`);
fact('tabs bound by adoption', made.reduce((n, r) => n + r.tabs, 0));
check(
  'every adoption either works or says why',
  adopted.out.every((r) => r.ok || r.reason),
  JSON.stringify(adopted.out.filter((r) => !r.ok && !r.reason).slice(0, 3))
);
check('no single adoption blocks the screen for long', slowest < 6000, `slowest ${slowest}ms`);

// -------------------------------------------------------------- the ceiling

const budget = await drive(
  `async (nvx) => {
     await nvx.engine.flush();
     const live = await chrome.declarativeNetRequest.getSessionRules();
     const max = chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES;
     const perSlot = {};
     for (const r of live) {
       const slot = Math.floor((r.id - 1000) / 192);
       perSlot[slot] = (perSlot[slot] || 0) + 1;
     }
     const counts = Object.keys(perSlot).map((k) => perSlot[k]);
     return {
       live: live.length,
       max: max,
       sessions: nvx.registry.listSessions().length,
       heaviest: counts.length ? Math.max.apply(null, counts) : 0,
       slots: counts.length,
       average: counts.length ? Math.round(live.length / counts.length) : 0,
     };
   }`
);

console.log(`\nthe rule budget, with everything adopted\n`);
fact('rules live in the browser', `${budget.live} of ${budget.max}`);
fact('sessions', `${budget.sessions} holding rules in ${budget.slots} slots`);
fact('rules per session', `${budget.average} average, ${budget.heaviest} heaviest, 192 allowed`);
fact(
  'sessions this ceiling allows at the measured weight',
  budget.average ? Math.floor(budget.max / Math.max(budget.average, 1)) : 'n/a'
);
check('the whole profile fits inside the browser rule ceiling', budget.live < budget.max, `${budget.live}/${budget.max}`);
check(
  'and does so with room for the profile to keep growing',
  budget.live < budget.max * 0.5,
  `using ${((budget.live / budget.max) * 100).toFixed(1)}% of the ceiling`
);
check('no session is near its own per-session cap', budget.heaviest < 192, `heaviest ${budget.heaviest}`);

// --------------------------------------------------- binding every open tab

const bindAll = await drive(
  `async (nvx) => {
     const sessions = nvx.registry.listSessions();
     if (!sessions.length) return { skipped: true };
     const tabs = await chrome.tabs.query({});
     const web = tabs.filter((t) => typeof t.id === 'number' && /^https?:/i.test(t.url || ''));
     const t0 = Date.now();
     let bound = 0;
     for (let i = 0; i < web.length; i++) {
       const t = web[i];
       if (nvx.registry.binding(t.id)) continue;
       await nvx.bind(t.id, sessions[i % sessions.length].id, t.url, t.windowId);
       bound++;
     }
     const bindMs = Date.now() - t0;
     const t1 = Date.now();
     nvx.engine.markDirty(sessions.map((s) => s.id));
     await nvx.engine.flush();
     const flushMs = Date.now() - t1;
     const live = await chrome.declarativeNetRequest.getSessionRules();
     return {
       web: web.length,
       bound: bound,
       bindMs: bindMs,
       flushMs: flushMs,
       live: live.length,
       max: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES,
     };
   }`
).catch((e) => ({ error: String(e) }));

console.log(`\nevery open tab managed at once\n`);
if (bindAll.error) {
  check('binding every open tab', false, bindAll.error);
} else {
  fact('tabs managed', `${bindAll.bound} newly bound of ${bindAll.web} web tabs`);
  fact('time to bind them all', `${bindAll.bindMs}ms`);
  fact('one full recompile of every session', `${bindAll.flushMs}ms`);
  fact('rules after', `${bindAll.live} of ${bindAll.max}`);
  check(
    'a full recompile of every session stays inside a navigation hold',
    bindAll.flushMs < 2000,
    `${bindAll.flushMs}ms`
  );
  check('managing every open tab still fits the ceiling', bindAll.live < bindAll.max, `${bindAll.live}/${bindAll.max}`);
}

// -------------------------------------------- what has to survive an eviction

const mirror = await drive(
  `async () => {
     const area = chrome.storage.session;
     const held = await area.get(null);
     let quota = null;
     try { quota = area.QUOTA_BYTES || null; } catch (e) { quota = null; }
     let used = null;
     try { used = await area.getBytesInUse(null); } catch (e) { used = null; }
     const local = await chrome.storage.local.get(null);
     return {
       bytes: JSON.stringify(held).length,
       quota: quota,
       used: used,
       keys: Object.keys(held),
       localBytes: JSON.stringify(local).length,
       localKeys: Object.keys(local).length,
     };
   }`
);

console.log(`\nwhat survives the worker dying, and what it costs\n`);
fact('session mirror', `${mirror.bytes} bytes${mirror.used !== null ? `, ${mirror.used} reported in use` : ''}`);
fact('session quota', mirror.quota ?? 'not reported');
fact('profile record', `${(mirror.localBytes / 1024).toFixed(1)}kB across ${mirror.localKeys} keys`);
check(
  'the session mirror is a rounding error against its quota',
  mirror.quota === null || mirror.bytes < mirror.quota * 0.25,
  `${mirror.bytes} bytes of ${mirror.quota}`
);
check(
  'the profile record stays small enough to rewrite on every change',
  mirror.localBytes < 2_000_000,
  `${(mirror.localBytes / 1024).toFixed(1)}kB`
);

// --------------------------------------------------------------- the journal

const diary = await drive(
  `async (nvx) => {
     const entries = await nvx.journal();
     const t1 = Date.now();
     const file = await nvx.journalFile();
     const fileMs = Date.now() - t1;
     return {
       count: entries.length,
       fileMs: fileMs,
       kb: Math.round(file.length / 102.4) / 10,
       questionMarks: file.split('?').length - 1,
       redactionMarkers: file.split('?...').length - 1,
     };
   }`
);

console.log(`\nthe journal, after all of that\n`);
fact('entries', diary.count);
fact('export', `${diary.kb}kB, ${diary.fileMs}ms to format`);
check('the journal is capped rather than unbounded', diary.count <= 2000, `${diary.count} entries`);
check(
  'every question mark in it is a redaction marker',
  diary.questionMarks === diary.redactionMarkers,
  `${diary.questionMarks} question marks, ${diary.redactionMarkers} markers`
);

// ------------------------------------------------------ what the popup reads

const paint = await drive(
  `async (nvx) => {
     const t0 = Date.now();
     const sessions = nvx.registry.listSessions();
     const bindings = [];
     for (const t of await chrome.tabs.query({})) {
       const b = typeof t.id === 'number' ? nvx.registry.binding(t.id) : null;
       if (b) bindings.push({ tabId: t.id, sessionId: b.sessionId });
     }
     return {
       ms: Date.now() - t0,
       sessions: sessions.length,
       bindings: bindings.length,
       bytes: JSON.stringify({ sessions: sessions, bindings: bindings }).length,
     };
   }`
);
console.log(`\nwhat the popup asks for, over and over\n`);
fact(
  'state payload',
  `${(paint.bytes / 1024).toFixed(1)}kB, ${paint.sessions} sessions, ${paint.bindings} bound tabs, ${paint.ms}ms to build`
);
check(
  'the polled payload stays small enough to rebuild on a timer',
  paint.bytes < 250_000,
  `${(paint.bytes / 1024).toFixed(1)}kB`
);

// --------------------------------------------------------------- the scripts

const scripts = await drive(
  `async (nvx) => {
     const reg = await chrome.scripting.getRegisteredContentScripts();
     return {
       posture: 'mirror',
       scripts: reg.map((r) => ({ id: r.id, world: r.world, matches: (r.matches || []).length })),
     };
   }`
);
console.log(`
injection, with the profile at full size
`);
fact('managed hosts', scripts.scripts.length ? scripts.scripts[0].matches : 0);
fact('registered under the default posture', scripts.scripts.map((x) => x.id).join(', '));
check(
  'the agent and the storage shim are registered, and nothing else is',
  scripts.scripts.length === 2 &&
    scripts.scripts.some((x) => x.id === 'nvx-agent') &&
    scripts.scripts.some((x) => x.id === 'nvx-storage'),
  scripts.scripts.map((x) => `${x.id}:${x.world}`).join(' ')
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Turn the mask on at full profile size to exercise the
 *           |  ordering the persona feature rests on.
 *  Note     |  The default posture fabricates nothing and registers
 *           |  no mask, so nothing above exercises it. Registration is
 *           |  rebuilt from every managed host, largest on this run.
 * ------------------------------------------------------------------
 */
const masked = await evaluate(
  `(async () => {
     const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
     await send({ cmd: 'setSettings', posture: 'persona' });
     await new Promise((r) => setTimeout(r, 2500));
     const reg = await chrome.scripting.getRegisteredContentScripts();
     return JSON.stringify(reg.map((r) => ({ id: r.id, world: r.world, matches: (r.matches || []).length })));
   })()`,
  120_000,
  pageSession,
  true
).then(JSON.parse);

console.log(`
the mask, turned on over the whole profile
`);
fact('registered under Persona', masked.map((x) => `${x.id}:${x.world}`).join(', '));
const maskAt = masked.findIndex((x) => x.id === 'nvx-mask');
const shimAt = masked.findIndex((x) => x.id === 'nvx-storage');
check('the mask is registered at all under Persona', maskAt >= 0, masked.map((x) => x.id).join(', '));
check(
  'and ahead of the storage shim, which is what lets it read its own seed',
  maskAt >= 0 && shimAt >= 0 && maskAt < shimAt,
  `mask at ${maskAt}, shim at ${shimAt}`
);
check(
  'every script covers the same host list',
  new Set(masked.map((x) => x.matches)).size === 1,
  masked.map((x) => `${x.id}=${x.matches}`).join(' ')
);

// ------------------------------------- the tabs that were open before any of it

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The case this whole suite exists for: tabs open before
 *           |  the extension arrived.
 *  How      |  Measured from inside a tab that predates every session,
 *           |  against a tab opened a moment ago on the same host.
 *  Note     |  A content script enters a document only as it loads, so
 *           |  pre-existing tabs have no shim or mask until reloaded.
 *           |  Header rules apply to their next request anyway, so a
 *           |  posture rewriting the user agent makes the page report
 *           |  one browser while its requests report another.
 * ------------------------------------------------------------------
 */
const oldTab = tabTargets[1];
const oldSession = (
  await browser.send('Target.attachToTarget', { targetId: oldTab, flatten: true })
).sessionId;
const freshTarget = await browser.send('Target.createTarget', {
  url: `http://${site(7)}/page?fresh=1`,
});
const freshSession = (
  await browser.send('Target.attachToTarget', { targetId: freshTarget.targetId, flatten: true })
).sessionId;
await new Promise((r) => setTimeout(r, 3000));

const coherence = async (sid) =>
  evaluate(
    `(async () => {
       const seen = await fetch('/echo', { cache: 'no-store' }).then((r) => r.json());
       return JSON.stringify({
         here: navigator.userAgent,
         sent: seen.userAgent,
         shimmed: Object.prototype.hasOwnProperty.call(window, '__nvx_shim_present') || null,
       });
     })()`,
    60_000,
    sid,
    true
  ).then(JSON.parse);

const wasOpen = await coherence(oldSession).catch((e) => ({ error: String(e) }));
const openedNow = await coherence(freshSession).catch((e) => ({ error: String(e) }));

console.log(`
tabs that were already open when the extension arrived
`);
if (wasOpen.error || openedNow.error) {
  check('reading a pre-existing tab', false, wasOpen.error || openedNow.error);
} else {
  const agrees = (r) => r.here === r.sent;
  fact('a tab opened before any session existed', agrees(wasOpen) ? 'agrees with itself' : 'reports two browsers');
  fact('  page says', wasOpen.here.slice(-42));
  fact('  requests say', String(wasOpen.sent).slice(-42));
  fact('a tab opened after the posture was on', agrees(openedNow) ? 'agrees with itself' : 'reports two browsers');
  fact('  page says', openedNow.here.slice(-42));
  fact('  requests say', String(openedNow.sent).slice(-42));
  check(
    'a tab loaded under the posture reports one browser to itself and to the network',
    agrees(openedNow),
    `page=${openedNow.here.slice(-30)} sent=${String(openedNow.sent).slice(-30)}`
  );
  check(
    'and so does one that was already open, or the posture is lying about it',
    agrees(wasOpen),
    `page=${wasOpen.here.slice(-30)} sent=${String(wasOpen.sent).slice(-30)}`
  );
  check(
    'a tab that predates the mask is left as the browser made it rather than half covered',
    wasOpen.here === wasOpen.sent && wasOpen.here !== openedNow.here,
    `was open=${wasOpen.here.slice(-24)} opened now=${openedNow.here.slice(-24)}`
  );

  // And it has to stop being an exception once it loads again, or the posture
  // is permanently off for every tab that happened to be open at the time.
  await browser.send('Page.reload', {}, { sessionId: oldSession }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3500));
  const reloaded = await coherence(oldSession).catch((e) => ({ error: String(e) }));
  fact('the same tab after a reload', reloaded.error ? reloaded.error : reloaded.here.slice(-42));
  check(
    'and it joins the posture the moment it loads again',
    !reloaded.error && reloaded.here === reloaded.sent && reloaded.here === openedNow.here,
    reloaded.error || `page=${reloaded.here.slice(-24)} sent=${String(reloaded.sent).slice(-24)}`
  );
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The memory of which tabs predate the mask has to
 *           |  outlive the worker.
 *  Note     |  That set is non-empty exactly between a posture change
 *           |  and a reload, which is when a v3 worker hits its thirty
 *           |  seconds of quiet. In the heap it would be lost and the
 *           |  tabs would start lying again. This empties the worker's
 *           |  copy as an eviction does and restores from the mirror.
 * ------------------------------------------------------------------
 */
const survived = await drive(
  `async (nvx) => {
     const before = await chrome.storage.session.get(null);
     const mirrored = before['nvx.ephemeral.v1'];
     const recycled = await nvx.recycleWorkerMemory();
     return {
       mirrored: mirrored && Array.isArray(mirrored.unmasked) ? mirrored.unmasked.length : 0,
       after: recycled.unmasked,
     };
   }`
).catch((e) => ({ error: String(e) }));

console.log(`\nand the memory of it, across a worker eviction\n`);
if (survived.error) {
  check('the set of tabs older than the mask survives an eviction', false, survived.error);
} else {
  fact('mirrored outside the worker', `${survived.mirrored} tab(s)`);
  fact('after the worker heap is emptied', `${survived.after} tab(s)`);
  check(
    'the tabs older than the mask are written somewhere the worker dying cannot reach',
    survived.mirrored > 0,
    `${survived.mirrored} in chrome.storage.session`
  );
  check(
    'and all of them come back when it does',
    survived.after === survived.mirrored,
    `${survived.after} restored of ${survived.mirrored}`
  );
}

// -------------------------------------------------------- the off switch

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Check the pause claim in full: no rules, no rewriting,
 *           |  no picker, and nothing lost.
 *  Note     |  A safety valve nobody has pulled is one nobody knows
 *           |  the shape of, and this is the control somebody reaches
 *           |  for once they believe the extension broke something.
 * ------------------------------------------------------------------
 */
const paused = await evaluate(
  `(async () => {
     const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
     const before = await send({ cmd: 'state' });
     const rulesBefore = (await chrome.declarativeNetRequest.getSessionRules()).length;

     await send({ cmd: 'setSettings', paused: true });
     await new Promise((r) => setTimeout(r, 1800));
     const rulesPaused = (await chrome.declarativeNetRequest.getSessionRules()).length;
     const scriptsPaused = (await chrome.scripting.getRegisteredContentScripts()).length;
     const whilePaused = await send({ cmd: 'state' });

     await send({ cmd: 'setSettings', paused: false });
     await new Promise((r) => setTimeout(r, 2500));
     const rulesAfter = (await chrome.declarativeNetRequest.getSessionRules()).length;
     const after = await send({ cmd: 'state' });

     return JSON.stringify({
       rulesBefore: rulesBefore,
       rulesPaused: rulesPaused,
       scriptsPaused: scriptsPaused,
       rulesAfter: rulesAfter,
       sessionsBefore: before.sessions.length,
       sessionsPaused: whilePaused.sessions.length,
       sessionsAfter: after.sessions.length,
       cookiesBefore: before.sessions.reduce((n, x) => n + x.cookies, 0),
       cookiesAfter: after.sessions.reduce((n, x) => n + x.cookies, 0),
       boundAfter: after.bindings.length,
     });
   })()`,
  180_000,
  pageSession,
  true
).then(JSON.parse).catch((e) => ({ error: String(e) }));

console.log(`\nthe off switch\n`);
if (paused.error) {
  check('pausing', false, paused.error);
} else {
  fact('rules', `${paused.rulesBefore} running, ${paused.rulesPaused} paused, ${paused.rulesAfter} resumed`);
  fact('content scripts while paused', paused.scriptsPaused);
  fact('sessions', `${paused.sessionsBefore} before, ${paused.sessionsPaused} while paused, ${paused.sessionsAfter} after`);
  fact('cookies held', `${paused.cookiesBefore} before, ${paused.cookiesAfter} after`);
  check(
    'pausing withdraws every rule, so a managed tab is an ordinary tab',
    paused.rulesPaused === 0,
    `${paused.rulesPaused} left behind`
  );
  check(
    'and unregisters every content script with them',
    paused.scriptsPaused === 0,
    `${paused.scriptsPaused} still registered`
  );
  check(
    'the sessions are still there, which is what makes it a pause rather than an uninstall',
    paused.sessionsPaused === paused.sessionsBefore,
    `${paused.sessionsPaused} of ${paused.sessionsBefore}`
  );
  check(
    'and every cookie in them survives the round trip',
    paused.cookiesAfter === paused.cookiesBefore && paused.cookiesBefore > 0,
    `${paused.cookiesBefore} then ${paused.cookiesAfter}`
  );
  check(
    'resuming puts the rules back',
    paused.rulesAfter > 0,
    `${paused.rulesAfter} rules after resuming`
  );
}

// ------------------------------------------------- past every stated ceiling

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The failures that cannot happen on a small profile.
 *  Note     |  The posture covers a fixed number of hosts and a
 *           |  profile can exceed it. A host past that line keeps the
 *           |  mask and loses the headers, so the page reports one
 *           |  browser while its requests report another, until now
 *           |  only a console warning in a worker nobody has open.
 * ------------------------------------------------------------------
 */
const past = await drive(
  `async (nvx) => {
     await nvx.clearJournal();
     await nvx.setLogLevel('debug');
     // Pinned rather than browsed, because the host list is built from what the
     // sessions claim and this needs to cross a line no amount of tab opening
     // would reach in a run this length.
     for (let i = 0; i < 12; i++) {
       const pinned = [];
       for (let j = 0; j < 30; j++) pinned.push('over' + i + '-' + j + '.test');
       await nvx.createSession('over_' + i, pinned);
     }
     const t0 = Date.now();
     await nvx.registerAgent();
     const registerMs = Date.now() - t0;
     const reg = await chrome.scripting.getRegisteredContentScripts();
     const entries = await nvx.journal();
     const complaint = entries.filter((e) => e.event === 'more managed hosts than the posture covers');
     const rules = await chrome.declarativeNetRequest.getSessionRules();
     return {
       registerMs: registerMs,
       hosts: reg.length ? reg[0].matches.length : 0,
       sessions: nvx.registry.listSessions().length,
       said: complaint.length,
       detail: complaint.length ? complaint[0].detail : '',
       rules: rules.length,
       max: chrome.declarativeNetRequest.MAX_NUMBER_OF_SESSION_RULES,
     };
   }`
).catch((e) => ({ error: String(e) }));

console.log(`
what it does when it stops fitting
`);
if (past.error) {
  check('pushing the profile past the posture ceiling', false, past.error);
} else {
  fact('sessions', past.sessions);
  fact('managed hosts', past.hosts);
  fact('time to re-register over that many hosts', `${past.registerMs}ms`);
  fact('rules', `${past.rules} of ${past.max}`);
  check(
    'a profile wider than the posture covers is still registered rather than refused',
    past.hosts > 250,
    `${past.hosts} hosts`
  );
  check(
    'and it says so somewhere the user can actually read',
    past.said > 0,
    past.said ? past.detail.slice(0, 90) : 'nothing in the journal'
  );
  check(
    'even at that width the rule ceiling holds',
    past.rules < past.max,
    `${past.rules}/${past.max}`
  );
  check(
    're-registering every content script stays off the critical path',
    past.registerMs < 5000,
    `${past.registerMs}ms`
  );
}

clearInterval(heartbeat);
console.log(`
${passes} passed, ${failures} failed
`);
shutdown(failures ? 1 : 0);
