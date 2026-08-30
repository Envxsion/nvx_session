/**
 * The two manifest versions, behind one surface.
 *
 * NVX ships MV3 everywhere and MV2 on Opera as an opt-in maximum-isolation
 * mode, and the differences are not cosmetic: MV2 has no chrome.scripting, no
 * chrome.action, no tabGroups, and no dynamic content script registration. It
 * also has a persistent background page, which removes the entire class of
 * lifecycle problems the MV3 build is built around.
 *
 * Everything version-specific lives here so the kernel never asks which
 * manifest it is running under.
 */

export type ManifestVersion = 2 | 3;

export function manifestVersion(): ManifestVersion {
  try {
    return chrome.runtime.getManifest().manifest_version === 2 ? 2 : 3;
  } catch {
    return 3;
  }
}

/** MV2 calls it browserAction; everything on it is otherwise identical. */
export interface ClickableAction {
  onClicked: { addListener(fn: () => void): void };
}

export function actionApi(): ClickableAction | null {
  const scope = chrome as unknown as {
    action?: ClickableAction;
    browserAction?: ClickableAction;
  };
  return scope.action?.onClicked ? scope.action : (scope.browserAction ?? null);
}

/**
 * The same toolbar button, for the parts of it that are not the click.
 *
 * Separate from `actionApi` only because that one is typed around `onClicked`
 * and a caller wanting the badge should not have to know which of the two names
 * this browser uses either. Both resolve the same object; having two functions
 * that each rediscover it was how a second copy of this appeared in the worker.
 */
export interface BadgeableAction {
  setBadgeText(details: { text: string }): void;
  setBadgeBackgroundColor(details: { color: string }): void;
  setTitle(details: { title: string }): void;
}

export function badgeApi(): BadgeableAction | null {
  const scope = chrome as unknown as {
    action?: BadgeableAction;
    browserAction?: BadgeableAction;
  };
  const api = scope.action ?? scope.browserAction;
  return api && typeof api.setBadgeText === 'function' ? api : null;
}

/**
 * Injects the page agent into a tab that does not already have one.
 *
 * Deliberately two named operations rather than a general "run this code"
 * shim. MV2's tabs.executeScript takes a string, and exposing that as a
 * primitive would put an eval-shaped hole through the extension for the sake
 * of tidiness.
 */
export async function injectAgent(tabId: number, file: string): Promise<boolean> {
  try {
    if (manifestVersion() === 3) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file], world: 'ISOLATED' });
      return true;
    }
    const tabs = chrome.tabs as unknown as {
      executeScript(tabId: number, opts: { file: string; runAt?: string }): Promise<unknown[]>;
    };
    await tabs.executeScript(tabId, { file, runAt: 'document_idle' });
    return true;
  } catch {
    return false;
  }
}

/** Reads a tab's rendered text. Used only by the in-browser isolation suite. */
export async function readBodyText(tabId: number): Promise<string> {
  if (manifestVersion() === 3) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body?.innerText ?? '',
    });
    return typeof r?.result === 'string' ? r.result : '';
  }
  const tabs = chrome.tabs as unknown as {
    executeScript(tabId: number, opts: { code: string }): Promise<unknown[]>;
  };
  const out = await tabs.executeScript(tabId, {
    code: 'document.body && document.body.innerText || ""',
  });
  return typeof out?.[0] === 'string' ? out[0] : '';
}

export interface PageFetch {
  ok: boolean;
  status: number;
  error: string | null;
}

/**
 * Issues a request from inside a tab, and reports what the page saw.
 *
 * Used only by the guard suite, and only because a refusal has to be observed
 * the way a page observes it: a blocked request rejects rather than returning
 * a status, and asserting on that from the worker would prove nothing.
 *
 * The two manifests need genuinely different mechanics. v3 awaits a promise
 * returned from an injected function; v2's executeScript takes a code string
 * and does not await anything, so the result is parked on the content script's
 * own window and polled for. Both attribute the request to the tab, which is
 * what makes the guard's tab-scoped rules apply to it.
 */
export async function fetchInPage(
  tabId: number,
  url: string,
  method: string
): Promise<PageFetch> {
  const failed = (e: unknown): PageFetch => ({
    ok: false,
    status: 0,
    error: e instanceof Error ? e.message : String(e),
  });

  if (manifestVersion() === 3) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (u: string, m: string) => {
          try {
            const res = await fetch(u, { method: m, cache: 'no-store' });
            return { ok: res.ok, status: res.status, error: null };
          } catch (e) {
            return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
          }
        },
        args: [url, method],
      });
      return (r?.result as PageFetch) ?? { ok: false, status: 0, error: 'no result' };
    } catch (e) {
      return failed(e);
    }
  }

  const tabs = chrome.tabs as unknown as {
    executeScript(tabId: number, opts: { code: string }): Promise<unknown[]>;
  };
  const slot = '__nvxPageFetch';
  const call = `fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},cache:'no-store'})`;
  try {
    await tabs.executeScript(tabId, {
      code: `(function(){window.${slot}=null;${call}.then(function(r){window.${slot}={ok:r.ok,status:r.status,error:null}},function(e){window.${slot}={ok:false,status:0,error:String(e&&e.message||e)}})})()`,
    });
    for (let i = 0; i < 60; i++) {
      const out = await tabs.executeScript(tabId, { code: `window.${slot}` });
      const value = out?.[0] as PageFetch | null | undefined;
      if (value) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, status: 0, error: 'the page never answered' };
  } catch (e) {
    return failed(e);
  }
}

/**
 * Whether the agent can be scoped to the hosts a session actually cares about.
 *
 * MV3 registers content scripts dynamically, so the agent runs only where a
 * session reaches, which keeps the worker asleep the rest of the time. MV2 has
 * no such API: the agent is declared in the manifest and runs everywhere. That
 * is more exposure, but MV2's background page is persistent anyway, so the
 * keepalive half of the argument disappears with it.
 */
export function canScopeAgent(): boolean {
  return manifestVersion() === 3 && Boolean(chrome.scripting?.registerContentScripts);
}
