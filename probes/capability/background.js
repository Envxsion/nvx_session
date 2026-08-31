/**
 * ------------------------------------------------------------------
 *  Title    |  NVX capability probe
 *  Ref      |  panel.js, inject-iso.js, inject-main.js, fixture
 *  ID       |  M0 (capability probe)
 * ------------------------------------------------------------------
 *  Purpose  |  Prove each API NVX Session depends on actually works,
 *           |  not just that it is present.
 *  How      |  Every probe calls the real API with the exact shape
 *           |  NVX needs and reports what came back.
 *  Note     |  Verdicts: pass, did the thing; fail, exists but
 *           |  refused or did the wrong thing; absent, not present;
 *           |  blocked, something external prevented an answer.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

const FIXTURE = 'http://localhost:8787';
const RULE_BASE = 90000;

const results = new Map();
const observed = new Map();

function record(id, verdict, detail, extra) {
  results.set(id, { id, verdict, detail, ...(extra ?? {}) });
}

async function probe(id, fn) {
  try {
    const r = await fn();
    record(id, r.verdict, r.detail, r.extra);
  } catch (e) {
    record(id, 'fail', `threw: ${e && e.message ? e.message : String(e)}`);
  }
}

const has = (path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), chrome) != null;

async function clearRules(ids) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch {}
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Add one session rule, report whether it survived,
 *           |  then remove it.
 *  How      |  The only honest way to test a DNR feature: Chromium
 *           |  validates the whole rule shape on insert, so a
 *           |  rejected option throws with a message naming it.
 * ------------------------------------------------------------------
 */
async function tryRule(id, rule) {
  const full = { id, priority: 1, ...rule };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [full],
  });
  const live = await chrome.declarativeNetRequest.getSessionRules();
  const found = live.find((r) => r.id === id);
  await clearRules([id]);
  if (!found) return { verdict: 'fail', detail: 'accepted then vanished from getSessionRules' };
  return { verdict: 'pass', detail: 'rule accepted and readable back' };
}

// ---------------------------------------------------------------- environment

function environment() {
  const ua = navigator.userAgent;
  const brands = navigator.userAgentData?.brands ?? [];
  const opr = /OPR\/([\d.]+)/.exec(ua);
  const chromium = /Chrome\/([\d.]+)/.exec(ua);
  const isOpera = Boolean(opr) || brands.some((b) => /opera/i.test(b.brand));
  return {
    browser: isOpera ? 'Opera' : brands.some((b) => /edge/i.test(b.brand)) ? 'Edge' : 'Chrome',
    operaVersion: opr ? opr[1] : null,
    chromiumVersion: chromium ? chromium[1] : null,
    chromiumMajor: chromium ? Number(chromium[1].split('.')[0]) : null,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
    brands: brands.map((b) => `${b.brand} ${b.version}`),
    userAgent: ua,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
  };
}

// ------------------------------------------------------------- static probes

