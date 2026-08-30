/**
 * The diagnostics panel, and everything the popup shares with it.
 *
 * One state payload, painted by whichever elements the page happens to have:
 * every painter below returns early when its node is missing, so the popup and
 * the full page can carry different subsets of the same surface without either
 * one knowing about the other.
 *
 * `$`, `send`, `el`, `plural`, `hex` and the colour ramp live in `base.js`,
 * which loads first on every page. Two surfaces computing a session colour
 * separately is how they come to disagree about the same session.
 */

let state = { sessions: [], bindings: [], desync: null, settings: {}, groupsAvailable: false };
let tabs = [];
let lastReport = null;
let chosenColor = COLORS[0];
let chosenDanger = 'warn';

let adoptCandidates = [];
let adoptSelected = new Set();
let adoptColor = COLORS[0];
let adoptBindTabs = true;
let adoptNameTouched = false;

/**
 * A button owns its own busy state. Width is fixed in CSS so swapping the
 * label never reflows the row it sits in.
 */
async function busy(btn, label, fn) {
  const original = btn.textContent;
  const siblings = [...document.querySelectorAll('.btn')];
  const wasDisabled = new Map(siblings.map((b) => [b, b.disabled]));
  siblings.forEach((b) => (b.disabled = true));
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.textContent = original;
    siblings.forEach((b) => (b.disabled = wasDisabled.get(b) ?? false));
  }
}

function paintStrip() {
  const strip = $('strip');
  if (!strip) return;
  strip.replaceChildren();
  const d = state.desync;
  const fields = [
    ['sessions', String(state.sessions.filter((s) => !s.system).length), ''],
    ['bound tabs', String(state.bindings.length), ''],
    [
      'desync',
      d ? `${d.total} / ${d.checked} checked` : 'unknown',
      d ? (d.total === 0 ? 'good' : 'bad') : '',
    ],
  ];
  for (const [k, v, tone] of fields) {
    const wrap = el('div');
    wrap.append(el('b', null, k));
    wrap.append(el('span', `v ${tone}`, v));
    strip.append(wrap);
  }
}

// ------------------------------------------------------------ deleting

/**
 * Deleting a session destroys its cookie jar, and there is no undo.
 *
 * So the row arms rather than acting. The second press names what is actually
 * lost instead of asking "are you sure", which is a question nobody reads: a
 * count of cookies and, where the session's tokens say so, the site those
 * cookies sign you in to.
 *
 * Not a modal, and not `confirm()`. A popup closes the moment it loses focus,
 * and a native dialog blocks the extension's own event loop, so the surface
 * asking the question would be destroyed by the act of asking it. That is the
 * same reason the account picker is a held navigation rather than an overlay.
 */
let armed = null;

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed.restore();
  armed = null;
}

/** What the second press costs, in the user's terms rather than the model's. */
function deleteCost(s) {
  const where = s.identityDomain || s.pinned[0] || (Array.isArray(s.family) ? s.family[0] : '');
  const parts = [];
  if (s.cookies) parts.push(where ? `signs you out of ${where}` : 'signs you out');
  if (s.tabs.length) parts.push(`${plural(s.tabs.length, 'tab', 'tabs')} left unmanaged`);
  parts.push('cannot be undone');
  return parts.join(', ');
}

const ARM_MS = 6000;

function armDelete(s, row, mid, actions, edit, del) {
  disarm();

  const cost = el('div', 'sub sub--cost', deleteCost(s));
  mid.append(cost);
  row.classList.add('arming');

  const go = el(
    'button',
    'btn btn--quiet btn--confirm',
    s.cookies ? `Delete ${plural(s.cookies, 'cookie', 'cookies')}` : 'Delete session'
  );
  go.type = 'button';
  go.addEventListener('click', () =>
    busy(go, 'Deleting', async () => {
      armed = null;
      await send({ cmd: 'deleteSession', sessionId: s.id });
      await refresh();
    })
  );

  const cancel = el('button', 'btn btn--quiet', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', disarm);

  // Hidden rather than removed. The click that armed this row is still
  // bubbling, and the outside-click handler below asks whether its target is
  // inside an arming row: a target detached from the document answers no, so
  // replacing these would disarm the row in the same gesture that armed it.
  edit.hidden = true;
  del.hidden = true;

  // Cancel goes last, which is where Delete was. A second click landing in the
  // same place as the first is the likeliest accident here, and it has to land
  // on the way out rather than on the irreversible half.
  actions.append(go, cancel);
  cancel.focus();

  armed = {
    timer: setTimeout(disarm, ARM_MS),
    restore: () => {
      cost.remove();
      go.remove();
      cancel.remove();
      row.classList.remove('arming');
      edit.hidden = false;
      del.hidden = false;
    },
  };
}

// Anywhere else, and Escape. An armed row left behind while the user reads
// another part of the list is a trap waiting for a stray press.
document.addEventListener('click', (e) => {
  if (armed && !e.target.closest('.row--session.arming')) disarm();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && armed) {
    e.stopPropagation();
    disarm();
  }
});

