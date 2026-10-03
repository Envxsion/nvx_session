/**
 * ------------------------------------------------------------------
 *  Title    |  Toolbar popup
 *  Ref      |  panel.js, base.js, guide.js, packages/ui/mark.js
 *  ID       |  M6 (popup UI)
 * ------------------------------------------------------------------
 *  Purpose  |  One question, asked mid-task: who am I on this tab,
 *           |  and can I be somebody else.
 *  How      |  The current tab is the hero, switching is one tap
 *           |  under it, and anything needing room stays in the full
 *           |  panel behind a link.
 *  Note     |  Reads the same state payload the panel does, not its
 *           |  own summary, so the two cannot come to disagree.
 *  Author   |  Ojas Kekre, 25/08/2026
 * ------------------------------------------------------------------
 */

/* $, send, el, hex and plural come from base.js and panel.js, which load
   first. Defining them again here is exactly the drift this arrangement exists
   to prevent. */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A stable small number from a string, to rotate a
 *           |  session's glyph.
 *  Note     |  Not a hash for security: only stable across reloads
 *           |  and spread around the circle, so a session always
 *           |  draws the same shape and two rarely collide.
 * ------------------------------------------------------------------
 */
function spin(id) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) % 360;
  return n;
}

/** An icon from the sprite in popup.html. */
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A session's own glyph: one ring with a gap, turned
 *           |  by its id.
 *  Note     |  Shape as well as colour, since colour alone is not a
 *           |  channel everybody has.
 * ------------------------------------------------------------------
 */
function drawGlyph(node, session, size = 34) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));

  const tone = session ? hex(session.color) : 'var(--mute-7)';
  const r = 13;
  const c = 2 * Math.PI * r;
  const on = c * 0.76;

  const ring = document.createElementNS(ns, 'circle');
  ring.setAttribute('cx', '17');
  ring.setAttribute('cy', '17');
  ring.setAttribute('r', String(r));
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', tone);
  ring.setAttribute('stroke-width', '2.5');
  ring.setAttribute('stroke-linecap', 'round');
  ring.setAttribute('stroke-dasharray', `${on} ${c - on}`);
  ring.setAttribute('transform', `rotate(${session ? spin(session.id) : 0} 17 17)`);

  const core = document.createElementNS(ns, 'circle');
  core.setAttribute('cx', '17');
  core.setAttribute('cy', '17');
  core.setAttribute('r', '4');
  core.setAttribute('fill', tone);

  svg.append(ring, core);
  node.replaceChildren(svg);
}

// --------------------------------------------------------------- the state

/* state is panel.js's, so the home view and the sessions view can never report
   different numbers for the same thing. */
let tab = null;

const realSessions = () => state.sessions.filter((s) => !s.system);
const sessionFor = (id) => state.sessions.find((s) => s.id === id) ?? null;

/** Whether the tab is somewhere a session could apply at all. */
function onASite() {
  return Boolean(tab) && /^https?:/i.test(tab.url ?? '');
}

function bindingFor(tabId) {
  return state.bindings.find((b) => b.tabId === tabId) ?? null;
}

/** Cookies this session holds for the tab's registrable domain, roughly. */
function relevance(session, host) {
  if (!host) return 0;
  const pinned = (session.pinned ?? []).some((p) => host === p || host.endsWith(`.${p}`));
  const family = (session.family ?? []).some((p) => host === p || host.endsWith(`.${p}`));
  return (pinned ? 2 : 0) + (family ? 1 : 0);
}

/** The session holding this tab, when it is one the user made. */
function currentSession() {
  const binding = tab ? bindingFor(tab.id) : null;
  const session = binding ? sessionFor(binding.sessionId) : null;
  return { binding, session, real: session && !session.system ? session : null };
}

// ---------------------------------------------------------------- the mark

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The mark in the bar says the same thing as the hero
 *           |  under it, before a word is read.
 *  How      |  Alarm beats paused beats live: a leak or a loop is
 *           |  the thing to look at, a pause is every promise off,
 *           |  and only then does the tab's own session colour it.
 * ------------------------------------------------------------------
 */
function paintMark() {
  const host = $('mark');
  if (!host || typeof setMark !== 'function') return;
  const { real } = currentSession();
  if ((state.desync?.foreign ?? 0) > 0 || state.loop) {
    setMark(host, { state: 'alarm' });
  } else if (state.settings?.paused) {
    setMark(host, { state: 'paused' });
  } else if (real) {
    setMark(host, { state: 'live', color: hex(real.color) });
  } else {
    setMark(host, { state: 'idle' });
  }
}

// ---------------------------------------------------------------- painting

/** One action in the hero's row. */
function heroAction(name, label, title, onPress, cls = '') {
  const b = el('button', `here-add ${cls}`);
  b.type = 'button';
  b.title = title;
  b.append(icon(name), el('span', null, label));
  b.addEventListener('click', async () => {
    b.disabled = true;
    const ok = await onPress();
    if (!ok) b.disabled = false;
  });
  return b;
}

