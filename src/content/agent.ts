/**
 * The in-page agent.
 *
 * Runs in the ISOLATED world of every managed tab and does three things that
 * have to happen inside a page.
 *
 * It holds a long-lived port to the service worker. That is not decoration:
 * a port keeps the worker alive, and a cold worker is exactly what loses the
 * race when a managed tab opens a child tab, because the child's first request
 * can leave before the worker has woken up to bind it.
 *
 * It renders the identity chooser, in a closed shadow root so page CSS cannot
 * reach it and page script cannot read it.
 *
 * And it applies the session mark to the tab, which is the one identity channel
 * available in every browser this has to run in.
 *
 * No imports, no exports. A content script is a classic script, and a single
 * export makes tsc emit module syntax that fails to load with no diagnostic.
 */

interface ChooserOption {
  sessionId: string;
  label: string;
  color: string;
  /** What the jar suggests this account is, when it can be worked out. */
  identity?: string;
  cookies: number;
}

interface ChooserRequest {
  kind: 'chooser';
  host: string;
  options: ChooserOption[];
  currentSessionId: string | null;
}

/** The same values as --s-* in packages/ui/tokens.css, which is the source. */
const HUE: Record<string, string> = {
  cyan: '#4fd6ea',
  azure: '#5a8cf0',
  violet: '#9a7bf5',
  magenta: '#e56ec4',
  coral: '#ef6f52',
  jade: '#3fcf8e',
  amber: '#eca93a',
  chalk: '#dfe4ec',
};

let mount: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let restoreFocusTo: Element | null = null;

/** Per-document, so the chooser's host element is not a fixed selector. */
const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
  b.toString(16).padStart(2, '0')
).join('');

function teardown(): void {
  mount?.remove();
  mount = null;
  root = null;
  if (restoreFocusTo instanceof HTMLElement) restoreFocusTo.focus();
  restoreFocusTo = null;
  document.removeEventListener('keydown', onKey, true);
}