async function runStatic() {
  results.clear();

  await probe('dnr.present', async () =>
    has('declarativeNetRequest')
      ? { verdict: 'pass', detail: 'chrome.declarativeNetRequest exists' }
      : { verdict: 'absent', detail: 'no declarativeNetRequest namespace' }
  );

  if (has('declarativeNetRequest.updateSessionRules')) {
    const dnr = chrome.declarativeNetRequest;

    await probe('dnr.limits', async () => ({
      verdict: 'pass',
      detail: `session ${dnr.MAX_NUMBER_OF_SESSION_RULES ?? '?'}, dynamic ${
        dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? '?'
      }, static ${dnr.MAX_NUMBER_OF_STATIC_RULESETS ?? '?'}`,
      extra: {
        sessionRules: dnr.MAX_NUMBER_OF_SESSION_RULES ?? null,
        dynamicRules: dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? null,
      },
    }));

    await probe('dnr.sessionRules', () =>
      tryRule(RULE_BASE + 1, {
        action: { type: 'block' },
        condition: { urlFilter: '|http://nvx.invalid/', resourceTypes: ['xmlhttprequest'] },
      })
    );

    await probe('dnr.tabIds', () =>
      tryRule(RULE_BASE + 2, {
        action: { type: 'block' },
        condition: {
          urlFilter: '|http://nvx.invalid/',
          tabIds: [-2],
          resourceTypes: ['xmlhttprequest'],
        },
      })
    );

    await probe('dnr.setRequestCookie', () =>
      tryRule(RULE_BASE + 3, {
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'set', value: 'nvx=1' }],
        },
        condition: { urlFilter: '|http://nvx.invalid/', resourceTypes: ['xmlhttprequest'] },
      })
    );

    await probe('dnr.removeSetCookie', () =>
      tryRule(RULE_BASE + 4, {
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
        },
        condition: { urlFilter: '|http://nvx.invalid/', resourceTypes: ['xmlhttprequest'] },
      })
    );

    await probe('dnr.responseHeaderCondition', () =>
      tryRule(RULE_BASE + 5, {
        action: { type: 'block' },
        condition: {
          urlFilter: '|http://nvx.invalid/',
          responseHeaders: [{ header: 'set-cookie' }],
          resourceTypes: ['xmlhttprequest'],
        },
      })
    );

    await probe('dnr.domainType', () =>
      tryRule(RULE_BASE + 6, {
        action: { type: 'block' },
        condition: {
          urlFilter: '|http://nvx.invalid/',
          domainType: 'thirdParty',
          resourceTypes: ['xmlhttprequest'],
        },
      })
    );

    await probe('dnr.mainFrameVariant', () =>
      tryRule(RULE_BASE + 7, {
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'set', value: 'nvx=1' }],
        },
        condition: {
          urlFilter: '|http://nvx.invalid/',
          resourceTypes: ['main_frame'],
          tabIds: [-2],
        },
      })
    );

    await probe('dnr.getMatchedRules', async () =>
      typeof dnr.getMatchedRules === 'function'
        ? (await dnr.getMatchedRules({}), { verdict: 'pass', detail: 'callable, feedback permission granted' })
        : { verdict: 'absent', detail: 'getMatchedRules missing' }
    );
  }

  await probe('scripting.present', async () =>
    has('scripting.registerContentScripts')
      ? { verdict: 'pass', detail: 'chrome.scripting available' }
      : { verdict: 'absent', detail: 'no scripting namespace, expected on MV2' }
  );

  if (has('scripting.registerContentScripts')) {
    await probe('scripting.mainWorld', async () => {
      const id = 'nvx-probe-mainworld-test';
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
      } catch {}
      await chrome.scripting.registerContentScripts([
        {
          id,
          js: ['inject-main.js'],
          matches: ['http://nvx.invalid/*'],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true,
        },
      ]);
      const live = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
      const w = live[0]?.world;
      return w === 'MAIN'
        ? { verdict: 'pass', detail: 'registered with world MAIN at document_start' }
        : { verdict: 'fail', detail: `registered but world reported as ${w}` };
    });

    await probe('scripting.matchOriginAsFallback', async () => {
      const id = 'nvx-probe-fallback-test';
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
      } catch {}
      await chrome.scripting.registerContentScripts([
        {
          id,
          js: ['inject-main.js'],
          matches: ['http://nvx.invalid/*'],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true,
          matchOriginAsFallback: true,
        },
      ]);
      const live = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
      return live[0]?.matchOriginAsFallback === true
        ? { verdict: 'pass', detail: 'about:blank and srcdoc frames reachable' }
        : { verdict: 'fail', detail: 'option accepted but not reflected back' };
    });
  }

  await probe('webRequest.present', async () =>
    has('webRequest.onHeadersReceived')
      ? { verdict: 'pass', detail: 'onHeadersReceived available' }
      : { verdict: 'absent', detail: 'no webRequest' }
  );

  if (has('webRequest.onHeadersReceived')) {
    await probe('webRequest.extraHeaders', async () => {
      const noop = () => {};
      chrome.webRequest.onHeadersReceived.addListener(
        noop,
        { urls: ['http://nvx.invalid/*'] },
        ['responseHeaders', 'extraHeaders']
      );
      const ok = chrome.webRequest.onHeadersReceived.hasListener(noop);
      chrome.webRequest.onHeadersReceived.removeListener(noop);
      return ok
        ? { verdict: 'pass', detail: 'non-blocking listener with extraHeaders accepted' }
        : { verdict: 'fail', detail: 'listener did not attach' };
    });

    await probe('webRequest.blocking', async () => {
      const noop = () => {};
      try {
        chrome.webRequest.onBeforeSendHeaders.addListener(
          noop,
          { urls: ['http://nvx.invalid/*'] },
          ['requestHeaders', 'blocking', 'extraHeaders']
        );
        const ok = chrome.webRequest.onBeforeSendHeaders.hasListener(noop);
        chrome.webRequest.onBeforeSendHeaders.removeListener(noop);
        return ok
          ? {
              verdict: 'pass',
              detail:
                'Listener attached. This alone proves nothing: both Chrome and Opera accept it under MV3 and then ignore the return value. See the blockingRewrite functional test.',
            }
          : { verdict: 'fail', detail: 'accepted but no listener attached' };
      } catch (e) {
        return {
          verdict: 'absent',
          detail: `blocking refused, expected on MV3: ${e.message}`,
        };
      }
    });
  }

  for (const [id, path, note] of [
    ['debugger', 'debugger', 'T2 protocol tier'],
    ['tabGroups', 'tabGroups', 'native tab colour binding'],
    ['offscreen', 'offscreen', 'conductor runner'],
    ['userScripts', 'userScripts', 'alternative MAIN injection'],
    ['cookies', 'cookies', 'adoption sweep'],
  ]) {
    await probe(`api.${id}`, async () =>
      has(path)
        ? { verdict: 'pass', detail: `available, ${note}` }
        : { verdict: 'absent', detail: `missing, ${note} unavailable` }
    );
  }

  if (has('cookies.getAll')) {
    await probe('cookies.partitionKey', async () => {
      await chrome.cookies.getAll({ partitionKey: { topLevelSite: 'http://nvx.invalid' } });
      return { verdict: 'pass', detail: 'CHIPS partitionKey accepted' };
    });
  }

  await probe('runtime.dynamicUrl', async () => {
    const url = chrome.runtime.getURL('probe-asset.js');
    const id = chrome.runtime.id;
    return url.includes(id)
      ? { verdict: 'fail', detail: 'resource URL contains the static extension id, probeable from a page' }
      : { verdict: 'pass', detail: 'use_dynamic_url honoured, id not leaked' };
  });

  return { env: environment(), results: [...results.values()] };
}

