/**
 * ------------------------------------------------------------------
 *  Title    |  State that outlives the worker but not the browser
 *  Ref      |  chrome.storage.session, restoreAfterRestart, tests/ephemeral.test.ts
 *  ID       |  Ephemeral state
 * ------------------------------------------------------------------
 *  Purpose  |  Remember three things that are neither settings nor
 *           |  sessions: which session a closed tab was in (for
 *           |  Ctrl+Shift+T), which tabs are left unmanaged, and which
 *           |  tabs predate the fingerprint mask.
 *  How      |  Kept in chrome.storage.session: held by the browser not
 *           |  the worker, readable by the next worker, cleared when
 *           |  the browser closes.
 *  Bug-Fix  |  Plain Maps in the worker heap died with the ~30s idle
 *           |  kill, so reopen memory lasted until the next lull and a
 *           |  reopened tab read as signed out. Clearing on browser
 *           |  close also matters: restoreAfterRestart owns the restart
 *           |  case and refuses to guess, so this must not guess behind
 *           |  it.
 *  Note     |  Manifest v2 has a persistent page and no session area,
 *           |  so this degrades to a no-op there; the Opera GX build
 *           |  ships v2. Everything below the class is pure.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

export interface ReopenEntry {
  sessionId: string;
  at: number;
}

/** The wire shape. `Map` does not survive structured cloning into storage. */
export interface EphemeralState {
  version: number;
  /** Origin to the sessions whose tabs closed there, oldest first. */
  reopen: Array<[string, ReopenEntry[]]>;
  /** Tab id to the registrable domains left unmanaged in that tab. */
  decided: Array<[number, string[]]>;
  /**
   * Tabs whose document predates the mask, and which the posture must leave
   * entirely real.
   *
   * Here rather than in the heap for the same reason as the other two, and with
   * a sharper edge than either. This set is non-empty exactly between a posture
   * change and those tabs being reloaded, which is precisely the period during
   * which somebody changes a setting and then walks away, which is precisely how
   * a worker reaches thirty seconds of quiet and is killed. Losing it does not
   * cost a question like the others do: it silently puts every one of those tabs
   * back to reporting one browser to itself and another to the network.
   *
   * Optional on read, so a mirror written by a build without it is still worth
   * having for the two fields it does carry.
   */
  unmasked?: number[];
}

export const EPHEMERAL_KEY = 'nvx.ephemeral.v1';
export const EPHEMERAL_VERSION = 1;

export interface EphemeralArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The two maps the kernel keeps, in the shape it keeps them. */
export interface EphemeralMaps {
  reopen: Map<string, ReopenEntry[]>;
  decided: Map<number, Set<string>>;
  unmasked: Set<number>;
}

export function emptyEphemeral(): EphemeralMaps {
  return { reopen: new Map(), decided: new Map(), unmasked: new Set() };
}

export function encodeEphemeral(maps: EphemeralMaps): EphemeralState {
  return {
    version: EPHEMERAL_VERSION,
    // An origin whose queue has been emptied is not written out. The live map
    // deletes those itself, but a queue drained by the last pop between two
    // writes would otherwise be stored as an empty array and read back as a
    // key that answers nothing.
    reopen: [...maps.reopen.entries()]
      .filter(([, queue]) => queue.length > 0)
      .map(([origin, queue]) => [origin, queue.map((e) => ({ sessionId: e.sessionId, at: e.at }))]),
    decided: [...maps.decided.entries()]
      .filter(([, domains]) => domains.size > 0)
      .map(([tabId, domains]) => [tabId, [...domains]]),
    unmasked: [...maps.unmasked],
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Rebuild the maps, skipping anything that does not look
 *           |  right.
 *  Note     |  Nothing is trusted even though the worker wrote it: a
 *           |  different build may have, and one bad entry must not
 *           |  cost the rest. Discarding one origin's queue asks about
 *           |  one tab; throwing would ask about every tab.
 * ------------------------------------------------------------------
 */
export function decodeEphemeral(raw: unknown): EphemeralMaps {
  const out = emptyEphemeral();
  if (!raw || typeof raw !== 'object') return out;
  const state = raw as Partial<EphemeralState>;
  if (state.version !== EPHEMERAL_VERSION) return out;

  if (Array.isArray(state.reopen)) {
    for (const pair of state.reopen) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [origin, queue] = pair as [unknown, unknown];
      if (typeof origin !== 'string' || !origin || !Array.isArray(queue)) continue;
      const entries: ReopenEntry[] = [];
      for (const e of queue) {
        if (!e || typeof e !== 'object') continue;
        const { sessionId, at } = e as Partial<ReopenEntry>;
        if (typeof sessionId !== 'string' || !sessionId) continue;
        if (typeof at !== 'number' || !Number.isFinite(at)) continue;
        entries.push({ sessionId, at });
      }
      if (entries.length) out.reopen.set(origin, entries);
    }
  }

  if (Array.isArray(state.decided)) {
    for (const pair of state.decided) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [tabId, domains] = pair as [unknown, unknown];
      if (typeof tabId !== 'number' || !Number.isInteger(tabId) || !Array.isArray(domains)) continue;
      const set = new Set<string>();
      for (const d of domains) if (typeof d === 'string' && d) set.add(d);
      if (set.size) out.decided.set(tabId, set);
    }
  }

  if (Array.isArray(state.unmasked)) {
    for (const tabId of state.unmasked) {
      if (typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0) {
        out.unmasked.add(tabId);
      }
    }
  }

  return out;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Read and write the maps, coalescing bursts.
 *  How      |  Written eagerly, not on the persistence debounce: the
 *           |  event that records a reopen is a tab closing, often the
 *           |  last thing the worker does before it is killed. 60ms
 *           |  folds a window's worth of closes into one write and
 *           |  stays far short of the idle timer.
 *  Note     |  A 400ms debounce is fine for a jar also live in the rule
 *           |  set; not for the only copy of something.
 * ------------------------------------------------------------------
 */
export class Ephemeral {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly area: EphemeralArea | null,
    private readonly read: () => EphemeralMaps,
    private readonly opts: { debounceMs?: number; onError?: (e: unknown) => void } = {}
  ) {}

  /** True when there is somewhere to write, which is false on manifest v2. */
  get live(): boolean {
    return this.area !== null;
  }

  async load(): Promise<EphemeralMaps> {
    if (!this.area) return emptyEphemeral();
    try {
      const raw = await this.area.get(EPHEMERAL_KEY);
      return decodeEphemeral(raw[EPHEMERAL_KEY]);
    } catch (e) {
      // A failed read is an empty memory, which costs a question. Letting it
      // throw would take the whole boot with it, which costs every tab.
      this.opts.onError?.(e);
      return emptyEphemeral();
    }
  }

  schedule(): void {
    if (!this.area || this.timer) return;
    this.timer = setTimeout(() => void this.save(), this.opts.debounceMs ?? 60);
  }

  async save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.area) return;
    const area = this.area;
    const run = async () => {
      try {
        await area.set({ [EPHEMERAL_KEY]: encodeEphemeral(this.read()) });
      } catch (e) {
        this.opts.onError?.(e);
      }
    };
    // Serialised against the previous write, so two bursts cannot land out of
    // order and leave the older snapshot on top of the newer one.
    const next = this.writing ? this.writing.then(run, run) : run();
    this.writing = next.catch(() => undefined);
    return next;
  }
}