function onKey(e: KeyboardEvent): void {
  if (!root) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    teardown();
    return;
  }
  // The chooser is modal, so focus must not escape into a page that is showing
  // whichever account happened to be signed in.
  if (e.key === 'Tab') {
    const items = [...root.querySelectorAll<HTMLElement>('[data-focusable]')];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = root.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

const SHEET = `
:host { all: initial; }
.scrim {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(3,4,5,.82); backdrop-filter: blur(10px);
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  animation: fade .22s cubic-bezier(.19,1,.22,1) both;
}
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes pop {
  from { opacity: 0; transform: scale(.972) translateY(-8px) }
  to { opacity: 1; transform: none }
}
.card {
  width: min(440px, 92vw);
  background: #14161a; border: 1px solid rgba(239,240,234,.16);
  padding: 26px; color: #eff0ea;
  animation: pop .3s cubic-bezier(.19,1,.22,1) both;
  box-shadow: 0 50px 100px -40px rgba(0,0,0,.9);
}
.eyebrow {
  font-size: 10px; letter-spacing: .22em; color: #dcea4f;
  margin: 0 0 14px; text-transform: uppercase;
}
h2 {
  font-family: "Bodoni Moda", Georgia, serif;
  font-size: 23px; font-weight: 500; letter-spacing: -.01em;
  margin: 0 0 6px; color: #eff0ea;
}
.sub { font-size: 11px; letter-spacing: .06em; color: #8a9096; margin: 0 0 20px; line-height: 1.5; }
.sub b { color: #cfd2d5; font-weight: 400; }
.opt {
  display: grid; grid-template-columns: 10px minmax(0,1fr) auto;
  gap: 13px; align-items: center; width: 100%;
  padding: 13px 12px; margin-bottom: 6px;
  background: rgba(239,240,234,.02);
  border: 1px solid rgba(239,240,234,.1);
  color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: border-color .2s cubic-bezier(.19,1,.22,1), background .2s cubic-bezier(.19,1,.22,1);
}
.opt:hover, .opt:focus-visible {
  border-color: #dcea4f; background: rgba(220,234,79,.06); outline: none;
}
.opt:focus-visible { outline: 2px solid #dcea4f; outline-offset: 2px; }
.dot { width: 9px; height: 9px; border-radius: 50%; }
.name {
  font-family: "Bodoni Moda", Georgia, serif; font-size: 17px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.who { font-size: 10px; letter-spacing: .08em; color: #8a9096; margin-top: 2px; }
.meta { font-size: 9px; letter-spacing: .1em; color: #565c63; white-space: nowrap; }
.current { color: #dcea4f; }
.foot {
  display: flex; gap: 8px; margin-top: 16px; padding-top: 14px;
  border-top: 1px solid rgba(239,240,234,.1);
}
.ghost {
  flex: 1; padding: 9px; background: none; color: #8a9096;
  border: 1px solid rgba(239,240,234,.1); font: inherit;
  font-size: 9px; letter-spacing: .14em; text-transform: uppercase; cursor: pointer;
  transition: color .2s, border-color .2s;
}
.ghost:hover, .ghost:focus-visible { color: #eff0ea; border-color: rgba(239,240,234,.3); outline: none; }
.ghost:focus-visible { outline: 2px solid #dcea4f; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .scrim, .card { animation: none }
}
`;

function render(req: ChooserRequest, choose: (sessionId: string | null) => void): void {
  teardown();
  restoreFocusTo = document.activeElement;

  mount = document.createElement('div');
  // The shadow root is closed, so the page cannot read which accounts exist.
  // The host element still sits in the light DOM, and a fixed attribute would
  // let a hostile page find and remove it, or hide it with one CSS rule, and
  // suppress the account picker entirely. A name it cannot predict costs
  // nothing and makes that a per-page guess rather than a one-liner.
  mount.setAttribute(`data-nvx-${nonce}`, '');
  // Closed, so the page cannot read which accounts exist.
  root = mount.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = SHEET;

  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', `Choose an account for ${req.host}`);

  const card = document.createElement('div');
  card.className = 'card';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'NVX // CHOOSE AN ACCOUNT';

  const h2 = document.createElement('h2');
  h2.textContent = 'Which account?';

  const sub = document.createElement('p');
  sub.className = 'sub';
  const b = document.createElement('b');
  b.textContent = req.host;
  sub.append(document.createTextNode('More than one of your sessions covers '), b);
  sub.append(document.createTextNode('. Pick one and the tab reloads under it.'));

  card.append(eyebrow, h2, sub);

  for (const opt of req.options) {
    const btn = document.createElement('button');
    btn.className = 'opt';
    btn.type = 'button';
    btn.setAttribute('data-focusable', '');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = HUE[opt.color] ?? HUE.cyan!;

    const mid = document.createElement('span');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = opt.label;
    mid.append(name);
    if (opt.identity) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = opt.identity;
      mid.append(who);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    if (opt.sessionId === req.currentSessionId) {
      meta.classList.add('current');
      meta.textContent = 'CURRENT';
    } else if (opt.cookies === 0) {
      // An empty session is the answer to "sign in as somebody else", so it
      // says what picking it does. "0 COOKIES" reads as broken.
      meta.textContent = 'SIGN IN';
    } else {
      meta.textContent = `${opt.cookies} COOKIES`;
    }

    btn.append(dot, mid, meta);
    btn.addEventListener('click', () => choose(opt.sessionId));
    card.append(btn);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  const dismiss = document.createElement('button');
  dismiss.className = 'ghost';
  dismiss.type = 'button';
  dismiss.setAttribute('data-focusable', '');
  dismiss.textContent = 'Not now';
  dismiss.addEventListener('click', () => choose(null));
  foot.append(dismiss);
  card.append(foot);

  scrim.append(card);
  root.append(style, scrim);
  document.documentElement.append(mount);

  document.addEventListener('keydown', onKey, true);
  root.querySelector<HTMLElement>('[data-focusable]')?.focus();
}

// ------------------------------------------------------------------ mark

const ICON_LINKS = 'link[rel~="icon" i]';
const MARKED = 'data-nvx-mark';

let painted: string | null = null;
let paintObserver: MutationObserver | null = null;
let beating: ReturnType<typeof setInterval> | null = null;
let reapplies: number[] = [];
let paintDisabled = false;
/**
 * The site's own icon elements, detached rather than destroyed. Unbinding a tab
 * has to give the page back exactly what it had, and the same nodes are handed
 * back so a site holding a reference to its link element still holds a live one.
 */
const stash: HTMLLinkElement[] = [];
/** The icons the page had, recorded where our own teardown cannot reach. */
const RESTORE = 'data-nvx-was';
/** Refreshed while this script exists, and stale for good once it does not. */
const ALIVE = 'data-nvx-alive';
const BEAT_MS = 4000;
const STASH_CAP = 8;

/**
 * A page can declare a thousand icon links, and each one the worker accepts is
 * a fetch it makes. Bounded here as well as in the worker, so the message stays
 * small even on a page built to make it enormous.
 */
const MAX_REPORTED_ICONS = 12;

function iconCandidates(): Array<{ href: string; type?: string; sizes?: string }> {
  const out: Array<{ href: string; type?: string; sizes?: string }> = [];
  for (const link of document.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
    if (out.length >= MAX_REPORTED_ICONS) break;
    if (link.hasAttribute(MARKED)) continue;
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      out.push({
        // Resolved here rather than in the worker, which has no notion of this
        // page's base URL and would guess wrong on any relative href.
        href: new URL(href, document.baseURI).href,
        ...(link.type ? { type: link.type } : {}),
        ...(link.sizes?.value ? { sizes: link.sizes.value } : {}),
      });
    } catch {
      /* an unparseable href is the site's problem, not ours */
    }
  }
  // Always worth a look even when nothing is declared, because it is where the
  // browser looks too.
  try {
    out.push({ href: new URL('/favicon.ico', location.href).href });
  } catch {
    /* not an http origin */
  }
  return out;
}

/**
 * Chrome resolves the tab icon from the link elements present, and its choice
 * among several is not something to rely on, so the site's own are removed
 * rather than merely outranked.
 *
 * Sites that rewrite their favicon at runtime, which is most of the ones worth
 * having sessions for, will put theirs back. Reapplying is correct, but a site
 * that reacts to our reapplication would loop, so the rate is capped and paint
 * gives up rather than spinning.
 */
function applyMark(dataUrl: string): void {
  if (paintDisabled || !document.head) return;

  /**
   * Nothing to do when the page is already wearing exactly this mark.
   *
   * Without this the function is not idempotent: the loop below keeps a marked
   * link whose href already matches and then appends another one regardless, so
   * every repaint left one more identical `link rel=icon` in the head. A
   * rebind, a colour change and a poll are all repaints, and the count only
   * ever goes up. Measured at three after a bind and a reload; on a long-lived
   * tab it is unbounded.
   */
  const worn = document.querySelector<HTMLLinkElement>(`link[${MARKED}]`);
  if (worn && worn.getAttribute('href') === dataUrl && painted === dataUrl) {
    // Still remove any duplicate that an earlier build left behind.
    for (const extra of document.querySelectorAll<HTMLLinkElement>(`link[${MARKED}]`)) {
      if (extra !== worn) extra.remove();
    }
    return;
  }

  const now = Date.now();
  reapplies = reapplies.filter((t) => now - t < 5000);
  reapplies.push(now);
  if (reapplies.length > 12) {
    paintDisabled = true;
    paintObserver?.disconnect();
    console.warn('[nvx] the page keeps replacing its favicon, leaving it alone');
    return;
  }

  for (const link of document.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
    if (link.hasAttribute(MARKED)) {
      if (link.getAttribute('href') === dataUrl) continue;
      link.remove();
      continue;
    }
    link.remove();
    if (!stash.includes(link) && stash.length < STASH_CAP) stash.push(link);
  }

  const link = document.createElement('link');
  link.setAttribute(MARKED, '');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = dataUrl;
  /**
   * What the page had before this, written onto the mark itself.
   *
   * The originals are held in `stash`, which lives in this script's isolated
   * world, and that world is destroyed the instant the extension is unloaded.
   * Nothing here gets to run at that point, which is why the mark used to
   * outlive the extension: a coloured dot on every managed tab, explained by
   * nothing, until each of those tabs happened to be reloaded.
   *
   * Recording them in the document puts them somewhere that survives, and the
   * watchdog in the page's own world can put them back without needing this
   * script, an extension API, or anything else that goes away with us.
   */
  try {
    link.setAttribute(RESTORE, JSON.stringify(stash.map((l) => l.getAttribute('href') ?? '').filter(Boolean)));
  } catch {
    /* an icon set nobody can serialise is one the watchdog will simply drop */
  }
  document.head.append(link);
  painted = dataUrl;
}

/**
 * A pulse the page's own world can see.
 *
 * The watchdog cannot ask whether this extension is still installed: it has no
 * extension APIs, by definition, because it is page script. What it can see is
 * whether anything has stamped the document recently. This is that stamp, and
 * it stops the moment we do.
 */
function beat(): void {
  try {
    document.documentElement.setAttribute(ALIVE, String(Date.now()));
  } catch {
    /* no document to stamp is the same as not being alive */
  }
}

function clearMark(): void {
  painted = null;
  for (const link of document.querySelectorAll<HTMLLinkElement>(`link[${MARKED}]`)) {
    link.remove();
  }
  if (!document.head) return;
  for (const link of stash.splice(0)) {
    if (!link.isConnected) document.head.append(link);
  }
}

function watchIcons(report: () => void): void {
  if (paintObserver || !document.head) return;
  paintObserver = new MutationObserver((records) => {
    if (paintDisabled) return;
    let foreign = false;
    for (const record of records) {
      const nodes = [...record.addedNodes, ...record.removedNodes, record.target];
      for (const node of nodes) {
        if (!(node instanceof HTMLLinkElement)) continue;
        if (node.hasAttribute(MARKED)) continue;
        if (node.rel && /(^|\s)(shortcut\s+)?icon(\s|$)/i.test(node.rel)) foreign = true;
      }
    }
    if (!foreign) return;
    // Reassert what is already known immediately so the tab does not flash the
    // site's own icon, then ask for a repaint in case the icon itself changed.
    if (painted) applyMark(painted);
    report();
  });
  paintObserver.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'rel'],
  });
}