// --------------------------------------------------------------- live probes

function waitForTab(tabId) {
  return new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 8000);
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Read a value out of a tab across MV2 and MV3.
 *  How      |  MV2 has no chrome.scripting, so both paths are carried.
 *  Note     |  The MV2 form takes the expression as source, because
 *           |  tabs.executeScript cannot serialise a function ref.
 * ------------------------------------------------------------------
 */
async function readTab(tabId, fn, mv2Expression) {
  if (chrome.scripting?.executeScript) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
    return r?.result;
  }
  return new Promise((resolve) => {
    chrome.tabs.executeScript(
      tabId,
      { code: mv2Expression ?? `(${fn.toString()})()` },
      (r) => resolve(Array.isArray(r) ? r[0] : undefined)
    );
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Retry reading a tab until it yields a value.
 *  Note     |  A tab reports complete before its document has made
 *           |  the attribute or body being read, so a single read
 *           |  races and returns null. Every live probe reads here.
 * ------------------------------------------------------------------
 */
async function readTabUntil(tabId, fn, tries = 15, waitMs = 200) {
  for (let i = 0; i < tries; i++) {
    const v = await readTab(tabId, fn).catch(() => null);
    if (v != null && v !== '') return v;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Spike 1. Does a non-blocking observer still see
 *           |  Set-Cookie when a DNR rule removes it?
 *  Note     |  Four outcomes matter; only one lets us both capture
 *           |  and suppress with these two mechanisms alone.
 * ------------------------------------------------------------------
 */
async function liveStripVersusObserve() {
  const stamp = Date.now();
  const url = `${FIXTURE}/set-one?stamp=${stamp}`;
  observed.clear();

  const listener = (d) => {
    if (!d.url.startsWith(`${FIXTURE}/set-one`)) return;
    const sc = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'set-cookie');
    observed.set('seen', sc.map((h) => h.value));
  };
  chrome.webRequest.onHeadersReceived.addListener(
    listener,
    { urls: [`${FIXTURE}/*`] },
    ['responseHeaders', 'extraHeaders']
  );

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_BASE + 20],
    addRules: [
      {
        id: RULE_BASE + 20,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
        },
        condition: {
          urlFilter: `|${FIXTURE}/set-one`,
          resourceTypes: ['main_frame', 'xmlhttprequest'],
        },
      },
    ],
  });

  try {
    await chrome.cookies.remove({ url: FIXTURE, name: 'nvx_probe' });
  } catch {}

  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTab(tab.id);
  await new Promise((r) => setTimeout(r, 350));

  const jar = await chrome.cookies.get({ url: FIXTURE, name: 'nvx_probe' });

  chrome.webRequest.onHeadersReceived.removeListener(listener);
  await clearRules([RULE_BASE + 20]);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  const sawIt = (observed.get('seen') ?? []).length > 0;
  const landed = Boolean(jar && jar.value.includes(String(stamp)));

  if (sawIt && !landed) {
    return {
      verdict: 'pass',
      detail: 'Observer saw Set-Cookie and the rule kept it out of the profile jar. Capture and suppress both work.',
      extra: { sawIt, landed },
    };
  }
  if (!sawIt && !landed) {
    return {
      verdict: 'fail',
      detail: 'The rule stripped the header before the observer ran. Capture must move to the reconcile fallback in DESIGN.html Spike 1.',
      extra: { sawIt, landed },
    };
  }
  if (sawIt && landed) {
    return {
      verdict: 'fail',
      detail: 'Observer saw it but the cookie still reached the profile jar. Stripping does not work here; hygiene needs the reconcile path.',
      extra: { sawIt, landed },
    };
  }
  return { verdict: 'blocked', detail: 'Cookie landed without the observer seeing it. Inconclusive.', extra: { sawIt, landed } };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The core bet. Does operation "set" on the Cookie
 *           |  request header actually replace what the browser
 *           |  would have sent, scoped to one tab?
 * ------------------------------------------------------------------
 */
