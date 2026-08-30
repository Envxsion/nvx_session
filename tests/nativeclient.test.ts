/**
 * The native host is optional, so the paths that matter most are the ones where
 * it is not there. A client that throws, hangs, or reports a stale answer when
 * the host is absent would make the Store build worse than having no host
 * support at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { NativeHost, PROTOCOL_VERSION, type NativePortApi } from '../src/native/client.js';

type Listener = (msg: Record<string, unknown>) => void;

/** A port that answers with whatever the responder returns. */
function fakeApi(
  responder: (msg: Record<string, unknown>) => Record<string, unknown> | null,
  opts: { lastError?: string; throwOnConnect?: boolean } = {}
) {
  const messageListeners: Listener[] = [];
  const disconnectListeners: (() => void)[] = [];
  let disconnected = false;

  const port = {
    onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    postMessage: (msg: Record<string, unknown>) => {
      const reply = responder(msg);
      if (reply) queueMicrotask(() => messageListeners.forEach((fn) => fn(reply)));
    },
    disconnect: () => {
      disconnected = true;
    },
  } as unknown as chrome.runtime.Port;

  const api: NativePortApi = {
    connectNative: () => {
      if (opts.throwOnConnect) throw new Error('Specified native messaging host not found.');
      return port;
    },
    lastError: () => opts.lastError,
  };

  return {
    api,
    get disconnected() {
      return disconnected;
    },
    drop: () => disconnectListeners.forEach((fn) => fn()),
  };
}

const helloOk = (msg: Record<string, unknown>) => ({
  id: msg.id,
  ok: true,
  protocol: PROTOCOL_VERSION,
  version: '0.1.0',
  platform: 'win32',
  capabilities: ['key'],
  sealed: true,
});

describe('when the host is present', () => {
  it('reports its version and capabilities', async () => {
    const { api } = fakeApi(helloOk);
    const status = await new NativeHost(api).status();
    expect(status).toMatchObject({
      present: true,
      info: { version: '0.1.0', capabilities: ['key'], sealed: true },
    });
  });

  it('round trips a key', async () => {
    const keys = new Map<string, string>();
    const { api } = fakeApi((msg) => {
      if (msg.type === 'hello') return helloOk(msg);
      if (msg.type === 'key.set') {
        keys.set(String(msg.account), String(msg.key));
        return { id: msg.id, ok: true };
      }
      if (msg.type === 'key.get') {
        return { id: msg.id, ok: true, key: keys.get(String(msg.account)) ?? null };
      }
      return { id: msg.id, ok: false };
    });

    const host = new NativeHost(api);
    expect(await host.setKey('vault', 'c2VjcmV0')).toBe(true);
    expect(await host.getKey('vault')).toBe('c2VjcmV0');
    expect(await host.getKey('other')).toBeNull();
  });

  it('answers concurrent requests to the right callers', async () => {
    const { api } = fakeApi((msg) =>
      msg.type === 'hello' ? helloOk(msg) : { id: msg.id, ok: true, key: `key-${msg.account}` }
    );
    const host = new NativeHost(api);
    await host.status();
    const [a, b, c] = await Promise.all([host.getKey('a'), host.getKey('b'), host.getKey('c')]);
    expect([a, b, c]).toEqual(['key-a', 'key-b', 'key-c']);
  });
});

describe('when the host is not present', () => {
  it('reports absence rather than throwing', async () => {
    const { api } = fakeApi(() => null, { throwOnConnect: true });
    const status = await new NativeHost(api, 50).status();
    expect(status).toMatchObject({ present: false, reason: 'absent' });
  });

  it('reports absence when the build has no connectNative at all', async () => {
    const status = await new NativeHost(null).status();
    expect(status).toMatchObject({ present: false, reason: 'absent' });
  });

  it('distinguishes a refused connection from a missing host', async () => {
    // Chrome says something about access when the extension id is not in the
    // manifest's allowed_origins, which is a different fix from installing it.
    const { api } = fakeApi(() => null, {
      throwOnConnect: true,
      lastError: 'Access to the specified native messaging host is forbidden.',
    });
    const status = await new NativeHost(api, 50).status();
    expect(status).toMatchObject({ present: false, reason: 'refused' });
  });

  it('reports a protocol mismatch as its own thing', async () => {
    const { api } = fakeApi((msg) => ({
      id: msg.id,
      ok: false,
      error: 'protocol mismatch: extension speaks 1, host speaks 99',
    }));
    const status = await new NativeHost(api, 50).status();
    expect(status).toMatchObject({ present: false, reason: 'mismatch' });
    expect((status as { detail: string }).detail).toContain('mismatch');
  });

  it('times out rather than hanging when the host never answers', async () => {
    const { api } = fakeApi(() => null);
    const status = await new NativeHost(api, 30).status();
    expect(status.present).toBe(false);
  });

  it('returns null from every capability call instead of throwing', async () => {
    const { api } = fakeApi(() => null, { throwOnConnect: true });
    const host = new NativeHost(api, 30);
    expect(await host.getKey('vault')).toBeNull();
    expect(await host.setKey('vault', 'c2VjcmV0')).toBe(false);
    expect(await host.clearKey('vault')).toBe(false);
    expect(await host.has('key')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('does not hang forever when the host idle-exits mid-request', async () => {
    const harness = fakeApi((msg) => (msg.type === 'hello' ? helloOk(msg) : null));
    const host = new NativeHost(harness.api, 40);
    await host.status();
    const pending = host.getKey('vault');
    harness.drop();
    await expect(pending).resolves.toBeNull();
  });

  it('caches the handshake, so absence is not re-probed on every call', async () => {
    const responder = vi.fn(helloOk);
    const { api } = fakeApi(responder);
    const host = new NativeHost(api);
    await host.status();
    await host.status();
    await host.status();
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('re-probes after a reset, so a freshly installed host is picked up', async () => {
    const responder = vi.fn(helloOk);
    const { api } = fakeApi(responder);
    const host = new NativeHost(api);
    await host.status();
    host.reset();
    await host.status();
    expect(responder).toHaveBeenCalledTimes(2);
  });
});