function paintHere() {
  const node = $('here');
  node.replaceChildren();
  node.className = 'here';

  const { session, real } = currentSession();
  const site = (tab ? hostOf(tab.url ?? '') : '').replace(/^www\./, '');

  // The hero carries the session's own colour as an edge and a light, so which
  // account you are on is legible before any of the words are read. Cleared
  // rather than left stale, or an unmanaged tab keeps the last session's tint.
  if (real) node.style.setProperty('--tone', hex(real.color));
  else node.style.removeProperty('--tone');

  const top = el('div', 'here-top');
  const glyph = el('span', 'glyph');
  drawGlyph(glyph, real, 40);
  const body = el('div', 'here-body');

  if (real) {
    node.classList.add('here--live');
    body.append(el('div', 'here-site', site || 'This tab'));
    const line = el('div', 'here-in');
    line.append(el('span', 'here-in-k', 'in'), el('b', null, real.label));
    if (real.identity && real.identity !== real.label) line.append(el('span', 'here-who', real.identity));
    body.append(line);
  } else if (session) {
    // The holding pen. It has a name the user did not choose, so it says what
    // it means rather than showing that name as though it were an account.
    node.classList.add('here--none');
    body.append(el('div', 'here-site', site || 'This tab'));
    body.append(el('div', 'here-in', 'Waiting for you to pick an account'));
  } else if (onASite()) {
    node.classList.add('here--none');
    body.append(el('div', 'here-site', site));
    body.append(el('div', 'here-in', 'Not in a session. It uses the browser’s own cookies.'));
  } else {
    // A browser page, or one of ours. There is nothing to isolate and nothing
    // to offer, and saying so is better than showing an empty chooser.
    node.classList.add('here--none', 'here--idle');
    body.append(el('div', 'here-site', 'No site open'));
    body.append(el('div', 'here-in', 'Open a site in this tab to put it in a session.'));
  }

  top.append(glyph, body);
  node.append(top);

  // The default-account hint. When this tab is on the very domain where the
  // session's identity was detected, say plainly which account it acts as,
  // because that is the moment a wrong default does its damage. Keyed on the
  // detected identity and its domain, so it names no provider.
  if (real && session.identity && session.identityDomain) {
    const host = tab ? hostOf(tab.url ?? '') : '';
    const dom = session.identityDomain;
    if (host && (host === dom || host.endsWith(`.${dom}`))) {
      node.append(
        el('p', 'here-identity', `On ${dom} this tab is ${session.identity}, the only account in this session.`)
      );
    }
  }

  if (real) {
    const meta = el('div', 'here-meta');
    meta.append(el('span', null, plural(real.tabs.length, 'tab', 'tabs')));
    meta.append(el('span', null, plural(real.cookies, 'cookie', 'cookies')));
    if (real.thirdParty === 'block') meta.append(el('span', null, 'third parties blocked'));
    node.append(meta);
  }

  // Two moves no separate-profile tool matches, side by side. A new account at
  // this same site in a new tab, keeping this one; and a burner that clears
  // itself when its tab closes. Both are one press on the site in front of you.
  if (onASite()) {
    const adds = el('div', 'here-adds');
    adds.append(
      heroAction(
        'plus',
        'New account here',
        site
          ? `Opens ${site} in a new tab as a fresh, empty account, and leaves this tab as it is.`
          : 'Opens this site in a new tab as a fresh, empty account.',
        async () => {
          const made = await send({ cmd: 'createSession', label: site || 'session', color: unusedColor() });
          if (!made?.id) return false;
          await send({ cmd: 'openInSession', sessionId: made.id, url: tab.url });
          window.close();
          return true;
        }
      ),
      heroAction(
        'burn',
        'Burner tab',
        site
          ? `Opens ${site} in a throwaway session that clears itself when you close the tab.`
          : 'Opens this site in a throwaway session that clears itself when you close the tab.',
        async () => {
          const r = await send({ cmd: 'newBurner', color: 'chalk', url: tab.url });
          if (r?.ok) window.close();
          return r?.ok === true;
        },
        'here-add--burner'
      )
    );
    node.append(adds);
  }
}

function paintSwitch() {
  const block = $('switch-block');
  const list = $('list');
  list.replaceChildren();

  const host = tab ? hostOf(tab.url ?? '') : '';
  const binding = tab ? bindingFor(tab.id) : null;
  const current = binding?.sessionId ?? null;
  if (!onASite()) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const options = realSessions()
    // Destinations only. Where the tab already is has the whole hero above,
    // and a list headed "move this tab to" whose first row is where it already
    // is reads as a bug even when it is labelled.
    .filter((s) => s.id !== current)
    .map((s) => ({ s, rank: relevance(s, host) }))
    // The ones that cover this site first, because that is what the tab is
    // most likely to want, then everything else so a deliberate move is still
    // one tap rather than a trip to the panel.
    .sort((a, b) => b.rank - a.rank || a.s.label.localeCompare(b.s.label));

  // There is always somewhere to go, because the last row makes one, so this
  // has no empty case to describe.
  $('switch-lede').textContent = current ? 'Move this tab to' : 'Put this tab in';

  /** One row, whether it names a session or makes one. */
  function opt(i, color, name, sub, tagText, tagClass, onPick) {
    const row = el('button', 'opt');
    row.type = 'button';
    row.style.setProperty('--tone', hex(color));
    // Only applies while the list carries .opt-enter, which is the first paint
    // of the popup's life. A repaint that replayed every row's entrance starts
    // each one at zero opacity, which is what the flicker was.
    row.style.animationDelay = `${Math.min(i * 40, 240)}ms`;

    const body = el('span', 'opt-body');
    body.append(el('span', 'opt-name', name));
    body.append(el('span', 'opt-sub', sub));

    const side = el('span', 'opt-side');
    if (tagText) side.append(el('span', `opt-tag ${tagClass ?? ''}`, tagText));
    side.append(icon('arrow'));

    row.append(el('span', 'opt-bar'), body, side);
    row.addEventListener('click', () => {
      row.classList.add('going');
      // Long enough for the fill to read as the action, short enough that it
      // never feels like waiting.
      void onPick().then(() => setTimeout(() => window.close(), 300));
    });
    list.append(row);
    return row;
  }

  options.forEach(({ s, rank }, i) => {
    const bits = [];
    if (s.identity && s.identity !== s.label) bits.push(s.identity);
    bits.push(plural(s.cookies, 'cookie', 'cookies'));

    let tag = '';
    let cls = '';
    if (s.cookies === 0) {
      tag = 'Sign in';
      cls = 'opt-tag--fresh';
    } else if (rank > 0) {
      tag = 'Knows this site';
    }

    opt(i, s.color, s.label, bits.join(', '), tag, cls, () =>
      send({
        cmd: 'bind',
        tabId: tab.id,
        sessionId: s.id,
        url: tab.url,
        windowId: tab.windowId,
      })
    );
  });

  /**
   * The row that makes a session instead of choosing one.
   *
   * It creates the session, gives it a colour up front rather than after the
   * fact, and moves the tab into it in a single press. The colour is shown
   * before the press: the thing you get is visible in the thing you press.
   */
  const nextColor = unusedColor();
  const site = host.replace(/^www\./, '');
  opt(
    options.length,
    nextColor,
    'New session',
    site ? `Signs in at ${site} on its own` : 'A fresh, empty identity',
    '',
    '',
    async () => {
      const made = await send({
        cmd: 'createSession',
        label: site || 'session',
        color: nextColor,
        pinned: site ? [site] : [],
      });
      if (!made?.id) return;
      await send({
        cmd: 'bind',
        tabId: tab.id,
        sessionId: made.id,
        url: tab.url,
        windowId: tab.windowId,
      });
    }
  ).classList.add('opt--new');
}

