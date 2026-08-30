/**
 * ------------------------------------------------------------------
 *  Title    |  Blocking webRequest backend
 *  Ref      |  jar/emit.ts, jar/store.ts, dnr.ts, exact.ts
 *  ID       |  M2 (netfilter)
 * ------------------------------------------------------------------
 *  Purpose  |  Rewrite the Cookie header at request time on Manifest
 *           |  V2, reading the jar as the request is made.
 *  How      |  Answers one question when asked, so there is nothing
 *           |  to precompile, flush or leave stale. No rule ceiling,
 *           |  no flush race, and worker traffic is attributable.
 *  Note     |  Costs Manifest V2, so this is the Opera path. Measured
 *           |  on Opera GX 134: a blocking listener really does
 *           |  rewrite the header, where MV3 accepts it and ignores
 *           |  the return value.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import { emit, type EmitOptions } from '../jar/emit.js';
import type { CookieStore } from '../jar/store.js';
import { contextFor } from '../observer/capture.js';

export interface RequestDetails {
  tabId: number;
  url: string;
  type?: string | undefined;
  initiator?: string | undefined;
  /** Present on every real event; the guard is the only thing that reads it. */
  method?: string | undefined;
  requestHeaders?: HttpHeader[] | undefined;
}

export interface HttpHeader {
  name: string;
  value?: string | undefined;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Who owns this request, if anyone.
 *  Note     |  Null means it belongs to no session and is left
 *           |  exactly as the browser built it, keeping unmanaged
 *           |  browsing untouched.
 * ------------------------------------------------------------------
 */
export type Owner = { id: string; store: CookieStore } | null;
export type Resolve = (details: RequestDetails) => Owner;

export interface RewriteResult {
  headers: HttpHeader[];
  sessionId: string;
  /** The header that was installed, empty when the Cookie header was removed. */
  header: string;
}

const COOKIE = 'cookie';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Compute the headers a managed request should carry.
 *  Note     |  Null (unowned) means leave it alone. Distinct from an
 *           |  owned request with an empty jar, whose Cookie header
 *           |  is removed; conflating them lets the profile jar
 *           |  through, the same trap as a missing declarative rule.
 * ------------------------------------------------------------------
 */
export function rewriteHeaders(
  details: RequestDetails,
  resolve: Resolve,
  opts: EmitOptions = {}
): RewriteResult | null {
  const owner = resolve(details);
  if (!owner) return null;

  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }

  const context = contextFor({
    ...(details.type !== undefined ? { type: details.type } : {}),
    url: details.url,
    ...(details.initiator !== undefined ? { initiator: details.initiator } : {}),
  });

  // The method matters: a cross-site POST must not carry SameSite=Lax, and
  // this is one of the two paths that actually knows what the method is.
  const header = emit(owner.store, url, context, {
    ...opts,
    ...(details.method ? { method: details.method } : {}),
  }).header;
  const others = (details.requestHeaders ?? []).filter((h) => h.name.toLowerCase() !== COOKIE);
  const headers = header ? [...others, { name: 'Cookie', value: header }] : others;

  return { headers, sessionId: owner.id, header };
}

export type BlockingListener = (
  details: RequestDetails
) => { requestHeaders?: HttpHeader[]; cancel?: boolean } | undefined;

export interface BlockingApi {
  addListener(fn: BlockingListener, filter: { urls: string[] }, extra: string[]): void;
  removeListener(fn: BlockingListener): void;
}

export interface BlockingOptions extends EmitOptions {
  /** Reports every rewrite, so the same leak accounting applies to both backends. */
  onRewrite?: (result: RewriteResult, details: RequestDetails) => void;
  onError?: (err: unknown, details: RequestDetails) => void;
  /**
   * Refuses a request outright. This is how the blast-radius guard enforces
   * itself on manifest v2, where there are no declarative rules to install; on
   * v3 the same decision is made by a block rule instead.
   *
   * Returning true cancels, and cancelling is a real cancellation here rather
   * than the ignored return value v3 gives a blocking listener.
   */
  veto?: (details: RequestDetails, sessionId: string | null) => boolean;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Present the flush engine's surface so the worker wires
 *           |  either backend without knowing which it has.
 *  Note     |  Every method is a no-op because there is nothing to
 *           |  compile: that is the point.
 * ------------------------------------------------------------------
 */
export class BlockingNetfilter {
  readonly name = 'blocking' as const;
  private listener: BlockingListener | null = null;

  constructor(
    private readonly api: BlockingApi,
    private readonly resolve: Resolve,
    private readonly opts: BlockingOptions = {}
  ) {}

  install(): void {
    if (this.listener) return;
    this.listener = (details) => {
      try {
        const owner = this.resolve(details);
        // Asked before the rewrite, because a refused request has no headers
        // worth computing and the answer must not depend on whether it did.
        if (this.opts.veto?.(details, owner ? owner.id : null)) return { cancel: true };
        const result = rewriteHeaders(details, this.resolve, this.opts);
        if (!result) return undefined;
        this.opts.onRewrite?.(result, details);
        return { requestHeaders: result.headers };
      } catch (err) {
        // A throw here would be a request the browser sends unmodified, which
        // is the profile jar reaching a managed tab. Never silent.
        this.opts.onError?.(err, details);
        return undefined;
      }
    };
    this.api.addListener(
      this.listener,
      { urls: ['http://*/*', 'https://*/*'] },
      // extraHeaders is required or the Cookie header is not visible to modify.
      ['blocking', 'requestHeaders', 'extraHeaders']
    );
  }

  uninstall(): void {
    if (!this.listener) return;
    this.api.removeListener(this.listener);
    this.listener = null;
  }

  // ------------------------------------------------- flush engine surface

  markDirty(_sessions: Iterable<string>): void {
    /* nothing is precompiled, so nothing can be stale */
  }

  async flush(): Promise<void> {
    /* resolves immediately: there is no window to race */
  }

  async retire(_sessionId: string): Promise<void> {
    /* a deleted session simply stops resolving */
  }

  get pending(): number {
    return 0;
  }
}

/** Adapts the live browser API to the injectable surface used above. */
export function browserBlockingApi(): BlockingApi | null {
  const wr = chrome.webRequest as unknown as {
    onBeforeSendHeaders?: {
      addListener: (...args: unknown[]) => void;
      removeListener: (...args: unknown[]) => void;
    };
  };
  if (!wr?.onBeforeSendHeaders) return null;
  return {
    addListener: (fn, filter, extra) =>
      wr.onBeforeSendHeaders!.addListener(fn as unknown, filter, extra),
    removeListener: (fn) => wr.onBeforeSendHeaders!.removeListener(fn as unknown),
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether this browser honours a blocking listener's
 *           |  return value.
 *  Note     |  Measured, not feature-detected: Chrome and Opera under
 *           |  MV3 accept the listener then ignore it, so the API
 *           |  proves nothing. Manifest version is the honest signal.
 * ------------------------------------------------------------------
 */
export function blockingIsReal(): boolean {
  try {
    return chrome.runtime.getManifest().manifest_version === 2;
  } catch {
    return false;
  }
}