// ----------------------------------------------------------------- guard

interface GuardNotice {
  kind: 'guard';
  action: 'warned' | 'blocked';
  what: string;
  rule: string;
  session: string;
  url: string;
  method: string;
}

const GUARD_SHEET = `
:host { all: initial; }
.card {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
  width: min(390px, calc(100vw - 36px));
  background: #14161a; border: 1px solid rgba(239,240,234,.16);
  border-left: 3px solid var(--tone);
  padding: 16px 18px; color: #eff0ea;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  box-shadow: 0 40px 80px -34px rgba(0,0,0,.9);
  animation: rise .28s cubic-bezier(.19,1,.22,1) both;
}
@keyframes rise {
  from { opacity: 0; transform: translateY(14px) }
  to { opacity: 1; transform: none }
}
.eyebrow {
  font-size: 9px; letter-spacing: .2em; text-transform: uppercase;
  color: var(--tone); margin: 0 0 9px;
}
h2 {
  font-family: "Bodoni Moda", Georgia, serif; font-weight: 500;
  font-size: 18px; letter-spacing: -.01em; margin: 0 0 6px; color: #eff0ea;
}
.meta {
  font-size: 10px; letter-spacing: .07em; color: #8a9096;
  margin: 0; line-height: 1.6; word-break: break-all;
}
.meta b { color: #cfd2d5; font-weight: 400; }
.foot { display: flex; gap: 8px; margin-top: 14px; }
button {
  flex: 1; padding: 8px; background: none; color: #8a9096;
  border: 1px solid rgba(239,240,234,.14); font: inherit;
  font-size: 9px; letter-spacing: .14em; text-transform: uppercase; cursor: pointer;
  transition: color .18s, border-color .18s;
}
button:hover, button:focus-visible { color: #eff0ea; border-color: rgba(239,240,234,.34); outline: none; }
button:focus-visible { outline: 2px solid var(--tone); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .card { animation: none } }
`;

