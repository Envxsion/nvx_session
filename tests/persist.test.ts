/**
 * ------------------------------------------------------------------
 *  Title    |  Persistence across versions
 *  Ref      |  kernel/persist.ts (Persistence, deserialise)
 * ------------------------------------------------------------------
 *  Purpose  |  Pin that state written by another schema version is
 *           |  never read as empty and never overwritten, so a
 *           |  downgrade or an unmigrated upgrade cannot wipe every
 *           |  session.
 *  Author   |  Ojas Kekre, 02/10/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import { Persistence, SCHEMA_VERSION, type StorageArea } from '../src/kernel/persist.js';
import { Registry } from '../src/kernel/registry.js';

function area(seed: Record<string, unknown> = {}): StorageArea & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    async get(keys) {
      const list = keys === null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

const NEWER = SCHEMA_VERSION + 1;
const newerState = { version: NEWER, sessions: [{ id: 's_keep', label: 'Keep me' }], bindings: [] };

describe('state from another schema version', () => {
  it('is not loaded as an empty registry', async () => {
    const a = area({ 'nvx.state.v1': newerState });
    // Nothing usable, which boot treats as a first run, rather than a successful
    // load of nothing.
    expect(await Persistence.load(a)).toBeNull();
  });

  it('falls back to a backup this version can read', async () => {
    const backup = { version: SCHEMA_VERSION, sessions: [], bindings: [] };
    const a = area({ 'nvx.state.v1': newerState, 'nvx.state.backup': backup });
    const loaded = await Persistence.load(a);
    expect(loaded?.source).toBe('backup');
  });

  it('survives the next save, set aside under its own name', async () => {
    const a = area({ 'nvx.state.v1': newerState });
    const p = new Persistence(a, new Registry());
    p.schedule();
    await p.save();
    expect(a.map.get(`nvx.state.v1.v${NEWER}`)).toEqual(newerState);
    // And it was not rotated into the backup slot, where the save after this
    // one would have overwritten it.
    expect(a.map.get('nvx.state.backup')).toBeUndefined();
  });

  it('still rotates this version\'s own state into the backup as before', async () => {
    const mine = { version: SCHEMA_VERSION, sessions: [], bindings: [] };
    const a = area({ 'nvx.state.v1': mine });
    const p = new Persistence(a, new Registry());
    p.schedule();
    await p.save();
    expect(a.map.get('nvx.state.backup')).toEqual(mine);
  });
});