// --------------------------------------------------------------- notices

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Every notice on the home view, in one shape.
 *  How      |  A compact notice: an icon, a one-line title, a short
 *           |  body, and its actions inline. The hero stays the star;
 *           |  a notice says its piece in two lines and gets out of
 *           |  the way. Each painter keeps its own logic and buttons.
 *  Note     |  tone is one of alarm, warn, info, mute; it colours
 *           |  the icon and the left edge, nothing else.
 * ------------------------------------------------------------------
 */
function notice(node, { tone, glyph, title, text, actions = [], dismiss = null }) {
  node.hidden = false;
  node.replaceChildren();
  node.dataset.tone = tone;

  const ic = el('span', 'notice-ic');
  ic.append(icon(glyph));

  const body = el('div', 'notice-body');
  body.append(el('div', 'notice-title', title));
  if (text) body.append(el('p', 'notice-text', text));
  if (actions.length) {
    const acts = el('div', 'notice-acts');
    for (const [label, onPress, title2] of actions) {
      const b = el('button', 'notice-btn', label);
      b.type = 'button';
      if (title2) b.title = title2;
      b.addEventListener('click', async () => {
        b.disabled = true;
        await onPress();
      });
      acts.append(b);
    }
    body.append(acts);
  }
  node.append(ic, body);

  if (dismiss) {
    const x = el('button', 'notice-x');
    x.type = 'button';
    x.setAttribute('aria-label', dismiss[0]);
    x.title = dismiss[0];
    x.append(icon('x'));
    x.addEventListener('click', async () => {
      x.disabled = true;
      node.classList.add('leaving');
      await dismiss[1]();
    });
    node.append(x);
  }
}

function clearNotice(node) {
  node.hidden = true;
  node.replaceChildren();
}

