/**
 * Exact per-request cookie rewriting, through the debugger.
 *
 * Why this exists, stated plainly, because it costs a visible infobar and that
 * has to be worth something.
 *
 * The declarative backend compiles a session's jar into rules and installs
 * them. Installing takes time. An origin that sets a cookie in a 303 and
 * redirects immediately gives us no time at all, so the next hop in the chain
 * leaves carrying the previous rule's header. On a federated sign-in every hop
 * is a redirect, so we lose every hop, and the site bounces you back to the
 * identity provider forever. Measured on a real Moodle behind Okta: 287 stale
 * headers out of 2009 requests, and an infinite loop.
 *
 * No amount of tuning fixes that. `onHeadersReceived` cannot block under
 * manifest v3, so there is no point at which we can hold the redirect until the
 * rules catch up. The only mechanism that sees a request late enough to know
 * the jar's current contents and early enough to change what goes on the wire
 * is `Fetch.requestPaused`.
 *
 * So the jar is read at the moment the request is paused, exactly like the
 * blocking backend does on manifest v2, and there is nothing left to go stale.
 * `rewriteHeaders` is shared with that backend rather than reimplemented, so
 * all three paths cannot disagree about what a session should send.
 */

import { rewriteHeaders, type Owner, type RequestDetails, type Resolve } from './blocking.js';
import type { EmitOptions } from '../jar/emit.js';

export interface DebuggerTarget {
  tabId: number;
}

