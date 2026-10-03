/**
 * ------------------------------------------------------------------
 *  Title    |  Cross-browser helpers
 *  Ref      |  platform.ts (isGecko, initiatorOf, portableScripts),
 *           |  netfilter/compile.ts (responseStripHeaders)
 *  ID       |  test (platform compat)
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { initiatorOf, isGecko, portableScripts } from '../src/platform.js';
import { requestStripHeaders, responseStripHeaders, setPackExtras } from '../src/netfilter/compile.js';

afterEach(() => {
  vi.unstubAllGlobals();
  setPackExtras({});
});

describe('initiatorOf', () => {
  it('prefers Chromium initiator', () => {
    expect(initiatorOf({ initiator: 'https://a.test', originUrl: 'https://b.test/x' })).toBe('https://a.test');
  });
  it('reads Firefox originUrl as an origin', () => {
    expect(initiatorOf({ originUrl: 'https://b.test/x?y=1' })).toBe('https://b.test');
  });
  it('treats the browser and this extension as no initiator, like Chromium does', () => {
    expect(initiatorOf({ originUrl: 'about:newtab' })).toBeUndefined();
    expect(initiatorOf({ originUrl: 'moz-extension://abc/chooser.html' })).toBeUndefined();
    expect(initiatorOf({})).toBeUndefined();
  });
});

describe('portableScripts', () => {
  const scripts = [{ id: 'shim', matchOriginAsFallback: true }, { id: 'agent' }];
  it('leaves Chromium registrations alone', () => {
    expect(isGecko()).toBe(false);
    expect(portableScripts(scripts)).toBe(scripts);
  });
  it('swaps the Chromium-only key on Firefox, which rejects it', () => {
    vi.stubGlobal('browser', { runtime: { getBrowserInfo: () => Promise.resolve({}) } });
    expect(isGecko()).toBe(true);
    expect(portableScripts(scripts)).toEqual([{ id: 'shim', matchAboutBlank: true }, { id: 'agent' }]);
  });
});

describe('strip lists', () => {
  it('always strips Set-Cookie and the account headers, plus a pack', () => {
    expect(responseStripHeaders()).toContain('set-cookie');
    expect(responseStripHeaders()).toContain('google-accounts-signin');
    setPackExtras({ responseHeaders: ['x-new-signal'], requestHeaders: ['x-ms-refreshtokencredential'] });
    expect(responseStripHeaders()).toContain('x-new-signal');
    expect(requestStripHeaders()).toEqual(['x-ms-refreshtokencredential']);
  });
});
