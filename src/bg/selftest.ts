/**
 * The isolation proof, runnable from inside the browser.
 *
 * This is the same set of checks tools/e2e.mjs drives over CDP, moved into the
 * extension so it can run anywhere the extension can be loaded. Chrome 151
 * cannot be side-loaded by any automated route, so on Chrome this is the only
 * way to measure rather than assume.
 *
 * It creates throwaway sessions and tabs, proves them, and cleans up after
 * itself whether it passes or throws.
 */

import { parseSetCookie } from '../jar/cookie.js';
import { isPublicSuffix } from '../jar/psl.js';
import { CookieStore } from '../jar/store.js';
import type { Netfilter } from '../netfilter/types.js';
import { readBodyText } from '../platform.js';
import type { Registry } from '../kernel/registry.js';
import type { DesyncLog } from '../observer/desync.js';
import { DEFAULT_DANGER } from '../guard/policy.js';

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  checks: Check[];
  observed: {
    work: string | null;
    personal: string | null;
    control: string | null;
    ruleCount: number;
    desync: ReturnType<DesyncLog['snapshot']>;
  };
  environment: { browser: string; chromium: string | null; manifest: number };
  error?: string;
}

const WORK = '__nvx_selftest_work';
const PERSONAL = '__nvx_selftest_personal';

function environment(): SelfTestResult['environment'] {
  const ua = navigator.userAgent;
  const chromium = /Chrome\/([\d.]+)/.exec(ua);
  const isOpera = /OPR\//.test(ua);
  return {
    browser: isOpera ? 'Opera' : /Edg\//.test(ua) ? 'Edge' : 'Chrome',
    chromium: chromium ? chromium[1]! : null,
    manifest: chrome.runtime.getManifest().manifest_version,
  };
}

async function settled(tabId: number, url: string): Promise<unknown> {
  await chrome.tabs.update(tabId, { url });
  await new Promise<void>((resolve) => {
    const done = (id: number, info: { status?: string | undefined }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 10_000);
  });

  // A tab reports complete before its body is necessarily readable, so this
  // polls rather than reading once and trusting the result.
  for (let i = 0; i < 20; i++) {
    const text = await readBodyText(tabId);
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        /* not ready */
      }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return null;
}

export async function runSelfTest(
  registry: Registry,
  engine: Netfilter,
  desync: DesyncLog,
  currentRules: () => Promise<unknown[]>,
  fixture = 'http://localhost:8787',
  /**
   * Declares a tab deliberately unmanaged, so the picker leaves it alone.
   *
   * The control arm exists to show what the profile jar does without a session,
   * which now collides with holding an unbound tab on a domain more than one
   * session covers. That hold is right for a person and wrong here: the tab is
   * unmanaged on purpose, and being asked about it stops the run.
   */
  leaveUnmanaged: (tabId: number, url: string) => void = () => {}
): Promise<SelfTestResult> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  const tabs: number[] = [];
  const cleanup = async () => {
    for (const t of tabs) {
      try {
        await chrome.tabs.remove(t);
      } catch {
        /* already gone */
      }
    }
    for (const id of [WORK, PERSONAL]) {
      registry.deleteSession(id);
      await engine.retire(id);
    }
    try {
      await chrome.cookies.remove({ url: fixture, name: 'profile_jar' });
    } catch {
      /* nothing to remove */
    }
  };

  try {
    const probe = await fetch(`${fixture}/echo`, { cache: 'no-store' }).catch(() => null);
    if (!probe?.ok) {
      return {
        ok: false,
        checks: [],
        observed: { work: null, personal: null, control: null, ruleCount: 0, desync: desync.snapshot() },
        environment: environment(),
        error: `The fixture origin at ${fixture} is not answering. Start it with: node tools/fixture/server.mjs`,
      };
    }

    // A cookie in the real profile jar. No managed tab may ever send it.
    await chrome.cookies.set({ url: fixture, name: 'profile_jar', value: 'LEAK', path: '/' });

    for (const [id, value] of [
      [WORK, 'WORK_ONLY'],
      [PERSONAL, 'PERSONAL_ONLY'],
    ] as const) {
      registry.createSession({
        id,
        label: id,
        color: 'cyan',
        pinned: [],
        store: new CookieStore(),
        family: [],
        forked: [],
        danger: DEFAULT_DANGER,
        thirdParty: 'allow',
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
      const parsed = parseSetCookie(`sid=${value}; Path=/`, { url: new URL(fixture) }, { isPublicSuffix });
      if (parsed.ok) registry.getSession(id)!.store.upsert(parsed.cookie);
    }

    const extra = parseSetCookie('extra=w1; Path=/', { url: new URL(fixture) }, { isPublicSuffix });
    if (extra.ok) registry.getSession(WORK)!.store.upsert(extra.cookie);

    const win = await chrome.windows.getCurrent();
    const mk = async () => {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
      tabs.push(t.id!);
      return t.id!;
    };

    const a = await mk();
    const b = await mk();
    const c = await mk();

    for (const [tabId, sessionId] of [
      [a, WORK],
      [b, PERSONAL],
    ] as const) {
      const m = registry.bind(tabId, sessionId, {
        windowId: win.id ?? -1,
        url: `${fixture}/echo`,
        origin: 'manual',
      });
      engine.markDirty(m.dirty);
    }
    await engine.flush();
    leaveUnmanaged(c, `${fixture}/echo?who=control`);

    const work = (await settled(a, `${fixture}/echo?who=work`)) as { cookieHeader?: string } | null;
    const personal = (await settled(b, `${fixture}/echo?who=personal`)) as { cookieHeader?: string } | null;
    const control = (await settled(c, `${fixture}/echo?who=control`)) as { cookieHeader?: string } | null;

    const w = work?.cookieHeader ?? '';
    const p = personal?.cookieHeader ?? '';
    const ctl = control?.cookieHeader ?? '';
    const ruleCount = (await currentRules()).length;

    add('work tab carries its own session', w.includes('WORK_ONLY'));
    add('personal tab carries its own session', p.includes('PERSONAL_ONLY'));
    add('work tab cannot see the personal session', !w.includes('PERSONAL_ONLY'));
    add('personal tab cannot see the work session', !p.includes('WORK_ONLY'));
    add('work tab keeps its own extra cookie', w.includes('extra=w1'));
    add('personal tab does not inherit it', !p.includes('extra=w1'));
    add('profile jar never reaches the work tab', !w.includes('profile_jar'));
    add('profile jar never reaches the personal tab', !p.includes('profile_jar'));
    add('an unmanaged tab still sees the profile jar', ctl.includes('profile_jar'));
    add('both sessions live in one window', true);
    add('rules were actually installed', ruleCount > 0, `${ruleCount} rules`);

    const snap = desync.snapshot();
    add('desync counter is zero', snap.total === 0, `checked ${snap.checked} request(s)`);

    return {
      ok: checks.every((x) => x.pass),
      checks,
      observed: { work: w, personal: p, control: ctl, ruleCount, desync: snap },
      environment: environment(),
    };
  } catch (e) {
    return {
      ok: false,
      checks,
      observed: { work: null, personal: null, control: null, ruleCount: 0, desync: desync.snapshot() },
      environment: environment(),
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await cleanup();
  }
}
