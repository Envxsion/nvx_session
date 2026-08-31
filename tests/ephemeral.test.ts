/**
 * ------------------------------------------------------------------
 *  Title    |  The session-scoped mirror
 *  Ref      |  kernel/ephemeral.js
 *  ID       |  test (ephemeral)
 * ------------------------------------------------------------------
 *  Purpose  |  Covers the encoding and the write discipline of the
 *           |  ephemeral mirror.
 *  Note     |  What they cannot cover, the worker dying, is asserted
 *           |  against a real browser in `e2e.mjs`, where the worker is
 *           |  killed over the debugger between close and reopen.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it, vi } from 'vitest';
import {
  Ephemeral,
  EPHEMERAL_KEY,
  EPHEMERAL_VERSION,
  decodeEphemeral,
  emptyEphemeral,
  encodeEphemeral,
  type EphemeralArea,
  type EphemeralMaps,
} from '../src/kernel/ephemeral.js';

function maps(): EphemeralMaps {
  return {
    reopen: new Map([
      ['https://a.example', [{ sessionId: 's_1', at: 1000 }, { sessionId: 's_2', at: 2000 }]],
      ['https://b.example', [{ sessionId: 's_1', at: 3000 }]],
    ]),
    decided: new Map([
      [7, new Set(['a.example'])],
      [9, new Set(['b.example', 'c.example'])],
    ]),
    unmasked: new Set([3, 11]),
  };
}

/** An area that records what it was asked to store, and can be made to fail. */
function area(): EphemeralArea & { store: Record<string, unknown>; fail: boolean; writes: number } {
  const a = {
    store: {} as Record<string, unknown>,
    fail: false,
    writes: 0,
    async get(keys: string | string[] | null) {
      if (a.fail) throw new Error('nope');
      const names = keys === null ? Object.keys(a.store) : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of names) if (k in a.store) out[k] = a.store[k];
      return out;
    },
    async set(items: Record<string, unknown>) {
      if (a.fail) throw new Error('nope');
      a.writes++;
      Object.assign(a.store, structuredClone(items));
    },
  };
  return a;
}

