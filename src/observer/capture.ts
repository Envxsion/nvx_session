/**
 * Capturing Set-Cookie without letting it reach the profile jar.
 *
 * Confirmed by the M0 probe on both Chrome 151 and Opera 134: a non-blocking
 * onHeadersReceived listener with extraHeaders still sees Set-Cookie even when
 * a rule removes it from the response. So capture and suppress can both run,
 * and the reconcile fallback in Spike 1 is not needed.
 */

import { parseSetCookie, type Cookie, type ParseFailure } from '../jar/cookie.js';
import { isPublicSuffix, registrableDomain } from '../jar/psl.js';
import type { EmitContext } from '../jar/emit.js';

export interface HeaderPair {
  name: string;
  value?: string;
}

export interface CaptureInput {
  url: string;
  statusCode?: number;
  responseHeaders?: HeaderPair[];
  now?: number;
}

export interface CaptureResult {
  cookies: Cookie[];
  /** Rejections, grouped by reason. A jar that quietly drops cookies looks
   *  exactly like a site that logged you out, so these are counted. */
  rejected: { reason: ParseFailure; header: string }[];
  /** Registrable domains touched, for the netfilter dirty set. */
  domains: string[];
}

const EMPTY: CaptureResult = Object.freeze({ cookies: [], rejected: [], domains: [] });

/**
 * Only http and https carry cookies. Skipping everything else early keeps the
 * observer off the hot path for extension pages, data URLs and blobs.
 */
export function capturable(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

export function captureSetCookie(input: CaptureInput): CaptureResult {
  if (!capturable(input.url)) return EMPTY;

  const headers = input.responseHeaders;
  // Undefined rather than empty means extraHeaders was not granted, which is a
  // configuration fault rather than a response without cookies. The caller
  // distinguishes them; here both simply yield nothing.
  if (!headers || headers.length === 0) return EMPTY;

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return EMPTY;
  }

  const now = input.now ?? Date.now();
  const cookies: Cookie[] = [];
  const rejected: { reason: ParseFailure; header: string }[] = [];
  const domains = new Set<string>();

  for (const h of headers) {
    if (h.name.toLowerCase() !== 'set-cookie') continue;
    const raw = h.value;
    if (!raw) continue;

    // Chrome delivers one header entry per Set-Cookie, but a misbehaving
    // server or proxy can fold several into one entry separated by newlines.
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseSetCookie(line, { url, now }, { isPublicSuffix, now });
      if (parsed.ok) {
        cookies.push(parsed.cookie);
        domains.add(registrableDomain(parsed.cookie.domain));
      } else {
        rejected.push({ reason: parsed.reason, header: truncate(line) });
      }
    }
  }

  return { cookies, rejected, domains: [...domains] };
}

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * Which emission context a request belongs to, derived from what webRequest
 * reports. This has to agree with the rule variant the compiler produced for
 * the same request, or desync detection reports phantom mismatches.
 */
export function contextFor(details: {
  type?: string;
  url: string;
  initiator?: string | undefined;
}): EmitContext {
  const initiator = details.initiator;

  /**
   * A top level navigation is only 'top-level' when it is also cross-site.
   *
   * A same-site navigation, including a form POST to your own origin, carries
   * everything the browser would carry on any same-site request, so it is
   * first-party. Collapsing the two used to be harmless because the eligibility
   * rules agreed for GET; they no longer do, because a cross-site POST must not
   * carry SameSite=Lax and a same-site POST must.
   */
  if (details.type === 'main_frame') {
    if (!initiator || initiator === 'null') return 'top-level';
    try {
      const a = registrableDomain(new URL(initiator).hostname);
      const b = registrableDomain(new URL(details.url).hostname);
      return a === b ? 'first-party' : 'top-level';
    } catch {
      return 'top-level';
    }
  }

  // A browser-initiated subresource has no initiator. Treating it as first
  // party matches how the browser scopes SameSite in that case.
  if (!initiator || initiator === 'null') return 'first-party';

  try {
    const a = registrableDomain(new URL(initiator).hostname);
    const b = registrableDomain(new URL(details.url).hostname);
    return a === b ? 'first-party' : 'third-party';
  } catch {
    return 'first-party';
  }
}
