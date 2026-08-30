/**
 * Restart and crash recovery, exercised against real chrome.storage.
 *
 * Unit tests can prove the serialiser round-trips. They cannot prove that a
 * worker which died mid-session comes back with the same sessions, that stale
 * rules from the previous worker are cleared, or that a truncated write is
 * survivable. Those only show up against the real storage area and the real
 * rule engine, so they run here.
 */

import { parseSetCookie } from '../jar/cookie.js';
import { isPublicSuffix } from '../jar/psl.js';
import { CookieStore } from '../jar/store.js';
import { Persistence, serialise, type Settings, type StorageArea } from '../kernel/persist.js';
import { Registry } from '../kernel/registry.js';
import type { Netfilter } from '../netfilter/types.js';
import type { Check } from './selftest.js';
import { DEFAULT_DANGER } from '../guard/policy.js';

const PROBE_A = '__nvx_restore_a';
const PROBE_B = '__nvx_restore_b';

/** A storage area with no history, for the checks that are about first writes. */
function memoryArea(): StorageArea {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

export interface RestoreResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

export async function runRestoreTest(
  registry: Registry,
  engine: Netfilter,
  storage: StorageArea,
  reboot: () => Promise<{ rules: number; sessions: string[] }>,
  currentRules: () => Promise<unknown[]>,
  /**
   * The live preferences. This suite writes whole state blobs to the real
   * storage area, and serialising without them would silently reset the user's
   * identity channels to defaults for the crime of running a diagnostic.
   */
  settings?: Settings,
  /**
   * Removes a session from whatever registry is live *now*.
   *
   * Rebooting replaces the worker's registry and engine wholesale, so the ones
   * passed in above are stale by the time this suite finishes. Cleaning up
   * through them deletes the probe sessions from an object nothing reads any
   * more, and the real registry keeps them for good.
   */
  drop?: (id: string) => Promise<void>
): Promise<RestoreResult> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  const cleanup = async () => {
    for (const id of [PROBE_A, PROBE_B]) {
      if (drop) {
        await drop(id).catch(() => undefined);
      } else {
        registry.deleteSession(id);
        await engine.retire(id);
      }
    }
  };

  try {
    // ---------------------------------------------------------- seed state
    for (const [id, value] of [
      [PROBE_A, 'ALPHA'],
      [PROBE_B, 'BETA'],
    ] as const) {
      registry.createSession({
        id,
        label: id,
        color: 'jade',
        pinned: ['example.invalid'],
        store: new CookieStore(),
        family: [],
        forked: [],
        danger: DEFAULT_DANGER,
        thirdParty: 'allow',
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
      const p = parseSetCookie(
        `restore=${value}; Path=/; Max-Age=600`,
        { url: new URL('https://example.invalid/') },
        { isPublicSuffix }
      );
      if (p.ok) registry.getSession(id)!.store.upsert(p.cookie);
    }

    // A backup only exists once there is a prior good state to promote, so the
    // very first save legitimately has none.
    //
    // Deliberately measured against an empty area rather than the real one. By
    // the time this runs the worker has been saving for a while, so the real
    // area already holds a good state and promoting it to backup on the next
    // write is correct behaviour, not the bug this is looking for. Asserting
    // against the live area would either fail for the wrong reason or pass by
    // accident depending on how quickly the suite was started.
    const virgin = memoryArea();
    const virginWrites = new Persistence(virgin, registry, {
      debounceMs: 0,
      ...(settings ? { settings: () => settings } : {}),
    });
    virginWrites.schedule();
    await virginWrites.save();
    const afterFirst: Record<string, unknown> = await virgin.get('nvx.state.backup');
    add('the first save writes no bogus backup', afterFirst['nvx.state.backup'] === undefined);

    virginWrites.schedule();
    await virginWrites.save();
    const afterSecond: Record<string, unknown> = await virgin.get('nvx.state.backup');
    add('the second save promotes the first to backup', afterSecond['nvx.state.backup'] !== undefined);

    const persistence = new Persistence(storage, registry, {
      debounceMs: 0,
      ...(settings ? { settings: () => settings } : {}),
    });
    persistence.schedule();
    await persistence.save();
    persistence.schedule();
    await persistence.save();

    // -------------------------------------------------- round trip through
    const first = await Persistence.load(storage);
    add('state survives a save and load', Boolean(first), first?.source);
    add(
      'both probe sessions come back',
      Boolean(first && first.registry.getSession(PROBE_A) && first.registry.getSession(PROBE_B))
    );
    add(
      'the jar comes back with its cookies',
      first?.registry.getSession(PROBE_A)?.store.size === 1,
      `${first?.registry.getSession(PROBE_A)?.store.size ?? 0} cookie(s)`
    );
    add(
      'pinned domains survive',
      first?.registry.getSession(PROBE_B)?.pinned.join(',') === 'example.invalid'
    );

    // ------------------------------------------------------ crash recovery
    // A torn or truncated write is what a crash actually looks like. The
    // primary is replaced with garbage; the backup written alongside it is
    // what should be picked up.
    await storage.set({ 'nvx.state.v1': { version: 1, sessions: 'not-an-array' } });
    const recovered = await Persistence.load(storage);
    add('a corrupt primary falls back to the backup', recovered?.source === 'backup', recovered?.source ?? 'nothing loaded');
    add(
      'the recovered copy still has the sessions',
      Boolean(recovered?.registry.getSession(PROBE_A)),
      `${recovered?.registry.listSessions().length ?? 0} session(s)`
    );

    // Restore a good primary so the reboot below is not testing the backup.
    await storage.set({
      'nvx.state.v1': serialise(registry, { ...(settings ? { settings } : {}) }),
    });

    // ---------------------------------------------------- worker restart
    const before = (await currentRules()).length;
    const after = await reboot();
    add(
      'a restarted worker restores every session',
      after.sessions.includes(PROBE_A) && after.sessions.includes(PROBE_B),
      `${after.sessions.length} session(s)`
    );
    add(
      'a restarted worker does not accumulate rules',
      after.rules <= Math.max(before, 1) * 2,
      `${before} before, ${after.rules} after`
    );

    // ------------------------------------------------- unreadable storage
    const hostile: StorageArea = {
      async get() {
        throw new Error('storage unavailable');
      },
      async set() {
        throw new Error('storage unavailable');
      },
      async remove() {
        throw new Error('storage unavailable');
      },
    };
    const nothing = await Persistence.load(hostile);
    add('an unreadable storage area returns nothing rather than throwing', nothing === null);

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    return {
      ok: false,
      checks,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await cleanup();
  }
}