describe('the session scoped mirror', () => {
  it('round trips all three', () => {
    const back = decodeEphemeral(encodeEphemeral(maps()));
    expect([...back.reopen.keys()]).toEqual(['https://a.example', 'https://b.example']);
    expect(back.reopen.get('https://a.example')).toEqual([
      { sessionId: 's_1', at: 1000 },
      { sessionId: 's_2', at: 2000 },
    ]);
    expect([...(back.decided.get(9) ?? [])].sort()).toEqual(['b.example', 'c.example']);
    expect([...back.unmasked].sort((a, b) => a - b)).toEqual([3, 11]);
  });

  /**
   * The set of tabs the fingerprint posture must leave entirely real, because
   * their documents are older than the mask and a script cannot enter a
   * document that already exists.
   *
   * It is mirrored for a sharper reason than the other two. It is non-empty
   * exactly between a posture change and those tabs being reloaded, which is
   * exactly the period in which somebody changes a setting and walks away,
   * which is exactly how a worker reaches the thirty seconds of quiet that ends
   * it. Losing the other two costs a question; losing this one silently puts
   * every one of those tabs back to reporting one browser to itself and a
   * different one to the network.
   */
  describe('the tabs older than the mask', () => {
    it('survives a mirror written before the field existed', () => {
      const older = encodeEphemeral(maps()) as Record<string, unknown>;
      delete older.unmasked;
      const back = decodeEphemeral(older);
      expect(back.unmasked.size).toBe(0);
      // And the two fields that were there are still worth having.
      expect(back.reopen.size).toBe(2);
      expect(back.decided.size).toBe(2);
    });

    it('drops an id no tab can have rather than carrying it into a rule', () => {
      const state = { ...encodeEphemeral(maps()), unmasked: [-1, 4, 2.5, 'x', null, 6] };
      expect([...decodeEphemeral(state).unmasked].sort((a, b) => a - b)).toEqual([4, 6]);
    });

    it('reads nothing from a field that is not a list', () => {
      const state = { ...encodeEphemeral(maps()), unmasked: 'all of them' };
      expect(decodeEphemeral(state).unmasked.size).toBe(0);
    });

    it('writes an empty set as an empty list rather than omitting it', () => {
      const m = maps();
      m.unmasked.clear();
      expect(encodeEphemeral(m).unmasked).toEqual([]);
    });
  });

  it('keeps the close order, because the queue unwinds from the end', () => {
    const state = encodeEphemeral(maps());
    expect(state.reopen[0]?.[1].map((e) => e.at)).toEqual([1000, 2000]);
  });

  it('does not write an origin whose queue has been drained', () => {
    const m = maps();
    m.reopen.get('https://b.example')!.length = 0;
    const state = encodeEphemeral(m);
    expect(state.reopen.map(([o]) => o)).toEqual(['https://a.example']);
  });

  it('reads nothing from a version it does not know', () => {
    const state = { ...encodeEphemeral(maps()), version: EPHEMERAL_VERSION + 1 };
    expect(decodeEphemeral(state).reopen.size).toBe(0);
  });

  it('reads nothing from a shape it does not recognise', () => {
    for (const junk of [null, undefined, 42, 'x', [], {}, { version: 1 }]) {
      expect(decodeEphemeral(junk)).toEqual(emptyEphemeral());
    }
  });

  /**
   * The whole reason nothing here throws. A single entry written by another
   * build must cost one question, not every tab's memory at once.
   */
  it('drops the entries it cannot read and keeps the rest', () => {
    const state = {
      version: EPHEMERAL_VERSION,
      reopen: [
        ['https://a.example', [{ sessionId: 's_1', at: 1 }, { sessionId: 7, at: 2 }, { at: 3 }]],
        ['https://b.example', 'not a queue'],
        [null, [{ sessionId: 's_2', at: 4 }]],
        ['https://c.example', [{ sessionId: 's_3', at: Number.NaN }]],
        ['https://d.example', [{ sessionId: 's_4', at: 5 }]],
      ],
      decided: [
        [7, ['a.example', 5, null]],
        ['nine', ['b.example']],
        [8.5, ['c.example']],
        [10, ['d.example']],
      ],
    };
    const back = decodeEphemeral(state);
    expect([...back.reopen.keys()]).toEqual(['https://a.example', 'https://d.example']);
    expect(back.reopen.get('https://a.example')).toEqual([{ sessionId: 's_1', at: 1 }]);
    expect([...back.decided.keys()]).toEqual([7, 10]);
    expect([...(back.decided.get(7) ?? [])]).toEqual(['a.example']);
  });

  it('writes what is live at write time rather than at construction time', async () => {
    const a = area();
    const live = emptyEphemeral();
    const e = new Ephemeral(a, () => live, { debounceMs: 1 });
    live.reopen.set('https://a.example', [{ sessionId: 's_1', at: 1 }]);
    await e.save();
    expect(decodeEphemeral(a.store[EPHEMERAL_KEY]).reopen.size).toBe(1);
  });

  it('folds a burst of changes into one write', async () => {
    const a = area();
    const live = emptyEphemeral();
    const e = new Ephemeral(a, () => live, { debounceMs: 5 });
    for (let i = 0; i < 20; i++) {
      live.reopen.set(`https://${i}.example`, [{ sessionId: 's_1', at: i }]);
      e.schedule();
    }
    await new Promise((r) => setTimeout(r, 40));
    expect(a.writes).toBe(1);
    expect(decodeEphemeral(a.store[EPHEMERAL_KEY]).reopen.size).toBe(20);
  });

  it('reads back an empty memory rather than throwing when storage refuses', async () => {
    const a = area();
    a.fail = true;
    const onError = vi.fn();
    const e = new Ephemeral(a, emptyEphemeral, { onError });
    expect(await e.load()).toEqual(emptyEphemeral());
    expect(onError).toHaveBeenCalled();
  });

  it('reports the failure rather than swallowing it when a write refuses', async () => {
    const a = area();
    a.fail = true;
    const onError = vi.fn();
    await new Ephemeral(a, emptyEphemeral, { onError }).save();
    expect(onError).toHaveBeenCalled();
  });

  /**
   * Manifest v2 has no session area and a background page that does not die, so
   * absence is a supported configuration rather than a degraded one. It must
   * cost nothing and it must not pretend to have stored anything.
   */
  it('is inert with no area, and says so', async () => {
    const e = new Ephemeral(null, maps);
    expect(e.live).toBe(false);
    e.schedule();
    await e.save();
    expect(await e.load()).toEqual(emptyEphemeral());
  });
});