async function liveCookieSubstitution() {
  const stamp = Date.now();
  await chrome.cookies.set({
    url: FIXTURE,
    name: 'nvx_real',
    value: `profile_${stamp}`,
    path: '/',
  });

  const seedCheck = await chrome.cookies.get({ url: FIXTURE, name: 'nvx_real' });
  const seeded = Boolean(seedCheck && seedCheck.value === `profile_${stamp}`);

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const injected = `nvx_vault=vault_${stamp}`;

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_BASE + 21],
    addRules: [
      {
        id: RULE_BASE + 21,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'set', value: injected }],
        },
        condition: {
          urlFilter: `|${FIXTURE}/echo`,
          tabIds: [tab.id],
          resourceTypes: ['main_frame', 'xmlhttprequest'],
        },
      },
    ],
  });

  await chrome.tabs.update(tab.id, { url: `${FIXTURE}/echo?probe=substitution` });
  await waitForTab(tab.id);

  const body = await readTabUntil(tab.id, () => document.body.innerText);

  const control = await chrome.tabs.create({
    url: `${FIXTURE}/echo?probe=control`,
    active: false,
  });
  await waitForTab(control.id);
  const controlBody = await readTabUntil(control.id, () => document.body.innerText);

  await clearRules([RULE_BASE + 21]);
  for (const t of [tab.id, control.id]) {
    try {
      await chrome.tabs.remove(t);
    } catch {}
  }
  try {
    await chrome.cookies.remove({ url: FIXTURE, name: 'nvx_real' });
  } catch {}

  let sent = null;
  let controlSent = null;
  try {
    sent = JSON.parse(body).cookieHeader;
    controlSent = JSON.parse(controlBody).cookieHeader;
  } catch {
    return { verdict: 'blocked', detail: 'Could not parse the fixture response. Is the fixture server running?' };
  }

  const replaced = sent === injected;
  const leaked = Boolean(sent && sent.includes('nvx_real'));
  const controlHasReal = Boolean(controlSent && controlSent.includes('nvx_real'));

  // The managed arm is what the architecture rests on. The control arm only
  // shows that an unmanaged tab is left alone, and it can legitimately be
  // inconclusive if the seed cookie never landed, so it must not be able to
  // turn a working substitution into a failure.
  if (replaced) {
    return {
      verdict: 'pass',
      detail: controlHasReal
        ? 'Managed tab sent only the injected value; unmanaged tab kept the profile jar. Per-tab substitution confirmed.'
        : `Managed tab sent only the injected value, so substitution works. Control arm inconclusive: unmanaged tab sent ${controlSent}`,
      extra: { sent, controlSent, seeded },
    };
  }
  if (leaked && sent.includes('nvx_vault')) {
    return {
      verdict: 'fail',
      detail: `Header was appended rather than replaced, so the profile jar leaks through. Received: ${sent}`,
      extra: { sent, controlSent, seeded },
    };
  }
  return {
    verdict: 'fail',
    detail: `Rule did not apply. Expected "${injected}", managed tab sent: ${sent}`,
    extra: { sent, controlSent, seeded },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Rewrite the Cookie header for real via blocking
 *           |  webRequest and check what the origin received.
 *  Note     |  Opera keeps blocking webRequest, but accepting a
 *           |  listener is not honouring its return value. A pass
 *           |  means the second netfilter backend closes the service
 *           |  worker gap and the flush race.
 * ------------------------------------------------------------------
 */
async function liveBlockingRewrite() {
  if (!chrome.webRequest?.onBeforeSendHeaders) {
    return { verdict: 'absent', detail: 'no webRequest.onBeforeSendHeaders' };
  }

  const marker = `nvx_blocking=b_${Date.now()}`;
  const listener = (details) => {
    const headers = (details.requestHeaders ?? []).filter(
      (h) => h.name.toLowerCase() !== 'cookie'
    );
    headers.push({ name: 'Cookie', value: marker });
    return { requestHeaders: headers };
  };

  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: [`${FIXTURE}/echo*`] },
      ['requestHeaders', 'blocking', 'extraHeaders']
    );
  } catch (e) {
    return {
      verdict: 'absent',
      detail: `blocking listener refused: ${e.message}. Expected on Chrome MV3.`,
    };
  }

  const tab = await chrome.tabs.create({
    url: `${FIXTURE}/echo?probe=blocking`,
    active: false,
  });
  await waitForTab(tab.id);
  const body = await readTabUntil(tab.id, () => document.body.innerText);

  chrome.webRequest.onBeforeSendHeaders.removeListener(listener);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  let sent = null;
  try {
    sent = JSON.parse(body).cookieHeader;
  } catch {
    return { verdict: 'blocked', detail: 'could not parse fixture response' };
  }

  return sent === marker
    ? {
        verdict: 'pass',
        detail:
          'A blocking listener actually rewrote the Cookie header. The MV2 style backend is real here, which closes the service worker gap and the flush race.',
        extra: { sent },
      }
    : {
        verdict: 'fail',
        detail: `Listener attached but its return value was ignored. Origin received: ${sent}`,
        extra: { sent },
      };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Spike 3. Does the ISOLATED world script run before
 *           |  the MAIN world one at the same runAt?
 *  Note     |  Path B needs it. If MAIN wins, the sessionStorage
 *           |  handshake cannot seed in time and per-tab posture on
 *           |  a shared origin requires T2 unconditionally.
 * ------------------------------------------------------------------
 */
