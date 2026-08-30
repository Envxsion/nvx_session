/**
 * The type surface shared across the Pro seam.
 *
 * These declarations stay in the public tree even though the implementations
 * that satisfy them (license.ts, sync.ts) live in the private `pro` submodule.
 * The reason is single-source typing: the free stub in `pro.free.ts`, the real
 * classes in `pro/`, and the service worker that constructs and calls them all
 * refer to one definition of each shape, so a free build and a Pro build cannot
 * drift apart on what a licence status or a sync result looks like. Nothing here
 * is an algorithm or a secret; it is the contract, and a contract is public.
 */

import type { StorageArea } from './persist.js';

// -------------------------------------------------------------- licence types

/** A device the studio knows about, as the seat-taken response lists them. */
export interface SeatDevice {
  /** The coarse label, e.g. "Windows, Chrome". Never anything identifying. */
  label: string;
  /** Whole-day-ish "last seen" the server stamps, for the transfer prompt. */
  lastSeen?: number;
}

/**
 * The outcome of an activation attempt, in the shape the settings screen acts
 * on. Everything the user might need to decide (a transfer, a retry, a support
 * mail) is a distinct case rather than a message string.
 */
export type ActivateResult =
  | { ok: true }
  /** The seat is held by another device; offer a transfer with `transfer: true`. */
  | { ok: false; reason: 'seat_taken'; devices: SeatDevice[]; maxDevices: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'revoked' }
  /** The operator has paused this licence. Reversible: it works again when resumed. */
  | { ok: false; reason: 'paused' }
  | { ok: false; reason: 'expired' }
  /** Reached the server but it refused for a reason the user cannot fix here. */
  | { ok: false; reason: 'rejected' }
  /** Could not reach the server. Activation needs the network exactly once. */
  | { ok: false; reason: 'network' };

/** A parsed HTTP reply: the status and the decoded JSON body, or null body. */
export interface HttpReply {
  status: number;
  json: unknown;
}

export interface LicensePorts {
  storage: StorageArea;
  /** The licence API base, e.g. https://session.nvx.sh/api/license, or null. */
  endpoint: () => string | null;
  /** POST json and return the parsed reply. Rejects only on a transport failure. */
  post: (url: string, body: string) => Promise<HttpReply>;
  /** A coarse device label for the studio's device list. No identifying detail. */
  deviceLabel: () => string;
  now: () => number;
  /** A fresh random id, e.g. crypto.randomUUID. */
  newId: () => string;
  /**
   * Hands the current token (or null when there is none) to the entitlement
   * gate. The one line that connects this module to what features are unlocked.
   */
  onToken: (token: string | null) => Promise<void>;
}

/** What the settings screen shows about the licence, derived, never the token. */
export interface LicenseStatus {
  /** Whether a claim key is stored at all, so the UI shows enter vs manage. */
  present: boolean;
  /** The device id, so the studio and a support request can name this machine. */
  device: string | null;
}

// ----------------------------------------------------------------- sync types

/** The subset of a session that is structure rather than contents, and so may sync. */
export interface SyncSession {
  id: string;
  label: string;
  color: string;
  group?: string;
  pinned: string[];
  family: string[];
  thirdParty: 'allow' | 'block';
  allowedParties: string[];
  danger?: unknown;
  createdAt: number;
  /** Last time the session was seen active, the field the merge resolves ties by. */
  lastSeen: number;
}

/** The plaintext that is encrypted. A version-stamped list of session structures. */
export interface SyncConfig {
  v: number;
  sessions: SyncSession[];
  /** When this config was last changed on some device, for last-writer-wins. */
  updatedAt: number;
}

/**
 * The envelope stored on the server. Every field but the version is opaque: the
 * salt and iv are not secret (they are meant to be stored in the clear beside the
 * ciphertext), and the ciphertext is unreadable without the passphrase-derived
 * key.
 */
export interface SyncEnvelope {
  /** Envelope format version. */
  v: number;
  /** base64 PBKDF2 salt, 16 bytes. */
  salt: string;
  /** base64 AES-GCM iv, 12 bytes, fresh per encryption. */
  iv: string;
  /** base64 AES-GCM ciphertext of the JSON config. */
  ct: string;
  /** The config's updatedAt, copied out so the server can order versions without reading them. */
  version: number;
}

export interface SyncCryptoPorts {
  /** WebCrypto SubtleCrypto, `crypto.subtle` in the worker, Node's in a test. */
  subtle: SubtleCrypto;
  /** Fills n bytes of randomness, `crypto.getRandomValues` in the worker. */
  random: (n: number) => Uint8Array;
}

/** A parsed HTTP reply, the same shape the licence client uses. */
export interface SyncHttpReply {
  status: number;
  json: unknown;
}

export type SyncResult =
  | { ok: true; applied: number }
  /** The passphrase does not match the blob on the server: a different one was used elsewhere. */
  | { ok: false; reason: 'passphrase' }
  | { ok: false; reason: 'no_license' }
  | { ok: false; reason: 'network' }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'disabled' };

export interface SyncPorts {
  storage: StorageArea;
  /** The sync API base, e.g. https://session.nvx.sh/api/license/sync, or null. */
  endpoint: () => string | null;
  post: (url: string, body: string) => Promise<SyncHttpReply>;
  crypto: SyncCryptoPorts;
  now: () => number;
  /** The licence key and device, the cross-device account identity. Null without a licence. */
  credentials: () => { key: string; device: string } | null;
  /** This device's current session structure, read from the registry. */
  readConfig: () => SyncConfig;
  /** Apply a merged structure to the registry, returning how many sessions it created or changed. */
  applyConfig: (merged: SyncConfig) => number;
}

export interface SyncStatus {
  enabled: boolean;
  lastSyncedAt: number | null;
}
