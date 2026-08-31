/**
 * ------------------------------------------------------------------
 *  Title    |  The M1 done criterion
 *  Ref      |  cdp.mjs, fixture, worker diagnostic surface
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Prove two sessions in one window, one domain, stay
 *           |  isolated, against the fixture origin.
 *  How      |  Each tab sends only its own cookies, the profile jar
 *           |  never reaches either, and the desync counter ends at
 *           |  zero. Drives the real kernel in a real browser through
 *           |  the worker's diagnostic surface, nothing simulated.
 *  Note     |  node tools/e2e.mjs opera
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, browserEndpoint, loadUnpacked } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mv2 = process.argv.includes('--mv2');
const DIST = join(ROOT, mv2 ? 'dist-mv2' : 'dist');
const FIXTURE = 'http://localhost:8787';

const BROWSERS = {
  opera: [`${process.env.LOCALAPPDATA}\\Programs\\Opera GX\\opera.exe`],
  chrome: [`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
};

const which = process.argv[2] ?? 'opera';
const keep = process.argv.includes('--keep');
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
  const r = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' });
  if (!r.ok) throw new Error();
} catch {
  console.error('fixture is not answering. run: node tools/fixture/server.mjs');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nvx-e2e-'));
const PORT = 9640 + Math.floor(Math.random() * 200);

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
    '--disable-background-timer-throttling',
    `${FIXTURE}/page?e2e=1`,
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
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 800);
}

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

try {
  const v = await browserEndpoint(PORT);
  console.log(`${v.Browser}\n`);
  const browser = await connect(v.webSocketDebuggerUrl);
  await browser.send('Target.setDiscoverTargets', { discover: true });

  const loaded = await loadUnpacked(browser, DIST);
  if (!loaded.id) throw new Error(`side-load failed: ${loaded.error}`);
  console.log(`extension ${loaded.id}\n`);

  // The worker is lazy. Poll until one appears, since it starts on install and
  // again whenever a registered event fires.
  const findWorkers = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const { targetInfos } = await browser.send('Target.getTargets');
      const found = targetInfos.filter(
        (t) =>
          t.url.startsWith(`chrome-extension://${loaded.id}/`) &&
          // MV2's background is a page, not a worker, and it is the only
          // extension page open at this point.
          ['service_worker', 'worker', 'other', 'background_page', 'page'].includes(t.type) &&
          !t.url.endsWith('/popup.html') &&
          !t.url.endsWith('/diagnostics.html')
      );
      if (found.length) return found;
    }
    return [];
  };

  let sessionId = null;
  /** Kept so a phase can end this worker on purpose. See the reopen phase. */
  let workerTargetId = null;

  /**
   * Attaching means finding a worker that is actually running the kernel.
   *
   * Opera still honours --load-extension, so by the time this runs the
   * extension is already present, and loading it again over CDP adds a second
   * instance rather than replacing the first. That leaves more than one service
   * worker target under one extension id, and only one of them ever evaluates
   * the module: the other answers every probe from a context that is genuinely
   * the worker and genuinely empty, which from the outside is indistinguishable
   * from an extension that failed to boot.
   *
   * So every candidate is tried and the first one carrying the surface wins.
   * Taking the first target in the list instead is a coin flip, and it is the
   * coin flip that made this look like a broken build.
   */
  const attach = async () => {
    for (let round = 0; round < 8; round++) {
      // Newest first. The instance this run loaded over CDP is created after the
      // one the command line flag left behind, and probing the older one first
      // wakes a worker nothing is going to use.
      for (const sw of (await findWorkers()).reverse()) {
        const r = await browser
          .send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
          .catch(() => null);
        if (!r) continue;

        const probe = await browser
          .send(
            'Runtime.evaluate',
            { expression: 'typeof globalThis.__nvx', returnByValue: true },
            { sessionId: r.sessionId, timeout: 5000 }
          )
          .catch(() => null);

        if (probe?.result?.value === 'object') {
          sessionId = r.sessionId;
          workerTargetId = sw.targetId;
          return;
        }
        await browser
          .send('Target.detachFromTarget', { sessionId: r.sessionId })
          .catch(() => undefined);
      }
      // Nothing surfaced. A stopped worker only comes back when one of its
      // registered events fires, and no amount of attaching is such an event,
      // so the loop would otherwise wait forever on a browser that is behaving
      // correctly. A navigation is the cheapest thing that wakes it.
      await wake();
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('no service worker exposed the diagnostic surface');
  };

  const wake = async () => {
    const t = await browser
      .send('Target.createTarget', { url: `${FIXTURE}/page?wake=1` })
      .catch(() => null);
    if (!t) return;
    await new Promise((r) => setTimeout(r, 700));
    await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  };

  await attach();

  const evaluate = async (expression, ms = 60_000) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        // No awaitPromise, deliberately. Every message here is synchronous and
        // short, so a worker that dies mid-phase is noticed on the next poll
        // rather than hanging a single long call until its timeout. Work is
        // kicked off and its result parked on a global, which drive() collects.
        r = await browser.send(
          'Runtime.evaluate',
          { expression, returnByValue: true },
          { sessionId, timeout: ms }
        );
      } catch (e) {
        if (attempt > 0) throw e;
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

  /**
   * Runs a body against the kernel.
   *
   * An MV3 worker is stopped when idle and restarted on demand, and CDP exposes
   * the restarting global scope well before it is usable: measured on Opera 150,
   * that context has 255 own properties against 344 once running, and setTimeout
   * is not among them, so it cannot even wait for itself. From the outside it is
   * indistinguishable from an extension that failed to boot, which is what made
   * this look like a broken build rather than a lifecycle race.
   *
   * The worker cannot be caught in a settled state by probing once, because it
   * can cycle between two consecutive messages. So the body carries its own
   * not-ready sentinel and the wait happens here, where there is a clock.
   */
  const drive = async (body, ms = 60_000) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const started = await evaluate(
        `(() => {
           const nvx = globalThis.__nvx;
           if (!nvx) return 'not-ready';
           const slot = { done: false, value: null, error: null };
           globalThis.__nvxRun = slot;
           Promise.resolve()
             .then(() => nvx.whenReady())
             .then(() => (${body})(nvx))
             .then(
               (v) => { slot.value = v; slot.done = true; },
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
             const slot = globalThis.__nvxRun;
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
    throw new Error('the worker never settled into a usable state');
  };

  // Holds the worker awake across the run. Without it a slow phase is measured
  // against a worker that died halfway through it. Evaluating a bare expression
  // is not enough: what resets the idle timer is an extension API call, so the
  // heartbeat makes one.
  const heartbeat = setInterval(() => {
    browser
      .send(
        'Runtime.evaluate',
        { expression: 'chrome.storage.local.get("nvx.keepalive")' },
        { sessionId, timeout: 5000 }
      )
      .catch(() => undefined);
  }, 8000);

  console.log('driving the kernel\n');

  const report = await drive(
    `async (nvx) => {
       const F = ${JSON.stringify(FIXTURE)};

       // A cookie in the real profile jar. No managed tab may ever send it.
       await chrome.cookies.set({ url: F, name: 'profile_jar', value: 'LEAK', path: '/' });

       await nvx.createSession('work');
       await nvx.createSession('personal');

       const win = await chrome.windows.getCurrent();
       const a = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
       const b = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });

       await nvx.bind(a.id, 'work', F + '/echo', win.id);
       await nvx.bind(b.id, 'personal', F + '/echo', win.id);

       await nvx.seed('work', F + '/', 'sid=WORK_ONLY; Path=/');
       await nvx.seed('personal', F + '/', 'sid=PERSONAL_ONLY; Path=/');
       await nvx.seed('work', F + '/', 'extra=w1; Path=/');

       // MV2 has no chrome.scripting; the equivalent takes a code string.
       const readText = async (tabId) => {
         if (chrome.scripting) {
           const [r] = await chrome.scripting.executeScript({
             target: { tabId },
             func: () => document.body?.innerText ?? '',
           });
           return typeof r?.result === 'string' ? r.result : '';
         }
         const out = await chrome.tabs.executeScript(tabId, {
           code: 'document.body && document.body.innerText || ""',
         });
         return typeof out?.[0] === 'string' ? out[0] : '';
       };

       const read = async (tabId, url) => {
         await chrome.tabs.update(tabId, { url });
         await new Promise((res) => {
           const on = (id, info) => {
             if (id === tabId && info.status === 'complete') {
               chrome.tabs.onUpdated.removeListener(on);
               res();
             }
           };
           chrome.tabs.onUpdated.addListener(on);
           setTimeout(res, 8000);
         });
         for (let i = 0; i < 15; i++) {
           const text = await readText(tabId);
           if (text) {
             try { return JSON.parse(text); } catch {}
           }
           await new Promise((res) => setTimeout(res, 200));
         }
         return null;
       };

       const same = win.id;
       const workEcho = await read(a.id, F + '/echo?who=work');
       const personalEcho = await read(b.id, F + '/echo?who=personal');

       // An unmanaged tab must still see the real profile jar. Declared as
       // deliberately unmanaged first: an unbound tab on a domain more than one
       // session covers is otherwise held at the picker, which is right for a
       // person and would stop this run.
       const c = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: same });
       await nvx.unmanaged(c.id, F + '/echo?who=control');
       const controlEcho = await read(c.id, F + '/echo?who=control');

       const rules = await nvx.rules();

       for (const t of [a.id, b.id, c.id]) { try { await chrome.tabs.remove(t); } catch {} }
       try { await chrome.cookies.remove({ url: F, name: 'profile_jar' }); } catch {}

       return {
         work: workEcho && workEcho.cookieHeader,
         personal: personalEcho && personalEcho.cookieHeader,
         control: controlEcho && controlEcho.cookieHeader,
         sameWindow: true,
         ruleCount: rules.length,
         backend: nvx.backendName,
         desync: nvx.desync.snapshot(),
       };
     }`
  );

  if (report?.error) throw new Error(report.error);

  console.log(`  work tab      ${report.work}`);
  console.log(`  personal tab  ${report.personal}`);
  console.log(`  control tab   ${report.control}`);
  console.log(`  backend       ${report.backend}`);
  console.log(`  rules live    ${report.ruleCount}`);
  console.log(`  desync        ${JSON.stringify(report.desync)}\n`);

  const work = report.work ?? '';
  const personal = report.personal ?? '';
  const control = report.control ?? '';

  check('work tab carries its own session', work.includes('WORK_ONLY'));
  check('personal tab carries its own session', personal.includes('PERSONAL_ONLY'));
  check('work tab cannot see the personal session', !work.includes('PERSONAL_ONLY'));
  check('personal tab cannot see the work session', !personal.includes('WORK_ONLY'));
  check('work tab keeps its own extra cookie', work.includes('extra=w1'));
  check('personal tab does not inherit it', !personal.includes('extra=w1'));
  check('profile jar never reaches the work tab', !work.includes('profile_jar'));
  check('profile jar never reaches the personal tab', !personal.includes('profile_jar'));
  check('an unmanaged tab still sees the profile jar', control.includes('profile_jar'));
  check('both sessions live in one window', report.sameWindow === true);
  // The blocking backend installs nothing: it reads the jar per request, which
  // is exactly why it has no rule ceiling and no flush race. Asserting rules
  // exist there would be asserting the wrong architecture.
  check(
    report.backend === 'blocking'
      ? 'the blocking backend needs no rules at all'
      : 'rules were actually installed',
    report.backend === 'blocking' ? report.ruleCount === 0 : report.ruleCount > 0,
    `${report.backend}, ${report.ruleCount} rules`
  );
  check(
    'desync counter is zero',
    report.desync.total === 0,
    `checked ${report.desync.checked} request(s)`
  );

  const restore = await drive('(nvx) => nvx.restoretest()', 120_000).catch((e) => ({
    ok: false,
    checks: [],
    error: e.message,
  }));

  console.log(`\nrestore and crash recovery\n`);
  if (restore?.error) {
    check('restore suite ran', false, restore.error);
  } else {
    for (const c of restore?.checks ?? []) {
      check(c.name, c.pass, c.detail ?? '');
    }
  }

  /**
   * Reopening a tab, and the visit after it.
   *
   * A tab closed in a session is remembered so that Ctrl+Shift+T puts it back
   * where it was rather than asking. The memory used to be one entry per origin
   * that was never cleared, so it kept answering: the reopen rejoined the right
   * session, and so did every deliberate fresh visit for the next hour, on a
   * domain two sessions both claim, which is precisely where guessing signs
   * somebody in as the wrong person without asking.
   *
   * So both halves are checked here, and the second one is the regression: one
   * close earns one reopen, and the visit after that is a question again.
   *
   * And it runs across a real eviction. The scenario is split in three so that
   * the worker can be killed over the debugger between the close and the
   * reopen, which is what a manifest v3 browser does on its own after thirty
   * seconds of quiet. Doing it deliberately is the only honest version of this
   * test: the memory used to live in the worker's heap, so it advertised an
   * hour and lasted until the next lull, and the reason that showed up as an
   * intermittent rather than a failure is that the phase happened to be fast
   * enough to usually beat the idle timer. Killed on purpose it failed every
   * time, which is what it should have been doing all along.
   */
  const REO = FIXTURE.replace('localhost', '127.0.0.1');
  // The other host the fixture answers on, deliberately. Earlier suites in this
  // run open and close tabs on localhost, and each of those leaves an entry in
  // the very memory under test, so a scenario built on localhost pops somebody
  // else's leftovers instead of running out as intended.
  const reoBody = (body) => `async (nvx) => {
       const F = ${JSON.stringify(REO)};
       const settle = async (ms = 2500) => new Promise((r) => setTimeout(r, ms));
       const open = async () => {
         const win = await chrome.windows.getCurrent();
         const t = await chrome.tabs.create({ url: F + '/page', active: false, windowId: win.id });
         await settle();
         return t.id;
       };
       ${body}
     }`;

  const reoSetup = await drive(
    reoBody(`
       const win = await chrome.windows.getCurrent();
       await nvx.createSession('reo_a', ['127.0.0.1']);
       await nvx.createSession('reo_b', ['127.0.0.1']);
       // A tab that lived in reo_a and was closed.
       const first = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
       await nvx.bind(first.id, 'reo_a', F + '/page', win.id);
       await chrome.tabs.remove(first.id);
       await settle(1200);
       // This origin only. Earlier suites leave entries for localhost, and a
       // total across every origin measures the run rather than the scenario.
       return {
         remembered: nvx.reopen.find((r) => F.startsWith(r.origin))?.queue.length ?? 0,
         mirrored: nvx.reopenIsMirrored,
       };`),
    90_000
  ).catch((e) => ({ error: String(e) }));

  /**
   * Ends the worker and waits for the next one to carry the surface.
   *
   * `Target.closeTarget` on a service worker stops it the way the browser's own
   * idle timer would. Everything in its heap is gone; anything the extension
   * wants to survive has to be somewhere the browser holds.
   */
  const killWorker = async () => {
    if (!workerTargetId) return false;
    const id = workerTargetId;
    sessionId = null;
    workerTargetId = null;
    await browser.send('Target.closeTarget', { targetId: id }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1200));
    await attach();
    return true;
  };
  // Not on manifest v2. Its background page is persistent, so there is no
  // eviction to survive and nothing to mirror; ending it would be a different
  // experiment with a different meaning.
  const evicted = mv2 ? null : await killWorker().catch(() => false);

  const reopen = await drive(
    reoBody(`
       // The reopen. Should rejoin without asking, on a worker that has never
       // seen the tab that was closed.
       const second = await open();
       const rejoined = nvx.registry.binding(second)?.sessionId ?? null;
       const heldAfterReopen = nvx.held.some((h) => h.tabId === second);

       // The visit after it. The memory is spent, two sessions cover the host,
       // so this one has to be asked about rather than assumed.
       const third = await open();
       const assumed = nvx.registry.binding(third)?.sessionId ?? null;
       const heldAfterVisit = nvx.held.some((h) => h.tabId === third);

       for (const id of [second, third]) { try { await chrome.tabs.remove(id); } catch {} }
       await settle(600);
       for (const id of ['reo_a', 'reo_b']) {
         nvx.registry.deleteSession(id);
         await nvx.engine.retire(id);
       }
       return { rejoined, heldAfterReopen, assumed, heldAfterVisit };`),
    90_000
  ).catch((e) => ({ error: String(e) }));

  console.log(`\nreopening a tab\n`);
  check('a closed tab is remembered', reoSetup?.remembered === 1, `queued=${reoSetup?.remembered}`);
  if (mv2) {
    check(
      'the memory needs no mirror, because the background page does not die',
      reoSetup?.mirrored === false
    );
  } else {
    check(
      'the memory is kept somewhere the worker dying cannot reach',
      reoSetup?.mirrored === true
    );
    check('the worker was ended between the close and the reopen', evicted === true);
  }
  check(
    'reopening it rejoins the session it was in',
    reopen?.rejoined === 'reo_a',
    `session=${reopen?.rejoined}`
  );
  check('and is not asked about', reopen?.heldAfterReopen === false);
  check(
    'the visit after that is not assumed to be the same account',
    reopen?.assumed === null,
    `session=${String(reopen?.assumed)}`
  );
  check('it is held and asked about instead', reopen?.heldAfterVisit === true);


  /**
   * The journal, and the setup screen's reading of the profile.
   *
   * Both are wired into the worker rather than being pure, and both had unit
   * tests for the maths and nothing for the wiring. The distinction matters
   * here more than usual: the journal's whole value is that it records what
   * really happened, and a journal with a perfect encoder that nothing calls is
   * worth exactly nothing.
   *
   * The redaction check is the one to keep. It seeds a query string that looks
   * like a single sign-on callback and then asserts the secret is nowhere in
   * the file the product would hand somebody to attach to a bug report.
   */
  const diary = await drive(
    `async (nvx) => {
       const F = ${JSON.stringify(FIXTURE)};
       const win = await chrome.windows.getCurrent();
       const settle = (ms) => new Promise((r) => setTimeout(r, ms));

       await nvx.setLogLevel('debug');
       await nvx.clearJournal();

       // Something worth recording: a tab bound to a session, on a url whose
       // query string is the exact shape that must never be written down.
       await nvx.createSession('diary', ['localhost']);
       const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
       await nvx.bind(tab.id, 'diary', F + '/page?code=SUPERSECRET&state=abc', win.id);
       await settle(400);

       const entries = await nvx.journal();
       const bound = entries.find((e) => e.event === 'bound' && e.tabId === tab.id);
       const file = await nvx.journalFile();

       // The profile, read the way the setup screen reads it. Seeded through
       // the browser's own cookie store so the whole path is exercised: the jar,
       // the candidate scoring, the grouping, and the summary the page renders.
       const soon = Math.floor(Date.now() / 1000) + 7 * 86400;
       // Split and join rather than a regex: this whole body is embedded in a
       // template literal on the way to the worker, and a backslash escape does
       // not survive the trip intact.
       const b64 = (o) =>
         btoa(JSON.stringify(o)).split('+').join('-').split('/').join('_').split('=').join('');
       const jwt = (c) => b64({ alg: 'none' }) + '.' + b64(c) + '.sig';
       // Two registrable domains, not two hosts of one: grouping is across
       // registrable domains, and portal.x.example with idp.x.example is a
       // single candidate before grouping ever runs.
       const acct = ['nvxportal.example', 'nvxidp.example'];
       for (const host of acct) {
         await chrome.cookies.set({
           url: 'https://' + host + '/',
           name: 'auth_token',
           value: jwt({ email: 'someone@nvxtest.example', exp: soon }),
           domain: host,
           secure: true,
           httpOnly: true,
           expirationDate: soon,
         });
       }
       const scan = await nvx.adoptScan();
       const group = scan.groups.find((g) => g.label === 'someone@nvxtest.example');
       for (const host of acct) {
         await chrome.cookies.remove({ url: 'https://' + host + '/', name: 'auth_token' });
       }

       try { await chrome.tabs.remove(tab.id); } catch {}
       nvx.registry.deleteSession('diary');
       await nvx.engine.retire('diary');

       return {
         recorded: Boolean(bound),
         session: bound?.session ?? null,
         detail: bound?.detail ?? '',
         leaks: file.includes('SUPERSECRET'),
         marked: file.includes('?...'),
         // fromCharCode, because a backslash escape in this body is resolved by
         // the template literal carrying it, and would arrive here as a real
         // newline inside a string literal.
         header: file.split(String.fromCharCode(10))[0],
         grouped: group ? group.domains.slice().sort() : null,
         signedIn: group?.signedIn ?? null,
         preselect: group?.preselect ?? null,
       };
     }`,
    90_000
  ).catch((e) => ({ error: String(e) }));

  console.log(`\nthe journal, and reading the profile\n`);
  check('a real binding is recorded', diary?.recorded === true, diary?.error ?? '');
  check(
    'and it names the session rather than an id',
    diary?.session === 'diary',
    `session=${diary?.session}`
  );
  check('and says which rule claimed the tab', String(diary?.detail).includes('by hand'), diary?.detail);
  check(
    'the exported file carries no query string, whatever was in it',
    diary?.leaks === false && diary?.marked === true,
    `secret present=${String(diary?.leaks)} redaction marker=${String(diary?.marked)}`
  );
  check('and says what it is at the top', String(diary?.header).includes('NVX Session journal'));
  check(
    'the profile scan groups one account across its sites',
    JSON.stringify(diary?.grouped) === JSON.stringify(['nvxidp.example', 'nvxportal.example']),
    `grouped=${JSON.stringify(diary?.grouped)}`
  );
  check('and offers it as a signed-in account', diary?.signedIn === true);
  check('and arrives ticked', diary?.preselect === true);

  /**
   * The mark suite proves the compositor. This proves the channel: that a real
   * tab, in a real session, ends up wearing the icon the worker painted. It is
   * the only part of tab identity that cannot be checked without a page.
   */
  const marked = await drive(
    `async (nvx) => {
       const F = ${JSON.stringify(FIXTURE)};
       await nvx.createSession('marked', ['localhost']);
       const win = await chrome.windows.getCurrent();
       const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
       await nvx.bind(tab.id, 'marked', F + '/page', win.id);

       await chrome.tabs.update(tab.id, { url: F + '/page?mark=1' });

       // The agent is registered for a host only once a session reaches it, so
       // the first load after binding may predate the registration. Reloading
       // once is what a user would never have to do, because binding happens
       // long before they navigate.
       let found = null;
       for (let i = 0; i < 40 && !found; i++) {
         await new Promise((r) => setTimeout(r, 400));
         if (i === 12) { try { await chrome.tabs.reload(tab.id); } catch {} }
         const probe =
           'JSON.stringify((() => { const l = document.querySelector("link[data-nvx-mark]");' +
           ' return l ? { href: l.href.slice(0, 40), rel: l.rel } : null; })())';
         let raw = null;
         if (chrome.scripting) {
           const [r] = await chrome.scripting.executeScript({
             target: { tabId: tab.id },
             func: () => {
               const l = document.querySelector('link[data-nvx-mark]');
               return l ? JSON.stringify({ href: l.href.slice(0, 40), rel: l.rel }) : null;
             },
           }).catch(() => [null]);
           raw = r?.result ?? null;
         } else {
           const out = await chrome.tabs.executeScript(tab.id, { code: probe }).catch(() => [null]);
           raw = out?.[0] ?? null;
         }
         try { found = raw ? JSON.parse(raw) : null; } catch { found = null; }
       }

       try { await chrome.tabs.remove(tab.id); } catch {}
       nvx.registry.deleteSession('marked');
       await nvx.engine.retire('marked');
       return found;
     }`,
    90_000
  ).catch(() => null);

  console.log(`\ntab identity\n`);
  check(
    'a managed tab ends up wearing the mark',
    Boolean(marked?.href?.startsWith('data:image/png;base64,')),
    marked ? `${marked.rel} ${marked.href.slice(0, 30)}...` : 'no marked link in the page'
  );

  /**
   * Service worker traffic, which is the hardest case in the whole design.
   *
   * A worker's fetch carries tabId -1, so nothing about the request says which
   * session it belongs to. The declarative backend has to guess in advance by
   * compiling an ownership rule; the blocking backend can simply ask who owns
   * the origin at the moment it is asked. Both are checked here, because a
   * session that isolates pages but not their service workers is not isolated.
   */
  const sw = await drive(
    `async (nvx) => {
       const F = ${JSON.stringify(FIXTURE)};
       await chrome.cookies.set({ url: F, name: 'profile_jar', value: 'LEAK', path: '/' });
       await nvx.createSession('swowner', ['localhost']);
       await nvx.seed('swowner', F + '/', 'swsid=SW_SESSION; Path=/');

       const win = await chrome.windows.getCurrent();
       const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
       await nvx.bind(tab.id, 'swowner', F + '/sw-page', win.id);
       await chrome.tabs.update(tab.id, { url: F + '/sw-page' });

       const readAttr = async () => {
         const code = 'document.documentElement.getAttribute("data-nvx-sw")';
         if (chrome.scripting) {
           const [r] = await chrome.scripting.executeScript({
             target: { tabId: tab.id },
             func: () => document.documentElement.getAttribute('data-nvx-sw'),
           }).catch(() => [null]);
           return r?.result ?? null;
         }
         const out = await chrome.tabs.executeScript(tab.id, { code }).catch(() => [null]);
         return out?.[0] ?? null;
       };

       let raw = null;
       for (let i = 0; i < 50 && !raw; i++) {
         await new Promise((r) => setTimeout(r, 400));
         raw = await readAttr();
       }

       try { await chrome.tabs.remove(tab.id); } catch {}
       try { await chrome.cookies.remove({ url: F, name: 'profile_jar' }); } catch {}
       nvx.registry.deleteSession('swowner');
       await nvx.engine.retire('swowner');

       let parsed = null;
       try { parsed = raw ? JSON.parse(raw) : null; } catch {}
       return { backend: nvx.backendName, seen: parsed?.body?.cookieHeader ?? null, error: parsed?.error ?? null };
     }`,
    90_000
  ).catch((e) => ({ error: e.message }));

  console.log(`
