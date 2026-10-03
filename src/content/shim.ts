/**
 * ------------------------------------------------------------------
 *  Title    |  Storage shim
 *  Ref      |  View, expose, commit, src/store/keys.ts (key maths)
 *  ID       |  M4 (storage shim)
 * ------------------------------------------------------------------
 *  Purpose  |  Replace localStorage and sessionStorage with objects
 *           |  that namespace the origin store per session, so two
 *           |  sessions on one site stop reading and overwriting each
 *           |  other. Runs in the MAIN world at document_start.
 *  How      |  Storage is synchronous with no sync path to the
 *           |  worker, so the real store is namespaced rather than
 *           |  proxied to the kernel. The shim installs before it
 *           |  knows its session, so it parks pending, journals
 *           |  writes and reads through, then rebases on commit; a
 *           |  sessionStorage stamp removes the pending window on the
 *           |  next load. A Proxy, not patched methods, so
 *           |  enumeration and storage events stay invisible.
 *  Note     |  No imports or exports (a classic script; one export
 *           |  makes tsc emit failing module syntax). Key maths is
 *           |  duplicated from src/store/keys.ts on purpose; the
 *           |  suite asserts the two agree.
 *  Author   |  Ojas Kekre, 24/08/2026
 * ------------------------------------------------------------------
 */