/** The slice of chrome.debugger this needs, injectable so it can be tested. */
export interface DebuggerApi {
  attach(target: DebuggerTarget, version: string): Promise<void>;
  detach(target: DebuggerTarget): Promise<void>;
  send(
    target: DebuggerTarget,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown>;
  onEvent(
    fn: (source: DebuggerTarget, method: string, params?: Record<string, unknown>) => void
  ): void;
  onDetach(fn: (source: DebuggerTarget, reason: string) => void): void;
}

export function browserDebuggerApi(): DebuggerApi | null {
  const dbg = (chrome as unknown as { debugger?: typeof chrome.debugger }).debugger;
  if (!dbg?.attach) return null;
  return {
    attach: (target, version) => dbg.attach(target, version),
    detach: (target) => dbg.detach(target),
    send: (target, method, params) =>
      dbg.sendCommand(target, method, params) as Promise<unknown>,
    onEvent: (fn) =>
      dbg.onEvent.addListener((source, method, params) => {
        if (typeof source.tabId === 'number') {
          fn({ tabId: source.tabId }, method, params as Record<string, unknown>);
        }
      }),
    onDetach: (fn) =>
      dbg.onDetach.addListener((source, reason) => {
        if (typeof source.tabId === 'number') fn({ tabId: source.tabId }, String(reason));
      }),
  };
}

/** The CDP protocol version to speak. 1.3 is the stable one. */
const PROTOCOL = '1.3';

interface PausedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface Paused {
  requestId: string;
  request: PausedRequest;
  resourceType?: string;
  frameId?: string;
}

/**
 * Turns a paused CDP request into the shape the shared rewriter expects.
 *
 * The interesting part is the context, because it decides which SameSite
 * cookies are eligible and getting it wrong silently changes what a session
 * sends.
 *
 * Measured, after getting it wrong: at `requestStage: 'Request'` the paused
 * request has **no `Sec-Fetch-*` headers at all**. They are added later, by the
 * network service, well after CDP hands the request over. Any scheme that reads
 * them here silently falls through to its default on every single request, and
 * the default was the lenient one.
 *
 * What is present is `resourceType`, and `Origin` or `Referer` on anything that
 * has one. So a `Document` request is a navigation, and same-site-ness comes
 * from the initiator, which is what the rest of the kernel already uses.
 */
export function detailsFor(tabId: number, paused: Paused): RequestDetails {
  const headers = paused.request.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  let initiator: string | undefined;
  if (lower['origin'] && lower['origin'] !== 'null') initiator = lower['origin'];
  else if (lower['referer']) {
    try {
      initiator = new URL(lower['referer']).origin;
    } catch {
      initiator = undefined;
    }
  }

  return {
    tabId,
    url: paused.request.url,
    method: paused.request.method,
    type: cdpType(paused.resourceType),
    ...(initiator ? { initiator } : {}),
    requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  };
}

/** CDP resource types to the webRequest names the rest of the kernel speaks. */
function cdpType(resourceType?: string): string {
  switch (resourceType) {
    // A navigation. CDP does not separate the top frame from a subframe here,
    // and calling it a navigation is what lets the initiator comparison decide
    // same-site-ness, which is the question that actually matters for SameSite.
    case 'Document':
      return 'main_frame';
    case 'Stylesheet':
      return 'stylesheet';
    case 'Image':
      return 'image';
    case 'Font':
      return 'font';
    case 'Script':
      return 'script';
    case 'XHR':
    case 'Fetch':
      return 'xmlhttprequest';
    case 'WebSocket':
      return 'websocket';
    case 'Media':
      return 'media';
    case 'Ping':
      return 'ping';
    default:
      return 'other';
  }
}

export interface ExactOptions extends EmitOptions {
  onRewrite?: (sessionId: string, url: string, header: string) => void;
  onError?: (err: unknown, where: string) => void;
  /** Told when a tab loses interception for any reason other than us asking. */
  onLost?: (tabId: number, reason: string) => void;
}

export interface EngageResult {
  ok: boolean;
  reason?: string;
}

/**
 * Attaches to a tab and rewrites its Cookie header per request.
 *
 * Every paused request must be continued. A throw that skips the continue does
 * not fail one request, it hangs the tab, which is worse than any staleness, so
 * the handler continues unmodified rather than propagating anything.
 */
export interface PausedTrace {
  url: string;
  method: string;
  type: string;
  initiator: string | null;
  header: string;
  /** The Sec-Fetch-* trio, which is what the context is decided from. */
  fetchSite: string | null;
  fetchMode: string | null;
  fetchDest: string | null;
}

const TRACE_CAP = 24;

export class ExactInterceptor {
  private readonly live = new Map<number, { patterns: string[] }>();
  /**
   * The last few decisions, kept for the suites. Reasoning about what CDP puts
   * in a paused request is how this got the SameSite context wrong once
   * already; reading it back is cheaper and does not lie.
   */
  private readonly trace: PausedTrace[] = [];
  /** Tabs an attach is in flight for, so two events cannot race one attach. */
  private readonly attaching = new Map<number, Promise<EngageResult>>();

  constructor(
    private readonly api: DebuggerApi,
    private readonly resolve: Resolve,
    private readonly opts: ExactOptions = {}
  ) {
    this.api.onEvent((source, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      void this.onPaused(source.tabId, params as unknown as Paused);
    });
    this.api.onDetach((source, reason) => {
      if (!this.live.delete(source.tabId)) return;
      // Not our doing: devtools opened, the user dismissed the bar, the tab
      // crashed. The caller has to put the declarative rules back.
      this.opts.onLost?.(source.tabId, reason);
    });
  }

  recent(n = TRACE_CAP): PausedTrace[] {
    return this.trace.slice(-n);
  }

  isLive(tabId: number): boolean {
    return this.live.has(tabId);
  }

  liveTabs(): number[] {
    return [...this.live.keys()];
  }

  /**
   * Which URLs to pause. Scoped to the hosts the session actually has an
   * opinion about, because pausing every image on the page adds a round trip
   * per subresource for no benefit.
   */
  static patternsFor(domains: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const d of domains) {
      const host = d.trim().toLowerCase();
      if (!host || host.includes('/') || host.includes('*')) continue;
      out.add(`*://${host}/*`);
      // The leading dot is what stops this matching evil-example.com.
      out.add(`*://*.${host}/*`);
      // A pattern is matched against the whole URL, and a URL with a port has
      // the port where this expects the path. Without these the fixture, which
      // lives on localhost:8787, is never intercepted at all, and the suite
      // would report the feature working while it did nothing.
      out.add(`*://${host}:*/*`);
      out.add(`*://*.${host}:*/*`);
    }
    return [...out].sort();
  }