service worker traffic
`);
  if (!sw || sw.error) {
    check('the fixture service worker ran', false, sw?.error ?? 'no result');
  } else {
    check('the service worker fetch was attributed to a session', sw.seen !== null, String(sw.seen));
    check(
      'a service worker sends its own session, not the profile jar',
      typeof sw.seen === 'string' && sw.seen.includes('swsid=SW_SESSION') && !sw.seen.includes('profile_jar'),
      `${sw.backend}: ${sw.seen}`
    );
  }

  /**
   * Adoption, against the real profile jar. The unit tests cover the shape of a
   * candidate; only the browser can say whether chrome.cookies actually hands
   * over the httpOnly session cookie that makes adoption worth anything.
   */
  const adopted = await drive(
    `async (nvx) => {
       const F = ${JSON.stringify(FIXTURE)};
       await chrome.cookies.set({
         url: F, name: 'adopt_me', value: 'FROM_PROFILE', path: '/',
         expirationDate: Math.floor(Date.now() / 1000) + 3600,
       });

       /**
        * The scan is asked while a tab is knowingly on the domain, rather than
        * while one happens to be.
        *
        * "A domain with a tab open is marked open" failed about one run in
        * three, and never because the flag was wrong: earlier phases open,
        * navigate and close tabs, so whether anything was still sitting on
        * localhost by the time adoption ran was luck. A check that fails at
        * random teaches you to re-run rather than to read it, which is worse
        * than not having it.
        */
       const held = await chrome.tabs.create({ url: F + '/page', active: false });
       await new Promise((r) => setTimeout(r, 600));

       const scan = await nvx.scan();
       const seen = scan.candidates.find((c) => c.domain === 'localhost');

       await chrome.tabs.remove(held.id).catch(() => undefined);

       const made = await nvx.adopt(['localhost'], { label: 'adopted', bindOpenTabs: false });
       const session = made.ok ? nvx.registry.getSession(made.id) : null;
       const jar = session ? session.store.all().map((c) => c.name + '=' + c.value) : [];

       if (made.ok) {
         nvx.registry.deleteSession(made.id);
         await nvx.engine.retire(made.id);
       }
       try { await chrome.cookies.remove({ url: F, name: 'adopt_me' }); } catch {}

       return { seen: seen || null, made, jar, total: scan.total };
     }`,
    60_000
  ).catch((e) => ({ error: e.message }));

  console.log(`\nadoption\n`);
  if (adopted?.error) {
    check('adoption ran', false, adopted.error);
  } else {
    check(
      'the profile jar is readable',
      adopted.total > 0 && Boolean(adopted.seen),
      `${adopted.total} candidate domain(s)`
    );
    check(
      'a candidate reports its hosts and cookie count',
      (adopted.seen?.cookies ?? 0) > 0 && (adopted.seen?.hosts?.length ?? 0) > 0,
      adopted.seen ? `${adopted.seen.cookies} cookie(s) on ${adopted.seen.hosts.join(', ')}` : ''
    );
    check('a domain with a tab open is marked open', adopted.seen?.open === true);
    check('adopting creates a session', adopted.made?.ok === true, adopted.made?.reason ?? '');
    check(
      'the adopted session carries the profile cookie',
      adopted.jar?.some((c) => c === 'adopt_me=FROM_PROFILE'),
      (adopted.jar ?? []).join(' ')
    );
  }

  const paint = await drive('(nvx) => nvx.painttest()', 60_000).catch((e) => ({
    ok: false,
    checks: [],
    error: e.message,
  }));

  if (paint?.error) {
    check('mark suite ran', false, paint.error);
  } else {
    for (const c of paint?.checks ?? []) {
      check(c.name, c.pass, c.detail ?? '');
    }
  }

  console.log(`\nstorage isolation\n`);

  if (mv2) {
    // Not a skip for convenience: manifest v2 has no way to declare a MAIN
    // world content script, so there is nothing to virtualise storage with.
    // Reported rather than passed vacuously.
    console.log('  ----  manifest v2 has no MAIN world, so storage stays shared');
  } else {
    const storage = await drive('(nvx) => nvx.storagetest()', 120_000).catch((e) => ({
      ok: false,
      checks: [],
      error: e.message,
    }));

    if (storage?.error) {
      check('storage suite ran', false, storage.error);
    } else {
      for (const c of storage?.checks ?? []) {
        check(c.name, c.pass, c.detail ?? '');
      }
    }
  }

  console.log(`\nfingerprint mask\n`);

  if (mv2) {
    // Not a skip for convenience. Manifest v2 has no chrome.scripting, so there
    // is no way to register a MAIN world script at document_start and no mask to
    // measure. Reported rather than passed vacuously.
    console.log('  ----  manifest v2 has no MAIN world, so there is no mask to measure');
  } else {
    const mask = await drive('(nvx) => nvx.masktest()', 180_000).catch((e) => ({
      ok: false,
      checks: [],
      error: e.message,
    }));
    if (mask?.error) {
      check('mask suite ran', false, mask.error);
    } else {
      for (const c of mask?.checks ?? []) check(c.name, c.pass, c.detail ?? '');
    }
  }

  console.log(`\nredirect chains\n`);

  if (mv2) {
    // Nothing to prove: the blocking backend reads the jar at request time, so
    // there is no window for a rule to be stale in.
    console.log('  ----  the blocking backend has no flush race to close');
  } else {
    const chain = await drive('(nvx) => nvx.chaintest()', 180_000).catch((e) => ({
      ok: false,
      checks: [],
      error: e.message,
    }));
    if (chain?.error) {
      check('chain suite ran', false, chain.error);
    } else {
      for (const c of chain?.checks ?? []) check(c.name, c.pass, c.detail ?? '');
    }
    if (process.argv.includes('--trace')) {
      const trace = await drive('(nvx) => nvx.exactTrace()', 20_000).catch(() => []);
      for (const t of trace ?? []) {
        if (!/chain/.test(t.url)) continue;
        console.log(
          `  trace  ${t.method} ${t.url.replace('http://', '').slice(0, 46)}
` +
            `         type=${t.type} init=${t.initiator} site=${t.fetchSite} mode=${t.fetchMode} dest=${t.fetchDest}
` +
            `         sent=[${t.header}]`
        );
      }
    }
  }

  console.log(`\nblast-radius guardrails\n`);

  const guarded = await drive('(nvx) => nvx.guardtest()', 120_000).catch((e) => ({
    ok: false,
    checks: [],
    error: e.message,
  }));

  if (guarded?.error) {
    check('guard suite ran', false, guarded.error);
  } else {
    for (const c of guarded?.checks ?? []) {
      check(c.name, c.pass, c.detail ?? '');
    }
  }

  clearInterval(heartbeat);
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  shutdown(failed.length ? 1 : 0);
} catch (e) {
  console.error(`\ne2e failed: ${e.message}`);
  shutdown(2);
}
