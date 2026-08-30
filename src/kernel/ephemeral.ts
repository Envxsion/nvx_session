/**
 * State that has to outlive the worker and must not outlive the browser.
 *
 * Three things the kernel remembers are neither settings nor sessions. Which
 * session a closed tab was in, so `Ctrl+Shift+T` puts it back rather than
 * asking. Which tabs the user has deliberately left unmanaged, so the picker
 * does not come back the moment they navigate. And which tabs are older than
 * the fingerprint mask, so the posture leaves them alone rather than rewriting
 * the headers of a page it never reached.
 *
 * Both were plain `Map`s in the worker's heap, and that is wrong in a way no
 * unit test could see. A manifest v3 service worker is terminated when idle,
 * which on Chromium is thirty seconds of quiet, and everything in its heap goes
 * with it. So the reopen memory advertised an hour and in practice lasted until
 * the next lull: close a tab, read something, press `Ctrl+Shift+T`, and the tab
 * came back unbound and was asked about, which reads exactly like being signed
 * out. Measured rather than argued: stopping the worker between the close and
 * the reopen turns `rejoined=reo_a` into `rejoined=null, held=true` every time,
 * and that is the same failure the suite had been seeing at about two runs in
 * ten, where the eviction landed inside the phase by luck rather than by
 * design.
 *
 * The lifetime wanted here is exactly `chrome.storage.session`: kept in memory
 * by the browser rather than the worker, readable by the next worker, and
 * cleared when the browser closes. That last half matters as much as the first.
 * A browser restart is a different question with a different answer already:
 * `restoreAfterRestart` matches the tabs that came back against the bindings
 * that were saved, and it deliberately refuses to guess where two sessions were
 * open on one origin. Carrying this memory across a restart would let it guess
 * behind that check's back.
 *
 * Manifest v2 has no session area and its background page is persistent, so
 * there the heap already has the right lifetime and this degrades to a no-op.
 * That is a real configuration rather than a fallback: the Opera GX build ships
 * v2.
 *
 * Everything below the class is pure, so the encoding is testable without a
 * browser; `tests/ephemeral.test.ts` holds it.
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
 * Rebuilds the maps, skipping anything that does not look right.
 *
 * Nothing here is trusted even though the worker wrote it: a build with a
 * different shape can have written it, and a single bad entry must not cost the
 * rest. Discarding one origin's queue means one tab gets asked about, which is
 * the safe direction; throwing would mean every tab does.
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
 * Reads and writes the pair, coalescing bursts.
 *
 * Written eagerly rather than on the persistence debounce, and the difference
 * is the whole point: the event that records a reopen is a tab closing, which
 * is very often the last thing the worker does before it goes quiet and is
 * killed. A four hundred millisecond debounce is fine for a jar that is also
 * live in the rule set; it is not fine for the only copy of something. Sixty
 * milliseconds is enough to fold a window's worth of closes into one write and
 * far short of the idle timer that would end the worker.
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