/**
 * A short note in the corner, for something that already happened.
 *
 * Distinct from the guard card on purpose. That one interrupts because it wants
 * a decision. This one only says what was done on the user's behalf, so it
 * asks for nothing, takes no focus, and leaves. Silence would be worse: a tab
 * quietly rejoining an account is exactly the kind of thing that has to be
 * visible, or the extension is deciding who you are without telling you.
 */
const NOTE_SHEET = `
:host { all: initial }
.note {
  position: fixed; left: 18px; bottom: 18px; z-index: 2147483646;
  display: flex; align-items: center; gap: 10px;
  padding: 11px 15px 11px 13px;
  background: rgba(12,13,15,.94);
  border: 1px solid rgba(239,240,234,.14);
  border-left: 2px solid var(--tone, #dcea4f);
  color: #eff0ea;
  font: 300 12px/1.35 'Familjen Grotesk', system-ui, sans-serif;
  letter-spacing: .01em;
  box-shadow: 0 18px 46px rgba(0,0,0,.5);
  animation: slip .4s cubic-bezier(.19,1,.22,1) both;
  backdrop-filter: blur(7px);
}
.note.out { animation: fade .5s cubic-bezier(.19,1,.22,1) both }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone, #dcea4f); flex: none }
b { font-weight: 500 }
@keyframes slip { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
@keyframes fade { to { opacity: 0; transform: translateY(6px) } }
@media (prefers-reduced-motion: reduce) { .note, .note.out { animation: none } }
`;

