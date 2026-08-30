/**
 * The toolbar popup.
 *
 * One question, asked mid-task: who am I on this tab, and can I be somebody
 * else. So the current tab is the hero, switching is one tap under it, and
 * anything that needs room stays in the full panel behind a link.
 *
 * It reads the same state payload the panel does rather than a summary of its
 * own, because two surfaces computing the same numbers separately is how they
 * come to disagree.
 */

/* $, send, el, hex and plural come from panel.js, which loads first. Defining
   them again here is exactly the drift this arrangement exists to prevent. */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A stable small number from a string, used to rotate a session's glyph.
 *
 * Not a hash for any security purpose: it only has to be stable across reloads
 * and spread ids around the circle, so the same session always draws the same
 * shape and two sessions rarely draw the same one.
 */
function spin(id) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) % 360;
  return n;
}

// ---------------------------------------------------------------- the mark

/**
 * The product mark: an aperture that does not close.
 *
 * Three arcs around a common centre with a gap in each, rotated apart. It is
 * the one idea the whole thing rests on, drawn: concentric, sharing a centre,
 * never touching.
 */
function drawMark(node) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');

  const rings = [
    { r: 14.5, gap: 66, turn: 0, w: 2, o: 1 },
    { r: 9.5, gap: 78, turn: 132, w: 2, o: 0.68 },
    { r: 4.5, gap: 96, turn: 262, w: 2, o: 0.4 },
  ];

  for (const ring of rings) {
    const c = 2 * Math.PI * ring.r;
    const on = c * (1 - ring.gap / 360);
    const arc = document.createElementNS(ns, 'circle');
    arc.setAttribute('cx', '17');
    arc.setAttribute('cy', '17');
    arc.setAttribute('r', String(ring.r));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'var(--signal)');
    arc.setAttribute('stroke-width', String(ring.w));
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${on} ${c - on}`);
    arc.setAttribute('opacity', String(ring.o));
    arc.setAttribute('transform', `rotate(${ring.turn} 17 17)`);
    svg.append(arc);
  }
  node.replaceChildren(svg);
}

/**
 * A session's own glyph: one ring with a gap, turned by its id.
 *
 * Shape as well as colour, because colour alone is not a channel everybody has.
 */
function drawGlyph(node, session, size = 34) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 34 34');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));

  const tone = session ? hex(session.color) : 'var(--mute-8)';
  const r = 13;
  const c = 2 * Math.PI * r;
  const on = c * 0.76;

  const halo = document.createElementNS(ns, 'circle');
  halo.setAttribute('cx', '17');
  halo.setAttribute('cy', '17');
  halo.setAttribute('r', String(r));
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', tone);
  halo.setAttribute('stroke-width', '7');
  halo.setAttribute('opacity', '0.1');

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

  svg.append(halo, ring, core);
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

// ---------------------------------------------------------------- painting

function paintHere() {
  const node = $('here');
  node.replaceChildren();
  node.className = 'here';

  const binding = tab ? bindingFor(tab.id) : null;
  const session = binding ? sessionFor(binding.sessionId) : null;

  // The hero carries a wash in the session's own colour, so which account you
  // are on is legible before any of the words are read. Cleared rather than
  // left stale, or an unmanaged tab keeps the last session's tint.
  const real = session && !session.system ? session : null;
  if (real) node.style.setProperty('--tone', hex(real.color));
  else node.style.removeProperty('--tone');

  const top = el('div', 'here-top');
  const glyph = el('span', 'glyph');
  drawGlyph(glyph, real, 38);

  const body = el('div', 'here-body');
  if (session && !session.system) {
    body.append(el('div', 'here-name', session.label));
    if (session.identity && session.identity !== session.label) {
      body.append(el('div', 'here-who', session.identity));
    } else {
      body.append(el('div', 'here-who', `${plural(session.cookies, 'cookie', 'cookies')} held`));
    }
  } else if (session) {
    // The holding pen. It has a name the user did not choose, so it says what
    // it means rather than showing that name as though it were an account.
    node.classList.add('here--none');
    body.append(el('div', 'here-name', 'Deciding'));
    body.append(el('div', 'here-who', 'waiting for you to pick an account'));
  } else if (onASite()) {
    node.classList.add('here--none');
    body.append(el('div', 'here-name', 'No session'));
    body.append(el('div', 'here-who', 'this tab uses the browser as it always did'));
  } else {
    // A browser page, or one of ours. There is nothing to isolate and nothing
    // to offer, and saying so is better than showing an empty chooser.
    node.classList.add('here--none');
    body.append(el('div', 'here-name', 'Nothing here'));
    body.append(el('div', 'here-who', 'open a site to put it in a session'));
  }

  top.append(glyph, body);
  node.append(top);

  // The default-account hint. When this tab is on the very domain where the
  // session's identity was detected, say plainly which account it will act as,
  // because that is the exact moment a wrong default does its damage: a link
  // opened here resolves to this account and no other. Keyed on the detected
  // identity and its domain, so it names no provider and hardcodes nothing.
  if (session && !session.system && session.identity && session.identityDomain) {
    const host = tab ? hostOf(tab.url ?? '') : '';
    const dom = session.identityDomain;
    if (host && (host === dom || host.endsWith(`.${dom}`))) {
      const hint = el(
        'p',
        'here-identity',
        `On ${dom}, this tab is ${session.identity}. No other account is in this session, so nothing here can quietly act as one.`
      );
      node.append(hint);
    }
  }

  if (session && !session.system) {
    const meta = el('div', 'here-meta');
    const tabs = el('span');
    tabs.append(document.createTextNode('tabs '), el('b', null, String(session.tabs.length)));
    const cookies = el('span');
    cookies.append(document.createTextNode('cookies '), el('b', null, String(session.cookies)));
    meta.append(tabs, cookies);
    if (session.thirdParty === 'block') {
      const tp = el('span');
      tp.append(document.createTextNode('third parties '), el('b', null, 'blocked'));
      meta.append(tp);
    }
    node.append(meta);
  } else if (!session && onASite()) {
    node.append(
      el(
        'p',
        'here-note',
        'Pick a session below and the tab reloads under it. Nothing is sent until you do.'
      )
    );
  }

  // Two moves no separate-profile tool matches, side by side. A new account at
  // this same site in a new tab, keeping this one; and a burner that clears itself
  // when its tab closes. Both are one press on the site in front of you.
  if (onASite()) {
    const site = (tab ? hostOf(tab.url ?? '') : '').replace(/^www\./, '');
    const adds = el('div', 'here-adds');

    const add = el('button', 'here-add');
    add.type = 'button';
    add.append(el('span', 'here-add-plus', '+'), document.createTextNode('New account here'));
    add.title = site
      ? `Opens ${site} in a new tab as a fresh, empty account, and leaves this tab exactly as it is.`
      : 'Opens this site in a new tab as a fresh, empty account.';
    add.addEventListener('click', async () => {
      add.disabled = true;
      const made = await send({ cmd: 'createSession', label: site || 'session', color: unusedColor() });
      if (made?.id) {
        await send({ cmd: 'openInSession', sessionId: made.id, url: tab.url });
        window.close();
      } else {
        add.disabled = false;
      }
    });

    const burn = el('button', 'here-add here-add--burner');
    burn.type = 'button';
    burn.append(el('span', 'here-add-plus', '↺'), document.createTextNode('Burner tab'));
    burn.title = site
      ? `Opens ${site} in a throwaway session that clears itself the moment you close the tab.`
      : 'Opens this site in a throwaway session that clears itself when you close the tab.';
    burn.addEventListener('click', async () => {
      burn.disabled = true;
      const r = await send({ cmd: 'newBurner', color: 'chalk', url: tab.url });
      if (r?.ok) window.close();
      else burn.disabled = false;
    });

    adds.append(add, burn);
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
  // no longer has an empty case to describe.
  $('switch-lede').textContent = current ? 'move this tab to' : 'put this tab in';

  /** One row, whether it names a session or makes one. */
  function opt(i, color, name, sub, tagText, tagClass, onPick) {
    const row = el('button', 'opt');
    row.type = 'button';
    row.style.setProperty('--tone', hex(color));
    // Only applies while the list carries .opt-enter, which is the first paint
    // of the popup's life. A repaint that replayed every row's entrance starts
    // each one at zero opacity, which is what the flicker was.
    row.style.animationDelay = `${Math.min(i * 38, 220)}ms`;

    const body = el('div', 'opt-body');
    body.append(el('div', 'opt-name', name));
    body.append(el('div', 'opt-sub', sub));

    row.append(el('span', 'dot'), body, el('span', `opt-tag ${tagClass ?? ''}`, tagText ?? ''));
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
      tag = 'SIGN IN';
      cls = 'opt-tag--fresh';
    } else if (rank > 0) {
      tag = 'COVERS';
    }

    opt(i, s.color, s.label, bits.join('  /  '), tag, cls, () =>
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
   * Without it, the only way to put a tab somewhere new was to open the
   * sessions view, create a session there, come back and pick it, and what you
   * got in the meantime was a session with no tabs and no visible effect: the
   * tab still looked exactly like an ordinary unmanaged tab, because it was
   * one. So this creates the session, gives it a colour up front rather than
   * after the fact, and moves the tab into it in a single press.
   *
   * The colour is shown before the press, not chosen after it. That is the
   * whole point of the dot on this row: the thing you get is visible in the
   * thing you are pressing.
   */
  const nextColor = unusedColor();
  const site = host.replace(/^www\./, '');
  opt(
    options.length,
    nextColor,
    'New session',
    site ? `signs in at ${site} on its own` : 'a fresh, empty identity',
    'CREATE',
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

/**
 * The alarm, as opposed to the reading beside it.
 *
 * The health strip below has said "isolation: 2 leaks" for a while now, and
 * that is not an alarm: it is a number on a surface nobody has open. A leak
 * means the profile jar reached a tab that is supposed to be somebody else,
 * which is the one failure this whole thing exists to prevent, so it takes the
 * top of the view, says which session, and offers the two things worth doing
 * about it rather than leaving the user to work them out.
 *
 * It clears itself when the count goes back to zero, and the toolbar icon
 * carries the same state so a popup nobody opens is no longer the only place
 * it is visible.
 */
/**
 * A sign-in this extension stopped fighting.
 *
 * Above the leak card, because it describes something that already happened to
 * the page in front of the user rather than a counter they can investigate
 * later, and because the action on it is the one they will want within seconds
 * of reading it.
 *
 * The tone is deliberately neither an apology nor an alarm. Something went
 * wrong, the extension noticed and got out of the way, the site works again,
 * and here is how to undo that if it was wrong. Every one of those is good news
 * except the first.
 */
/**
 * Says, on the first thing anybody sees, that nothing is being isolated.
 *
 * A paused extension that looks like a running one is the worst state this can
 * be in: every promise it makes is off, and the only place that said so was a
 * button in Settings that somebody pressed once and forgot. Worse than a
 * feature being broken, because a broken feature eventually announces itself
 * and this would not.
 *
 * Also the way back. Somebody who paused to test whether this was the cause of
 * something needs one press to undo it, from wherever they happen to be.
 */
/**
 * The one-time telemetry question.
 *
 * Opt-in, so it asks rather than assumes, and it asks once: the card shows only
 * in a build that can actually send (an endpoint was configured) and only until
 * the question has been answered either way. Both buttons record an answer, so
 * "No thanks" is a real decision that is remembered, not a dismissal that lets
 * the card come back. The honest sell is the small print: what it can never
 * contain matters more here than what it can.
 */
/**
 * The one caution worth meeting before it meets you.
 *
 * Signing into a federated login inside an isolated session hands the provider a
 * partial set of its cookies, which it can read as a stolen session and answer
 * by signing the account out or looping. The extension stops the loop and the
 * account is safe, but a redirect loop with no explanation reads as the site
 * being broken, so this says it once, plainly, on the home view. Acknowledging
 * records a persistent flag, the same shape as the consent card, so it is shown
 * once and never returns. The guide carries the long version.
 */
function paintCaution() {
  const node = $('caution');
  if (!node) return;
  if (state.settings?.cautionAcked === true) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'before you sign in'));
  body.append(
    el(
      'p',
      'leak-text',
      'A single sign-on login inside a session (Google, Okta, a work SSO) can ' +
        'occasionally loop or sign you out, because an isolated session shows the ' +
        'provider only some of its cookies. NVX stops the loop on its own and your ' +
        'account stays safe. If a login spins, open that site in a session made ' +
        'for it and sign in fresh rather than copying an account in.'
    )
  );

  const acts = el('div', 'leak-acts');
  const ok = el('button', 'btn btn--quiet', 'Got it');
  ok.type = 'button';
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    const r = await send({ cmd: 'setSettings', cautionAcked: true });
    if (r?.settings) state.settings = r.settings;
    await refresh();
    paintHome(true);
  });
  acts.append(ok);
  body.append(acts);
  node.append(body);
}

function paintConsent() {
  const node = $('consent');
  if (!node) return;
  const show = state.telemetryPossible === true && state.settings?.telemetryAsked !== true;
  if (!show) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'help improve NVX?'));
  body.append(
    el(
      'p',
      'leak-text',
      'Send anonymous usage counts: which features get used, how many sessions ' +
        'exist, nothing more. Tied to a random id, never to you. It can never ' +
        'contain a URL, a site you visit, a cookie or an account. Off unless you ' +
        'say yes, and you can change your mind in Settings.'
    )
  );

  const acts = el('div', 'leak-acts');
  const yes = el('button', 'btn btn--quiet', 'Sure, help out');
  yes.type = 'button';
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    const r = await send({ cmd: 'setSettings', telemetry: true });
    if (r?.settings) state.settings = r.settings;
    await refresh();
    paintHome(true);
  });
  const no = el('button', 'btn btn--quiet', 'No thanks');
  no.type = 'button';
  no.addEventListener('click', async () => {
    no.disabled = true;
    // Answered, not dismissed: records the decision so the card does not return.
    const r = await send({ cmd: 'setSettings', telemetry: false, telemetryAsked: true });
    if (r?.settings) state.settings = r.settings;
    await refresh();
    paintHome(true);
  });
  acts.append(yes, no);
  body.append(acts);
  node.append(body);
}

/**
 * The undo for a move made with the popup closed.
 *
 * A right-click or keyboard move happens where a toast cannot follow, so the
 * worker remembers the one most recent such move and the popup offers it here
 * the next time it opens. Undo puts the tab back; Keep it stops offering,
 * because a card that will not go away is worse than the convenience it adds.
 */
function paintMoved() {
  const node = $('moved');
  if (!node) return;
  const m = state.lastMove;
  if (!m) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'moved a tab'));
  body.append(
    el('p', 'leak-text', `A tab was moved to ${m.label} from outside the popup. Undo puts it back.`)
  );

  const acts = el('div', 'leak-acts');
  const undo = el('button', 'btn btn--quiet', 'Undo');
  undo.type = 'button';
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    await send({ cmd: 'undoLastMove' });
    await refresh();
    paintHome(true);
  });
  const keep = el('button', 'btn btn--quiet', 'Keep it');
  keep.type = 'button';
  keep.addEventListener('click', async () => {
    keep.disabled = true;
    await send({ cmd: 'dismissLastMove' });
    await refresh();
    paintHome(true);
  });
  acts.append(undo, keep);
  body.append(acts);
  node.append(body);
}

function paintPaused() {
  const node = $('paused');
  if (!node) return;
  if (!state.settings?.paused) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'paused'));
  body.append(
    el(
      'p',
      'leak-text',
      'Nothing is being isolated. Every tab is using the browser’s own cookies, ' +
        'exactly as it would without this installed. Your sessions and everything in ' +
        'them are untouched.'
    )
  );

  const acts = el('div', 'leak-acts');
  const go = el('button', 'btn btn--quiet', 'Resume isolation');
  go.type = 'button';
  go.addEventListener('click', async () => {
    go.disabled = true;
    const r = await send({ cmd: 'setSettings', paused: false });
    if (r?.settings) state.settings = r.settings;
    await refresh();
    paintHome(true);
  });
  acts.append(go);
  body.append(acts);
  node.append(body);
}

function paintLoop() {
  const node = $('loop');
  const loop = state.loop;
  if (!loop) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'a sign-in was looping'));
  body.append(
    el(
      'p',
      'leak-text',
      `${loop.domain} kept redirecting to itself in a managed tab, which is what happens when ` +
        'a site is handed part of a sign-in rather than all of it. NVX has stopped managing it' +
        `${loop.freed ? ` and handed ${plural(loop.freed, 'tab', 'tabs')} back` : ''}, so it ` +
        'works normally again.'
    )
  );

  const acts = el('div', 'leak-acts');

  const undo = el('button', 'btn btn--quiet', 'Manage it again');
  undo.type = 'button';
  undo.title = `Put ${loop.domain} back under session management. If it loops again it will be released again.`;
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    await send({ cmd: 'releaseSite', domain: loop.domain, release: false });
    await refresh();
    paintHome(true);
  });

  const ok = el('button', 'btn btn--quiet', 'Got it');
  ok.type = 'button';
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    await send({ cmd: 'dismissLoop' });
    await refresh();
    paintHome(true);
  });

  acts.append(undo, ok);
  body.append(acts);
  node.append(body);
}

function paintLeak() {
  const node = $('leak');
  const foreign = state.desync?.foreign ?? 0;
  if (!foreign) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const body = el('div', 'leak-body');
  body.append(el('div', 'leak-title', 'isolation fault'));
  body.append(
    el(
      'p',
      'leak-text',
      `${plural(foreign, 'request', 'requests')} in a managed tab carried a cookie the ` +
        'session does not own. The usual cause is a host this session had no rule for yet, ' +
        'which the trail names. Page scripts also write cookies straight to the browser, ' +
        'and those are not routed through the session.'
    )
  );

  const acts = el('div', 'leak-acts');

  const look = el('button', 'btn btn--quiet', 'What happened');
  look.type = 'button';
  look.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
    window.close();
  });

  // Not "dismiss". The count is a measurement, so the only honest way to clear
  // it is to start measuring again, and the label has to say that or somebody
  // will read a zero as a fix.
  const reset = el('button', 'btn btn--quiet', 'Recount');
  reset.type = 'button';
  reset.addEventListener('click', async () => {
    reset.disabled = true;
    await send({ cmd: 'resetDesync' });
    state.desync = { total: 0, foreign: 0, stale: 0, checked: 0 };
    paintHome(true);
  });

  acts.append(look, reset);
  body.append(acts);
  node.append(el('span', 'leak-mark'), body);
}

/**
 * Three readings, coloured only when something is wrong.
 *
 * The desync number is the one that has to be handled carefully. It counts
 * three different things, and only one of them is a fault: foreign means the
 * profile jar reached a managed tab, which is the failure the whole design
 * exists to prevent. stale means a cookie rotated mid-flight, which happens
 * once per hop of every normal sign-in. Showing the total taught the last
 * reader to diagnose a loop that was not there, so the total is not shown.
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
  const isolation = el('div', `vital ${foreign ? 'vital--bad vital--alarm' : 'vital--good'}`);
  isolation.append(el('div', 'vital-k', 'isolation'));
  isolation.append(
    el('div', 'vital-v', foreign ? `${plural(foreign, 'leak', 'leaks')}` : 'clean')
  );
  isolation.title = foreign
    ? 'A request in a managed tab carried a cookie the session does not own. Open the full panel.'
    : `No leak in ${d.checked ?? 0} requests checked.`;

  const parties = new Set();
  let sent = 0;
  for (const s of realSessions()) {
    for (const t of s.thirdParties ?? []) {
      parties.add(t.party);
      if (!t.blocked) sent++;
    }
  }
  const tp = el('div', `vital ${sent ? 'vital--bad' : parties.size ? 'vital--good' : ''}`);
  tp.append(el('div', 'vital-k', 'third parties'));
  tp.append(el('div', 'vital-v', parties.size ? (sent ? `${sent} sent` : `${parties.size} blocked`) : 'none'));
  tp.title = sent
    ? 'Some third parties were handed the browser cookies, which makes sessions correlatable.'
    : 'Third parties seen across your sessions, with no cookies handed to them.';

  const managed = state.bindings.filter((b) => sessionFor(b.sessionId)?.system !== true).length;
  const tabs = el('div', 'vital');
  tabs.append(el('div', 'vital-k', 'managed'));
  tabs.append(el('div', 'vital-v', `${managed}`));
  tabs.title = 'Tabs currently bound to a session.';

  node.append(isolation, tp, tabs);
}

// ------------------------------------------------------------------ views

/**
 * One view at a time, and the popup takes the width the view needs.
 *
 * Not a router in any real sense: there are a handful of destinations and no
 * history worth keeping, so it is a class on the body and a hidden attribute on
 * each view. The width lives in CSS per view rather than being computed here,
 * because the browser sizes the popup from the document and animating that one
 * property animates the popup itself.
 */
function go(view) {
  document.body.dataset.view = view;
  for (const node of document.querySelectorAll('.view')) {
    node.hidden = node.dataset.view !== view;
  }
  for (const b of document.querySelectorAll('.nav-b')) {
    b.setAttribute('aria-current', String(b.dataset.go === view));
  }
  $('back').hidden = view === 'home';
  // The bar keeps the product name rather than repeating the view name. Every
  // view but home carries a sticky heading of its own two rows down, and the
  // two said the same word in the same face at the same size, which reads as a
  // rendering fault rather than as a breadcrumb.
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
  // After the swap, not during it: the new view has no height until it is
  // unhidden, so measuring here rather than on the next frame always reports
  // that nothing scrolls.
  requestAnimationFrame(measureScroll);
}

/**
 * Whether there is more below, which is the only thing that makes a cut-off
 * list read as a list rather than as everything there is.
 *
 * The alternative considered was a scroll-driven CSS mask, which needs no
 * script at all but cannot tell the difference between a view that fits and a
 * view scrolled to its end, so it fades content that is genuinely the last
 * thing.
 */
function measureScroll() {
  const s = $('stage');
  if (!s) return;
  const more = s.scrollHeight - s.clientHeight - s.scrollTop > 6;
  document.body.classList.toggle('more-below', more);
}

$('stage').addEventListener('scroll', measureScroll, { passive: true });

/**
 * Measured when anything actually changes size, rather than on a frame after a
 * view swap and on window resize.
 *
 * The old pair missed most of what matters here. A popup is sized by the
 * browser from the document, so the window resize that follows a view change
 * arrives after the frame the swap scheduled a measurement on, and there is no
 * window resize at all when a list simply gets longer. What was left was a
 * scroller that scrolled with no rail and no fade, which is a list nobody
 * discovers continues: the exact failure this function exists to prevent, in
 * the case it was written for.
 */
if (typeof ResizeObserver === 'function') {
  const watch = new ResizeObserver(() => measureScroll());
  watch.observe($('stage'));
  for (const view of document.querySelectorAll('.view')) watch.observe(view);
}

/**
 * A count on a nav destination, so something that arrived while you were
 * elsewhere is visible without visiting every view. Only counts that mean
 * "somebody should look at this" qualify: a third party that was handed
 * cookies, and a blast radius entry that was refused.
 */
function paintNavCounts() {
  let sent = 0;
  for (const s of realSessions()) {
    for (const t of s.thirdParties ?? []) if (!t.blocked) sent++;
  }
  const marks = { parties: sent };
  for (const b of document.querySelectorAll('.nav-b')) {
    const n = marks[b.dataset.go] ?? 0;
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

for (const b of document.querySelectorAll('.nav-b')) {
  b.addEventListener('click', () => go(b.dataset.go));
}
$('back').addEventListener('click', () => go('home'));

// Escape leaves a view the way it closes a sheet, and a sheet takes priority
// because it is the thing in front.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openSheet = [...document.querySelectorAll('.sheet')].some((n) => !n.hidden);
  if (openSheet || document.body.dataset.view === 'home') return;
  go('home');
});

/**
 * A sheet needs the full width whichever view opened it, and nothing else in
 * here changes the body class, so watching for it is cheaper and more reliable
 * than threading a callback through the panel's own sheet helpers.
 */
new MutationObserver(() => {
  const open = [...document.querySelectorAll('.sheet')].some((n) => !n.hidden);
  document.body.classList.toggle('sheeted', open);
}).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });

// ----------------------------------------------------------------- actions

/**
 * The one surface that stayed a page. Every suite behind it opens tabs, and a
 * popup closes the moment it loses focus, so a run would destroy the surface
 * reporting on it.
 */
document.querySelector('.diag-link')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
  window.close();
});

// ---------------------------------------------------------------- journal

/**
 * What the extension did, read back.
 *
 * Newest first, because the question is almost always "what just happened".
 * The worker reverses on the way out rather than storing in that order, so the
 * exported file still reads top to bottom like a log file should.
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
    rows.append(el('p', 'empty', 'NOTHING RECORDED YET'));
    $('journal-note').textContent =
      'It fills as you use the browser. Every tab that joins a session, every session made or deleted, and everything that went wrong.';
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
 * Writes the whole journal out as a file.
 *
 * The blob is built here rather than in the worker, and the anchor click is why:
 * a service worker cannot save a file, and asking for the downloads permission
 * to write one text file is a worse trade than letting the page that asked make
 * the blob itself. The object url is revoked on the next turn, because a popup
 * can be closed before the browser has read it if it is revoked immediately.
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
 * Arms before it acts, the same as deleting a session, and for the same reason:
 * the journal is the only record of what happened and there is no undo.
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
 * Back to the setup screen, which opens itself once and then never again.
 *
 * Two adoption surfaces, and they are not the same job. The sheet beside this
 * makes one session out of a hand-picked set of domains, with a name and a
 * colour chosen there. The setup screen reads the whole profile and proposes
 * one session per account it can recognise. Somebody who skipped it on the
 * first run, or who has signed into three new things since, wants the second
 * one and had no way back to it.
 */
$('setup-again')?.addEventListener('click', () => {
  void send({ cmd: 'openWelcome' });
  window.close();
});

$('guide-full')?.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('guide.html') });
  window.close();
});

// ------------------------------------------------------------------- start

/**
 * panel.js paints on its own as soon as it has state. This adds the home view,
 * which is the only thing it does not know about, and re-runs after any action
 * that could have changed which session this tab is in.
 */
/**
 * Everything the home view draws, as one string.
 *
 * The popup polls the worker because state changes underneath it: a tab
 * rebinds, a leak is counted, a third party is seen. Repainting on every poll
 * meant tearing down and rebuilding the whole view every 1500 milliseconds, and
 * the rows carry a staggered entrance animation, so the list went to nothing and
 * faded back in twice a second whether or not anything had happened. It also
 * threw away the scroll position and any keyboard focus in it.
 *
 * So the paint is skipped when the answer would be identical. Everything below
 * is read by one of the four painters; a field missing here is a field whose
 * change would not reach the screen, which is the failure mode to watch for when
 * adding one.
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

  if (stage && at) stage.scrollTop = at;
  measureScroll();
}

void (async () => {
  drawMark($('mark'));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active ?? null;
  // An extension page has a hostname, and it is a thirty two character id that
  // means nothing to anybody. Only a real site gets named.
  $('host').textContent = /^https?:/i.test(tab?.url ?? '') ? hostOf(tab.url) : '';

  go('home');
  // panel.js kicked off its own refresh at load; this waits for state to arrive
  // rather than racing it, then keeps the home view in step with every later
  // repaint the panel does.
  for (let i = 0; i < 40 && !state.sessions.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  paintHome(true);
  // The poll stays; what changed is that it only redraws when the answer would
  // be different. See homeState.
  window.setInterval(() => paintHome(), 1500);
})();
