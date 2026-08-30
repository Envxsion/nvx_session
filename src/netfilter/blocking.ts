/**
 * The blocking webRequest backend.
 *
 * This is the other half of the isolation story, and it is a fundamentally
 * different shape from the declarative one. Instead of compiling a session's
 * jar into rules and racing to install them before the next request, it answers
 * one question at the moment it is asked: what Cookie header should this
 * request carry? The jar is read at request time, so there is nothing to
 * precompile, nothing to flush, and nothing to be stale.
 *
 * Three problems the declarative backend lives with simply do not exist here.
 *
 * The rule ceiling is gone: a session can hold cookies for ten thousand hosts
 * and cost nothing, where declarative rules are capped at 192 per session and
 * overflow silently drops hosts.
 *
 * The flush race is gone: a navigation cannot outrun a rule set that is never
 * installed. §14's whole "await the flush before releasing the navigation"
 * dance is unnecessary.
 *
 * And the service worker gap closes: worker traffic arrives with tabId -1 like
 * everything else, but here the answer can consult who actually owns that
 * origin rather than relying on a rule that had to be compiled in advance for a
 * request nobody could attribute.
 *
 * What it costs is Manifest V2, which is why this is the Opera path and not the
 * default. Measured on Opera GX 134: a blocking listener really does rewrite
 * the Cookie header, where both browsers under MV3 accept the listener and then
 * ignore what it returns.
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
 * Who owns this request, if anyone. Returning null means the request belongs to
 * no session and must be left exactly as the browser built it, which is what
 * keeps unmanaged browsing untouched.
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
 * Computes the headers a managed request should carry.
 *
 * Returns null for anything unowned, which the listener turns into "leave this
 * request alone". Note the difference between that and an owned request with an
 * empty jar: the first is untouched, the second has its Cookie header removed.
 * Conflating them is the mistake that lets the profile jar through, and it is
 * the same trap the declarative compiler has with a missing rule.
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
 * Presents the same surface the flush engine does, so the worker wires either
 * backend without knowing which it has. Every method is a no-op because there
 * is nothing to compile: that is the point.
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
 * Whether this browser will honour what a blocking listener returns.
 *
 * Measured, not feature-detected: both Chrome and Opera under MV3 accept the
 * listener and the 'blocking' option and then ignore the return value, so the
 * presence of the API proves nothing. Manifest version is the honest signal.
 */
export function blockingIsReal(): boolean {
  try {
    return chrome.runtime.getManifest().manifest_version === 2;
  } catch {
    return false;
  }
}