let noteMount: HTMLElement | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;

function showNote(text: string, accent: string, boldPart?: string): void {
  noteMount?.remove();
  if (noteTimer) clearTimeout(noteTimer);

  noteMount = document.createElement('div');
  noteMount.setAttribute(`data-nvx-${nonce}`, '');
  const root = noteMount.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = NOTE_SHEET;

  const box = document.createElement('div');
  box.className = 'note';
  box.style.setProperty('--tone', accent);

  const dot = document.createElement('span');
  dot.className = 'dot';

  const line = document.createElement('span');
  line.append(document.createTextNode(text));
  if (boldPart) {
    const b = document.createElement('b');
    b.textContent = boldPart;
    line.append(document.createTextNode(' '), b);
  }

  box.append(dot, line);
  root.append(style, box);
  (document.body ?? document.documentElement).append(noteMount);

  noteTimer = setTimeout(() => {
    box.classList.add('out');
    setTimeout(() => {
      noteMount?.remove();
      noteMount = null;
    }, 500);
  }, 3200);
}

let guardMount: HTMLElement | null = null;
let guardTimer: ReturnType<typeof setTimeout> | null = null;

function clearGuard(): void {
  guardMount?.remove();
  guardMount = null;
  if (guardTimer) clearTimeout(guardTimer);
  guardTimer = null;
}

/**
 * What the user sees when a session touches something with a blast radius.
 *
 * A warning fades, because warning on every destructive request and demanding
 * a click would be the fastest possible route to the feature being turned off.
 * A refusal does not: the request did not happen, the page is about to behave
 * as though it failed for no reason, and the user needs to know why and to have
 * a way past it.
 */
