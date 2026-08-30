/**
 * Talking to the native host, when there is one.
 *
 * The host is optional by design: the Store build cannot ship a binary, so
 * every capability it provides has a degraded path and absence is the normal
 * case rather than an error. Nothing here throws when the host is missing.
 *
 * Framing is the browser's problem on this side. chrome.runtime.connectNative
 * handles the length prefixes and hands over parsed objects, which is why the
 * codec lives in native/ and not here.
 */

export const HOST_NAME = 'com.nvx.session';
export const PROTOCOL_VERSION = 1;

export interface HostInfo {
  version: string;
  protocol: number;
  platform: string;
  runtime?: string;
  capabilities: string[];
  /** True when the key store is wrapped by the OS rather than held in the clear. */
  sealed: boolean;
  store?: string;
}

export type HostStatus =
  | { present: true; info: HostInfo }
  /**
   * Why it is not there matters to the UI. "Not installed" is a thing the user
   * can fix with one command; "protocol mismatch" means they have a stale host
   * and reinstalling is the fix; a refused connection usually means the
   * extension id is not in the manifest's allowed_origins.
   */
  | { present: false; reason: 'absent' | 'mismatch' | 'refused' | 'timeout'; detail?: string };

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NativePortApi {
  connectNative(name: string): chrome.runtime.Port;
  lastError(): string | undefined;
}

export function browserNativeApi(): NativePortApi | null {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connectNative) return null;
  return {
    connectNative: (name) => chrome.runtime.connectNative(name),
    lastError: () => chrome.runtime.lastError?.message,
  };
}

/**
 * A connection that opens on demand and forgets itself when the host exits.
 *
 * Deliberately not a long-lived singleton: the host idle-exits, and holding a
 * dead port would make every later request hang rather than reconnect.
 */
export class NativeHost {
  private port: chrome.runtime.Port | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private cached: HostStatus | null = null;

  constructor(
    private readonly api: NativePortApi | null = browserNativeApi(),
    private readonly timeoutMs = 8000
  ) {}

  /** Forgets a cached answer, so a freshly installed host is picked up. */
  reset(): void {
    this.cached = null;
    this.disconnect();
  }

  private disconnect(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('the native host went away'));
    }
    this.pending.clear();
    try {
      this.port?.disconnect();
    } catch {
      /* already gone */
    }
    this.port = null;
  }

  private open(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    if (!this.api) return null;
    try {
      const port = this.api.connectNative(HOST_NAME);
      port.onMessage.addListener((msg: Record<string, unknown>) => {
        const id = typeof msg?.id === 'number' ? msg.id : -1;
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
        this.disconnect();
      });
      this.port = port;
      return port;
    } catch {
      return null;
    }
  }

  async request(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const port = this.open();
    if (!port) return null;

    const id = this.nextId++;
    return new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value),
        reject: () => resolve(null),
        timer,
      });

      try {
        port.postMessage({ ...message, id });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  /** Handshake, cached. Absence is an answer, not a failure. */
  async status(): Promise<HostStatus> {
    if (this.cached) return this.cached;

    if (!this.api) {
      this.cached = { present: false, reason: 'absent', detail: 'no connectNative in this build' };
      return this.cached;
    }

    const reply = await this.request({ type: 'hello', protocol: PROTOCOL_VERSION });
    if (!reply) {
      const detail = this.api.lastError();
      this.cached = {
        present: false,
        // Chrome says "Specified native messaging host not found" when it is
        // not registered, and something about access when the extension id is
        // missing from allowed_origins. The two need different advice.
        reason: detail && /access|forbidden|origin/i.test(detail) ? 'refused' : 'absent',
        ...(detail ? { detail } : {}),
      };
      return this.cached;
    }

    if (reply.ok !== true) {
      this.cached = {
        present: false,
        reason: 'mismatch',
        detail: typeof reply.error === 'string' ? reply.error : 'the host refused the handshake',
      };
      return this.cached;
    }

    this.cached = {
      present: true,
      info: {
        version: String(reply.version ?? '?'),
        protocol: Number(reply.protocol ?? 0),
        platform: String(reply.platform ?? '?'),
        ...(typeof reply.runtime === 'string' ? { runtime: reply.runtime } : {}),
        capabilities: Array.isArray(reply.capabilities) ? (reply.capabilities as string[]) : [],
        sealed: reply.sealed === true,
        ...(typeof reply.store === 'string' ? { store: reply.store } : {}),
      },
    };
    return this.cached;
  }

  async has(capability: string): Promise<boolean> {
    const status = await this.status();
    return status.present && status.info.capabilities.includes(capability);
  }

  // ------------------------------------------------------------- key store

  async getKey(account: string): Promise<string | null> {
    if (!(await this.has('key'))) return null;
    const reply = await this.request({ type: 'key.get', account });
    return reply?.ok === true && typeof reply.key === 'string' ? reply.key : null;
  }

  async setKey(account: string, key: string): Promise<boolean> {
    if (!(await this.has('key'))) return false;
    const reply = await this.request({ type: 'key.set', account, key });
    return reply?.ok === true;
  }

  async clearKey(account: string): Promise<boolean> {
    if (!(await this.has('key'))) return false;
    const reply = await this.request({ type: 'key.clear', account });
    return reply?.ok === true;
  }
}
