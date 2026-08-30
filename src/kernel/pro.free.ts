/**
 * The Pro seam's free side: inert stand-ins for the classes the private `pro`
 * submodule supplies.
 *
 * A free build has no `pro` submodule, so the gate (pro.ts) keeps its committed
 * default and re-exports these. Every method is a no-op that resolves to "no
 * licence, nothing synced", which is exactly the free product. The service
 * worker constructs and calls these identically to the real classes; they simply
 * never do anything, and nothing free depends on them doing anything. The types
 * are the shared ones in pro-types.ts, so a free build and a Pro build agree on
 * every shape.
 */

import type {
  ActivateResult,
  LicensePorts,
  LicenseStatus,
  SyncPorts,
  SyncResult,
  SyncStatus,
} from './pro-types.js';

/** Inert licence client. Holds no device, activates nothing, keeps the gate free. */
export class License {
  constructor(private readonly ports: LicensePorts) {}

  async init(): Promise<void> {
    // No licence in a free build: make sure the entitlement gate sees no token.
    await this.ports.onToken(null);
  }

  deviceId(): string | null {
    return null;
  }

  status(): LicenseStatus {
    return { present: false, device: null };
  }

  credentials(): { key: string; device: string } | null {
    return null;
  }

  async activate(_rawKey: string, _opts: { transfer?: boolean } = {}): Promise<ActivateResult> {
    // A free build carries no endpoint, so activation cannot reach a server.
    return { ok: false, reason: 'network' };
  }

  async refresh(): Promise<void> {}

  async remove(): Promise<void> {}
}

/** Inert sync client. Enabled never, syncs nothing, stores no passphrase. */
export class Sync {
  constructor(private readonly ports: SyncPorts) {}

  async init(): Promise<void> {}

  status(): SyncStatus {
    return { enabled: false, lastSyncedAt: null };
  }

  async enable(_passphrase: string): Promise<SyncResult> {
    return { ok: false, reason: 'disabled' };
  }

  async disable(): Promise<void> {}

  async sync(): Promise<SyncResult> {
    return { ok: false, reason: 'disabled' };
  }
}