async function liveInjectionOrder() {
  if (!chrome.scripting?.registerContentScripts) {
    return {
      verdict: 'absent',
      detail:
        'No chrome.scripting here. On MV2 the equivalent is a declared content_scripts pair, which the MV2 probe build carries instead.',
    };
  }
  const ids = ['nvx-probe-iso', 'nvx-probe-main'];
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const stale = existing.filter((s) => s.id.startsWith('nvx-probe')).map((s) => s.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  } catch {}

  await chrome.scripting.registerContentScripts([
    {
      id: 'nvx-probe-iso',
      js: ['inject-iso.js'],
      matches: [`${FIXTURE}/*`],
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true,
    },
    {
      id: 'nvx-probe-main',
      js: ['inject-main.js'],
      matches: [`${FIXTURE}/*`],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    },
  ]);

  const runs = [];
  for (let i = 0; i < 5; i++) {
    const tab = await chrome.tabs.create({ url: `${FIXTURE}/page?run=${i}`, active: false });
    await waitForTab(tab.id);
    const seq = await readTabUntil(tab.id, () =>
      document.documentElement.getAttribute('data-nvx-seq')
    );
    const seeded = await readTabUntil(tab.id, () => {
      try {
        return sessionStorage.getItem('__nvx_probe_seed');
      } catch {
        return 'unreadable';
      }
    });
    runs.push({ seq, seeded });
    try {
      await chrome.tabs.remove(tab.id);
    } catch {}
  }

  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch {}

  const seqs = runs.map((r) => r.seq);
  const allIsoFirst = seqs.every((s) => s && s.startsWith('iso'));
  const anyNull = seqs.some((s) => !s);
  const handshakeWorked = runs.every((r) => r.seeded === 'ok');

  if (anyNull) {
    return { verdict: 'blocked', detail: `A run recorded nothing: ${JSON.stringify(seqs)}`, extra: { runs } };
  }
  if (allIsoFirst && handshakeWorked) {
    return {
      verdict: 'pass',
      detail: `ISOLATED ran first in all 5 runs and MAIN read the seed. Delivery path B is viable. ${JSON.stringify(seqs)}`,
      extra: { runs },
    };
  }
  if (allIsoFirst) {
    return {
      verdict: 'fail',
      detail: `Order is right but MAIN could not read the seed. ${JSON.stringify(runs)}`,
      extra: { runs },
    };
  }
  return {
    verdict: 'fail',
    detail: `Order is not guaranteed: ${JSON.stringify(seqs)}. Path B is dead; per-tab posture on a shared origin needs T2.`,
    extra: { runs },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The service worker gap. A request from a page service
 *           |  worker should report tabId -1.
 *  Note     |  That is why a tabIds rule cannot attribute it.
 * ------------------------------------------------------------------
 */
async function liveServiceWorkerAttribution() {
  const seen = [];
  const listener = (d) => {
    if (d.url.includes('/echo?from=sw')) seen.push({ tabId: d.tabId, type: d.type, initiator: d.initiator });
  };
  chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [`${FIXTURE}/*`] });

  const tab = await chrome.tabs.create({ url: `${FIXTURE}/sw-page`, active: false });
  await waitForTab(tab.id);
  await new Promise((r) => setTimeout(r, 1400));

  chrome.webRequest.onBeforeRequest.removeListener(listener);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  if (seen.length === 0) {
    return { verdict: 'blocked', detail: 'The service worker never issued its fetch. Cannot measure attribution.' };
  }
  const orphaned = seen.filter((s) => s.tabId < 0);
  if (orphaned.length > 0) {
    return {
      verdict: 'fail',
      detail: `Confirmed: ${orphaned.length}/${seen.length} service worker requests carry tabId ${orphaned[0].tabId}. The gap in DESIGN.html section 07 is real, mitigation (a) required.`,
      extra: { seen },
    };
  }
  return {
    verdict: 'pass',
    detail: `Service worker requests carried a real tabId (${seen[0].tabId}). The gap may not apply here.`,
    extra: { seen },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Can a rule attribute service worker traffic by
 *           |  matching tabIds [-1]?
 *  Note     |  If so, DESIGN sec 07 improves: one session per origin
 *           |  owns the worker and gets its traffic, registration is
 *           |  blocked only for the others, and offline support
 *           |  survives for the account you actually use.
 * ------------------------------------------------------------------
 */
async function liveServiceWorkerOwnership() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    return { verdict: 'absent', detail: 'no declarativeNetRequest' };
  }

  const marker = `nvx_swown=o_${Date.now()}`;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_BASE + 30],
    addRules: [
      {
        id: RULE_BASE + 30,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'set', value: marker }],
        },
        condition: { urlFilter: `${FIXTURE}/echo`, tabIds: [-1] },
      },
    ],
  });

  const tab = await chrome.tabs.create({ url: `${FIXTURE}/sw-page`, active: false });
  await waitForTab(tab.id);
  const raw = await readTabUntil(tab.id, () =>
    document.documentElement.getAttribute('data-nvx-sw')
  );

  await clearRules([RULE_BASE + 30]);
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}

  if (!raw) return { verdict: 'blocked', detail: 'the service worker never reported its fetch' };

  let sent = null;
  try {
    sent = JSON.parse(raw).body?.cookieHeader ?? null;
  } catch {
    return { verdict: 'blocked', detail: `unparseable service worker payload: ${raw}` };
  }

  return sent === marker
    ? {
        verdict: 'pass',
        detail:
          'A tabIds [-1] rule DID attribute service worker traffic. Single-session ownership is viable, so blanket service worker blocking is not required.',
        extra: { sent },
      }
    : {
        verdict: 'fail',
        detail: `tabIds [-1] did not match service worker traffic. Origin received: ${sent}. Blanket blocking stands.`,
        extra: { sent },
      };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Can the debugger attach to a service worker target
 *           |  directly and intercept its requests there?
 *  Note     |  The infobar is per tab, so attaching to a worker
 *           |  target may buy T2 quality interception without the
 *           |  visible cost that makes T2 opt-in.
 * ------------------------------------------------------------------
 */