function showGuard(notice: GuardNotice, allow: () => void): void {
  clearGuard();

  guardMount = document.createElement('div');
  guardMount.setAttribute(`data-nvx-${nonce}`, '');
  const root = guardMount.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = GUARD_SHEET;

  const card = document.createElement('div');
  card.className = 'card';
  const blocked = notice.action === 'blocked';
  card.style.setProperty('--tone', blocked ? '#ef6f52' : '#dcea4f');

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = blocked ? 'NVX // REFUSED' : 'NVX // BLAST RADIUS';

  const h2 = document.createElement('h2');
  h2.textContent = blocked
    ? `Refused: ${notice.what}`
    : `This would ${notice.what}`;

  const meta = document.createElement('p');
  meta.className = 'meta';
  const who = document.createElement('b');
  who.textContent = notice.session;
  meta.append(document.createTextNode('as '), who);
  meta.append(document.createTextNode(` / ${notice.method} ${notice.url}`));

  card.append(eyebrow, h2, meta);

  const foot = document.createElement('div');
  foot.className = 'foot';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = blocked ? 'Leave it blocked' : 'Got it';
  dismiss.addEventListener('click', clearGuard);
  foot.append(dismiss);

  if (blocked) {
    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.textContent = 'Allow for 5 minutes';
    unlock.addEventListener('click', (e) => {
      // Only a real click. The shadow root is closed so a page cannot reach
      // this button to call click() on it, and it cannot forge a trusted
      // event, so an allowance can only come from the person at the keyboard.
      if (!e.isTrusted) return;
      allow();
      clearGuard();
    });
    foot.append(unlock);
  }

  card.append(foot);
  root.append(style, card);
  document.documentElement.append(guardMount);

  // A refusal stays until it is answered. A warning is information, and
  // information that will not go away is an obstruction.
  if (!blocked) guardTimer = setTimeout(clearGuard, 9000);
}

// --------------------------------------------------------------- storage

/**
 * The bridge between the storage shim in the MAIN world and the worker.
 *
 * The shim installs before it can know which session it belongs to, because the
 * binding lives in the worker and takes a round trip. It parks in a pending
 * state and asks; this relays the question and the answer.
 *
 * The channel name was fixed rather than a nonce, and the argument for that was
 * half right, which is the interesting part.
 *
 * What it said: a page forging a commit could point the shim at another
 * session's namespace, but a page can already read every namespace on its own
 * origin through a same-origin about:blank frame, so the forgery grants nothing
 * it did not already have. That still holds, and the suite confirms the forgery
 * yields nothing.
 *
 * What it missed is the other direction. The channel did not only take
 * instructions, it published: the shim announced its session id in the detail
 * of an event with a fixed name, and that id is the same string on every origin
 * in that session. Any two sites could listen, compare notes, and link the same
 * person across everything they visited. That is not a smaller version of a leak
 * the page already had, it is the exact thing this product exists to prevent,
 * offered without the page having to do anything clever at all.
 *
 * So the traffic moved onto a per-document nonce the shim generates and
 * announces once, at document_start, before the page has a script to listen
 * with. A listener cannot be attached to an event that has already been
 * dispatched, and that is the whole argument.
 */
interface ShimState {
  sid: string | null;
  mode: string;
  forked: number;
  /** Whether this document has opened an IndexedDB database. See the shim. */
  idb: boolean;
}

const ANNOUNCE = '__nvx.storage.ready';

/**
 * Captured before any page script exists, for the same reason the shim captures
 * them: a page that replaced these later would otherwise see the nonce and every
 * message on it.
 */
const rawDispatch = EventTarget.prototype.dispatchEvent;
const rawListen = EventTarget.prototype.addEventListener;

/** Learned from the announcement. Empty means no shim has spoken here. */
let channel = '';

/** Set when the shim announced itself, so a page with no shim is not waited on. */
let shimReady = false;
/** Held until the worker answers, then delivered. */
let shimAnswer: { sid: string | null; fork: boolean; persona?: string | null; idb?: boolean } | null =
  null;

function toShim(kind: string, detail: Record<string, unknown> = {}): void {
  if (!channel) return;
  try {
    rawDispatch.call(
      document,
      new CustomEvent(`${channel}.${kind}`, { detail: JSON.stringify(detail) })
    );
  } catch {
    /* the document went away */
  }
}