(function nvxStorageShim(): void {
  const NS = '__nvx~';
  const SEP = '~';
  const STAMP = '__nvx~tab';
  /**
   * Where the mask reads its persona material. Written here rather than by the
   * mask because this is the script that has a channel to the worker; the mask
   * is static and can only read. Copied from src/store/keys.ts.
   */
  const PERSONA = '__nvx~p';
  /**
   * The session's script-readable cookies for this origin, kept beside the stamp
   * so the next load in this tab can answer document.cookie before the worker
   * has. Copied from src/store/keys.ts.
   */
  const JAR = '__nvx~c';
  /** When this tab last reloaded to drop a stale stamp, so it can never loop. */
  const RELOAD = '__nvx~r';
  /** Copied from src/store/keys.ts. Every one of these keys is ours and none is the page's. */
  function reserved(key: string): boolean {
    return key === STAMP || key === PERSONA || key === JAR || key === RELOAD;
  }
  /**
   * The channel, and why only its first word is a name anybody can guess.
   *
   * Everything after the announcement runs on a per-document nonce, and the
   * reason is what the fixed name was carrying. A page could
   * `document.addEventListener('__nvx.storage.state')` and read the session id
   * out of the detail. That id is the same string on every origin in that
   * session, so any two sites could compare notes and link the same person
   * across everything they visited in it. **The product exists to stop exactly
   * that, and was broadcasting the identifier that does it.** The same channel
   * took instructions: a page could dispatch `commit` with any id it liked.
   *
   * A nonce works here for one reason, and it is worth stating precisely because
   * it is the whole security argument: **a listener cannot be attached to an
   * event that has already been dispatched.** This runs at document_start, so it
   * speaks before the page's first script exists, and a page that starts
   * listening afterwards has already missed the only message sent in the clear.
   *
   * That holds only if the page cannot see later dispatches either, which it
   * could by replacing `EventTarget.prototype.dispatchEvent` once it starts
   * running. So the primitives are captured here, before that is possible, and
   * every later message goes through the captured ones.
   */
  const ANNOUNCE = '__nvx.storage.ready';

  const rawDispatch = EventTarget.prototype.dispatchEvent;
  const rawListen = EventTarget.prototype.addEventListener;

  const CHANNEL = (() => {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(36)).join('');
    } catch {
      // No crypto is a browser this does not run on, but a predictable channel
      // is worse than a slow one, so this refuses rather than falling back to
      // something guessable.
      return '';
    }
  })();

  /**
   * Already installed, decided by looking rather than by leaving a note.
   *
   * This used to be `if (globalThis.__nvxStorage) return`, with the receiver it
   * tested left on the page's own window. Nothing ever called that receiver, so
   * the only thing the property did was answer `'__nvxStorage' in window` for
   * anybody who asked. **An extension that hides your fingerprint and then
   * announces itself has made you more identifiable, not less**: the mask spends
   * hundreds of lines making patched functions indistinguishable from native
   * ones, and one enumerable global on `window` undoes all of it. Worse, the
   * population running this is small, so being found is a stronger signal than
   * anything the mask was hiding.
   *
   * Every property on a global is enumerable through `getOwnPropertyNames`,
   * whatever its flags, so the fix is not a better name: it is not writing one.
   * The shim already leaves a mark it cannot avoid, the accessor it puts over
   * `localStorage`, so that is what it asks about. A page can run this same test
   * and learn the same thing, which is the honest limit of virtualising storage
   * from inside the page, and is written up in `storagetest.ts`. The difference
   * is that finding us now takes knowing what to look for rather than reading a
   * list of names.
   */
  const HANDSHAKE = '__nvx.shim.v1';

  function alreadyInstalled(): boolean {
    try {
      /**
       * A native `Storage` can only ever hand back a string or undefined, so a
       * function is an answer only the proxy below can give. That matters in
       * both directions.
       *
       * It cannot be forged: a page that stored the handshake name as a key
       * would get its own string back, not a function, so it cannot talk the
       * shim out of installing and thereby switch its own isolation off.
       *
       * And it cannot misfire: the first version of this asked whether the
       * `localStorage` accessor still looked native, which is true of our own
       * proxy and false of anything else that had replaced it first. The unit
       * suite went red immediately, and the failure it was describing is the bad
       * one: **a false positive here means the shim silently does not install,
       * and storage isolation is off with nothing anywhere saying so.**
       */
      return typeof (window.localStorage as unknown as Record<string, unknown>)[HANDSHAKE] ===
        'function';
    } catch {
      return false;
    }
  }
  if (alreadyInstalled()) return;

  let real: { local: Storage | null; session: Storage | null };
  try {
    real = { local: window.localStorage, session: window.sessionStorage };
  } catch {
    // Storage is disabled for this origin. Nothing to virtualise, and throwing
    // here would break a page that already copes with that.
    return;
  }
  if (!real.local && !real.session) return;

  type Op =
    | { op: 'set'; key: string; value: string }
    | { op: 'remove'; key: string }
    | { op: 'clear' };

  /** pending: identity unknown. live: namespaced. through: unmanaged tab. */
  type Mode = 'pending' | 'live' | 'through';

  let mode: Mode = 'pending';
  let sid: string | null = null;

  /**
   * document.cookie writes made before the session was known, replayed on
   * commit, the same idea as a View's journal but for the cookie jar. A write in
   * the pending window is rare (it needs a page script before the worker has
   * answered) but a sign-in probe set that early and dropped is exactly the kind
   * of thing that loops, so it is kept rather than lost.
   */
  const cookieJournal: string[] = [];

  /**
   * document.cookie in a managed tab, answered from the session.
   *
   * A rule strips Set-Cookie from every response a managed tab receives, so the
   * browser's own jar only ever holds the profile's identity, and the worker
   * keeps the session's. Reading the native jar would hand this session the
   * wrong account's cookies; writing it would leak this session's cookies into
   * every other tab on the site. So once the tab is known to be managed, reads
   * and writes go through this view instead: seeded by the worker with the
   * session's script-readable cookies for this site, kept current by its
   * pushes, and saved beside the stamp so the next load starts correct.
   *
   * Field names are short because the list crosses three worlds on every load.
   */
  interface PageCookie {
    n: string;
    v: string;
    d: string;
    p: string;
    h: boolean;
    s: boolean;
    e: number | null;
  }
  const jar = new Map<string, PageCookie>();
  /** Writes from the pending window, re-applied over the worker's copy at commit. */
  let replayed: string[] = [];
  /** The namespace a stamped load committed to, checked against the first answer. */
  let stampedFrom: string | null = null;
  // Captured now, before a page can replace them to read what crosses the channel.
  const rawParse = JSON.parse;
  const rawStringify = JSON.stringify;
  const cookieDesc = (() => {
    try {
      return Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    } catch {
      return undefined;
    }
  })();

  function jarKey(c: PageCookie): string {
    return `${c.n}\n${c.d}\n${c.p}\n${c.h ? 1 : 0}`;
  }

  function mergeJar(list: unknown): void {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Partial<PageCookie>;
      if (typeof c.n !== 'string' || typeof c.v !== 'string') continue;
      if (typeof c.d !== 'string' || typeof c.p !== 'string') continue;
      const cookie: PageCookie = {
        n: c.n,
        v: c.v,
        d: c.d,
        p: c.p,
        h: c.h === true,
        s: c.s === true,
        e: typeof c.e === 'number' ? c.e : null,
      };
      if (cookie.e !== null && cookie.e <= now) jar.delete(jarKey(cookie));
      else jar.set(jarKey(cookie), cookie);
    }
  }

  function seedJar(list: unknown): void {
    jar.clear();
    mergeJar(list);
  }

  function saveJar(): void {
    try {
      if (mode === 'live' && real.session) real.session.setItem(JAR, rawStringify([...jar.values()]));
    } catch {
      /* quota or a disabled store; the next load waits for the worker instead */
    }
  }

  function loadJar(): void {
    try {
      const raw = real.session?.getItem(JAR);
      if (raw) seedJar(rawParse(raw));
    } catch {
      /* an unreadable snapshot is the same as none */
    }
  }

  function pathMatches(path: string, cookiePath: string): boolean {
    if (path === cookiePath) return true;
    if (!path.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
  }

  function onSecureOrigin(): boolean {
    return location.protocol === 'https:' || location.hostname === 'localhost';
  }

  /** The Cookie string this document would see, built the way the browser builds it. */
  function readJar(): string {
    const host = location.hostname;
    const path = location.pathname || '/';
    const now = Date.now();
    const hits = [...jar.values()].filter(
      (c) =>
        (c.e === null || c.e > now) &&
        (c.h ? host === c.d : host === c.d || host.endsWith(`.${c.d}`)) &&
        pathMatches(path, c.p) &&
        (!c.s || onSecureOrigin())
    );
    hits.sort((a, b) => b.p.length - a.p.length);
    return hits.map((c) => (c.n ? `${c.n}=${c.v}` : c.v)).join('; ');
  }

  function defaultPath(): string {
    const path = location.pathname || '/';
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  }

  /** One document.cookie assignment, as the parts the browser would act on. */
  function parseWrite(value: string): PageCookie | null {
    const parts = value.split(';');
    const first = parts.shift() ?? '';
    const eq = first.indexOf('=');
    const n = (eq === -1 ? '' : first.slice(0, eq)).trim();
    const v = (eq === -1 ? first : first.slice(eq + 1)).trim();
    if (!n && !v) return null;
    const host = location.hostname;
    let d = host;
    let h = true;
    let p = defaultPath();
    let s = false;
    let e: number | null = null;
    let maxAge: number | null = null;
    for (const raw of parts) {
      const i = raw.indexOf('=');
      const k = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
      const val = i === -1 ? '' : raw.slice(i + 1).trim();
      // A script cannot set an HttpOnly cookie; the browser drops the write.
      if (k === 'httponly') return null;
      if (k === 'domain' && val) {
        const dom = val.replace(/^\./, '').toLowerCase();
        if (host !== dom && !host.endsWith(`.${dom}`)) return null;
        d = dom;
        h = false;
      } else if (k === 'path' && val.startsWith('/')) {
        p = val;
      } else if (k === 'secure') {
        s = true;
      } else if (k === 'max-age') {
        const m = Number(val);
        if (Number.isFinite(m)) maxAge = m;
      } else if (k === 'expires') {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) e = t;
      }
    }
    if (maxAge !== null) e = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
    if (s && !onSecureOrigin()) return null;
    if (n.startsWith('__Secure-') && !s) return null;
    if (n.startsWith('__Host-') && (!s || !h || p !== '/')) return null;
    return { n, v, d, p, h, s, e };
  }

  function writeJar(value: string): boolean {
    const cookie = parseWrite(value);
    if (!cookie) return false;
    mergeJar([cookie]);
    return true;
  }

  /** Take a pending-window write back out of the browser's own jar. */
  function unsetNative(value: string): void {
    const cookie = parseWrite(value);
    if (!cookie || !cookie.n || !cookieDesc?.set) return;
    const domain = cookie.h ? '' : `; Domain=${cookie.d}`;
    try {
      cookieDesc.set.call(document, `${cookie.n}=; Max-Age=0; Path=${cookie.p}${domain}`);
    } catch {
      /* the browser refused; the value stays where the page first put it */
    }
  }

  /**
   * A load that committed from its stamp, then told a different session.
   *
   * The stamp is per origin, and a rebind can only clear the origin the tab is
   * on at that moment, so going Back to another origin can find the previous
   * session's stamp. The page has already run with that session's storage for a
   * few milliseconds, which is too long to patch up in place, so it reloads once
   * with the stale stamp gone. The reload time is kept so this can never loop.
   */
  function staleStamp(answered: string | null): boolean {
    const from = stampedFrom;
    stampedFrom = null;
    if (from === null || answered === from) return false;
    try {
      const last = Number(real.session?.getItem(RELOAD) ?? 0);
      if (Date.now() - last < 10_000) return false;
      real.session?.setItem(RELOAD, String(Date.now()));
      real.session?.removeItem(STAMP);
      real.session?.removeItem(JAR);
      real.session?.removeItem(PERSONA);
    } catch {
      return false;
    }
    location.reload();
    return true;
  }

  function usableSessionId(id: string): boolean {
    return id.length > 0 && id.length <= 128 && !id.includes(SEP);
  }

  function isNamespaced(raw: string): boolean {
    return raw.startsWith(NS) && raw.slice(NS.length).includes(SEP);
  }

  /**
   * One virtualised view over one real Storage.
   *
   * Kept as a class rather than two closures because localStorage and
   * sessionStorage differ only in which real store they sit on and whether they
   * fork, and having one implementation is the only way the two stay honest
   * with each other.
   */
  class View {
    /** Writes made before the session was known, replayed on commit. */
    private journal: Op[] = [];
    /** Set by a clear() during the pending window: stop reading through. */
    private cleared = false;

    constructor(
      private readonly store: Storage,
      /** localStorage forks the origin's own data on first use; sessionStorage
       *  is per tab and starts empty, so there is nothing to fork. */
      readonly forkable: boolean
    ) {}

    // --------------------------------------------------------------- keys

    private rawKeys(): string[] {
      const out: string[] = [];
      for (let i = 0; i < this.store.length; i++) {
        const k = this.store.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    }

    /** The keys the page is allowed to see, in store order. */
    keys(): string[] {
      const raw = this.rawKeys();
      if (mode === 'live' && sid) {
        const out: string[] = [];
        for (const k of raw) {
          const key = this.unNs(k);
          if (key !== null) out.push(key);
        }
        return out;
      }
      // Pending and passthrough both show the origin's own data. Our own keys
      // are filtered out either way: they are the extension's bookkeeping, and
      // an unmanaged tab enumerating them would see every other session's key
      // names for no reason.
      const plain = raw.filter((k) => !isNamespaced(k) && !reserved(k));
      if (mode !== 'pending') return plain;

      const seen = new Set(this.cleared ? [] : plain);
      for (const op of this.journal) {
        if (op.op === 'clear') seen.clear();
        else if (op.op === 'set') seen.add(op.key);
        else seen.delete(op.key);
      }
      return [...seen];
    }

    private ns(key: string): string {
      return `${NS}${sid}${SEP}${key}`;
    }

    private unNs(raw: string): string | null {
      if (!raw.startsWith(NS)) return null;
      const rest = raw.slice(NS.length);
      const cut = rest.indexOf(SEP);
      if (cut < 0) return null;
      return rest.slice(0, cut) === sid ? rest.slice(cut + 1) : null;
    }

    // -------------------------------------------------------------- reads

    getItem(key: string): string | null {
      if (mode === 'live' && sid) return this.store.getItem(this.ns(key));
      // Reaching another session's namespace by name is refused rather than
      // served. A page that wants it can still get at the real store, but it
      // will not arrive by accident through this object.
      if (isNamespaced(key) || reserved(key)) return null;
      if (mode === 'through') return this.store.getItem(key);

      for (let i = this.journal.length - 1; i >= 0; i--) {
        const op = this.journal[i]!;
        if (op.op === 'clear') return null;
        if (op.key !== key) continue;
        return op.op === 'set' ? op.value : null;
      }
      return this.cleared ? null : this.store.getItem(key);
    }

    get length(): number {
      return this.keys().length;
    }

    key(index: number): string | null {
      const n = Math.trunc(Number(index)) || 0;
      return this.keys()[n] ?? null;
    }

    // ------------------------------------------------------------- writes

    setItem(key: string, value: string): void {
      const k = String(key);
      const v = String(value);
      if (mode === 'live' && sid) {
        this.store.setItem(this.ns(k), v);
        return;
      }
      if (isNamespaced(k) || reserved(k)) {
        // A page writing into our prefix while unmanaged would corrupt a real
        // session's namespace. Refused loudly, because silently dropping a
        // write is the one failure mode a storage layer must not have.
        throw new DOMException(`${k} is reserved`, 'SecurityError');
      }
      if (mode === 'through') {
        this.store.setItem(k, v);
        return;
      }
      this.journal.push({ op: 'set', key: k, value: v });
    }

    removeItem(key: string): void {
      const k = String(key);
      if (mode === 'live' && sid) {
        this.store.removeItem(this.ns(k));
        return;
      }
      if (isNamespaced(k) || reserved(k)) return;
      if (mode === 'through') {
        this.store.removeItem(k);
        return;
      }
      this.journal.push({ op: 'remove', key: k });
    }

    clear(): void {
      if (mode === 'live' && sid) {
        // Only this session's keys. A real clear() would take out every other
        // session on the origin, which is the exact bug this exists to fix.
        for (const raw of this.rawKeys()) {
          if (this.unNs(raw) !== null) this.store.removeItem(raw);
        }
        return;
      }
      if (mode === 'through') {
        for (const raw of this.rawKeys()) {
          if (!isNamespaced(raw) && !reserved(raw)) this.store.removeItem(raw);
        }
        return;
      }
      this.cleared = true;
      this.journal = [{ op: 'clear' }];
    }

    // ------------------------------------------------------------- commit

    /** Copies the origin's own data into an empty namespace. Returns the count. */
    private fork(): number {
      if (!this.forkable || !sid) return 0;
      const raw = this.rawKeys();
      for (const k of raw) {
        if (this.unNs(k) !== null) return 0; // already has data, never re-fork
      }
      let copied = 0;
      for (const k of raw) {
        if (isNamespaced(k) || reserved(k)) continue;
        const v = this.store.getItem(k);
        if (v === null) continue;
        try {
          this.store.setItem(this.ns(k), v);
          copied++;
        } catch {
          // Quota. The origin's own data is still there and the page will read
          // whatever landed, which is better than aborting half way.
          break;
        }
      }
      return copied;
    }

    /** Replays the pending journal into whichever mode is now in force. */
    commit(fork: boolean): number {
      const forked = fork ? this.fork() : 0;
      const pending = this.journal;
      this.journal = [];
      const wasCleared = this.cleared;
      this.cleared = false;

      if (wasCleared && mode === 'through') {
        for (const raw of this.rawKeys()) {
          if (!isNamespaced(raw) && !reserved(raw)) this.store.removeItem(raw);
        }
      }
      for (const op of pending) {
        try {
          if (op.op === 'clear') this.clear();
          else if (op.op === 'set') this.setItem(op.key, op.value);
          else this.removeItem(op.key);
        } catch {
          /* quota, or a key that became reserved; the page sees the result */
        }
      }
      return forked;
    }
  }

  // ------------------------------------------------------- the page's view

  const METHODS = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key']);

  /**
   * A Proxy rather than a patched Storage, because a page reaches this object
   * in more ways than the four methods: `store.token`, `'token' in store`,
   * `delete store.token`, `Object.keys(store)`, `JSON.stringify(store)`, and
   * `store instanceof Storage` all have to keep working.
   */
  /**
   * The one object the handshake hands back. Its identity is never compared and
   * it is never called; being a function at all is the entire answer, because a
   * native `Storage` cannot produce one.
   */
  const handshake = (): string => HANDSHAKE;

  function expose(view: View): Storage {
    const target = Object.create(Storage.prototype) as Storage;
    Object.defineProperty(target, Symbol.toStringTag, {
      value: 'Storage',
      configurable: true,
    });

    const bound = {
      getItem: (k: unknown) => view.getItem(String(k)),
      setItem: (k: unknown, v: unknown) => view.setItem(String(k), String(v)),
      removeItem: (k: unknown) => view.removeItem(String(k)),
      clear: () => view.clear(),
      key: (i: unknown) => view.key(Number(i)),
    };

    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
        /**
         * The handshake a second evaluation asks, answered here rather than
         * left on the window as a name anybody can enumerate.
         *
         * A function is the answer specifically because a native `Storage`
         * cannot produce one: it stores strings. So a page cannot fake this by
         * storing a key, and cannot use it to talk the shim out of installing.
         * `ownKeys` never mentions it, so it does not appear in
         * `Object.keys`, `JSON.stringify` or anything else that enumerates.
         */
        if (prop === HANDSHAKE) return handshake;
        if (prop === 'length') return view.length;
        // Native Storage gives its own members precedence over stored keys, so
        // a site storing something called "clear" still gets the method.
        if (METHODS.has(prop)) return bound[prop as keyof typeof bound];
        const v = view.getItem(prop);
        return v === null ? undefined : v;
      },
      set(_t, prop, value) {
        if (typeof prop === 'symbol') return false;
        if (prop === 'length' || METHODS.has(prop)) return true;
        view.setItem(prop, String(value));
        return true;
      },
      has(t, prop) {
        if (typeof prop === 'symbol') return Reflect.has(t, prop);
        if (prop === 'length' || METHODS.has(prop)) return true;
        return view.getItem(prop) !== null;
      },
      deleteProperty(_t, prop) {
        if (typeof prop === 'symbol') return true;
        view.removeItem(prop);
        return true;
      },
      ownKeys() {
        return view.keys();
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        const v = view.getItem(prop);
        if (v === null) return undefined;
        // Configurable, or the proxy invariant for ownKeys is violated the
        // moment a key is removed between two traps.
        return { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_t, prop, desc) {
        if (typeof prop === 'symbol') return false;
        if ('value' in desc) view.setItem(prop, String(desc.value));
        return true;
      },
      getPrototypeOf() {
        return Storage.prototype;
      },
      preventExtensions() {
        return false;
      },
    });
  }

  const views: { local?: View; session?: View } = {};
  const proxies: { local?: Storage; session?: Storage } = {};

  if (real.local) {
    views.local = new View(real.local, true);
    proxies.local = expose(views.local);
  }
  if (real.session) {
    views.session = new View(real.session, false);
    proxies.session = expose(views.session);
  }

  for (const [name, proxy] of [
    ['localStorage', proxies.local],
    ['sessionStorage', proxies.session],
  ] as const) {
    if (!proxy) continue;
    try {
      // An own accessor on the window shadows the one on Window.prototype.
      // Configurable, because a page shipping its own storage polyfill must
      // still be able to install it rather than throwing on load.
      Object.defineProperty(window, name, {
        get: () => proxy,
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* a page that already froze it; nothing to virtualise */
    }
  }

  // ------------------------------------------------------- storage events

  /**
   * A storage event carries a raw key, so without translation a page learns
   * every other session's key names and gets woken by writes that are not its
   * own. Cross-tab sign-out listeners are the common case and they must still
   * fire, so ours are re-dispatched with the key the page expects.
   */
  const synthetic = new WeakSet<Event>();
  window.addEventListener(
    'storage',
    (e) => {
      const ev = e as StorageEvent;
      if (synthetic.has(ev)) return;
      ev.stopImmediatePropagation();

      const key = ev.key;
      const area = ev.storageArea === real.session ? 'session' : 'local';
      const proxy = area === 'session' ? proxies.session : proxies.local;
      if (!proxy) return;

      let out: string | null;
      if (key === null) {
        out = null; // a clear(), which is ours to forward only when live
        if (mode !== 'live') return;
      } else if (mode === 'live' && sid) {
        const rest = key.startsWith(NS) ? key.slice(NS.length) : null;
        const cut = rest === null ? -1 : rest.indexOf(SEP);
        if (cut < 0 || rest!.slice(0, cut) !== sid) return;
        out = rest!.slice(cut + 1);
      } else {
        if (isNamespaced(key) || reserved(key)) return;
        out = key;
      }

      const next = new StorageEvent('storage', {
        key: out,
        oldValue: ev.oldValue,
        newValue: ev.newValue,
        url: ev.url,
        storageArea: proxy,
      });
      synthetic.add(next);
      window.dispatchEvent(next);
    },
    true
  );

  /**
   * The rest of what a page shares with every other tab on its origin.
   *
   * Web Locks are named per origin, so two sessions elected one leader between
   * them, and an auth library renewing tokens only in its leader tab let the
   * other session's tokens lapse: names are scoped like storage keys. The
   * cookie store API and FedCM read the browser's own jar and its signed-in
   * accounts, which in a managed tab are another identity, so they are absent
   * there and sites fall back to document.cookie and a sign-in popup, which do
   * carry the session. A shared worker's requests have no tab, so no session.
   */
  const decided: (() => void)[] = [];
  const whenDecided = () =>
    mode === 'pending' ? new Promise<void>((resolve) => decided.push(resolve)) : Promise.resolve();
  const lockName = (name: string) => (mode === 'live' && sid ? `${NS}${sid}${SEP}${name}` : name);
  try {
    const proto = window.LockManager?.prototype as unknown as Record<string, unknown> | undefined;
    const request = proto?.request;
    const query = proto?.query;
    if (proto && typeof request === 'function') {
      Object.defineProperty(proto, 'request', {
        configurable: true,
        writable: true,
        value(this: LockManager, name: string, ...rest: unknown[]) {
          return whenDecided().then(() =>
            (request as (...a: unknown[]) => unknown).call(this, lockName(String(name)), ...rest)
          );
        },
      });
    }
    if (proto && typeof query === 'function') {
      Object.defineProperty(proto, 'query', {
        configurable: true,
        writable: true,
        value(this: LockManager) {
          return whenDecided()
            .then(() => (query as () => Promise<LockManagerSnapshot>).call(this))
            .then((snap) => {
              const own = (list: LockInfo[] | undefined) =>
                (list ?? []).flatMap((l) => {
                  const n = l.name ?? '';
                  if (mode === 'live' && sid) {
                    const head = `${NS}${sid}${SEP}`;
                    return n.startsWith(head) ? [{ ...l, name: n.slice(head.length) }] : [];
                  }
                  return isNamespaced(n) ? [] : [l];
                });
              return { held: own(snap.held), pending: own(snap.pending) };
            });
        },
      });
    }
  } catch {
    /* no Web Locks here */
  }
  const hideWhenManaged = (target: object, key: string) => {
    try {
      const desc =
        Object.getOwnPropertyDescriptor(target, key) ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) as object, key);
      if (!desc) return;
      const read = desc.get ?? (() => desc.value);
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: desc.enumerable ?? false,
        get() {
          return mode === 'through' ? read.call(this) : undefined;
        },
        set(v: unknown) {
          Object.defineProperty(target, key, { configurable: true, writable: true, value: v });
        },
      });
    } catch {
      /* left as it is */
    }
  };
  hideWhenManaged(window, 'cookieStore');
  hideWhenManaged(window, 'CookieStore');
  hideWhenManaged(window, 'IdentityCredential');
  hideWhenManaged(window, 'SharedWorker');
  try {
    const proto = window.CredentialsContainer?.prototype as unknown as Record<string, unknown> | undefined;
    const get = proto?.get;
    if (proto && typeof get === 'function') {
      Object.defineProperty(proto, 'get', {
        configurable: true,
        writable: true,
        value(this: CredentialsContainer, options?: { identity?: unknown }, ...rest: unknown[]) {
          if (!options || !('identity' in options)) return (get as (...a: unknown[]) => unknown).call(this, options, ...rest);
          return whenDecided().then(() =>
            mode === 'through'
              ? (get as (...a: unknown[]) => unknown).call(this, options, ...rest)
              : Promise.reject(new DOMException('Browser sign-in is off in an isolated session.', 'NotAllowedError'))
          );
        },
      });
    }
  } catch {
    /* no credential management here */
  }

  /**
   * The page's first request waits until its session's rules are current.
   *
   * A page's own response can set a cookie the page then needs at once: a form
   * posted on load, a fetch the moment the script runs. The rule carrying that
   * cookie is installed a few milliseconds after the response, so the request
   * left without it, and a POST cannot be asked for again. So the first request
   * of a document in a session waits one round trip to the worker, which
   * answers once every rule it owes is in. After that nothing waits. Not in a
   * frame, which has no agent to answer, and not on an unmanaged page.
   */
  const settleWaiters: (() => void)[] = [];
  let settled: Promise<void> | null = null;
  // A response can carry a cookie the next request needs, and a sign-in step
  // sends that next request at once. So a request sent shortly after a response
  // waits too, once per response, and one sent later does not.
  let lastResponse = -1;
  let settledFor = -1;
  const markResponse = () => {
    lastResponse = performance.now();
  };
  const inFrame = (() => {
    try {
      return window.top !== window;
    } catch {
      return true;
    }
  })();
  const needsSettle = () => {
    if (inFrame || mode === 'through') return false;
    if (settled === null) return true;
    return lastResponse > settledFor && performance.now() - lastResponse < 300;
  };
  let inFlight: Promise<void> | null = null;
  function settle(): Promise<void> {
    if (inFlight) return inFlight;
    settledFor = Math.max(lastResponse, 0);
    inFlight = new Promise<void>((resolve) => {
      settleWaiters.push(resolve);
      tell('settle');
      setTimeout(resolve, 1500);
    }).then(() => {
      inFlight = null;
    });
    settled = inFlight;
    return inFlight;
  }
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      const tracked = (p: Promise<Response>) =>
        p.then(
          (r) => {
            markResponse();
            return r;
          },
          (e: unknown) => {
            markResponse();
            throw e;
          }
        );
      window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
        if (!needsSettle()) return tracked(nativeFetch.apply(this, args));
        return settle().then(() => tracked(nativeFetch.apply(this, args)));
      } as typeof fetch;
    }
    const xhr = window.XMLHttpRequest?.prototype as unknown as Record<string, unknown> | undefined;
    const send = xhr?.send;
    const open = xhr?.open;
    if (xhr && typeof send === 'function' && typeof open === 'function') {
      const sync = new WeakSet<object>();
      Object.defineProperty(xhr, 'open', {
        configurable: true,
        writable: true,
        value(this: XMLHttpRequest, ...args: unknown[]) {
          if (args[2] === false) sync.add(this);
          return (open as (...a: unknown[]) => unknown).apply(this, args);
        },
      });
      Object.defineProperty(xhr, 'send', {
        configurable: true,
        writable: true,
        value(this: XMLHttpRequest, ...args: unknown[]) {
          // A synchronous request cannot be held without blocking the page.
          this.addEventListener('loadend', markResponse);
          if (!needsSettle() || sync.has(this)) return (send as (...a: unknown[]) => unknown).apply(this, args);
          void settle().then(() => (send as (...a: unknown[]) => unknown).apply(this, args));
        },
      });
    }
  } catch {
    /* left native */
  }

  /**
   * A form posted into a new tab, held until that tab is in this session.
   *
   * A new tab is put in its session when the browser reports it, which is after
   * it has started loading, so a POST into one went out with no cookies: the
   * AWS console's "add session" opened a tab that answered with a 404. A GET can
   * be loaded again, a POST cannot, so the post waits. The tab is opened blank
   * first, the worker says when it is bound and its rules are in, and the form
   * is then submitted into it. On an unmanaged page nothing here runs.
   */
  const SAME_CONTEXT = new Set(['', '_self', '_parent', '_top']);
  const childReady: (() => void)[] = [];
  const awaitChild = () =>
    new Promise<void>((resolve) => {
      childReady.push(resolve);
      tell('child');
      setTimeout(resolve, 3000);
    });
  let holdingForm = false;
  function opensNewTab(form: HTMLFormElement, submitter?: HTMLElement | null): string | null {
    const target = (submitter?.getAttribute('formtarget') ?? form.getAttribute('target') ?? '').trim();
    if (SAME_CONTEXT.has(target.toLowerCase())) return null;
    const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase();
    if (method !== 'post') return null;
    try {
      // A name already taken by a frame or window posts there, not to a new tab.
      if (target !== '_blank' && (window.frames as unknown as Record<string, unknown>)[target]) return null;
    } catch {
      return null;
    }
    return target;
  }
  const Form = typeof HTMLFormElement === 'function' ? HTMLFormElement : null;
  const nativeSubmit = Form ? Form.prototype.submit : null;
  function holdAndPost(form: HTMLFormElement, target: string, submitter?: HTMLElement | null): void {
    holdingForm = true;
    const name = target === '_blank' ? `nvx${Math.random().toString(36).slice(2)}` : target;
    const extra: HTMLInputElement[] = [];
    const named = submitter as HTMLButtonElement | HTMLInputElement | null | undefined;
    if (named?.name) {
      const carry = document.createElement('input');
      carry.type = 'hidden';
      carry.name = named.name;
      carry.value = named.value ?? '';
      extra.push(carry);
    }
    try {
      window.open('about:blank', name);
    } catch {
      /* a blocked popup posts into the named target as it would have */
    }
    void awaitChild().then(() => {
      const before = form.getAttribute('target');
      form.setAttribute('target', name);
      for (const e of extra) form.appendChild(e);
      try {
        nativeSubmit?.call(form);
      } finally {
        for (const e of extra) e.remove();
        if (before === null) form.removeAttribute('target');
        else form.setAttribute('target', before);
        holdingForm = false;
      }
    });
  }
  window.addEventListener(
    'submit',
    (e) => {
      if (mode !== 'live' || holdingForm || e.defaultPrevented) return;
      const form = e.target as HTMLFormElement | null;
      if (!Form || !(form instanceof Form)) return;
      const submitter = (e as SubmitEvent).submitter ?? null;
      const target = opensNewTab(form, submitter);
      if (target === null) {
        const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase();
        if (method !== 'post' || !needsSettle()) return;
        e.preventDefault();
        void settle().then(() => nativeSubmit?.call(form));
        return;
      }
      e.preventDefault();
      holdAndPost(form, target, submitter);
    },
    false
  );
  try {
    if (Form && nativeSubmit) Object.defineProperty(Form.prototype, 'submit', {
      configurable: true,
      writable: true,
      value(this: HTMLFormElement) {
        const target = mode === 'live' && !holdingForm ? opensNewTab(this) : null;
        if (target === null) {
          const method = (this.getAttribute('method') ?? 'get').toLowerCase();
          if (method === 'post' && needsSettle()) {
            void settle().then(() => nativeSubmit.call(this));
            return;
          }
          return nativeSubmit.call(this);
        }
        holdAndPost(this, target);
      },
    });
  } catch {
    /* left native */
  }

  /**
   * BroadcastChannel, namespaced like storage.
   *
   * A channel is shared by every same-origin context by name, so two sessions
   * on one site heard each other: an auth library syncing tokens across tabs
   * (Okta's does it this way) handed one session's token to the other, and a
   * sign-out in one signed the other out. The page keeps its own name; the
   * channel underneath is per session. Created before the session is known, a
   * channel queues what it posts and opens its real channel on commit.
   */
  const channelsWaiting: (() => void)[] = [];
  try {
    const Native = window.BroadcastChannel;
    if (typeof Native === 'function') {
      const scoped = (name: string) => (mode === 'live' && sid ? `${NS}${sid}${SEP}${name}` : name);
      class Channel extends EventTarget {
        readonly name: string;
        onmessage: ((this: Channel, ev: MessageEvent) => unknown) | null = null;
        onmessageerror: ((this: Channel, ev: MessageEvent) => unknown) | null = null;
        private inner: BroadcastChannel | null = null;
        private queued: unknown[] = [];
        private closed = false;
        constructor(name: string) {
          super();
          this.name = String(name);
          if (mode === 'pending') channelsWaiting.push(() => this.open());
          else this.open();
        }
        private open(): void {
          if (this.closed || this.inner) return;
          const inner = new Native(scoped(this.name));
          const relay = (type: 'message' | 'messageerror') => (e: Event) => {
            const m = e as MessageEvent;
            const out = new MessageEvent(type, { data: m.data, origin: m.origin, lastEventId: m.lastEventId });
            const handler = type === 'message' ? this.onmessage : this.onmessageerror;
            if (typeof handler === 'function') handler.call(this, out);
            this.dispatchEvent(out);
          };
          inner.onmessage = relay('message');
          inner.onmessageerror = relay('messageerror');
          this.inner = inner;
          for (const data of this.queued.splice(0)) inner.postMessage(data);
        }
        postMessage(data: unknown): void {
          if (this.closed) throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
          if (this.inner) this.inner.postMessage(data);
          else this.queued.push(structuredClone(data));
        }
        close(): void {
          this.closed = true;
          this.queued = [];
          this.inner?.close();
          this.inner = null;
        }
      }
      Object.defineProperty(window, 'BroadcastChannel', { configurable: true, writable: true, value: Channel });
    }
  } catch {
    /* no BroadcastChannel here, so nothing to keep apart */
  }

  // -------------------------------------------------------------- handshake

  function tell(kind: string, detail: Record<string, unknown> = {}): void {
    if (!CHANNEL) return;
    try {
      // Serialised, because a detail object crossing world boundaries is not
      // guaranteed to arrive as the same shape it left as. Dispatched through
      // the captured primitive, so a page that replaced dispatchEvent after
      // document_start does not see the traffic or the channel it is on.
      rawDispatch.call(
        document,
        new CustomEvent(`${CHANNEL}.${kind}`, { detail: JSON.stringify(detail) })
      );
    } catch {
      /* the document went away mid-handshake */
    }
  }

  let acked = false;
  let warned = false;

  /**
   * The mask's half of the same trick, kept out of `commit` on purpose.
   *
   * `commit` returns early when it is told the session it already has, which is
   * the common case for a re-answer: nothing about the storage view needs
   * redoing. But the posture can change without the session changing, and a
   * worker that has just been told to stop using personas answers with the same
   * session id and a persona of null. Folded into `commit` that message was
   * dropped by the early return and the tab kept its persona until it happened
   * to be rebound, which is a setting the user changed and did not get.
   *
   * `undefined` means the worker said nothing about it, which is what an older
   * build's message looks like, so the key is left exactly as it was. `null`
   * means it said there is no persona, which clears it.
   */
  function setPersona(material: string | null | undefined): void {
    if (material === undefined || !real.session) return;
    try {
      if (material && mode === 'live') real.session.setItem(PERSONA, material);
      else real.session.removeItem(PERSONA);
    } catch {
      /* quota or a disabled store */
    }
  }

  function commit(next: string | null, fork: boolean): void {
    if (next !== null && !usableSessionId(next)) return;
    if (mode !== 'pending' && next === sid) return;

    sid = next;
    mode = next === null ? 'through' : 'live';

    const forked =
      (views.local?.commit(fork && mode === 'live') ?? 0) +
      (views.session?.commit(false) ?? 0);

    try {
      // The stamp is what removes the pending window from every load after the
      // first: sessionStorage is per tab and per origin, so the next document
      // in this tab, and any same-origin frame in it, knows its session before
      // the worker has been asked.
      if (mode === 'live' && real.session) {
        real.session.setItem(STAMP, sid!);
      } else {
        real.session?.removeItem(STAMP);
      }
    } catch {
      /* quota or a disabled store; the handshake still works, just slower */
    }

    tell('state', { sid, mode, forked, idb: idbUsed });
    settleWorkers();
    for (const rebind of channelsWaiting.splice(0)) rebind();
    for (const go of decided.splice(0)) go();

    // Replay any document.cookie writes made before the session was known. On a
    // managed tab they belong in the store; on an unmanaged one they were only
    // ever native, so they are dropped rather than sent.
    if (cookieJournal.length) {
      const pending = cookieJournal.splice(0);
      if (mode === 'live') {
        for (const value of pending) {
          tell('cookie', { value, url: location.href });
          // It also went to the browser's own jar while nobody knew better.
          // Taken back out, so this session's write does not reach other tabs.
          unsetNative(value);
        }
        replayed = pending;
      }
    }
  }

  /**
   * IndexedDB, reported when a page uses it.
   *
   * IndexedDB is shared between sessions on the same origin, and knowing that a
   * specific site uses it is the honest disclosure, because Firebase, Supabase
   * and Auth0 all keep tokens there and two sessions on such a site can otherwise
   * read each other's login while every other part of this extension is working.
   * So a page that opens a database is named to the worker, which surfaces it in
   * the Storage view. Closing that gap, by namespacing the database under the
   * session, is a Pro feature that lives outside this free shim.
   */
  let idbUsed = false;

  /**
   * Service workers, off in a managed tab.
   *
   * A worker is one per origin and shared by every tab on it, whichever session
   * each tab is in, and the requests it makes carry no tab. With two sessions on
   * a site, those requests matched no session's rule and went out with the
   * browser's own cookies: YouTube's worker had both sessions' tabs showing the
   * profile's account. No rule can say which tab a worker request is for, so a
   * managed page does not get one. Registration fails as it does in a private
   * window, which every site has to handle, and a worker already controlling
   * the page is unregistered and the page loaded once more without it.
   */
  const workerReady: ((managed: boolean) => void)[] = [];
  function settleWorkers(): void {
    const managed = mode === 'live';
    for (const resolve of workerReady.splice(0)) resolve(managed);
    if (!managed) return;
    const container = navigator.serviceWorker;
    if (!container) return;
    const controlled = Boolean(container.controller);
    void container
      .getRegistrations()
      .then((all) => Promise.all(all.map((r) => r.unregister())))
      .then(() => {
        if (!controlled) return;
        try {
          const last = Number(real.session?.getItem(RELOAD) ?? 0);
          if (Date.now() - last < 10_000) return;
          real.session?.setItem(RELOAD, String(Date.now()));
        } catch {
          return;
        }
        location.reload();
      })
      .catch(() => undefined);
  }
  try {
    const proto = window.ServiceWorkerContainer?.prototype as unknown as Record<string, unknown> | undefined;
    const register = proto?.register;
    if (proto && typeof register === 'function') {
      Object.defineProperty(proto, 'register', {
        configurable: true,
        writable: true,
        value(this: ServiceWorkerContainer, ...args: unknown[]) {
          const refuse = () =>
            Promise.reject(new DOMException('Service workers are off in an isolated session.', 'SecurityError'));
          if (mode === 'live') return refuse();
          if (mode === 'through') return (register as (...a: unknown[]) => unknown).apply(this, args);
          return new Promise<boolean>((resolve) => workerReady.push(resolve)).then((managed) =>
            managed ? refuse() : (register as (...a: unknown[]) => unknown).apply(this, args)
          );
        },
      });
    }
  } catch {
    /* no worker support here, so nothing to keep off */
  }

  // IndexedDB: open reports the first use of a shared database to the worker.
  try {
    const factory = window.indexedDB;
    const proto = factory && (Object.getPrototypeOf(factory) as object | null);
    if (proto) {
      const open = (proto as Record<string, unknown>).open;
      if (typeof open === 'function') {
        Object.defineProperty(proto, 'open', {
          configurable: true,
          writable: true,
          value(this: IDBFactory, ...args: unknown[]) {
            if (!idbUsed) {
              idbUsed = true;
              // Its own message rather than a state one, whose fork count means
              // nothing outside a commit.
              tell('idb', { used: true });
            }
            return (open as (...a: unknown[]) => IDBOpenDBRequest).apply(this, args);
          },
        });
      }
    }
  } catch {
    // A page that will not let its factory be wrapped keeps its IndexedDB and
    // loses the disclosure, which is the right way round: no report is worth
    // breaking a database call over.
  }

  /**
   * document.cookie, answered from the session in a managed tab.
   *
   * Live: reads come from the session view above, and writes go into it and on
   * to the worker, never into the browser's own jar, because that jar is shared
   * by every tab on the site. A site that sets a probe cookie and reads it back
   * (Google and Slack both do) sees it, and so does the next request.
   *
   * Pending: the session is not known yet, so the page gets the browser's own
   * behaviour, and each write is journalled. If the tab turns out to be managed
   * the journal is forwarded and the native copy taken back out; if not, the
   * native write was simply correct. Through: native, untouched.
   */
  function forwardCookie(value: string): void {
    tell('cookie', { value, url: location.href });
  }
  try {
    const desc = cookieDesc;
    if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
      const nativeGet = desc.get;
      const nativeSet = desc.set;
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        enumerable: desc.enumerable ?? true,
        get(this: Document): string {
          if (mode === 'live' && this === document) return readJar();
          return nativeGet.call(this) as string;
        },
        set(this: Document, value: string) {
          const text = String(value);
          if (mode === 'live' && this === document) {
            if (writeJar(text)) {
              saveJar();
              try {
                forwardCookie(text);
              } catch {
                /* forwarding is best effort; the view already holds the write */
              }
            }
            return;
          }
          nativeSet.call(this, value);
          if (mode === 'pending' && this === document) cookieJournal.push(text);
        },
      });
    }
  } catch {
    // A browser that will not let document.cookie be wrapped keeps native
    // behaviour, which is the same graceful loss as an unwrappable IndexedDB.
  }

  rawListen.call(document, `${CHANNEL}.wait`, () => {
    acked = true;
  });

  rawListen.call(document, `${CHANNEL}.commit`, (e) => {
    let payload: { sid?: unknown; fork?: unknown; persona?: unknown; cookies?: unknown } = {};
    try {
      payload = JSON.parse(String((e as CustomEvent).detail ?? '{}'));
    } catch {
      return;
    }
    acked = true;
    const answered = typeof payload.sid === 'string' ? payload.sid : null;
    if (staleStamp(answered)) return;
    commit(answered, payload.fork === true);
    // The worker's copy of the session's cookies for this site, with anything
    // the page wrote before it was known laid back over the top.
    if (mode === 'live') {
      if (Array.isArray(payload.cookies)) seedJar(payload.cookies);
      for (const w of replayed.splice(0)) writeJar(w);
      saveJar();
    }
    // After the commit, because whether a persona is written depends on the mode
    // that commit just settled.
    setPersona(
      typeof payload.persona === 'string'
        ? payload.persona
        : payload.persona === null
          ? null
          : undefined
    );
  });

  rawListen.call(document, `${CHANNEL}.settle.ready`, () => {
    for (const go of settleWaiters.splice(0)) go();
  });

  rawListen.call(document, `${CHANNEL}.child.ready`, () => {
    for (const go of childReady.splice(0)) go();
  });

  rawListen.call(document, `${CHANNEL}.jar`, (e) => {
    if (mode !== 'live') return;
    try {
      const payload = rawParse(String((e as CustomEvent).detail ?? '{}')) as { cookies?: unknown };
      mergeJar(payload.cookies);
      saveJar();
    } catch {
      /* malformed; the next push or load corrects it */
    }
  });

  rawListen.call(document, `${CHANNEL}.reset`, () => {
    try {
      real.session?.removeItem(STAMP);
      real.session?.removeItem(PERSONA);
      real.session?.removeItem(JAR);
    } catch {
      /* nothing to clear */
    }
  });


  /**
   * The announcement comes first, and the order is load bearing.
   *
   * The agent runs in the ISOLATED world of the same document and, measured on
   * both browsers, at document_start it runs before this does, so its listener
   * for this name is already attached and its ack arrives synchronously.
   *
   * This is the one message on a name anybody could guess, and the only one sent
   * before the page's first script exists, which is what makes announcing the
   * nonce in it safe: nothing is listening yet.
   *
   * It used to sit below the stamp, and moving the traffic onto a nonce is what
   * exposed why that was wrong. A stamped tab commits during that block, and a
   * commit reports its state; sent before the channel is known, that report goes
   * to a name nobody will ever listen on. The worker would then have no state
   * for the second and every later load in a tab, which is most loads.
   */
  if (CHANNEL) {
    try {
      rawDispatch.call(
        document,
        new CustomEvent(ANNOUNCE, { detail: JSON.stringify({ channel: CHANNEL }) })
      );
    } catch {
      /* the document went away mid-handshake */
    }
  }

  /**
   * A stamp left by an earlier load in this tab. Trusted only as far as the
   * pending window, because the agent's commit overrides it a few milliseconds
   * later; what it buys is that a page reading its token in the first inline
   * script gets the right one rather than the origin's shared copy.
   *
   * It is cleared on rebind, so it cannot outlive the binding that wrote it.
   */
  let stamped: string | null = null;
  try {
    stamped = real.session?.getItem(STAMP) ?? null;
  } catch {
    stamped = null;
  }
  if (stamped && usableSessionId(stamped)) {
    commit(stamped, false);
    stampedFrom = stamped;
    loadJar();
  }

  /** A subframe has no agent, so silence there means something different. */
  const subframe = (() => {
    try {
      return window.top !== window;
    } catch {
      // Cross-origin top, which means this frame is not sharing the tab's
      // storage anyway and its own behaviour is the correct behaviour.
      return false;
    }
  })();

  /**
   * A same-origin subframe shares the tab's storage but gets no agent, so it
   * cannot be told which session it is in. What it can do is wait for the top
   * frame to be told and stamp it, which is the same tab and the same origin
   * and therefore the same sessionStorage.
   *
   * Waiting rather than passing through matters: passthrough in a managed tab
   * would write a framed sign-in straight into the origin's shared keys, which
   * is the leak this exists to close. Held in memory costs nothing if the wait
   * turns out to be pointless.
   */
  function waitForStamp(): void {
    let tries = 0;
    const tick = (): void => {
      if (mode !== 'pending') return;
      let seen: string | null = null;
      try {
        seen = real.session?.getItem(STAMP) ?? null;
      } catch {
        seen = null;
      }
      if (seen && usableSessionId(seen)) {
        commit(seen, false);
        loadJar();
        return;
      }
      if (++tries > 20) {
        // Nobody claimed this tab. An unmanaged tab, so the page's own
        // behaviour is the correct behaviour after all.
        commit(null, false);
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 40);
  }

  if (!acked && mode === 'pending') {
    if (subframe) waitForStamp();
    // No agent and not a frame: an unmanaged tab, where the page's own
    // behaviour is the correct behaviour.
    else commit(null, false);
  } else if (mode === 'pending') {
    setTimeout(() => {
      if (mode !== 'pending' || warned) return;
      warned = true;
      // Deliberately still pending rather than falling through to the shared
      // store. Losing writes made in the first seconds of a page whose worker
      // died is a visible, rare failure; writing a session's token into the
      // origin's shared keys would be a silent one.
      console.warn('[nvx] the session for this tab never arrived, storage is held in memory');
    }, 5000);
  }
})();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Take the session mark off a page this extension has
 *           |  stopped maintaining.
 *  How      |  Runs in the page's own world, so it survives what the
 *           |  agent cannot. It reads the timestamp the agent
 *           |  refreshes every few seconds; a stamp that stopped
 *           |  moving means nobody is left to move it.
 *  Note     |  The mark is a `link rel=icon` the agent added, so it
 *           |  belongs to the page; unloading the extension destroys
 *           |  the agent's world synchronously, so its disconnect
 *           |  handler never runs and the dot would stay on every
 *           |  managed tab until reload. Reported from real use.
 *           |  Deliberately slow and forgiving (6s checks, 20s
 *           |  staleness); worst case it shows the page's own icon
 *           |  for a moment before the agent repaints.
 * ------------------------------------------------------------------
 */