  async engage(tabId: number, domains: Iterable<string>): Promise<EngageResult> {
    const patterns = ExactInterceptor.patternsFor(domains);
    if (!patterns.length) return { ok: false, reason: 'no hosts to watch' };

    const existing = this.live.get(tabId);
    if (existing) {
      if (existing.patterns.join('\n') === patterns.join('\n')) return { ok: true };
      // The jar grew a host. Re-enabling replaces the pattern set in place,
      // which is cheaper and less visible than detaching and attaching again.
      return this.enable(tabId, patterns);
    }

    const inFlight = this.attaching.get(tabId);
    if (inFlight) return inFlight;

    const run = (async (): Promise<EngageResult> => {
      try {
        await this.api.attach({ tabId }, PROTOCOL);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // Another debugger already owns this tab, which is devtools nine times
        // out of ten. Not an error, just a tab that keeps the rules instead.
        return { ok: false, reason };
      }
      return this.enable(tabId, patterns);
    })();

    this.attaching.set(tabId, run);
    try {
      return await run;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  private async enable(tabId: number, patterns: string[]): Promise<EngageResult> {
    try {
      await this.api.send({ tabId }, 'Fetch.enable', {
        patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })),
      });
      this.live.set(tabId, { patterns });
      return { ok: true };
    } catch (e) {
      this.live.delete(tabId);
      try {
        await this.api.detach({ tabId });
      } catch {
        /* it was never really attached */
      }
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async release(tabId: number): Promise<void> {
    if (!this.live.delete(tabId)) return;
    try {
      await this.api.send({ tabId }, 'Fetch.disable');
    } catch {
      /* the tab is already gone */
    }
    try {
      await this.api.detach({ tabId });
    } catch {
      /* likewise */
    }
  }

  async releaseAll(): Promise<void> {
    for (const tabId of [...this.live.keys()]) await this.release(tabId);
  }

  private async onPaused(tabId: number, paused: Paused): Promise<void> {
    if (!paused?.requestId) return;
    const requestId = paused.requestId;

    let headers: Array<{ name: string; value?: string | undefined }> | null = null;
    try {
      const details = detailsFor(tabId, paused);
      const result = rewriteHeaders(details, this.resolve, this.opts);
      if (result) {
        headers = result.headers;
        this.opts.onRewrite?.(result.sessionId, details.url, result.header);
      }
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(paused.request.headers ?? {})) {
        lower[k.toLowerCase()] = v;
      }
      this.trace.push({
        url: details.url,
        method: details.method ?? '',
        type: details.type ?? '',
        initiator: details.initiator ?? null,
        header: result?.header ?? '(untouched)',
        fetchSite: lower['sec-fetch-site'] ?? null,
        fetchMode: lower['sec-fetch-mode'] ?? null,
        fetchDest: lower['sec-fetch-dest'] ?? null,
      });
      if (this.trace.length > TRACE_CAP) this.trace.splice(0, this.trace.length - TRACE_CAP);
    } catch (e) {
      this.opts.onError?.(e, 'rewrite');
    }

    try {
      await this.api.send({ tabId }, 'Fetch.continueRequest', {
        requestId,
        ...(headers
          ? {
              headers: headers
                .filter((h) => h.value !== undefined)
                .map((h) => ({ name: h.name, value: String(h.value) })),
            }
          : {}),
      });
    } catch (e) {
      // The request may have been cancelled, or the tab navigated away. Nothing
      // to recover, but never silent: a continue that does not land is a tab
      // that hangs, and that has to be visible if it ever happens.
      this.opts.onError?.(e, 'continue');
    }
  }
}

export type { Owner, Resolve };