async function liveDebuggerOnServiceWorker() {
  if (!chrome.debugger) return { verdict: 'absent', detail: 'no chrome.debugger' };

  const marker = `nvx_swdbg=d_${Date.now()}`;
  const tab = await chrome.tabs.create({ url: `${FIXTURE}/sw-page`, active: false });
  await waitForTab(tab.id);
  await new Promise((r) => setTimeout(r, 1500));

  const targets = await chrome.debugger.getTargets();
  const swTarget = targets.find(
    (t) =>
      /sw\.js(\?|$)/.test(t.url) &&
      t.url.includes('localhost:8787') &&
      ['service_worker', 'worker', 'other'].includes(t.type)
  );

  const cleanup = async (dbg) => {
    if (dbg) {
      try {
        await chrome.debugger.detach(dbg);
      } catch {}
    }
    try {
      await chrome.tabs.remove(tab.id);
    } catch {}
  };

  if (!swTarget) {
    await cleanup(null);
    return {
      verdict: 'blocked',
      detail: `no service worker target listed. saw: ${targets
        .map((t) => `${t.type}:${t.url.slice(0, 48)}`)
        .join(' | ')}`,
    };
  }

  const dbg = { targetId: swTarget.id };
  try {
    await chrome.debugger.attach(dbg, '1.3');
  } catch (e) {
    await cleanup(null);
    return { verdict: 'fail', detail: `attach to service worker target refused: ${e.message}` };
  }

  let paused = 0;
  const onEvent = async (source, method, params) => {
    if (source.targetId !== swTarget.id || method !== 'Fetch.requestPaused') return;
    paused++;
    const headers = Object.entries(params.request.headers)
      .filter(([k]) => k.toLowerCase() !== 'cookie')
      .map(([name, value]) => ({ name, value }));
    headers.push({ name: 'Cookie', value: marker });
    try {
      await chrome.debugger.sendCommand(dbg, 'Fetch.continueRequest', {
        requestId: params.requestId,
        headers,
      });
    } catch {}
  };
  chrome.debugger.onEvent.addListener(onEvent);

  let enabled = true;
  try {
    await chrome.debugger.sendCommand(dbg, 'Fetch.enable', {
      patterns: [{ urlPattern: '*' }],
    });
  } catch (e) {
    enabled = false;
  }

  if (enabled) {
    await readTab(tab.id, () => {
      document.documentElement.removeAttribute('data-nvx-sw');
      navigator.serviceWorker.controller?.postMessage('go');
      return true;
    });
    await new Promise((r) => setTimeout(r, 2000));
  }

  const raw = await readTab(tab.id, () =>
    document.documentElement.getAttribute('data-nvx-sw')
  );

  chrome.debugger.onEvent.removeListener(onEvent);
  await cleanup(dbg);

  if (!enabled) {
    return { verdict: 'fail', detail: 'attached to the service worker but Fetch.enable was refused' };
  }

  let sent = null;
  try {
    sent = raw ? JSON.parse(raw).body?.cookieHeader ?? null : null;
  } catch {}

  if (sent === marker) {
    return {
      verdict: 'pass',
      detail: `Attached to the service worker target and rewrote its Cookie header (${paused} request(s) intercepted). Closes the gap without touching any tab.`,
      extra: { sent, paused },
    };
  }
  return {
    verdict: 'fail',
    detail: `Attached and Fetch.enable succeeded (${paused} paused) but the origin received: ${sent}`,
    extra: { sent, paused },
  };
}