function watchTheMark(): void {
  const MARKED = 'data-nvx-mark';
  const RESTORE = 'data-nvx-was';
  const ALIVE = 'data-nvx-alive';
  const STALE_MS = 20_000;
  const EVERY_MS = 6000;

  let timer: ReturnType<typeof setInterval> | null = null;

  const restore = (): void => {
    const marks = document.querySelectorAll<HTMLLinkElement>(`link[${MARKED}]`);
    if (!marks.length) return;

    let originals: string[] = [];
    try {
      const raw = marks[0]?.getAttribute(RESTORE);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) originals = parsed.filter((h): h is string => typeof h === 'string');
    } catch {
      /* an unreadable record leaves the page with no icon, which is the
         browser's own default and still better than somebody else's dot */
    }

    for (const mark of marks) mark.remove();

    const head = document.head;
    if (!head) return;
    for (const href of originals) {
      // Not re-added if the page already put one back itself, which sites that
      // manage their own favicon do constantly.
      if (head.querySelector(`link[rel~="icon" i][href="${CSS.escape(href)}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = href;
      head.append(link);
    }
  };

  const check = (): void => {
    const stamp = Number(document.documentElement.getAttribute(ALIVE) ?? 0);
    // Never marked, or the agent is still stamping. Nothing to do either way.
    if (!document.querySelector(`link[${MARKED}]`)) return;
    if (stamp && Date.now() - stamp < STALE_MS) return;
    restore();
    if (timer) clearInterval(timer);
    timer = null;
  };

  timer = setInterval(check, EVERY_MS);
}

try {
  watchTheMark();
} catch {
  /* a page that will not let us watch is a page that keeps a dot; the mark is
     cosmetic and the isolation this file exists for must not be risked for it */
}
