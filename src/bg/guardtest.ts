/**
 * ------------------------------------------------------------------
 *  Title    |  Blast-radius proof
 *  Ref      |  guard/guard.ts, guard/policy.ts
 *  ID       |  test (guard)
 * ------------------------------------------------------------------
 *  Purpose  |  Runnable inside the browser: a session marked production
 *           |  refuses a destructive request and lets everything else
 *           |  through, so both halves are measured from a real page.
 *  Note     |  Shoots at the fixture, not a real delete endpoint. A
 *           |  /destroy path on any host is destructive under the generic
 *           |  catalog rules, so the guard is proved with nothing at risk.
 *  Author   |  Ojas Kekre, 17/08/2026
 * ------------------------------------------------------------------
 */

import { CookieStore } from '../jar/store.js';
import type { Registry } from '../kernel/registry.js';
import type { Netfilter } from '../netfilter/types.js';
import type { Guard } from '../guard/guard.js';
import { DEFAULT_DANGER, type Danger } from '../guard/policy.js';
import { fetchInPage } from '../platform.js';
import type { Check } from './selftest.js';

export interface GuardTestResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

const S = '__nvx_guardtest';

async function loaded(tabId: number, url: string): Promise<void> {
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
}

export async function runGuardTest(
  registry: Registry,
  engine: Netfilter,
  guard: Guard,
  opts: { fixture?: string } = {}
): Promise<GuardTestResult> {
  const fixture = opts.fixture ?? 'http://localhost:8787';
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
    registry.deleteSession(S);
    await engine.retire(S);
    await guard.retire(S);
  };

  const setDanger = async (danger: Danger) => {
    const session = registry.getSession(S);
    if (session) session.danger = danger;
    guard.markDirty([S]);
    await guard.flush();
    // Rules are installed asynchronously by the browser after the call
    // resolves, and a request that outruns them measures nothing.
    await new Promise((r) => setTimeout(r, 400));
  };

  try {
    const probe = await fetch(`${fixture}/echo`, { cache: 'no-store' }).catch(() => null);
    if (!probe?.ok) {
      return {
        ok: false,
        checks: [],
        error: `The fixture origin at ${fixture} is not answering. Start it with: node tools/fixture/server.mjs`,
      };
    }

    registry.createSession({
      id: S,
      label: 'guardtest',
      color: 'coral',
      pinned: ['localhost'],
      store: new CookieStore(),
      family: [],
      forked: [],
      danger: DEFAULT_DANGER,
      thirdParty: 'allow',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });

    const win = await chrome.windows.getCurrent();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
    tabs.push(tab.id!);
    const m = registry.bind(tab.id!, S, {
      windowId: win.id ?? -1,
      url: `${fixture}/page`,
      origin: 'manual',
    });
    engine.markDirty(m.dirty);
    await engine.flush();
    await loaded(tab.id!, `${fixture}/page?guard=1`);

    const destroy = `${fixture}/danger/proj_1/destroy`;
    const read = `${fixture}/danger/proj_1`;

    // Warn. Nothing is stopped, and the trail records it.
    await setDanger('warn');
    const warned = await fetchInPage(tab.id!, destroy, 'DELETE');
    add('a warned session is not stopped', warned.ok, warned.error ?? `status ${warned.status}`);

    const afterWarn = guard.audit.forSession(S);
    add(
      'the warning is recorded against the session',
      afterWarn.some((e) => e.action === 'warned' && e.url === destroy),
      afterWarn.map((e) => `${e.action}:${e.rule}`).join(' ') || 'nothing recorded'
    );
    add(
      'and it names what would have happened',
      afterWarn.some((e) => e.what.includes('destroy')),
      afterWarn[0]?.what ?? ''
    );

    // Block. The request must not reach the origin.
    await setDanger('block');
    // One assertion for both backends on purpose. A declarative block rule and
    // a cancelled blocking listener are entirely different mechanisms and the
    // page cannot tell them apart, which is exactly the property worth holding.
    const blocked = await fetchInPage(tab.id!, destroy, 'DELETE');
    add(
      'a production session refuses the request',
      !blocked.ok,
      blocked.error ?? `status ${blocked.status}`
    );

    const ordinary = await fetchInPage(tab.id!, read, 'GET');
    add('and lets ordinary traffic through untouched', ordinary.ok, `status ${ordinary.status}`);

    const harmless = await fetchInPage(tab.id!, read, 'POST');
    add(
      'a write that is not destructive is not refused',
      harmless.ok,
      harmless.error ?? `status ${harmless.status}`
    );

    // The way past it, which is what stops the whole feature being switched off.
    guard.unlock(S, 'generic.destroy.path');
    await guard.flush();
    await new Promise((r) => setTimeout(r, 400));
    const allowed = await fetchInPage(tab.id!, destroy, 'DELETE');
    add('an unlocked endpoint goes through', allowed.ok, allowed.error ?? `status ${allowed.status}`);
    add(
      'and the allowance is still recorded rather than being a blind spot',
      guard.audit.forSession(S).some((e) => e.action === 'warned' && e.url === destroy)
    );

    // Off. The trail continues either way, because a session nobody is guarding
    // is exactly the one somebody will ask questions about later.
    await setDanger('off');
    const off = await fetchInPage(tab.id!, destroy, 'DELETE');
    add('turning the guard off stops refusing', off.ok, off.error ?? `status ${off.status}`);
    add(
      'and still writes the trail',
      guard.audit.forSession(S).some((e) => e.action === 'logged')
    );

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    return { ok: false, checks, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await cleanup();
  }
}