function paintSessions() {
  const node = $('sessions');
  if (!node) return;
  // A repaint rebuilds every row, so an armed one would be replaced by a fresh
  // Delete button with the arm state still recorded against a node that is no
  // longer in the document.
  disarm();
  node.replaceChildren();
  if (!state.sessions.length) {
    node.append(el('p', 'empty', 'NO SESSIONS YET'));
    return;
  }
  state.sessions.forEach((s, i) => {
    const row = el('div', 'row row--session');
    row.style.animationDelay = `${Math.min(i * 20, 300)}ms`;

    const dot = tone(el('span', 'dot'), s.color);

    const mid = el('div', 'row-body');
    mid.append(el('div', 'name', s.label));
    if (s.identity && s.identity !== s.label) {
      mid.append(el('div', 'who', s.identity));
    }
    // Production is worth seeing without opening the editor: it is the one
    // setting that changes whether a request goes out at all.
    const line = el('div', 'tags');
    line.append(el('span', 'sub', s.pinned.length ? s.pinned.join(', ') : 'no pinned domains'));
    if (s.danger === 'block') line.append(el('span', 'tag tag--production', 'PRODUCTION'));
    else if (s.danger === 'off') line.append(el('span', 'tag', 'UNGUARDED'));
    mid.append(line);

    // Domains this session was observed signing in at, as opposed to the ones
    // that were named. Shown separately because the difference matters: these
    // were learned, and a session covering somewhere unexpected is worth being
    // able to see rather than having to infer from behaviour.
    const family = Array.isArray(s.family) ? s.family : [];
    if (family.length) {
      mid.append(el('div', 'sub sub--learned', `also signs in at ${family.join(', ')}`));
    }

    const count = el(
      'span',
      'count',
      `${plural(s.cookies, 'cookie', 'cookies')} / ${plural(s.tabs.length, 'tab', 'tabs')}`
    );

    // The anonymous holding session is machinery the chooser needs. Offering a
    // delete button for it would let the user break their own account picker.
    if (s.system) {
      row.append(dot, mid, count, el('span', 'tag tag--system', 'SYSTEM'));
    } else {
      const actions = el('div', 'row-actions');

      /**
       * Signing into a site as this session, the safe way.
       *
       * The reason this button exists rather than "just open a tab and log in":
       * opening a fresh tab already inside the session, before it makes a single
       * request, is the one way to sign into a big provider without the copied
       * half-a-login that gets an account locked out. It is the button that
       * makes the whole model work, so it is the first one on the row.
       */
      const signin = el('button', 'btn btn--quiet', 'Sign in here');
      signin.type = 'button';
      signin.title = `Open a site signed in as ${s.label}, cleanly. This is how you add a Google or other account to this session without risking the account you use elsewhere.`;
      signin.addEventListener('click', () => openSignIn(s, signin));

      const edit = el('button', 'btn btn--quiet', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => openEdit(s, edit));

      const del = el('button', 'btn btn--quiet btn--danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => armDelete(s, row, mid, actions, edit, del));

      actions.append(signin, edit, del);
      row.append(dot, mid, count, actions);
    }

    node.append(row);
  });
}

/**
 * Which tabs are ticked, kept across repaints by tab id.
 *
 * A set rather than a flag on each row, because the list repaints on a timer
 * and a selection stored in the DOM would be wiped every time a cookie count
 * changed somewhere. Ids that are no longer open are pruned on each paint.
 */
const picked = new Set();
let moveBusy = false;

function paintTabs() {
  const node = $('tabs');
  if (!node) return;
  node.replaceChildren();
  const relevant = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  if (!relevant.length) {
    node.append(el('p', 'empty', 'NO HTTP TABS OPEN'));
    paintMoveBar();
    return;
  }

  // Drop ticks for tabs that closed since the last paint.
  const openIds = new Set(relevant.map((t) => t.id));
  for (const id of [...picked]) if (!openIds.has(id)) picked.delete(id);

  relevant.forEach((t, i) => {
    const row = el('div', 'row row--tab');
    row.style.animationDelay = `${Math.min(i * 16, 260)}ms`;

    // The tick. First column, so a column of them reads as a column and the eye
    // can run down it.
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tab-check';
    check.checked = picked.has(t.id);
    check.setAttribute('aria-label', `Select ${t.title || t.url}`);
    check.addEventListener('change', () => {
      if (check.checked) picked.add(t.id);
      else picked.delete(t.id);
      paintMoveBar();
    });

    const session = state.sessions.find((s) => s.id === t.sessionId);
    const dot = tone(el('span', 'dot'), session?.color);

    const mid = el('div', 'row-body');
    mid.append(el('div', 'name', t.title || t.url));
    mid.append(el('div', 'sub', t.url));

    // The chooser normally appears on its own, only when a navigation is
    // genuinely ambiguous. This is how you ask for it the rest of the time.
    const pick = el('button', 'btn btn--quiet', 'Choose');
    pick.type = 'button';
    pick.addEventListener('click', () =>
      busy(pick, 'Asking', async () => {
        const r = await send({ cmd: 'choose', tabId: t.id });
        if (!r?.ok) {
          pick.textContent = r?.reason === 'no-agent' ? 'Blocked' : 'Not here';
          await new Promise((res) => setTimeout(res, 1400));
        }
      })
    );

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Session for ${t.title || t.url}`);
    select.append(new Option('unbound', ''));
    for (const s of state.sessions) {
      select.append(new Option(s.label, s.id));
    }
    select.value = t.sessionId ?? '';
    select.addEventListener('change', async () => {
      select.disabled = true;
      if (select.value) {
        await send({
          cmd: 'bind',
          tabId: t.id,
          sessionId: select.value,
          url: t.url,
          windowId: t.windowId,
        });
      } else {
        await send({ cmd: 'unbind', tabId: t.id });
      }
      await refresh();
    });

    row.append(check, dot, mid, pick, select);
    node.append(row);
  });

  paintMoveBar();
}

/** How many distinct domains are ticked, to label a by-domain action honestly. */
function domainOfUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The action bar under the tab list.
 *
 * Two kinds of selection, because two kinds of intent. Ticking rows by hand is
 * the precise one. "All on this site" is the common one: somebody has six
 * Google tabs and wants them all in Work, and picking them one by one is
 * exactly the tedium this whole feature removes.
 */
function paintMoveBar() {
  const bar = $('tab-move');
  if (!bar) return;
  bar.replaceChildren();

  const relevant = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  const count = picked.size;

  const left = el('div', 'move-left');
  const all = el('button', 'btn btn--quiet', count && count === relevant.length ? 'None' : 'All');
  all.type = 'button';
  all.addEventListener('click', () => {
    if (count === relevant.length) picked.clear();
    else for (const t of relevant) picked.add(t.id);
    paintTabs();
  });
  left.append(all);

  // Group the current tabs by domain, so "same site as the active one" is one
  // press. The active tab's domain is the useful default.
  const active = relevant.find((t) => t.active) ?? relevant[0];
  const activeDomain = active ? domainOfUrl(active.url) : '';
  if (activeDomain) {
    const sameCount = relevant.filter((t) => domainOfUrl(t.url) === activeDomain).length;
    if (sameCount > 1) {
      const site = el('button', 'btn btn--quiet', `All ${activeDomain}`);
      site.type = 'button';
      site.title = `Select the ${sameCount} tabs on ${activeDomain}`;
      site.addEventListener('click', () => {
        for (const t of relevant) if (domainOfUrl(t.url) === activeDomain) picked.add(t.id);
        paintTabs();
      });
      left.append(site);
    }
  }
  bar.append(left);

  const right = el('div', 'move-right');
  if (count) {
    right.append(el('span', 'move-count', `${count} selected`));

    const to = document.createElement('select');
    to.className = 'move-to';
    to.setAttribute('aria-label', 'Move selected tabs to');
    to.append(new Option('Move to…', ''));
    for (const sn of state.sessions) to.append(new Option(sn.label, sn.id));
    to.append(new Option('Unbind', '__unbind'));
    to.disabled = moveBusy;
    to.addEventListener('change', async () => {
      const value = to.value;
      if (!value) return;
      const target = value === '__unbind' ? null : value;
      const ids = [...picked];

      // Where each tab sat before the move, captured now because the move is
      // the thing that changes it. This is all undo needs, and it is read from
      // state we already hold rather than asked of the worker.
      const prior = new Map();
      for (const id of ids) {
        const t = tabs.find((x) => x.id === id);
        prior.set(id, t ? t.sessionId ?? null : null);
      }

      moveBusy = true;
      paintMoveBar();
      const r = await send({ cmd: 'moveTabs', tabIds: ids, sessionId: target });
      moveBusy = false;
      if (r?.ok) {
        picked.clear();
        const where = target
          ? state.sessions.find((s) => s.id === target)?.label ?? target
          : 'no session';
        toast(`Moved ${plural(r.moved, 'tab', 'tabs')} to ${where}`, {
          label: 'Undo',
          onClick: () => undoMove(prior),
        });
      }
      await refresh();
      paintTabs();
    });
    right.append(to);
  }
  bar.append(right);

  bar.hidden = false;
}

/**
 * Puts a moved batch back where it came from.
 *
 * The tabs did not all start in the same session, so a single reverse move
 * would be wrong: the undo groups them by where each one was and sends one
 * guarded move per group, through the same path the forward move used, so the
 * mid-move block protects the way back exactly as it protected the way there. A
 * tab whose previous state was no session goes back to none.
 */
async function undoMove(prior) {
  const byDest = new Map();
  for (const [id, sid] of prior) {
    const key = sid ?? '__none';
    if (!byDest.has(key)) byDest.set(key, []);
    byDest.get(key).push(id);
  }
  for (const [key, ids] of byDest) {
    await send({ cmd: 'moveTabs', tabIds: ids, sessionId: key === '__none' ? null : key });
  }
  await refresh();
  paintTabs();
  toast('Move undone');
}

// -------------------------------------------------------------- channels

const CHANNELS = [
  {
    key: 'paint',
    label: 'Mark tab icons',
    hint: 'Stamps the session colour onto the favicon of every tab it owns. Works everywhere.',
  },
  {
    key: 'group',
    label: 'Group tabs natively',
    hint: 'Also gathers a session into a browser tab group. Off by default, because it rearranges tabs you arranged.',
  },
];

function paintChannels() {
  const node = $('channels');
  if (!node) return;
  node.replaceChildren();

  for (const channel of CHANNELS) {
    const available = channel.key !== 'group' || state.groupsAvailable;
    const row = el('div', 'toggle-row');

    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(Boolean(state.settings?.[channel.key])));
    toggle.setAttribute('aria-label', channel.label);
    toggle.disabled = !available;
    toggle.append(el('span', 'knob'));
    toggle.addEventListener('click', async () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(next));
      toggle.disabled = true;
      const r = await send({ cmd: 'setSettings', [channel.key]: next });
      if (r?.settings) state.settings = r.settings;
      toggle.disabled = !available;
      paintChannels();
    });

    const label = el('div', 'toggle-label', channel.label);
    label.append(
      el('small', null, available ? channel.hint : 'This browser exposes no tab group API.')
    );

    row.append(toggle, label);
    node.append(row);
  }

  // Anonymous usage stats, shown only in a build that can actually send them,
  // and honest about being off by default and about what it can never contain.
  if (state.telemetryPossible) {
    const row = el('div', 'toggle-row');
    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(Boolean(state.settings?.telemetry)));
    toggle.setAttribute('aria-label', 'Anonymous usage stats');
    toggle.append(el('span', 'knob'));
    toggle.addEventListener('click', async () => {
      const next = toggle.getAttribute('aria-checked') !== 'true';
      toggle.setAttribute('aria-checked', String(next));
      toggle.disabled = true;
      const r = await send({ cmd: 'setSettings', telemetry: next });
      if (r?.settings) state.settings = r.settings;
      toggle.disabled = false;
      paintChannels();
    });
    const label = el('div', 'toggle-label', 'Anonymous usage stats');
    label.append(
      el(
        'small',
        null,
        'Off by default. Sends only counts and which features ran, tied to a random id, never a URL, a site, a cookie or an account. Turning it off erases that id.'
      )
    );
    row.append(toggle, label);
    node.append(row);
  }

  $('channel-note').textContent =
    'Both channels only ever touch tabs a session owns. Unmanaged tabs are left exactly as the browser drew them.';
}

// ---------------------------------------------------------- fingerprint

/**
 * The posture, described by what it does rather than by how private it sounds.
 *
 * Mirror is the default and the honest one. Six of your own accounts sharing a
 * device fingerprint is unremarkable and agencies do it daily; what raises a
 * flag is incoherence, so fabricating nothing is a real answer rather than the
 * absence of one, and the copy has to say that instead of reading as "off".
 */
const POSTURES = [
  {
    key: 'mirror',
    label: 'Mirror',
    note: 'Your real machine, unchanged. Sessions are separated by cookies and storage and nothing about the device is fabricated, so nothing can contradict itself. Every site sees exactly what it would without this installed.',
  },
  {
    key: 'standardize',
    label: 'Standardize',
    note: 'Every session presents one shared, normalised machine. This lowers how identifiable you are across the whole population running it, which only works because everybody lands in the same place rather than each getting their own disguise.',
  },
  {
    key: 'persona',
    label: 'Persona',
    note: 'Each session presents a machine of its own, the same one every time that session is used and a different one on each site it visits. This is the posture that stops two of your accounts being matched by the machine they run on, which the other two cannot do because under both of them your accounts share a device.',
  },
];

/**
 * The off switch.
 *
 * It exists because the first question when a site starts misbehaving is
 * whether this extension is why, and until there was a pause the only way to
 * answer that was to uninstall, which throws away every session to run one
 * experiment. It is also the honest answer to a site this cannot handle yet: a
 * sign-in that will not complete is better paused than fought.
 *
 * Deliberately not framed as a toggle among the others. It turns off the thing
 * the whole product is for, so it says so in full rather than reading as one
 * more preference.
 */
function paintPause() {
  const btn = $('pause');
  if (!btn) return;
  const paused = state.settings?.paused === true;

  btn.textContent = paused ? 'Resume isolation' : 'Pause everything';
  btn.setAttribute('aria-pressed', String(paused));
  btn.classList.toggle('btn--alarm', paused);

  $('pause-note').textContent = paused
    ? 'Paused. No rules, no cookie rewriting, no picker: every tab is behaving exactly as it would with this extension removed. Your sessions and everything in them are untouched and come straight back.'
    : 'Turns everything off without losing anything. Every tab goes back to the browser’s own cookies, your sessions stay exactly where they are, and pressing it again puts them back. This is the first thing to try if a site has started behaving strangely, rather than uninstalling to find out.';

  btn.onclick = () =>
    busy(btn, paused ? 'Resuming' : 'Pausing', async () => {
      const r = await send({ cmd: 'setSettings', paused: !paused });
      if (r?.settings) state.settings = r.settings;
      await refresh();
    });
}

/**
 * Sites this extension has been told to leave alone.
 *
 * Listed rather than only recorded, because most of these will have been added
 * automatically by the sign-in loop detector, and a tool that silently stops
 * managing things is indistinguishable from one that is quietly broken. If
 * something is not being isolated, the reason has to be somewhere the user can
 * find without reading a journal.
 */
function paintReleased() {
  const node = $('released');
  if (!node) return;
  const released = state.released ?? [];
  node.replaceChildren();

  $('released-note').textContent = released.length
    ? 'These are handled by the browser exactly as they would be without NVX. A site lands here when you release it, or when a sign-in on it kept looping and NVX let go rather than keep fighting it.'
    : 'Nothing is being skipped. If a sign-in ever loops, the site responsible lands here and this says so.';

  if (!released.length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;

  for (const domain of released) {
    const row = el('div', 'row row--released');
    const body = el('div');
    body.append(el('div', 'name name--sm', domain));
    body.append(el('div', 'sub', 'not managed'));

    const back = el('button', 'btn btn--quiet', 'Manage again');
    back.type = 'button';
    back.addEventListener('click', () =>
      busy(back, 'Applying', async () => {
        await send({ cmd: 'releaseSite', domain, release: false });
        await refresh();
      })
    );

    row.append(body, back);
    node.append(row);
  }
}

/**
 * A Pro-gated toggle in the Isolation section (fail closed, cache isolation).
 *
 * Only rendered where it can matter: a build that can unlock it (dev, or a Pro
 * build showing it locked as an upsell). A free store build never shows it. When
 * locked it carries a Pro tag and does nothing; when available it toggles the
 * setting. The copy has two forms so it can say what the feature does when it is
 * yours and what it would do when it is not.
 */
function paintProToggle(nodeId, spec) {
  const node = $(nodeId);
  if (!node) return;
  const available = (state.entitlements ?? []).includes(spec.feature);
  const buildPro = state.license?.buildPro === true;
  if (!available && !buildPro) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.replaceChildren();

  const on = state.settings?.[spec.setting] === true && available;
  const row = el('div', 'toggle-row');
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.setAttribute('aria-label', spec.label);
  toggle.disabled = !available;
  toggle.append(el('span', 'knob'));
  toggle.addEventListener('click', async () => {
    if (!available) return;
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next));
    toggle.disabled = true;
    const r = await send({ cmd: 'setSettings', [spec.setting]: next });
    if (r?.settings) state.settings = r.settings;
    await refresh();
  });

  const label = el('div', 'toggle-label', spec.label);
  if (!available) label.append(el('span', 'pro-chip', 'Pro'));
  label.append(el('small', null, available ? spec.on : spec.off));
  row.append(toggle, label);
  node.append(row);
}

function paintFailClosed() {
  paintProToggle('failclosed', {
    feature: 'fail_closed',
    setting: 'failClosed',
    label: 'Fail closed',
    on: 'Strip cookies from every site a managed tab touches that this session does not own, not just the ones it already holds. Full isolation, at the cost of being signed out of unrelated sites in that tab.',
    off: 'Full isolation: nothing leaves a managed tab unless the session owns it. Unlocks with Pro.',
  });
  paintProToggle('cacheisolation', {
    feature: 'cache_isolation',
    setting: 'cacheIsolation',
    label: 'Cache isolation',
    on: "Stop a session's tabs from caching, so nothing a site stashes in the shared browser cache can be read back by another session on the same site. Costs the cache, so pages reload a little more.",
    off: "Keep the shared cache from carrying anything across your sessions on one site. Unlocks with Pro.",
  });
}

function paintPosture() {
  paintPause();
  paintReleased();
  paintFailClosed();
  const node = $('posture');
  if (!node) return;
  const current = state.settings?.posture ?? 'mirror';
  // Persona is the machine-per-session Pro feature. When it is not available the
  // effective posture degrades to Mirror, so that is what reads as checked, and
  // the Persona control is locked with a Pro tag rather than selectable-but-inert.
  const personaAvailable = (state.entitlements ?? []).includes('os_persona');
  const effective = personaAvailable || current !== 'persona' ? current : 'mirror';

  node.replaceChildren();
  for (const p of POSTURES) {
    const locked = p.key === 'persona' && !personaAvailable;
    const b = el('button', null, p.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.level = p.key;
    b.setAttribute('aria-checked', String(p.key === effective));
    b.disabled = state.mask?.available === false || locked;
    if (locked) b.append(el('span', 'pro-chip', 'Pro'));
    b.addEventListener('click', async () => {
      if (p.key === effective || locked) return;
      const r = await send({ cmd: 'setSettings', posture: p.key });
      if (r?.settings) state.settings = r.settings;
      await refresh();
    });
    node.append(b);
  }

  /**
   * What the setting is doing, and then what it is not doing yet.
   *
   * A fingerprint is changed by a script that runs before the page does, and
   * that script cannot enter a page which is already open. So switching this on
   * with tabs open changes nothing in those tabs, and the honest thing is to
   * say which ones rather than let the control imply it reached everywhere. The
   * worker leaves those tabs entirely alone in the meantime, headers included,
   * because a page reporting one browser while its requests report another is a
   * sharper fingerprint than the real one.
   */
  const behind = state.mask?.unmasked ?? 0;
  $('posture-note').textContent =
    state.mask?.available === false
      ? 'This build has no way to run a script in the page before the page does, so there is nothing to change a fingerprint with. Cookies and storage are still isolated.'
      : (POSTURES.find((p) => p.key === effective)?.note ?? '') +
        (behind && effective !== 'mirror'
          ? ` ${plural(behind, 'tab was', 'tabs were')} already open when you chose this, and a page cannot be changed after it has loaded, so ${behind === 1 ? 'it is' : 'they are'} left exactly as the browser made ${behind === 1 ? 'it' : 'them'} until you reload.`
          : '');

  paintSurfaces();
}

/**
 * What is masked and what is not, listed rather than summarised.
 *
 * A posture control with no inventory under it reads as a promise about the
 * whole fingerprint, and this one covers four surfaces. Naming the rest, and
 * saying which of them cannot close at this tier at all, is the difference
 * between a tool somebody can reason about and one that quietly oversells.
 */
/**
 * What each surface actually does, because they do different things.
 *
 * One line for all of them said "reads return a stable, seeded value", which is
 * true of three of them and false of the fourth: the navigator is normalised
 * rather than noised, and the half of it that matters most is not in the page at
 * all. A row that describes the wrong mechanism is worse than a row with no
 * description, because it is the screen telling somebody something untrue about
 * what they are running.
 */
const MASKED = {
  canvas: 'reads return a stable, seeded value',
  webgl: 'the card it names is the bucket, and the pixels it hands back are seeded',
  audio: 'rendered samples are seeded, below anything audible',
  navigator: 'the browser name is normalised, in the page and on the wire alike',
  voices: 'speech voices for languages you do not read are hidden, since those are installed packs',
};

function paintSurfaces() {
  const node = $('surfaces');
  if (!node) return;
  node.replaceChildren();

  const mask = state.mask;
  if (!mask || state.settings?.posture === 'mirror') return;

  for (const name of mask.applied ?? []) {
    const row = el('div', 'row row--check pass');
    row.append(tone(el('span', 'dot'), null));
    const mid = el('div', 'row-body');
    mid.append(el('div', 'name', name));
    mid.append(el('div', 'sub sub--wrap', MASKED[name] ?? 'reads return a stable, seeded value'));
    row.append(mid, el('span', 'check-mark', 'masked'));
    node.append(row);
  }

  for (const item of mask.unapplied ?? []) {
    const row = el('div', 'row row--check');
    row.append(el('span', 'dot'));
    const mid = el('div', 'row-body');
    mid.append(el('div', 'name', item.surface));
    mid.append(el('div', 'sub sub--wrap', item.why));
    row.append(mid, el('span', 'check-mark', 'real'));
    node.append(row);
  }
}

// -------------------------------------------------------- blast radius

/**
 * The three levels, described by what they do rather than by how alarming they
 * sound. "High" and "low" would leave the user guessing whether anything is
 * actually stopped, which is the one thing they need to know.
 */
const DANGER = [
  {
    key: 'off',
    label: 'Off',
    note: 'Nothing is interrupted. Destructive requests are still written to the trail, because a session nobody is guarding is the one you end up asking questions about.',
  },
  {
    key: 'warn',
    label: 'Warn',
    note: 'A card appears in the page when this session touches something with a blast radius. Nothing is stopped.',
  },
  {
    key: 'block',
    label: 'Production',
    note: 'Catalogued destructive requests are refused outright. The page is told why and can allow that one endpoint for five minutes.',
  },
];

/** One segmented control, used by both sheets. */
function dangerControl(node, noteNode, selected, onPick) {
  node.replaceChildren();
  for (const level of DANGER) {
    const b = el('button', null, level.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.level = level.key;
    b.setAttribute('aria-checked', String(level.key === selected));
    b.addEventListener('click', () => onPick(level.key));
    node.append(b);
  }
  noteNode.textContent = DANGER.find((d) => d.key === selected)?.note ?? '';
}

function timeAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function paintAudit() {
  const node = $('audit');
  if (!node) return;
  node.replaceChildren();
  const report = await send({ cmd: 'guard' });
  const rows = report?.recent ?? [];

  if (!rows.length) {
    node.append(el('p', 'empty', 'NOTHING WITH A BLAST RADIUS YET'));
  }

  for (const e of rows.slice(0, 25)) {
    const row = el('div', `row row--audit ${e.action}`);
    row.append(el('span', 'dot'));

    const mid = el('div');
    // What would have happened, not which endpoint was called. The URL is the
    // evidence; the sentence is the thing you are scanning for.
    mid.append(el('div', 'name', `${e.sessionLabel}: ${e.what}`));
    const detail = `${e.method} ${e.url}${e.count > 1 ? `  x${e.count}` : ''}`;
    mid.append(el('div', 'sub', detail));
    row.append(mid);

    const verb = el('span', `verb ${e.action}`);
    verb.textContent = `${e.action === 'blocked' ? 'refused' : e.action} / ${timeAgo(e.at)}`;
    row.append(verb);

    node.append(row);
  }

  const c = report?.counts ?? { total: 0, blocked: 0, warned: 0 };
  const unlocks = report?.unlocks ?? [];
  $('audit-note').textContent =
    `${plural(c.total, 'entry', 'entries')} on record, ${c.blocked} refused and ${c.warned} warned about. ` +
    'Every session is watched; only a session set to Production has anything refused. ' +
    (unlocks.length
      ? `${plural(unlocks.length, 'endpoint is', 'endpoints are')} temporarily allowed and will lock again on their own.`
      : '');
}

$('audit-refresh')?.addEventListener('click', () => busy($('audit-refresh'), 'Checking', paintAudit));

$('audit-clear')?.addEventListener('click', () =>
  busy($('audit-clear'), 'Clearing', async () => {
    await send({ cmd: 'clearAudit' });
    await paintAudit();
  })
);

/**
 * Cookies are half an identity. This is the other half, and it is worth showing
 * plainly rather than assuming: a site that keeps its token in localStorage is
 * only isolated if the shim reached the page, and the honest failure is a tab
 * reading "shared" rather than a claim on a settings screen that it is not.
 */
const STORAGE_MODES = {
  live: { title: 'Isolated', sub: 'reads and writes stay inside this session' },
  through: { title: 'Shared', sub: 'unmanaged tab, left exactly as the browser has it' },
  pending: { title: 'Waiting', sub: 'held in memory until the session is known' },
};

async function paintStorage() {
  const node = $('storage');
  if (!node) return;
  node.replaceChildren();
  const report = await send({ cmd: 'storage' });

  if (!report?.available) {
    const row = el('div', 'row row--check');
    row.append(el('span', 'dot'));
    const mid = el('div');
    mid.append(el('div', 'name', 'Not available in this build'));
    mid.append(
      el(
        'div',
        'sub sub--wrap',
        'Virtualising localStorage needs a MAIN world content script, which manifest v2 cannot declare. Cookies are still isolated.'
      )
    );
    row.append(mid);
    row.append(el('span', 'check-mark', 'n/a'));
    node.append(row);
    $('storage-note').textContent = '';
    return;
  }

  const rows = (report.tabs ?? []).filter((t) => t.origin);
  if (!rows.length) {
    // "Nothing here" is the wrong reading of an empty list: the feature is on
    // and simply has no page to act on yet.
    const row = el('div', 'row row--check pass');
    row.append(el('span', 'dot'));
    const mid = el('div');
    mid.append(el('div', 'name', 'Ready'));
    mid.append(
      el('div', 'sub sub--wrap', 'No managed page has loaded yet. Open one and it appears here.')
    );
    row.append(mid);
    row.append(el('span', 'check-mark', 'on'));
    node.append(row);
  }

  for (const t of rows.sort((a, b) => b.at - a.at).slice(0, 12)) {
    const mode = STORAGE_MODES[t.mode] ?? STORAGE_MODES.pending;
    const row = el('div', 'row row--check ' + (t.mode === 'live' ? 'pass' : ''));
    row.append(el('span', 'dot'));
    const mid = el('div');
    mid.append(el('div', 'name', t.origin));
    const session = t.sid ? (state.sessions ?? []).find((s) => s.id === t.sid) : null;
    mid.append(el('div', 'sub', session ? `${mode.sub}, as ${session.label}` : mode.sub));
    row.append(mid);
    row.append(el('span', 'check-mark', mode.title.toLowerCase()));
    node.append(row);
  }

  /**
   * The sites where the shared half of storage is not hypothetical.
   *
   * IndexedDB is not separated between sessions, which the note below has
   * always said. What it could not say is whether that sentence applies to
   * anything you use. Most sites never touch it; the ones that do are the ones
   * where it matters most, because Firebase, Supabase and Auth0 all keep tokens
   * there, so two sessions on such a site can read each other's login while
   * every other part of this is working. Naming them turns a disclaimer into a
   * disclosure.
   */
  for (const domain of report.idb ?? []) {
    const row = el('div', 'row row--check warn');
    row.append(el('span', 'dot'));
    const mid = el('div');
    mid.append(el('div', 'name', domain));
    mid.append(
      el(
        'div',
        'sub sub--wrap',
        'Keeps data in IndexedDB, which is shared between your sessions. If it stores your login there, sessions on this site can see each other.'
      )
    );
    row.append(mid);
    row.append(el('span', 'check-mark', 'shared'));
    node.append(row);
  }

  const copied = (report.forked ?? []).reduce((n, s) => n + s.origins, 0);
  const shared = (report.idb ?? []).length;
  $('storage-note').textContent =
    `A session landing on a site for the first time copies what the profile already had there, so it arrives signed in rather than just holding the right cookies. ${copied} copied so far. ` +
    'This keeps sessions out of each other; it does not hide them from the site itself. ' +
    (shared
      ? `IndexedDB is not separated, and ${plural(shared, 'site listed above uses', 'sites listed above use')} it.`
      : 'IndexedDB is not separated, and no site seen this session has used it.');
}

$('storage-refresh')?.addEventListener('click', () =>
  busy($('storage-refresh'), 'Checking', paintStorage)
);

/**
 * The host is optional, so the interesting state is why it is not there. Each
 * reason has a different fix and saying "unavailable" for all of them is how
 * somebody spends an evening on a registry key.
 */
const NATIVE_REASONS = {
  absent: {
    title: 'Not installed',
    hint: 'Optional. It keeps the vault key in the OS credential store instead of asking for a passphrase every restart. Install: node native/install.mjs <extension-id>',
  },
  refused: {
    title: 'Installed, but refusing this extension',
    hint: 'The host manifest does not list this extension id in allowed_origins. Re-run the installer with the id shown on the extensions page.',
  },
  mismatch: {
    title: 'Installed, but a different version',
    hint: 'The host and the extension speak different protocol versions. Re-run the installer to update it.',
  },
  timeout: {
    title: 'Installed, but not answering',
    hint: 'The host was launched and did not reply. Run node tools/native-check.mjs to see what it does outside the browser.',
  },
};

async function paintNative() {
  const node = $('native');
  if (!node) return;
  node.replaceChildren();
  const status = await send({ cmd: 'native' });

  const row = el('div', 'row row--check ' + (status?.present ? 'pass' : ''));
  row.append(el('span', 'dot'));

  const mid = el('div');
  if (status?.present) {
    mid.append(el('div', 'name', `Connected, version ${status.info.version}`));
    mid.append(
      el(
        'div',
        'sub',
        `${status.info.platform} / protocol ${status.info.protocol} / ` +
          `${status.info.capabilities.join(', ') || 'no capabilities'}` +
          `${status.info.sealed ? ' / key sealed by the OS' : ' / key held unsealed'}`
      )
    );
  } else {
    const reason = NATIVE_REASONS[status?.reason] ?? NATIVE_REASONS.absent;
    mid.append(el('div', 'name', reason.title));
    mid.append(el('div', 'sub sub--wrap', reason.hint));
    if (status?.detail) mid.append(el('div', 'who', status.detail));
  }

  row.append(mid);
  row.append(el('span', 'check-mark', status?.present ? 'ready' : 'optional'));
  node.append(row);
}

$('native-refresh')?.addEventListener('click', () =>
  busy($('native-refresh'), 'Checking', async () => {
    await send({ cmd: 'native', refresh: true });
    await paintNative();
  })
);

function paintResults(report) {
  const node = $('results');
  if (!node) return;
  node.replaceChildren();

  if (report.error) {
    node.append(el('div', 'banner', report.error));
    return;
  }

  const env = report.environment;
  const head = el('p', 'sub');
  const passed = report.checks.filter((c) => c.pass).length;
  head.textContent = env?.browser
    ? `${env.browser} ${env.chromium ?? ''} / manifest v${env.manifest} / ${passed} of ${report.checks.length} passed`
    : `${passed} of ${report.checks.length} passed`;
  node.append(head);

  report.checks.forEach((c, i) => {
    const row = el('div', `row row--check ${c.pass ? 'pass' : 'fail'}`);
    row.style.animationDelay = `${Math.min(i * 18, 320)}ms`;
    row.append(el('span', 'dot'));
    row.append(el('span', 'check-name', c.name + (c.detail ? `  (${c.detail})` : '')));
    row.append(el('span', 'check-mark', c.pass ? 'pass' : 'fail'));
    node.append(row);
  });
}

async function refresh() {
  const [s, t] = await Promise.all([send({ cmd: 'state' }), send({ cmd: 'tabs' })]);
  state = s ?? state;
  tabs = t ?? [];
  paintStrip();
  paintSessions();
  paintTabs();
  paintChannels();
  paintPosture();
  paintPro();
  paintSync();
  void paintAudit();
  paintThirdParties();
  void paintStorage();
  void paintNative();
}

/**
 * The Pro tier, section 30. One block in Settings that reads the licence state
 * the worker computes and never verifies anything itself: it shows what is
 * unlocked, and on a Pro build lets a licence key be entered, moved between
 * devices, or removed. On a free build it is the honest roadmap, no purchase
 * button, because payment is not switched on until the isolation it sells has no
 * hole left. Everything degrades to the free product, so an absent or unreachable
 * licence server is not a broken screen, it is the free screen.
 */
const PRO_FEATURES = [
  ['idb_isolation', 'IndexedDB isolation', 'Each session gets its own IndexedDB, not just its own name.'],
  ['fail_closed', 'Fail closed', 'On a tab it cannot fully cover, hold the line instead of falling back to the browser’s own jar.'],
  ['exact_mode', 'Exact cookie control', 'Rewrite the Cookie header per request, so nothing a session should withhold ever leaves.'],
  ['worker_isolation', 'Worker isolation', 'Carry the session into web and service workers, not only the page.'],
  ['os_persona', 'A machine per session', 'A stable, unlinkable machine per session under Persona, on your real OS, so two of your accounts cannot be matched by the device they share.'],
  ['cache_isolation', 'Per-session cache', 'A separate HTTP cache per session, so nothing bleeds through a shared one.'],
  ['sync', 'Cross-device sync', 'Carry your sessions, encrypted, to your other machines.'],
];

function proFeatureList(unlocked) {
  const list = el('ul', 'pro-feats');
  for (const [key, name, blurb] of PRO_FEATURES) {
    const on = unlocked.has(key);
    const li = el('li', `pro-feat ${on ? 'is-on' : ''}`);
    li.append(el('span', 'pro-tick', on ? '✓' : '○'));
    const body = el('div', 'pro-feat-body');
    body.append(el('div', 'pro-feat-name', name));
    body.append(el('div', 'pro-feat-blurb', blurb));
    li.append(body);
    list.append(li);
  }
  return list;
}

function fmtDay(sec) {
  if (!sec) return null;
  try {
    return new Date(sec * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

/**
 * Cross-device sync, the Pro `sync` feature, in its own block.
 *
 * Honest about the two things that matter: only the structure syncs, not the
 * logins, and the passphrase is the key, so losing it loses the ability to read
 * the blob. Shown only where it can matter (dev, or a Pro build), locked with a
 * Pro chip otherwise.
 */
function paintSync() {
  const node = $('sync');
  const block = $('sync-block');
  const chip = $('sync-chip');
  if (!node || !block) return;
  const available = (state.entitlements ?? []).includes('sync');
  const buildPro = state.license?.buildPro === true;
  if (!available && !buildPro) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  if (chip) chip.hidden = available;
  node.replaceChildren();

  node.append(
    el(
      'p',
      'pro-lead',
      'Carry your sessions across your devices, end to end encrypted. Only the structure travels: names, colours, and pinned sites. Your logins stay on each device, which is the only model that survives modern sign-in security.'
    )
  );

  if (!available) {
    node.append(el('p', 'pro-note', 'Unlocks with Pro. Needs a licence on each device you sync.'));
    return;
  }

  const s = state.sync ?? {};
  const msg = el('p', 'pro-msg');
  msg.hidden = true;
  const say = (text, cls) => {
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `pro-msg ${cls ?? ''}`;
  };
  const reasons = {
    passphrase: 'That passphrase does not match what another device used. Use the same one everywhere.',
    no_license: 'Sync needs a Pro licence active on this device.',
    network: 'Could not reach the sync server. Check your connection and try again.',
    conflict: 'Another device was syncing at the same time. Try Sync now again.',
    disabled: 'Enter a passphrase to turn sync on.',
  };
  const handle = (r) => {
    const result = r?.result ?? {};
    if (result.ok) {
      say(result.applied ? `Synced. ${plural(result.applied, 'session', 'sessions')} updated here.` : 'Synced.', 'pro-msg--ok');
    } else {
      say(reasons[result.reason] ?? 'Sync could not complete.', 'pro-msg--warn');
    }
    if (r?.sync) state.sync = r.sync;
  };

  if (!s.enabled) {
    // Turn on: a passphrase entry, with the one warning that matters.
    const form = el('div', 'pro-form');
    const input = el('input', 'pro-input');
    input.type = 'password';
    input.placeholder = 'A passphrase you will remember';
    input.autocomplete = 'off';
    const on = el('button', 'btn', 'Turn on sync');
    on.type = 'button';
    on.addEventListener('click', () =>
      busy(on, 'Syncing', async () => {
        const pass = input.value.trim();
        if (pass.length < 8) {
          say('Use at least 8 characters. This is the key to your synced data and cannot be recovered.', 'pro-msg--warn');
          return;
        }
        handle(await send({ cmd: 'syncEnable', passphrase: pass }));
        await refresh();
      })
    );
    form.append(input, on);
    node.append(form, msg);
    node.append(
      el(
        'p',
        'pro-note',
        'The passphrase is the key. It never leaves your devices, and it cannot be recovered, so keep it somewhere safe and use the same one on each device.'
      )
    );
    return;
  }

  // On: status, sync now, turn off.
  const when = s.lastSyncedAt ? fmtDay(Math.floor(s.lastSyncedAt / 1000)) : null;
  node.append(el('p', 'pro-note', when ? `On. Last synced ${when}.` : 'On.'));
  node.append(msg);
  const acts = el('div', 'pro-acts');
  const now = el('button', 'btn btn--quiet', 'Sync now');
  now.type = 'button';
  now.addEventListener('click', () =>
    busy(now, 'Syncing', async () => {
      handle(await send({ cmd: 'syncNow' }));
      await refresh();
    })
  );
  const off = el('button', 'btn btn--quiet btn--danger', 'Turn off');
  off.type = 'button';
  off.addEventListener('click', () =>
    busy(off, 'Turning off', async () => {
      await send({ cmd: 'syncDisable' });
      await refresh();
      toast('Sync turned off on this device. Your sessions here are untouched.');
    })
  );
  acts.append(now, off);
  node.append(acts);
}

function paintPro() {
  const node = $('pro');
  const block = $('pro-block');
  const badge = $('pro-badge');
  if (!node || !block) return;
  const lic = state.license ?? {};
  const tier = state.tier ?? 'free';
  const unlocked = new Set(state.entitlements ?? []);
  block.hidden = false;
  node.replaceChildren();

  const setBadge = (text, cls) => {
    if (!badge) return;
    badge.hidden = false;
    badge.textContent = text;
    badge.className = `pro-badge ${cls}`;
  };

  // A developer build unlocks everything without a licence, so it shows what a
  // shipped build would gate rather than the free roadmap or a key form.
  if (lic.dev === true) {
    setBadge('Dev', 'pro-badge--tester');
    node.append(
      el(
        'p',
        'pro-lead',
        'Developer build. Every Pro feature is unlocked locally for testing; a shipped build gates these behind a licence.'
      )
    );
    node.append(proFeatureList(unlocked));
    return;
  }

  // A free build (the store listing today): the roadmap, stated plainly, with no
  // way to pay because there is nothing to pay for yet.
  if (lic.buildPro !== true) {
    setBadge('Free', 'pro-badge--free');
    node.append(
      el(
        'p',
        'pro-lead',
        'Everything NVX does today is free and always will be. Pro is the next layer of isolation, in the works now.'
      )
    );
    node.append(proFeatureList(new Set()));
    const learn = el('button', 'btn btn--quiet', 'Read the plan');
    learn.type = 'button';
    learn.addEventListener('click', () =>
      chrome.tabs.create({ url: 'https://session.nvx.sh/pro' })
    );
    const acts = el('div', 'pro-acts');
    acts.append(learn);
    node.append(acts);
    return;
  }

  // A Pro build with a licence that is actually unlocking features.
  if (lic.present && tier !== 'free' && unlocked.size) {
    const tester = tier === 'max_access';
    setBadge(tester ? 'Tester' : 'Pro', tester ? 'pro-badge--tester' : 'pro-badge--pro');
    node.append(
      el('p', 'pro-lead', tester ? 'Max access, unlocked on this device.' : 'Pro is active on this device.')
    );
    const through = fmtDay(lic.exp);
    if (through) {
      node.append(
        el('p', 'pro-note', `Works offline through ${through}, and re-checks with the server on its own.`)
      );
    }
    node.append(proFeatureList(unlocked));

    const acts = el('div', 'pro-acts');
    const check = el('button', 'btn btn--quiet', 'Check status');
    check.type = 'button';
    check.addEventListener('click', () =>
      busy(check, 'Checking', async () => {
        await send({ cmd: 'refreshLicense' });
        await refresh();
      })
    );
    const remove = el('button', 'btn btn--quiet btn--danger', 'Remove from this device');
    remove.type = 'button';
    remove.addEventListener('click', () =>
      busy(remove, 'Removing', async () => {
        await send({ cmd: 'removeLicense' });
        await refresh();
        toast('Pro removed from this device. The seat is free to use on another.');
      })
    );
    acts.append(check, remove);
    node.append(acts);
    return;
  }

  // A Pro build with no working licence: the entry form. Also the state a
  // present-but-not-unlocking token lands in (expired, or bound to another
  // device), with a line saying so.
  setBadge('Free', 'pro-badge--free');
  if (lic.present && (lic.reason === 'expired' || lic.reason === 'wrong_device')) {
    node.append(
      el(
        'p',
        'pro-note pro-note--warn',
        lic.reason === 'expired'
          ? 'This licence has expired. Enter a current key, or check status if it was renewed.'
          : 'This licence is active on another device. Enter its key here to move it to this one.'
      )
    );
  } else {
    node.append(
      el('p', 'pro-lead', 'Have a Pro or tester key? Enter it to unlock Pro on this device.')
    );
  }

  const form = el('div', 'pro-form');
  const input = el('input', 'pro-input');
  input.type = 'text';
  input.placeholder = 'NVX-XXXX-XXXX-XXXX';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const activate = el('button', 'btn', 'Activate');
  activate.type = 'button';

  const msg = el('p', 'pro-msg');
  msg.hidden = true;
  const say = (text, cls) => {
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `pro-msg ${cls ?? ''}`;
  };

  const submit = (transfer) =>
    busy(activate, 'Activating', async () => {
      const key = input.value.trim();
      if (!key) {
        say('Enter your licence key first.', 'pro-msg--warn');
        return;
      }
      const r = await send({ cmd: 'enterLicense', key, ...(transfer ? { transfer: true } : {}) });
      const result = r?.result ?? {};
      if (result.ok) {
        await refresh();
        toast('Pro unlocked on this device.');
        return;
      }
      if (result.reason === 'seat_taken') {
        renderSeatTaken(result, key);
        return;
      }
      const reasons = {
        not_found: 'That key was not recognised. Check it and try again.',
        revoked: 'This licence has been revoked.',
        paused: 'This licence is paused. It will work again once it is resumed.',
        expired: 'This licence has expired.',
        network: 'Could not reach the licence server. Check your connection and try again.',
        rejected: 'That key could not be activated.',
      };
      say(reasons[result.reason] ?? 'That key could not be activated.', 'pro-msg--warn');
    });

  // The seat-taken transfer: the same key is live on another device, so offer to
  // move it here. This is the whole one-device-that-follows-you flow, and it
  // works even if that other machine is lost, because the release is server-side.
  function renderSeatTaken(result, key) {
    const box = el('div', 'pro-transfer');
    box.append(
      el(
        'p',
        'pro-note',
        `Your Pro is active on ${plural(result.devices?.length || 1, 'another device', 'your other devices')}. Moving it here signs it out there.`
      )
    );
    for (const d of result.devices ?? []) {
      const row = el('div', 'pro-device');
      row.append(el('span', 'pro-device-name', d.label || 'a device'));
      const seen = fmtDay(d.lastSeen ? Math.floor(d.lastSeen / 1000) : 0);
      if (seen) row.append(el('span', 'pro-device-seen', `last seen ${seen}`));
      box.append(row);
    }
    const move = el('button', 'btn', 'Move Pro to this device');
    move.type = 'button';
    move.addEventListener('click', () => submit(true));
    box.append(move);
    node.replaceChildren();
    node.append(
      el('p', 'pro-lead', 'Move your licence to this device'),
      box
    );
  }

  activate.addEventListener('click', () => submit(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit(false);
  });
  form.append(input, activate);
  node.append(form, msg);

  // A key is stored but not unlocking (paused, expired, or renewed on the
  // server). Offer a status check so a resumed or renewed licence comes back
  // without re-typing the key.
  if (lic.present) {
    const check = el('button', 'btn btn--quiet', 'Check status');
    check.type = 'button';
    check.addEventListener('click', () =>
      busy(check, 'Checking', async () => {
        await send({ cmd: 'refreshLicense' });
        await refresh();
      })
    );
    const acts = el('div', 'pro-acts');
    acts.append(check);
    node.append(acts);
  }

  node.append(proFeatureList(new Set()));
}

/**
 * Who else was on the page, grouped by the session that saw them.
 *
 * Read from the state payload rather than fetched separately, because the whole
 * point is that this sits next to the control it justifies: the setting and the
 * evidence for it should never be able to disagree.
 */
function paintThirdParties() {
  const node = $('thirdparty');
  if (!node) return;
  node.replaceChildren();

  const real = state.sessions.filter((s) => !s.system);
  const total = real.reduce((n, s) => n + (s.thirdParties?.length ?? 0), 0);

  if (!total) {
    node.append(el('p', 'empty', 'NOTHING THIRD PARTY SEEN YET'));
    $('tp-note').textContent =
      'Populated as your sessions browse. A session with no third parties has either seen none or has not been used yet.';
    return;
  }

  for (const s of real) {
    const seen = s.thirdParties ?? [];
    const head = el('div', 'row row--tp-head');

    const dot = tone(el('span', 'dot'), s.color);

    const blocking = s.thirdParty === 'block';
    const spared = new Set(s.allowedParties ?? []);

    const mid = el('div', 'row-body');
    mid.append(el('div', 'name', s.label));
    // The mode, in plain words, because a one-word "Blocked/Allowed" was read as
    // the session-wide setting when it was the opposite: a per-party "always
    // allowed" row under a blocking session looked like the session allowed all.
    mid.append(
      el(
        'div',
        'sub',
        blocking
          ? spared.size
            ? `Blocking third parties, ${plural(spared.size, 'one', 'ways')} allowed through`
            : 'Blocking third parties'
          : 'Allowing all third parties'
      )
    );

    // A single switch over the whole session, labelled by the state it is in
    // rather than by a bare adjective, so it reads as a mode and not as a verb.
    const toggle = el('button', `btn btn--quiet ${blocking ? 'btn--on' : ''}`, blocking ? 'BLOCKING' : 'ALLOWING ALL');
    toggle.type = 'button';
    toggle.title = blocking
      ? 'This whole session blocks third parties: one it has no cookies for gets nothing. Click to allow every third party instead.'
      : 'This whole session allows every third party, which hands them the browser’s own cookies and makes it correlatable with the others. Click to block them instead.';
    toggle.addEventListener('click', () =>
      busy(toggle, 'Applying', async () => {
        await send({
          cmd: 'setThirdParty',
          sessionId: s.id,
          thirdParty: blocking ? 'allow' : 'block',
        });
        await refresh();
      })
    );

    head.append(dot, mid, toggle);
    node.append(head);

    // One line that says what the per-party controls below do right now, so the
    // two levels, the session switch and the per-party spares, are never mistaken
    // for each other. Only when there is a list for it to be about.
    if (seen.length) {
      const parties = new Set(seen.map((x) => x.party)).size;
      const across = new Set(seen.map((x) => x.via)).size;
      node.append(
        el(
          'p',
          `tp-mode ${blocking ? 'tp-mode--block' : 'tp-mode--allow'}`,
          blocking
            ? `${plural(parties, 'third party', 'third parties')} across ${plural(across, 'site', 'sites')}. Each gets nothing unless you allow it here; allowing a sign-in provider is what a federated login needs.`
            : `${plural(parties, 'third party', 'third parties')} across ${plural(across, 'site', 'sites')}. The per-party controls are off because the session allows all; switch to BLOCKING to choose one at a time.`
        )
      );
    }

    /**
     * Each party is its own decision, because the list is not one kind of thing.
     *
     * A tracker and a sign-in provider are both third party, and on a federated
     * site they arrive in the same page load. A single switch over the pair asks
     * somebody to choose between being followed and being able to log in, and
     * what that produces in practice is a redirect loop that reads as the site
     * being broken. The list is already here and already says what each party
     * did, so the decision belongs on the row rather than above it.
     */

    // Every party the session saw, in full. No truncation and no "and N more":
    // a blocked list you cannot see all of is one you cannot act on, and the
    // point of this view is that the evidence is complete. The rows sit in the
    // stage's own flow, so the window grows to fit and the stage scrolls past
    // its cap, the one place anything scrolls in a view (see popup.css).
    for (const sighting of seen) {
      const row = el('div', 'row row--tp');
      const body = el('div');
      body.append(el('div', 'name name--sm', sighting.party));
      body.append(el('div', 'sub', `via ${sighting.via}`));

      const allowed = spared.has(sighting.party);
      const state = allowed ? 'Always allowed' : sighting.blocked ? 'Blocked' : 'Sent cookies';
      const pick = el(
        'button',
        `tag tag--act ${allowed ? 'tag--allowed' : sighting.blocked ? 'tag--blocked' : 'tag--production'}`,
        state.toUpperCase()
      );
      pick.type = 'button';
      // Only means anything while the session is blocking. Said rather than
      // hidden, because a control that vanishes is one nobody finds again.
      pick.title =
        s.thirdParty === 'block'
          ? allowed
            ? `${sighting.party} is let through even though this session blocks third parties. Click to block it again.`
            : `${sighting.party} gets no cookies. Click to let this one through, which is what a sign-in provider needs.`
          : 'This session allows every third party, so there is nothing to spare. Block them first.';
      pick.disabled = s.thirdParty !== 'block';
      pick.addEventListener('click', () =>
        busy(pick, '...', async () => {
          await send({
            cmd: 'allowParty',
            sessionId: s.id,
            party: sighting.party,
            allow: !allowed,
          });
          await refresh();
        })
      );

      row.append(body, el('span', 'count', `${sighting.count}`), pick);
      node.append(row);
    }
  }

  $('tp-note').textContent =
    'Blocked means the request went out with no cookie header. Sent cookies means the browser’s own jar reached that party, which is what makes sessions correlatable. Click any party to let that one through: a sign-in provider is third party too, and blocking it is what turns a login into a redirect loop.';
}

$('tp-clear')?.addEventListener('click', () =>
  busy($('tp-clear'), 'Clearing', async () => {
    await send({ cmd: 'clearThirdParties' });
    await refresh();
  })
);

// ------------------------------------------------------------------ sheets

/**
 * One trap for every sheet. A modal that lets focus wander back into the page
 * behind it is a modal in appearance only, and Escape has to work from
 * anywhere inside it including a text field.
 */
let openSheetId = null;
let sheetReturn = null;

function trapFocus(sheet, e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSheet();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = [...sheet.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.tabIndex !== -1 && n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function onSheetKey(e) {
  if (!openSheetId) return;
  trapFocus($(openSheetId), e);
}

function showSheet(id, focusId, returnTo) {
  $(id).hidden = false;
  openSheetId = id;
  sheetReturn = returnTo;
  document.addEventListener('keydown', onSheetKey, true);
  setTimeout(() => $(focusId)?.focus(), 40);
}

function closeSheet() {
  if (!openSheetId) return;
  $(openSheetId).hidden = true;
  openSheetId = null;
  document.removeEventListener('keydown', onSheetKey, true);
  sheetReturn?.focus();
  sheetReturn = null;
}

function swatches(node, selected, onPick) {
  node.replaceChildren();
  for (const c of COLORS) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.setAttribute('aria-checked', String(c === selected));
    b.style.background = hex(c);
    b.addEventListener('click', () => onPick(c));
    node.append(b);
  }
}

/** Starts on a hue no session is wearing, so two sessions rarely collide. */
function unusedColor() {
  const used = new Set(state.sessions.map((s) => s.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[state.sessions.length % COLORS.length];
}

function paintNewSwatches() {
  swatches($('new-colors'), chosenColor, (c) => {
    chosenColor = c;
    paintNewSwatches();
  });
}

function paintNewDanger() {
  dangerControl($('new-danger'), $('new-danger-note'), chosenDanger, (d) => {
    chosenDanger = d;
    paintNewDanger();
  });
}

/**
 * Which open tabs to fold into the session being created, by tab id.
 *
 * Picking a tab here is the fast path that the pinned-domain field is the slow
 * one for: instead of typing vercel.com you tick the vercel tab you already
 * have open, and on create it is moved into the session and its domain pinned,
 * so the thing you were looking at simply belongs to the session now.
 */
const newTabs = new Set();

function paintNewTabs() {
  const node = $('new-tabs');
  if (!node) return;
  node.replaceChildren();
  const relevant = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  // Drop ticks for tabs closed since the sheet opened.
  for (const id of [...newTabs]) if (!relevant.some((t) => t.id === id)) newTabs.delete(id);

  if (!relevant.length) {
    node.append(el('p', 'empty', 'NO OPEN TABS'));
    return;
  }

  for (const t of relevant) {
    const row = el('label', 'pick-row');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tab-check';
    check.checked = newTabs.has(t.id);
    check.addEventListener('change', () => {
      if (check.checked) newTabs.add(t.id);
      else newTabs.delete(t.id);
    });

    const session = state.sessions.find((s) => s.id === t.sessionId);
    const dot = tone(el('span', 'dot'), session?.color);

    const body = el('div', 'pick-body');
    body.append(el('div', 'pick-name', t.title || t.url));
    body.append(el('div', 'pick-sub', domainOfUrl(t.url) || t.url));

    row.append(check, dot, body);
    node.append(row);
  }
}

$('new-session')?.addEventListener('click', () => {
  $('new-label').value = '';
  $('new-pinned').value = '';
  chosenColor = unusedColor();
  chosenDanger = 'warn';
  newTabs.clear();
  paintNewSwatches();
  paintNewDanger();
  paintNewTabs();
  showSheet('sheet', 'new-label', $('new-session'));
});
$('sheet-cancel')?.addEventListener('click', closeSheet);
$('sheet-close')?.addEventListener('click', closeSheet);

$('sheet-create')?.addEventListener('click', () =>
  busy($('sheet-create'), 'Creating', async () => {
    const label = $('new-label').value.trim() || 'session';
    const typed = $('new-pinned')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // The picked tabs contribute their domains too, so a session made from tabs
    // pins the right sites without anyone typing them.
    const fromTabs = [...newTabs]
      .map((id) => domainOfUrl(tabs.find((t) => t.id === id)?.url || ''))
      .filter(Boolean);
    const pinned = [...new Set([...typed, ...fromTabs])];

    const r = await send({
      cmd: 'createSession',
      label,
      color: chosenColor,
      pinned,
      danger: chosenDanger,
    });
    // Move the picked tabs in, through the same guarded path everything else
    // uses, so they belong to the session the moment it exists.
    if (r?.id && newTabs.size) {
      await send({ cmd: 'moveTabs', tabIds: [...newTabs], sessionId: r.id });
    }
    closeSheet();
    await refresh();
  })
);

/**
 * Open a site signed in as a chosen session.
 *
 * A small prompt rather than a jump straight to a fixed site, because the whole
 * point is that the session is empty and the user decides who to sign in as. It
 * takes any address; the worker pins the domain and opens a tab already in the
 * session so the first request is already the right identity.
 */
let signingInto = null;

function openSignIn(session, returnTo) {
  signingInto = session;
  const input = $('signin-url');
  input.value = '';
  $('signin-for').textContent = session.label;
  $('signin-swatch').style.setProperty('--tone', hex(session.color));
  showSheet('signin-sheet', 'signin-url', returnTo);
}

$('signin-cancel')?.addEventListener('click', closeSheet);
$('signin-close')?.addEventListener('click', closeSheet);

/** A few common ones, as a convenience only. Any address works. */
for (const chip of document.querySelectorAll('[data-signin-site]')) {
  chip.addEventListener('click', () => {
    $('signin-url').value = chip.dataset.signinSite;
  });
}

$('signin-go')?.addEventListener('click', () =>
  busy($('signin-go'), 'Opening', async () => {
    const url = $('signin-url').value.trim();
    if (!url || !signingInto) return;
    const r = await send({ cmd: 'openInSession', sessionId: signingInto.id, url });
    closeSheet();
    if (r?.ok) {
      // The new tab took focus, so closing the popup is the natural end. On a
      // full page it stays, so refresh in case that is where we are.
      await refresh();
      if (typeof window !== 'undefined' && window.close) window.close();
    }
  })
);

// ------------------------------------------------------------------- edit

let editing = null;
let editColor = COLORS[0];
let editDanger = 'warn';
const editTabs = new Set();

/**
 * The same fast path the new-session sheet offers, on an existing session: tick
 * an open tab to pull it in rather than typing its domain. Only tabs that are
 * not already in this session are offered, because adding one already here is a
 * no-op that would only be confusing.
 */
function paintEditTabs() {
  const node = $('edit-tabs');
  if (!node) return;
  node.replaceChildren();
  const relevant = tabs.filter(
    (t) => t.url && /^https?:/.test(t.url) && t.sessionId !== editing
  );
  for (const id of [...editTabs]) if (!relevant.some((t) => t.id === id)) editTabs.delete(id);

  if (!relevant.length) {
    node.append(el('p', 'empty', 'NO OTHER OPEN TABS'));
    return;
  }

  for (const t of relevant) {
    const row = el('label', 'pick-row');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tab-check';
    check.checked = editTabs.has(t.id);
    check.addEventListener('change', () => {
      if (check.checked) editTabs.add(t.id);
      else editTabs.delete(t.id);
    });

    const session = state.sessions.find((s) => s.id === t.sessionId);
    const dot = tone(el('span', 'dot'), session?.color);

    const body = el('div', 'pick-body');
    body.append(el('div', 'pick-name', t.title || t.url));
    body.append(el('div', 'pick-sub', domainOfUrl(t.url) || t.url));

    row.append(check, dot, body);
    node.append(row);
  }
}

function paintEditSwatches() {
  swatches($('edit-colors'), editColor, (c) => {
    editColor = c;
    paintEditSwatches();
  });
}

function paintEditDanger() {
  dangerControl($('edit-danger'), $('edit-danger-note'), editDanger, (d) => {
    editDanger = d;
    paintEditDanger();
  });
}

function openEdit(session, returnTo) {
  editing = session.id;
  editColor = COLORS.includes(session.color) ? session.color : COLORS[0];
  $('edit-label').value = session.label;
  $('edit-pinned').value = session.pinned.join(', ');
  editDanger = DANGER.some((d) => d.key === session.danger) ? session.danger : 'warn';
  editTabs.clear();
  paintEditSwatches();
  paintEditDanger();
  paintEditTabs();
  showSheet('edit-sheet', 'edit-label', returnTo);
}

$('edit-cancel')?.addEventListener('click', closeSheet);
$('edit-close')?.addEventListener('click', closeSheet);

$('edit-save')?.addEventListener('click', () =>
  busy($('edit-save'), 'Saving', async () => {
    if (!editing) return;
    const target = editing;
    // Picked tabs pin their domains too, so pulling a tab in also claims its
    // site, exactly as the new-session sheet does.
    const fromTabs = [...editTabs]
      .map((id) => domainOfUrl(tabs.find((t) => t.id === id)?.url || ''))
      .filter(Boolean);
    const typed = $('edit-pinned')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await send({
      cmd: 'editSession',
      sessionId: target,
      label: $('edit-label').value,
      color: editColor,
      pinned: [...new Set([...typed, ...fromTabs])],
      danger: editDanger,
    });
    // Move the picked tabs in through the same guarded path new-session uses.
    if (editTabs.size) {
      await send({ cmd: 'moveTabs', tabIds: [...editTabs], sessionId: target });
    }
    editing = null;
    editTabs.clear();
    closeSheet();
    await refresh();
  })
);

/**
 * Per-session cookie backup: export the jar to a file, import one back.
 *
 * The deliberate counterpart to sync, which never carries the jars. Export builds
 * the file in the popup from the snapshot the worker hands back; import reads a
 * file the user picked and sends it to the worker to merge. Both are honest in the
 * note beside them about what a backup holds and what a device-bound login will
 * not do.
 */
$('edit-export')?.addEventListener('click', () =>
  busy($('edit-export'), 'Exporting', async () => {
    if (!editing) return;
    const r = await send({ cmd: 'exportSession', sessionId: editing });
    if (!r?.ok) return;
    const safe = (r.label || 'session').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 40) || 'session';
    const blob = new Blob([JSON.stringify({ nvx: 1, label: r.label, ...r.snapshot }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nvx-${safe}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  })
);

$('edit-import')?.addEventListener('click', () => $('edit-file')?.click());
$('edit-file')?.addEventListener('change', async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  const note = $('edit-backup-note');
  if (!file || !editing) return;
  try {
    const parsed = JSON.parse(await file.text());
    const r = await send({ cmd: 'importSession', sessionId: editing, snapshot: parsed });
    if (r?.ok) {
      note.textContent = `Imported ${plural(r.added, 'cookie', 'cookies')}. Reload the tabs in this session to use them.`;
      await refresh();
    } else {
      note.textContent = r?.reason || 'That file could not be imported.';
    }
  } catch {
    note.textContent = 'That file is not valid JSON.';
  }
});

// ------------------------------------------------------------------ adopt

function paintAdoptSwatches() {
  swatches($('adopt-colors'), adoptColor, (c) => {
    adoptColor = c;
    paintAdoptSwatches();
  });
}

function selectedCandidates() {
  return adoptCandidates.filter((c) => adoptSelected.has(c.domain));
}

/**
 * Rules a selection would compile to, mirrored from the compiler: four per
 * host, four per registrable fallback, plus the catch-all. Four because a top
 * level navigation compiles to two rules, split on whether the method is safe.
 * Shown before the session exists, because the alternative is a session that
 * silently drops hosts once it is too late to choose differently.
 */
const RULES_PER_HOST = 4;

function estimateRules(chosen) {
  const hosts = new Set();
  for (const c of chosen) for (const h of c.hosts) hosts.add(h);
  return hosts.size * RULES_PER_HOST + chosen.length * RULES_PER_HOST + 1;
}

function paintMeter() {
  const chosen = selectedCandidates();
  const rules = estimateRules(chosen);
  const ratio = rules / RULES_PER_SESSION;
  const over = ratio > 1;

  const node = $('adopt-meter');
  node.replaceChildren();

  const bar = el('div', 'meter-bar');
  const fill = el('div', `meter-fill${over ? ' over' : ratio > 0.7 ? ' warn' : ''}`);
  fill.style.width = `${Math.min(100, ratio * 100)}%`;
  bar.append(fill);

  const cookies = chosen.reduce((n, c) => n + c.cookies, 0);
  const text = el('div', `meter-text${over ? ' over' : ''}`);
  text.textContent = chosen.length
    ? over
      ? `${plural(chosen.length, 'site', 'sites')} needs ${rules} rules, over the ${RULES_PER_SESSION} a session gets. Deselect a few.`
      : `${plural(chosen.length, 'site', 'sites')} / ${plural(cookies, 'cookie', 'cookies')} / ${rules} of ${RULES_PER_SESSION} rules`
    : 'Nothing selected yet';

  node.append(bar, text);
  $('adopt-create').disabled = !chosen.length || over;

  if (!adoptNameTouched) {
    $('adopt-label').value = chosen.length ? chosen[0].label : '';
  }
}

function paintAdoptList() {
  const node = $('adopt-list');
  if (!node) return;
  const filter = $('adopt-filter').value.trim().toLowerCase();
  node.replaceChildren();

  const shown = adoptCandidates.filter(
    (c) =>
      !filter ||
      c.domain.includes(filter) ||
      (c.identity ?? '').toLowerCase().includes(filter)
  );

  if (!shown.length) {
    node.append(
      el('p', 'empty', adoptCandidates.length ? 'NOTHING MATCHES THAT FILTER' : 'NOTHING TO ADOPT')
    );
    return;
  }

  shown.forEach((c, i) => {
    const row = el('div', 'row row--adopt');
    row.style.animationDelay = `${Math.min(i * 12, 240)}ms`;

    const box = el('button', 'check');
    box.type = 'button';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(adoptSelected.has(c.domain)));
    box.setAttribute('aria-label', c.domain);

    const mid = el('div');
    mid.append(el('div', 'name', c.domain));
    if (c.identity) mid.append(el('div', 'who', c.identity));
    mid.append(
      el(
        'div',
        'sub',
        `${plural(c.cookies, 'cookie', 'cookies')} across ${plural(c.hosts.length, 'host', 'hosts')}`
      )
    );

    const tags = el('div', 'tags');
    if (c.signedIn) tags.append(el('span', 'tag tag--signed', 'SIGNED IN'));
    if (c.open) tags.append(el('span', 'tag tag--open', 'OPEN'));

    const toggle = () => {
      if (adoptSelected.has(c.domain)) adoptSelected.delete(c.domain);
      else adoptSelected.add(c.domain);
      box.setAttribute('aria-checked', String(adoptSelected.has(c.domain)));
      paintMeter();
    };
    // The whole row is the target. A sixteen pixel checkbox is not something to
    // ask anybody to hit repeatedly.
    row.addEventListener('click', toggle);
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    row.append(box, mid, tags);
    node.append(row);
  });
}

$('adopt')?.addEventListener('click', async () => {
  adoptCandidates = [];
  adoptSelected = new Set();
  adoptNameTouched = false;
  adoptBindTabs = true;
  adoptColor = unusedColor();
  $('adopt-filter').value = '';
  $('adopt-bind').setAttribute('aria-checked', 'true');
  paintAdoptSwatches();
  paintAdoptList();
  paintMeter();
  showSheet('adopt-sheet', 'adopt-filter', $('adopt'));

  await busy($('adopt'), 'Reading', async () => {
    const r = await send({ cmd: 'adoptScan' });
    adoptCandidates = r?.candidates ?? [];
    // Preselecting what is both signed in and open turns the common case into
    // one click, without preselecting a hundred sites nobody asked about.
    for (const c of adoptCandidates) {
      if (c.signedIn && c.open) adoptSelected.add(c.domain);
    }
  });

  // Painted after busy has restored the button states, or the enable that
  // depends on the selection is immediately undone by the restore.
  paintAdoptList();
  paintMeter();
});

$('adopt-cancel')?.addEventListener('click', closeSheet);
$('adopt-close')?.addEventListener('click', closeSheet);
$('adopt-filter')?.addEventListener('input', paintAdoptList);

$('adopt-signed')?.addEventListener('click', () => {
  for (const c of adoptCandidates) {
    if (c.signedIn) adoptSelected.add(c.domain);
  }
  paintAdoptList();
  paintMeter();
});

$('adopt-clear')?.addEventListener('click', () => {
  adoptSelected = new Set();
  paintAdoptList();
  paintMeter();
});

$('adopt-label')?.addEventListener('input', () => {
  adoptNameTouched = true;
});

$('adopt-bind')?.addEventListener('click', () => {
  adoptBindTabs = !adoptBindTabs;
  $('adopt-bind').setAttribute('aria-checked', String(adoptBindTabs));
});

$('adopt-create')?.addEventListener('click', () =>
  busy($('adopt-create'), 'Adopting', async () => {
    const chosen = selectedCandidates();
    const r = await send({
      cmd: 'adopt',
      domains: chosen.map((c) => c.domain),
      label: $('adopt-label').value.trim() || chosen[0]?.label,
      color: adoptColor,
      bindOpenTabs: adoptBindTabs,
    });
    if (!r?.ok) {
      $('adopt-meter').replaceChildren(el('div', 'meter-text over', r?.reason ?? 'adoption failed'));
      return;
    }
    closeSheet();
    await refresh();
  })
);

// ------------------------------------------------------------ diagnostics

$('refresh')?.addEventListener('click', () => busy($('refresh'), 'Reading', refresh));

$('selftest')?.addEventListener('click', () =>
  busy($('selftest'), 'Running', async () => {
    await send({ cmd: 'resetDesync' });
    const report = await send({ cmd: 'selftest' });
    lastReport = report;
    paintResults(report);
    $('copy').disabled = false;
    await refresh();
  })
);

$('restoretest')?.addEventListener('click', () =>
  busy($('restoretest'), 'Running', async () => {
    const report = await send({ cmd: 'restoretest' });
    lastReport = report;
    paintResults({
      ...report,
      environment: state.environment ?? { browser: '', chromium: '', manifest: 3 },
    });
    $('copy').disabled = false;
    await refresh();
  })
);

$('painttest')?.addEventListener('click', () =>
  busy($('painttest'), 'Running', async () => {
    const report = await send({ cmd: 'painttest' });
    lastReport = report;
    paintResults({ ...report, environment: state.environment });
    $('copy').disabled = false;
  })
);

$('storagetest')?.addEventListener('click', () =>
  busy($('storagetest'), 'Running', async () => {
    const report = await send({ cmd: 'storagetest' });
    lastReport = report;
    paintResults({ ...report, environment: state.environment });
    $('copy').disabled = false;
    await paintStorage();
  })
);

$('guardtest')?.addEventListener('click', () =>
  busy($('guardtest'), 'Running', async () => {
    const report = await send({ cmd: 'guardtest' });
    lastReport = report;
    paintResults({ ...report, environment: state.environment });
    $('copy').disabled = false;
    await paintAudit();
  })
);

$('copy')?.addEventListener('click', () =>
  busy($('copy'), 'Copied', async () => {
    await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
    await new Promise((r) => setTimeout(r, 650));
  })
);

/**
 * The popup hands off here for anything that needs room. Opening straight into
 * the sheet is the difference between being sent to a settings page and being
 * carried on with what you asked for.
 */
refresh().then(() => {
  if (location.hash === '#new') $('new-session')?.click();
});