// Attached at evaluation time, not from inside connect(). The shim runs in the
// MAIN world of the same document and, measured on both browsers, ISOLATED runs
// first at document_start, so this listener exists before it announces itself.
// Attaching it a tick later would miss the announcement on every page.
rawListen.call(document, ANNOUNCE, (e: Event) => {
  try {
    const raw = JSON.parse(String((e as CustomEvent).detail ?? '{}')) as { channel?: unknown };
    if (typeof raw.channel !== 'string' || !raw.channel) return;
    channel = raw.channel;
  } catch {
    return;
  }
  shimReady = true;

  // The state listener goes on now rather than at evaluation time, because its
  // name is not known until the announcement arrives. Still inside
  // document_start, so still before any page script exists.
  /**
   * A page that has opened an IndexedDB database, reported once.
   *
   * Separate from the state channel because it is a different kind of fact: the
   * state message describes a handshake and carries a fork count that only
   * means anything during a commit, while this is a standing property of the
   * document that can become true at any point in its life.
   */
  rawListen.call(document, `${channel}.idb`, () => {
    onShimIdb?.();
  });

  rawListen.call(document, `${channel}.state`, (ev: Event) => {
    try {
      const raw = JSON.parse(String((ev as CustomEvent).detail ?? '{}')) as Partial<ShimState>;
      onShimState?.({
        sid: typeof raw.sid === 'string' ? raw.sid : null,
        mode: typeof raw.mode === 'string' ? raw.mode : '',
        forked: typeof raw.forked === 'number' ? raw.forked : 0,
        idb: raw.idb === true,
      });
    } catch {
      /* malformed, and the shim is the only thing that sends these */
    }
  });

  // A cookie the page set with document.cookie, relayed from the MAIN world so
  // the worker can put it in the session store. The shim only sends these while
  // the tab is managed, so a plain page produces none.
  rawListen.call(document, `${channel}.cookie`, (ev: Event) => {
    try {
      const raw = JSON.parse(String((ev as CustomEvent).detail ?? '{}')) as {
        value?: unknown;
        url?: unknown;
      };
      if (typeof raw.value !== 'string' || !raw.value) return;
      onShimCookie?.(raw.value, typeof raw.url === 'string' ? raw.url : location.href);
    } catch {
      /* malformed, and the shim is the only thing that sends these */
    }
  });

  // Synchronous, so the shim knows to hold rather than deciding it is on an
  // unmanaged page and writing through to the origin's shared keys.
  toShim('wait');
  if (shimAnswer) toShim('commit', shimAnswer);
});

let onShimState: ((s: ShimState) => void) | null = null;
let onShimIdb: (() => void) | null = null;
let onShimCookie: ((value: string, url: string) => void) | null = null;



/**
 * The port exists to keep the worker warm. Chrome tears a service worker down
 * after roughly thirty seconds idle, and reconnecting on disconnect keeps the
 * link alive across the five minute port lifetime cap.
 */