/** After any notice action: re-read, then repaint whatever changed. */
async function settle(r) {
  if (r?.settings) state.settings = r.settings;
  await refresh();
  paintHome(true);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The one caution worth meeting before it meets you.
 *  How      |  A federated login in an isolated session hands the
 *           |  provider a partial set of cookies, read as a stolen
 *           |  session, so it loops or signs out. Said once, short;
 *           |  dismissing records a flag so it never returns. The
 *           |  guide has the long version.
 *  Note     |  The extension stops the loop and the account is safe.
 * ------------------------------------------------------------------
 */
function paintCaution() {
  const node = $('caution');
  if (!node) return;
  if (state.settings?.cautionAcked === true) return clearNotice(node);
  notice(node, {
    tone: 'info',
    glyph: 'info',
    title: 'Single sign-on can loop once',
    text: 'If a Google, Okta or work login spins, NVX stops it. Sign in fresh in a session made for that site.',
    dismiss: ['Got it', async () => settle(await send({ cmd: 'setSettings', cautionAcked: true }))],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The one-time telemetry question.
 *  How      |  Opt-in: shows only in a build that can send and only
 *           |  until answered either way. Both buttons record an
 *           |  answer, so "No thanks" is remembered, not dismissed.
 *  Note     |  The honest sell is the small print: what it can never
 *           |  contain matters more than what it can.
 * ------------------------------------------------------------------
 */
function paintConsent() {
  const node = $('consent');
  if (!node) return;
  const show = state.telemetryPossible === true && state.settings?.telemetryAsked !== true;
  if (!show) return clearNotice(node);
  notice(node, {
    tone: 'mute',
    glyph: 'info',
    title: 'Share anonymous usage stats?',
    text: 'Feature use, rough daily counts, timings and errors, tied to a random id, plus which major sign-in provider had trouble, from a fixed list. Never a URL, any other site, a cookie or an account. Change it any time in Settings.',
    actions: [
      ['Share stats', async () => settle(await send({ cmd: 'setSettings', telemetry: true }))],
      // Answered, not dismissed: records the decision so the notice does not return.
      ['No thanks', async () => settle(await send({ cmd: 'setSettings', telemetry: false, telemetryAsked: true }))],
    ],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The undo for a move made with the popup closed.
 *  How      |  A right-click or keyboard move happens where a toast
 *           |  cannot follow, so the worker remembers the one most
 *           |  recent move and the popup offers it on next open.
 *  Note     |  Undo puts the tab back; the close button keeps it,
 *           |  since a notice that will not leave is worse than its use.
 * ------------------------------------------------------------------
 */
function paintMoved() {
  const node = $('moved');
  if (!node) return;
  const m = state.lastMove;
  if (!m) return clearNotice(node);
  notice(node, {
    tone: 'mute',
    glyph: 'move',
    title: `Moved a tab to ${m.label}`,
    actions: [
      [
        'Undo',
        async () => {
          await send({ cmd: 'undoLastMove' });
          await settle();
        },
      ],
    ],
    dismiss: [
      'Keep it',
      async () => {
        await send({ cmd: 'dismissLastMove' });
        await settle();
      },
    ],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Says, on the first thing anybody sees, that nothing
 *           |  is being isolated.
 *  Note     |  A paused extension that looks like a running one is
 *           |  the worst state. Also the way back, one press.
 * ------------------------------------------------------------------
 */
function paintPaused() {
  const node = $('paused');
  if (!node) return;
  if (!state.settings?.paused) return clearNotice(node);
  notice(node, {
    tone: 'warn',
    glyph: 'pause',
    title: 'Isolation is paused',
    text: 'Every tab uses the browser’s own cookies. Your sessions are untouched.',
    actions: [['Resume', async () => settle(await send({ cmd: 'setSettings', paused: false }))]],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A sign-in this extension stopped fighting.
 *  Note     |  Tone is neither apology nor alarm. Something went
 *           |  wrong, the extension got out of the way, the site
 *           |  works again, and here is how to undo it.
 * ------------------------------------------------------------------
 */
function paintLoop() {
  const node = $('loop');
  const loop = state.loop;
  if (!loop) return clearNotice(node);
  const freed = loop.freed ? ` and handed ${plural(loop.freed, 'tab', 'tabs')} back` : '';
  notice(node, {
    tone: 'warn',
    glyph: 'loop',
    title: `${loop.domain} was looping`,
    text: `A sign-in kept redirecting to itself, so NVX stopped managing the site${freed}. It works normally again.`,
    actions: [
      [
        'Manage again',
        async () => {
          await send({ cmd: 'releaseSite', domain: loop.domain, release: false });
          await settle();
        },
        `Put ${loop.domain} back under session management. If it loops again it is released again.`,
      ],
      ['Report it', async () => openReport(), 'Tell us which sign-in looped, so it can be fixed for everyone.'],
    ],
    dismiss: [
      'Dismiss',
      async () => {
        await send({ cmd: 'dismissLoop' });
        await settle();
      },
    ],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The alarm, as opposed to the reading beside it.
 *  How      |  A leak means the profile jar reached a tab meant to
 *           |  be somebody else, the one failure this exists to
 *           |  prevent, so it takes the top of the view and offers
 *           |  the two things worth doing.
 *  Note     |  Clears itself at zero; the toolbar icon carries the
 *           |  same state, so a popup nobody opens is not the only
 *           |  place it shows.
 * ------------------------------------------------------------------
 */
function paintLeak() {
  const node = $('leak');
  const foreign = state.desync?.foreign ?? 0;
  if (!foreign) return clearNotice(node);
  notice(node, {
    tone: 'alarm',
    glyph: 'alert',
    title: `${plural(foreign, 'request', 'requests')} carried a foreign cookie`,
    text: 'Usually a host this session had no rule for yet. The blast radius log names it.',
    actions: [
      // The trail names the host the session had no rule for, which is the answer.
      ['What happened', async () => go('trail')],
      // Not "dismiss". The count is a measurement, so the only honest way to
      // clear it is to start measuring again, and the label has to say so.
      [
        'Recount',
        async () => {
          await send({ cmd: 'resetDesync' });
          state.desync = { total: 0, foreign: 0, stale: 0, checked: 0 };
          paintHome(true);
        },
      ],
      ['Report it', async () => openReport()],
    ],
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Three readings in one line, coloured only when
 *           |  something is wrong.
 *  Note     |  Desync counts three things; only foreign is a fault
 *           |  (profile jar reached a managed tab). stale is a
 *           |  cookie rotated mid-flight, once per hop of a normal
 *           |  sign-in, so the total is never shown.
 * ------------------------------------------------------------------
 */
function paintHealth() {
  const node = $('health');
  node.replaceChildren();

  const d = state.desync;
  if (!d) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  const foreign = d.foreign ?? 0;
  const item = (cls, text, title, target) => {
    const b = el('button', `vital ${cls}`);
    b.type = 'button';
    b.title = title;
    b.append(el('span', 'vital-dot'), el('span', null, text));
    b.addEventListener('click', () => go(target));
    return b;
  };

  const parties = new Set();
  let sent = 0;
  for (const s of realSessions()) {
    for (const t of s.thirdParties ?? []) {
      parties.add(t.party);
      if (!t.blocked) sent++;
    }
  }
  const managed = state.bindings.filter((b) => sessionFor(b.sessionId)?.system !== true).length;

  node.append(
    item(
      foreign ? 'vital--bad' : 'vital--good',
      foreign ? plural(foreign, 'leak', 'leaks') : 'Isolated',
      foreign
        ? 'A request in a managed tab carried a cookie the session does not own.'
        : `No leak in ${d.checked ?? 0} requests checked.`,
      'trail'
    ),
    item(
      sent ? 'vital--warn' : '',
      parties.size ? (sent ? `${sent} trackers got cookies` : `${parties.size} trackers held off`) : 'No trackers seen',
      sent
        ? 'Some third parties were handed the browser cookies, which makes sessions correlatable.'
        : 'Third parties seen across your sessions, with no cookies handed to them.',
      'parties'
    ),
    item('', plural(managed, 'managed tab', 'managed tabs'), 'Tabs currently in a session.', 'tabs')
  );
}

// ------------------------------------------------------------------ views

/* The four records of what happened share one destination in the bar, and a
   segmented control above the stage picks between them. */
const ACTIVITY = ['journal', 'trail', 'parties', 'storage'];
let lastActivity = 'journal';

/* Where Back and Escape lead from a view that lives inside another. Anything
   not listed sits directly under home. */
const PARENT = { plan: 'settings', help: 'settings', guide: 'help' };
const up = (view) => PARENT[view] ?? 'home';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  One view at a time.
 *  How      |  Not really a router: a data attribute on the body and
 *           |  a hidden attribute per view. The entering view rises
 *           |  in on transform and opacity only, so the swap never
 *           |  reflows anything but itself.
 * ------------------------------------------------------------------
 */
function go(view) {
  const from = document.body.dataset.view;
  document.body.dataset.view = view;
  if (ACTIVITY.includes(view)) lastActivity = view;
  document.body.classList.toggle('in-activity', ACTIVITY.includes(view));
  for (const node of document.querySelectorAll('.view')) {
    const on = node.dataset.view === view;
    node.hidden = !on;
    if (on && from !== view) {
      node.classList.remove('entering');
      void node.offsetWidth;
      node.classList.add('entering');
    }
  }
  for (const b of document.querySelectorAll('.nav-b, .sub-b, .bar-btn')) {
    const group = (b.dataset.group ?? '').split(' ');
    const here =
      (b.dataset.go && b.dataset.go === view) ||
      (b.id === 'nav-home' && view === 'home') ||
      group.includes(view);
    b.setAttribute('aria-current', here ? 'page' : 'false');
  }
  $('back').hidden = view === 'home';
  $('back').setAttribute('aria-label', PARENT[view] === 'settings' ? 'Back to settings' : PARENT[view] === 'help' ? 'Back to help' : 'Back to home');
  $('stage').scrollTop = 0;
  // Settings is short enough to carry the native host row rather than making
  // somebody hunt for it behind its own destination.
  const native = document.querySelector('.view[data-view="native"]');
  if (native) native.hidden = view !== 'settings';
  // Built the first time it is asked for, and left in the DOM afterwards. The
  // guide is a few hundred nodes that nothing else needs, and rebuilding it
  // would close every chapter the reader had opened.
  if (view === 'guide') renderGuidePopup($('guide-mount'));
  if (view === 'journal') void paintJournal();
  if (view === 'settings') {
    paintNewSites();
    paintDoors();
  }
  if (view === 'help') paintBuildFoot();
  // After the swap, not during it: the new view has no height until it is
  // unhidden, so measuring here rather than on the next frame always reports
  // that nothing scrolls.
  requestAnimationFrame(measureScroll);
}

// ------------------------------------------------------------ new sites

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a site nobody has placed yet is held for the
 *           |  chooser, and the sites the user said never to ask
 *           |  about again.
 *  How      |  Same toggle row as the Pro switches. The quiet list
 *           |  is the worker's, sent back whole minus the one
 *           |  removed, so the popup never has its own copy.
 *  Note     |  Defensive: a worker that does not send these fields
 *           |  yet reads as asking on and an empty list.
 * ------------------------------------------------------------------
 */
function paintNewSites() {
  const box = $('asknew');
  const list = $('quiet');
  if (!box || !list) return;
  box.replaceChildren();
  const on = state.settings?.askNewSites !== false;

  const row = el('div', 'toggle-row');
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.setAttribute('aria-label', 'Ask which session for new sites');
  toggle.append(el('span', 'knob'));
  toggle.addEventListener('click', async () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    toggle.disabled = true;
    const r = await send({ cmd: 'setSettings', askNewSites: next });
    if (r?.settings) state.settings = r.settings;
    toggle.disabled = false;
    paintNewSites();
  });
  const label = el('div', 'toggle-label', 'Ask which session for new sites');
  label.append(
    el(
      'small',
      null,
      on
        ? 'A site no session knows waits for you to pick one before it loads.'
        : 'New sites open outside any session, the way the browser always did.'
    )
  );
  row.append(toggle, label);
  box.append(row);

  list.replaceChildren();
  const quiet = Array.isArray(state.settings?.quiet) ? state.settings.quiet : [];
  const head = el('div', 'quiet-head');
  head.append(el('span', 'field-label', 'Never ask about'));
  if (quiet.length) head.append(el('span', 'quiet-n', String(quiet.length)));
  list.append(head);
  if (!quiet.length) {
    list.append(
      el('p', 'empty empty--inline', 'No sites yet. Choose “No session” with Remember on, and the site lands here.')
    );
    return;
  }
  const chips = el('div', 'site-chips');
  for (const domain of quiet) {
    const chip = el('span', 'site-chip site-chip--on');
    chip.append(el('span', null, domain));
    const x = el('button', 'site-chip-x');
    x.type = 'button';
    x.setAttribute('aria-label', `Ask about ${domain} again`);
    x.title = 'Ask again';
    x.append(icon('x'));
    x.addEventListener('click', async () => {
      x.disabled = true;
      const r = await send({ cmd: 'setSettings', quiet: quiet.filter((d) => d !== domain) });
      if (r?.settings) state.settings = r.settings;
      else state.settings = { ...state.settings, quiet: quiet.filter((d) => d !== domain) };
      paintNewSites();
    });
    chip.append(x);
    chips.append(chip);
  }
  list.append(chips);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether there is more below, the only thing that
 *           |  makes a cut-off list read as a list.
 *  Note     |  A scroll-driven CSS mask needs no script but cannot
 *           |  tell a view that fits from one scrolled to its end,
 *           |  so it fades content that is genuinely the last thing.
 * ------------------------------------------------------------------
 */
function measureScroll() {
  const s = $('stage');
  if (!s) return;
  const more = s.scrollHeight - s.clientHeight - s.scrollTop > 6;
  document.body.classList.toggle('more-below', more);
}

$('stage').addEventListener('scroll', measureScroll, { passive: true });

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Measure when anything actually changes size, not on
 *           |  a frame after a view swap and on window resize.
 *  Bug-Fix  |  The old pair missed most of it: a window resize after
 *           |  a view change arrives after the swap's scheduled
 *           |  frame, and there is no resize at all when a list just
 *           |  grows, leaving a scroller with no rail and no fade,
 *           |  a list nobody discovers continues.
 * ------------------------------------------------------------------
 */
if (typeof ResizeObserver === 'function') {
  const watch = new ResizeObserver(() => measureScroll());
  watch.observe($('stage'));
  for (const view of document.querySelectorAll('.view')) watch.observe(view);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A count on a nav destination, so something that
 *           |  arrived while you were elsewhere shows without
 *           |  visiting every view.
 *  Note     |  Only "somebody should look" counts qualify: a third
 *           |  party handed cookies, and a refused blast radius
 *           |  entry.
 * ------------------------------------------------------------------
 */
function paintNavCounts() {
  let sent = 0;
  for (const s of realSessions()) {
    for (const t of s.thirdParties ?? []) if (!t.blocked) sent++;
  }
  // Activity carries the parties count too, since that is the door to it.
  const marks = { parties: sent, activity: sent };
  for (const b of document.querySelectorAll('.nav-b, .sub-b')) {
    const key = b.id === 'nav-activity' ? 'activity' : b.dataset.go;
    const n = marks[key] ?? 0;
    const had = b.querySelector('.nav-n');
    if (!n) {
      had?.remove();
      continue;
    }
    const text = n > 99 ? '99+' : String(n);
    if (had) had.textContent = text;
    else b.append(el('span', 'nav-n', text));
  }
}

for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', () => go(b.dataset.go));
}
$('nav-home').addEventListener('click', () => go('home'));
$('nav-activity').addEventListener('click', () => go(lastActivity));
$('back').addEventListener('click', () => go(up(document.body.dataset.view)));

// Escape leaves a view the way it closes a sheet, and a sheet takes priority
// because it is the thing in front.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openSheet = [...document.querySelectorAll('.sheet')].some((n) => !n.hidden);
  if (openSheet || document.body.dataset.view === 'home') return;
  // Escape in a form field clears focus first rather than throwing away a
  // report half written.
  if (e.target instanceof HTMLElement && e.target.matches('input, textarea')) {
    e.target.blur();
    return;
  }
  go(up(document.body.dataset.view));
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A sheet needs the full width whichever view opened
 *           |  it.
 *  How      |  Nothing else here changes the body class, so watching
 *           |  for it beats threading a callback through the panel's
 *           |  own sheet helpers.
 * ------------------------------------------------------------------
 */
new MutationObserver(() => {
  const open = [...document.querySelectorAll('.sheet')].some((n) => !n.hidden);
  document.body.classList.toggle('sheeted', open);
}).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });

// ----------------------------------------------------------------- actions

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The one surface that stayed a page.
 *  Note     |  Every suite behind it opens tabs, and a popup closes
 *           |  the moment it loses focus, so a run would destroy the
 *           |  surface reporting on it.
 * ------------------------------------------------------------------
 */
// The suites drive a local fixture server, so only a developer build shows them.
// Hidden until the worker's state says dev, which paintHome applies.
const diagLink = document.querySelector('.diag-link');
if (diagLink) diagLink.hidden = true;
diagLink?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
  window.close();
});

// ---------------------------------------------------------------- journal

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What the extension did, read back.
 *  How      |  Newest first: the question is almost always "what
 *           |  just happened". The worker reverses on the way out,
 *           |  so the exported file still reads top to bottom.
 * ------------------------------------------------------------------
 */
const LOG_LEVELS = [
  ['debug', 'Everything', 'Every decision plus the routine traffic. What a bug report wants.'],
  ['info', 'Decisions', 'Every time a tab, a session or a cookie moved, and nothing else.'],
  ['warn', 'Problems', 'Only what looked wrong.'],
  ['error', 'Failures', 'Only what actually failed.'],
];

const AREA_LABEL = {
  life: 'startup',
  session: 'session',
  tab: 'tab',
  jar: 'cookies',
  rules: 'rules',
  storage: 'storage',
  mask: 'fingerprint',
  guard: 'blast radius',
  adopt: 'adoption',
  native: 'native host',
};

let journalEntries = [];

function clock(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function paintLogLevel() {
  const box = $('loglevel');
  if (!box) return;
  const current = state.settings?.logLevel ?? 'info';
  box.replaceChildren();
  for (const [value, label] of LOG_LEVELS) {
    const b = el('button', 'seg-b', label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    b.addEventListener('click', async () => {
      await send({ cmd: 'setSettings', logLevel: value });
      await refresh();
      paintLogLevel();
      void paintJournal();
    });
    box.append(b);
  }
  const note = $('loglevel-note');
  if (note) note.textContent = LOG_LEVELS.find(([v]) => v === current)?.[2] ?? '';
}

async function paintJournal() {
  const rows = $('journal');
  if (!rows) return;

  const r = await send({ cmd: 'journal' });
  journalEntries = Array.isArray(r?.entries) ? r.entries : [];
  paintLogLevel();

  rows.replaceChildren();
  if (!journalEntries.length) {
    rows.append(
      el('p', 'empty', 'Nothing recorded yet. Every tab that joins a session, every session made or deleted, and anything that goes wrong shows up here.')
    );
    $('journal-note').textContent = '';
    return;
  }

  for (const e of journalEntries) {
    const row = el('div', `jrow jrow--${e.level}`);

    const when = el('span', 'jrow-t', clock(e.at));
    const head = el('div', 'jrow-head');
    head.append(el('span', 'jrow-area', AREA_LABEL[e.area] ?? e.area), el('span', 'jrow-ev', e.event));
    if (e.count > 1) head.append(el('span', 'jrow-x', `x${e.count}`));

    const body = el('div', 'jrow-body');
    const bits = [e.session ? `in ${e.session}` : '', e.host ?? '', e.detail ?? ''].filter(Boolean);
    if (bits.length) body.append(el('span', 'jrow-detail', bits.join('  ·  ')));

    const main = el('div', 'jrow-main');
    main.append(head);
    if (body.childElementCount) main.append(body);

    row.append(when, main);
    rows.append(row);
  }

  $('journal-note').textContent =
    r.total > journalEntries.length
      ? `Showing the most recent ${journalEntries.length} of ${r.total}. Export writes all of them out.`
      : `${plural(journalEntries.length, 'entry', 'entries')} on disk.`;
}

$('journal-refresh')?.addEventListener('click', () =>
  busy($('journal-refresh'), 'Reading', () => paintJournal())
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Writes the whole journal out as a file.
 *  How      |  The blob is built here, not in the worker: a service
 *           |  worker cannot save a file, and the downloads
 *           |  permission for one text file is a worse trade.
 *  Note     |  The object url is revoked on the next turn; revoked
 *           |  at once, a closing popup may not have read it yet.
 * ------------------------------------------------------------------
 */
$('journal-export')?.addEventListener('click', () =>
  busy($('journal-export'), 'Writing', async () => {
    const r = await send({ cmd: 'journalFile' });
    if (!r?.ok || typeof r.text !== 'string') return;
    const url = URL.createObjectURL(new Blob([r.text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.download = `nvx-journal-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  })
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Arms before it acts, the same as deleting a session.
 *  Note     |  The journal is the only record of what happened and
 *           |  there is no undo.
 * ------------------------------------------------------------------
 */
let journalArmed = null;
$('journal-clear')?.addEventListener('click', async () => {
  const btn = $('journal-clear');
  if (journalArmed !== btn) {
    journalArmed = btn;
    btn.classList.add('is-armed');
    btn.textContent = 'Erase everything?';
    setTimeout(() => {
      if (journalArmed !== btn) return;
      journalArmed = null;
      btn.classList.remove('is-armed');
      btn.textContent = 'Clear';
    }, 6000);
    return;
  }
  journalArmed = null;
  btn.classList.remove('is-armed');
  btn.textContent = 'Clear';
  await send({ cmd: 'journalClear' });
  await paintJournal();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Back to the setup screen, which opens itself once
 *           |  and then never again.
 *  Note     |  Two adoption surfaces, different jobs. The sheet
 *           |  makes one session from hand-picked domains; the setup
 *           |  screen reads the whole profile and proposes one
 *           |  session per account. Somebody who skipped it wanted
 *           |  the second and had no way back.
 * ------------------------------------------------------------------
 */
$('setup-again')?.addEventListener('click', () => {
  void send({ cmd: 'openWelcome' });
  window.close();
});

// ------------------------------------------------------------------- help

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Doors that leave the extension for the site.
 *  Note     |  A button rather than a link so it sits in the same
 *           |  row vocabulary as every other door; opening a tab
 *           |  closes the popup anyway.
 * ------------------------------------------------------------------
 */
for (const b of document.querySelectorAll('[data-href]')) {
  b.addEventListener('click', () => {
    void chrome.tabs.create({ url: b.dataset.href });
    window.close();
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The Plan door says where you stand before you open it.
 *  Note     |  Read from the same licence snapshot paintPro uses, so
 *           |  the door and the view behind it never disagree.
 * ------------------------------------------------------------------
 */
function paintDoors() {
  const badge = $('door-plan-badge');
  const sub = $('door-plan-sub');
  if (!badge || !sub) return;
  const lic = state.license ?? {};
  const tier = state.tier ?? 'free';
  const unlocking = lic.present && tier !== 'free' && (state.entitlements ?? []).length > 0;
  let text = 'Free';
  let cls = 'pro-badge--free';
  let line = 'Enter a key, move it, or see what Pro adds';
  if (lic.dev === true) {
    text = 'Dev';
    cls = 'pro-badge--tester';
    line = 'Developer build, everything unlocked';
  } else if (unlocking) {
    const tester = tier === 'max_access';
    text = tester ? 'Tester' : 'Pro';
    cls = tester ? 'pro-badge--tester' : 'pro-badge--pro';
    line = 'Active on this device';
  } else if (lic.present) {
    line = 'Your key is stored but not unlocking right now';
  } else if (lic.buildPro !== true) {
    line = 'Everything here is free. See what Pro adds';
  }
  badge.hidden = false;
  badge.textContent = text;
  badge.className = `pro-badge ${cls}`;
  sub.textContent = line;
}

/** Version and build, the two facts every support reply starts by asking for. */
function paintBuildFoot() {
  const foot = $('build-foot');
  if (!foot) return;
  let version = state.version;
  if (!version) {
    try {
      version = chrome.runtime.getManifest().version;
    } catch {
      version = '';
    }
  }
  const build = state.buildTier ?? (state.license?.dev ? 'dev' : state.license?.buildPro ? 'pro' : 'free');
  foot.textContent = `NVX Session ${version}${build ? `, ${build} build` : ''}`;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Report a problem without leaving the popup.
 *  How      |  The worker builds the diagnostics, so the preview is
 *           |  exactly what would be sent: the same call with the
 *           |  same switches. Validation is inline and only after a
 *           |  first attempt, so an empty form is not shouting.
 *  Note     |  When the report cannot be sent (no endpoint in this
 *           |  build, offline, rate limited) the worker hands back
 *           |  the text, which is copied for the support page.
 * ------------------------------------------------------------------
 */
const report = {
  tried: false,
  sending: false,
};

function reportSwitch(id) {
  return $(id)?.getAttribute('aria-checked') === 'true';
}

function setReportSwitch(id, on) {
  $(id)?.setAttribute('aria-checked', String(on));
}

function syncSitesRow() {
  const diag = reportSwitch('report-diag');
  const sites = $('report-sites');
  const row = $('report-sites-row');
  if (!sites || !row) return;
  sites.disabled = !diag;
  row.classList.toggle('is-off', !diag);
  if (!diag) setReportSwitch('report-sites', false);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function reportErrors() {
  const text = ($('report-text')?.value ?? '').trim();
  const email = ($('report-email')?.value ?? '').trim();
  return {
    text:
      text.length < 10
        ? 'Say a little more, at least a sentence.'
        : text.length > 4000
          ? 'Keep it under 4000 characters.'
          : null,
    email: email && !EMAIL_RE.test(email) ? 'That email does not look right.' : null,
  };
}

function paintReportErrors() {
  const errs = reportErrors();
  for (const [key, node, input] of [
    ['text', 'report-text-err', 'report-text'],
    ['email', 'report-email-err', 'report-email'],
  ]) {
    const show = report.tried && errs[key];
    const msg = $(node);
    if (msg) {
      msg.hidden = !show;
      msg.textContent = show ? errs[key] : '';
    }
    $(input)?.setAttribute('aria-invalid', show ? 'true' : 'false');
  }
  return !errs.text && !errs.email;
}

async function paintPreview() {
  const pre = $('report-pre');
  if (!pre || !$('report-preview')?.open) return;
  if (!reportSwitch('report-diag')) {
    pre.textContent = 'Only what you typed above, plus the version and browser.';
    return;
  }
  pre.textContent = 'Loading';
  const r = await send({ cmd: 'reportPreview', includeSites: reportSwitch('report-sites') });
  pre.textContent = r?.preview
    ? JSON.stringify(r.preview, null, 2)
    : 'The preview is not available in this build yet.';
}

function reportSay(text, cls) {
  const msg = $('report-msg');
  if (!msg) return;
  msg.hidden = !text;
  msg.textContent = text ?? '';
  msg.className = `pro-msg ${cls ?? ''}`;
}

function reportDone(node) {
  $('report').hidden = true;
  const done = $('report-done');
  done.hidden = false;
  done.replaceChildren(node);
}

function resetReport() {
  report.tried = false;
  $('report').reset();
  setReportSwitch('report-diag', true);
  setReportSwitch('report-sites', false);
  syncSitesRow();
  paintReportErrors();
  reportSay(null);
  $('report').hidden = false;
  $('report-done').hidden = true;
}

async function sendReport() {
  if (report.sending) return;
  report.tried = true;
  if (!paintReportErrors()) {
    const first = reportErrors().text ? $('report-text') : $('report-email');
    first?.focus();
    return;
  }
  report.sending = true;
  const btn = $('report-send');
  btn.disabled = true;
  btn.textContent = 'Sending';
  reportSay(null);
  try {
    const r = await send({
      cmd: 'sendReport',
      text: $('report-text').value.trim(),
      expected: $('report-expected').value.trim(),
      email: $('report-email').value.trim(),
      diagnostics: reportSwitch('report-diag'),
      includeSites: reportSwitch('report-sites'),
    });
    if (r?.ok) {
      const box = el('div', 'report-ok');
      box.append(el('div', 'report-ok-title', 'Report sent'));
      box.append(
        el('p', 'pro-note', r.id ? `Reference ${r.id}. Quote it if you write to support.` : 'Thanks. It reached us.')
      );
      const again = el('button', 'btn btn--quiet', 'Send another');
      again.type = 'button';
      again.addEventListener('click', resetReport);
      box.append(again);
      reportDone(box);
      return;
    }
    if (r?.fallback) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(r.fallback);
        copied = true;
      } catch {
        copied = false;
      }
      const box = el('div', 'report-ok report-ok--warn');
      box.append(el('div', 'report-ok-title', 'Could not send from here'));
      box.append(
        el(
          'p',
          'pro-note',
          copied
            ? "Couldn't send from here. The report is copied; paste it at session.nvx.sh/support."
            : "Couldn't send from here, and the clipboard was not available. Your text is still in the form."
        )
      );
      const acts = el('div', 'pro-acts');
      const open = el('button', 'btn btn--primary', 'Open support');
      open.type = 'button';
      open.addEventListener('click', () => {
        void chrome.tabs.create({ url: 'https://session.nvx.sh/support' });
        window.close();
      });
      acts.append(open);
      if (!copied) {
        const back = el('button', 'btn btn--quiet', 'Back to the form');
        back.type = 'button';
        back.addEventListener('click', () => {
          $('report').hidden = false;
          $('report-done').hidden = true;
        });
        acts.append(back);
      }
      box.append(acts);
      reportDone(box);
      return;
    }
    const reasons = {
      rate: 'Too many reports in a short time. Wait a few minutes and try again.',
      network: 'Could not reach the report server. Check your connection and try again.',
      no_endpoint: 'This build has nowhere to send reports. Use Contact support instead.',
      rejected: 'The report was not accepted. Try shortening it, or use Contact support.',
    };
    reportSay(reasons[r?.reason] ?? 'The report could not be sent. Try again in a moment.', 'pro-msg--warn');
  } finally {
    report.sending = false;
    btn.disabled = false;
    btn.textContent = 'Send report';
  }
}

for (const id of ['report-diag', 'report-sites']) {
  $(id)?.addEventListener('click', () => {
    const b = $(id);
    if (b.disabled) return;
    setReportSwitch(id, !reportSwitch(id));
    syncSitesRow();
    void paintPreview();
  });
}
$('report-preview')?.addEventListener('toggle', () => void paintPreview());
$('report-text')?.addEventListener('input', paintReportErrors);
$('report-email')?.addEventListener('input', paintReportErrors);
$('report')?.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendReport();
});
$('help-report')?.addEventListener('click', () => openReport());

/** Into the help view with the report form in front and the cursor in it. */
function openReport() {
  if (document.body.dataset.view !== 'help') go('help');
  requestAnimationFrame(() => {
    $('report-block')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('report-text')?.focus({ preventScroll: true });
  });
}

$('guide-full')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('guide.html') });
  window.close();
});

// ------------------------------------------------------------------- start

/**
 * ------------------------------------------------------------------
 *  Purpose  |  panel.js paints on its own once it has state; this
 *           |  adds the home view it does not know about.
 *  How      |  Re-runs after any action that could have changed
 *           |  which session this tab is in.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the home view draws, as one string, so a
 *           |  paint is skipped when the answer would be identical.
 *  Bug-Fix  |  The popup polls, and repainting every poll rebuilt
 *           |  the whole view every 1500 ms; the staggered entrance
 *           |  made the list fade out and back twice a second and
 *           |  threw away scroll position and focus.
 *  Note     |  Every field below is read by one of the four
 *           |  painters; a field missing here is a change that would
 *           |  not reach the screen.
 * ------------------------------------------------------------------
 */
function homeState() {
  return JSON.stringify([
    tab?.id ?? null,
    tab?.url ?? null,
    document.body.dataset.view,
    state.desync,
    state.bindings.map((b) => [b.tabId, b.sessionId]),
    state.settings?.paused === true,
    state.loop ? [state.loop.domain, state.loop.at] : null,
    (state.released ?? []).join(),
    state.telemetryPossible === true,
    state.settings?.telemetryAsked === true,
    state.settings?.telemetry === true,
    state.lastMove ? [state.lastMove.tabId, state.lastMove.label, state.lastMove.to] : null,
    state.settings?.cautionAcked === true,
    state.settings?.askNewSites !== false,
    (state.settings?.quiet ?? []).join(),
    state.sessions.map((s) => [
      s.id,
      s.label,
      s.color,
      s.identity ?? null,
      s.cookies,
      s.tabs.length,
      s.thirdParty,
      s.system === true,
      (s.pinned ?? []).join(),
      (s.family ?? []).join(),
      (s.thirdParties ?? []).map((t) => [t.party, t.blocked]),
    ]),
  ]);
}

let painted = null;

function paintHome(force = false) {
  const now = homeState();
  if (!force && now === painted) return;
  const first = painted === null;
  painted = now;

  // Kept across a genuine repaint. A list that rebuilds while somebody is
  // partway down it and comes back at the top is a list that cannot be read.
  const stage = $('stage');
  const at = stage?.scrollTop ?? 0;

  /**
   * The entrance plays once, when the popup opens.
   *
   * It is an entrance: it means "this just appeared". Replaying it because a
   * cookie count went from three to four says something appeared that did not,
   * and at 1500 milliseconds it reads as a fault rather than as motion.
   */
  $('list')?.classList.toggle('opt-enter', first);

  paintPaused();
  paintCaution();
  paintConsent();
  paintMoved();
  paintLoop();
  paintLeak();
  paintHere();
  paintSwitch();
  paintHealth();
  paintNavCounts();
  paintMark();
  paintNewSites();
  paintDoors();
  if (diagLink) diagLink.hidden = state.dev !== true;

  if (stage && at) stage.scrollTop = at;
  measureScroll();
}

void (async () => {
  if (typeof mountMark === 'function') mountMark($('mark'), { state: 'idle' });
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active ?? null;
  // An extension page has a hostname, and it is a thirty two character id that
  // means nothing to anybody. Only a real site gets named.
  $('host').textContent = /^https?:/i.test(tab?.url ?? '') ? hostOf(tab.url) : '';

  // ?view= opens straight onto a view, for links from other pages and for the
  // screenshot tool. Only a view that exists is honoured.
  const asked = new URLSearchParams(location.search).get('view');
  go(asked && document.querySelector(`.view[data-view="${CSS.escape(asked)}"]`) ? asked : 'home');
  // panel.js kicked off its own refresh at load; this waits for state to arrive
  // rather than racing it, then keeps the home view in step with every later
  // repaint the panel does.
  // Waits for the answer, not for a session: a new user has none, and waiting
  // for one made every first open sit blank for two seconds.
  for (let i = 0; i < 40 && !stateLoaded; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  paintHome(true);
  if (document.body.dataset.view === 'help') paintBuildFoot();
  // #report opens the help view on the form, for a link from another page.
  if (location.hash === '#report') openReport();
  // The poll stays; what changed is that it only redraws when the answer would
  // be different. See homeState.
  window.setInterval(() => paintHome(), 1500);
})();