const LIVE = {
  cookieSubstitution: liveCookieSubstitution,
  blockingRewrite: liveBlockingRewrite,
  serviceWorkerOwnership: liveServiceWorkerOwnership,
  debuggerOnServiceWorker: liveDebuggerOnServiceWorker,
  stripVersusObserve: liveStripVersusObserve,
  injectionOrder: liveInjectionOrder,
  serviceWorkerAttribution: liveServiceWorkerAttribution,
};

async function runLive(which) {
  const out = [];
  const names = which ? [which] : Object.keys(LIVE);
  for (const n of names) {
    const started = performance.now();
    try {
      const r = await LIVE[n]();
      out.push({ id: n, ...r, ms: Math.round(performance.now() - started) });
    } catch (e) {
      out.push({
        id: n,
        verdict: 'blocked',
        detail: `threw: ${e && e.message ? e.message : String(e)}`,
        ms: Math.round(performance.now() - started),
      });
    }
  }
  return out;
}

async function fixtureUp() {
  try {
    const r = await fetch(`${FIXTURE}/echo`, { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.cmd === 'static') reply(await runStatic());
    else if (msg.cmd === 'live') reply({ results: await runLive(msg.which) });
    else if (msg.cmd === 'fixture') reply({ up: await fixtureUp(), url: FIXTURE });
    else reply({ error: 'unknown command' });
  })();
  return true;
});

const actionApi = chrome.action ?? chrome.browserAction;
actionApi?.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Unattended mode: run every probe and post the report
 *           |  back to the fixture with no clicks.
 *  How      |  Loaded into a throwaway profile by tools/run-probe.mjs
 *           |  there is nobody to click, so it runs itself.
 *  Note     |  Gated on the fixture answering, so a probe loaded by
 *           |  hand into a real browser never phones anywhere.
 * ------------------------------------------------------------------
 */
let autorunDone = false;

async function autorun(trigger) {
  if (autorunDone) return;
  if (!(await fixtureUp())) return;
  autorunDone = true;

  const started = Date.now();
  const staticPart = await runStatic();
  const live = await runLive();

  const payload = {
    trigger,
    env: staticPart.env,
    static: staticPart.results,
    live,
    tookMs: Date.now() - started,
    at: new Date().toISOString(),
  };

  try {
    await fetch(`${FIXTURE}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('nvx probe: could not post report', e);
  }
}

chrome.runtime.onInstalled.addListener(() => autorun('onInstalled'));
chrome.runtime.onStartup?.addListener(() => autorun('onStartup'));
setTimeout(() => autorun('timer'), 1500);