function connect(): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: 'nvx-agent' });
  } catch {
    return;
  }

  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  const report = (): void => {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      try {
        port.postMessage({ kind: 'icons', candidates: iconCandidates(), url: location.href });
      } catch {
        /* the port went away; reconnection will report again */
      }
    }, 120);
  };

  onShimState = (state) => {
    try {
      port.postMessage({ kind: 'storage.state', ...state, url: location.href });
    } catch {
      /* the port went away; the next connection reports again */
    }
  };

  onShimIdb = () => {
    try {
      port.postMessage({ kind: 'storage.idb', url: location.href });
    } catch {
      /* the port went away; the page will report again on the next open */
    }
  };

  onShimCookie = (value, url) => {
    try {
      port.postMessage({ kind: 'page.cookie', value, url });
    } catch {
      /* the port went away; a later write reconnects and reports again */
    }
  };

  port.onMessage.addListener(
    (
      msg:
        | ChooserRequest
        | { kind: 'paint'; dataUrl: string }
        | { kind: 'unpaint' }
        | {
            kind: 'storage.commit';
            sid: string | null;
            fork: boolean;
            persona?: string | null;
            idb?: boolean;
          }
        | { kind: 'storage.reset' }
        | { kind: 'note'; text: string; accent: string; strong?: string }
        | GuardNotice
    ) => {
    if (msg?.kind === 'paint') {
      applyMark(msg.dataUrl);
      return;
    }
    if (msg?.kind === 'unpaint') {
      clearMark();
      return;
    }
    if (msg?.kind === 'storage.commit') {
      shimAnswer = {
        sid: typeof msg.sid === 'string' ? msg.sid : null,
        fork: msg.fork === true,
        // Relayed verbatim, including the difference between "no persona" and
        // "nothing said about one". The shim treats those differently and this
        // is only a wire.
        persona: typeof msg.persona === 'string' ? msg.persona : null,
        // The IndexedDB isolation gate, relayed so the shim can turn namespacing
        // on and off when a Pro licence changes without the tab reloading.
        idb: msg.idb === true,
      };
      // Held rather than sent when the shim has not announced itself yet: on a
      // cold worker the answer can arrive first, and a commit nobody is
      // listening for would leave the shim parked forever.
      if (shimReady) toShim('commit', shimAnswer);
      return;
    }
    if (msg?.kind === 'storage.reset') {
      toShim('reset');
      return;
    }
    if (msg?.kind === 'note') {
      showNote(
        typeof msg.text === 'string' ? msg.text.slice(0, 120) : '',
        typeof msg.accent === 'string' ? msg.accent.slice(0, 32) : '#dcea4f',
        typeof msg.strong === 'string' ? msg.strong.slice(0, 60) : undefined
      );
      return;
    }
    if (msg?.kind === 'guard') {
      const notice = msg;
      showGuard(notice, () => {
        try {
          port.postMessage({ kind: 'guard.unlock', rule: notice.rule });
        } catch {
          /* the port went away; the guard simply stays on */
        }
      });
      return;
    }
    if (msg?.kind !== 'chooser') return;
    render(msg, (sessionId) => {
      teardown();
      port.postMessage({ kind: 'chose', sessionId });
    });
    }
  );

  port.onDisconnect.addListener(() => {
    /**
     * The mark comes off if the extension is what went away.
     *
     * The favicon is a link element this script put in the page, so it belongs
     * to the document rather than to the extension, and removing the extension
     * does not take it with it. What the user sees is every managed tab still
     * wearing a coloured dot with nothing left to explain it, and no way to
     * clear it short of reloading every one of those tabs. There is no uninstall
     * hook that could tidy this up afterwards, because by then nothing of ours
     * is running.
     *
     * A disconnected port is running, for the moment it takes to check. If the
     * runtime id is gone the extension has been removed, disabled or reloaded,
     * and this is the last chance to put the page's own icon back.
     *
     * Pause goes through the ordinary repaint rather than through here, so this
     * is only ever the disappearing case.
     */
    /**
     * Read through a try, because this is exactly the moment the context is
     * being torn down: once an extension is unloaded, touching `chrome.runtime`
     * from a content script throws "Extension context invalidated" rather than
     * answering undefined. An unguarded read throws before reaching the cleanup
     * below, which is the difference between the mark coming off and it staying
     * on a tab with nothing left to explain it.
     */
    let alive = false;
    try {
      alive = Boolean(chrome.runtime?.id);
    } catch {
      alive = false;
    }
    if (!alive) {
      paintObserver?.disconnect();
      paintObserver = null;
      try {
        clearMark();
      } catch {
        /* the document is going away too, which achieves the same thing */
      }
      return;
    }
    // Otherwise the worker was merely idle. Reconnect.
    setTimeout(connect, 250);
  });

  // Asked immediately, before the document has a head, because the shim is
  // holding every write until this is answered.
  try {
    port.postMessage({ kind: 'storage.hello', url: location.href });
  } catch {
    /* the port went away before the first message; reconnection asks again */
  }


  const start = (): void => {
    watchIcons(report);
    report();
    // Cheap: one attribute write every four seconds, and the only thing that
    // tells the page's own world we are still here.
    beat();
    if (!beating) beating = setInterval(beat, BEAT_MS);
  };
  // document_start means there is no head yet, and a single frame's worth of
  // the site's own icon is better than a mark that never lands because the
  // listener was attached after the event.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

/**
 * The agent is registered for the hosts a session reaches, and separately
 * injected on demand for a tab the user asked to re-pick. Both can land on the
 * same page, and a second instance would open a second port, hold the worker
 * awake for as long as the tab lives, and render the chooser twice.
 */
const scope = globalThis as unknown as { __nvxAgent?: boolean };
if (!scope.__nvxAgent) {
  scope.__nvxAgent = true;
  connect();
}
