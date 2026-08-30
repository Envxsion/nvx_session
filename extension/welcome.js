/**
 * The setup screen, shown once, on the first run.
 *
 * The problem it exists for: this extension installed onto a browser somebody
 * has used for years does nothing visible. Every tab is unmanaged, every account
 * is still in the shared jar, and the one screen that would change that is
 * behind a toolbar button and a dialog nobody has a reason to open. Measured
 * against the only thing that matters, whether the person ends up isolated, an
 * extension that waits to be found has already failed.
 *
 * So this reads the profile, works out which of it looks like a real signed-in
 * account, groups the sites that belong to one account together, and offers the
 * whole thing as a single press.
 *
 * Three rules shape every decision here.
 *
 * Nothing is done before the button. The screen is a proposal, and the profile
 * is untouched until somebody presses something.
 *
 * Nothing is destroyed by the button either. Adoption copies, so the browser's
 * own jar is exactly as it was afterwards and undoing this is deleting a session.
 *
 * And it must be skippable without guilt. A first run screen that reads as a
 * demand is one people close and resent. "Not now" is a real answer and it is
 * offered as plainly as the other one.
 */

/* $, send, el, plural, COLORS and hex come from base.js. */

let groups = [];
let selected = new Set();
let showAll = false;
let scanned = null;

const fmt = (n) => n.toLocaleString();

/**
 * The colour a group will get, decided once and read by both the dot beside it
 * and the session that is created from it.
 *
 * Two places computing this separately is the drift `tests/ramp.test.ts` exists
 * to prevent one level down, and the first version had it: the dot took the
 * group's index in the whole list and the session took its index among the
 * ticked ones, so the swatch somebody saw was not the colour they got as soon
 * as they unticked anything above it.
 *
 * Keyed on position in the full list rather than on the selection, so a colour
 * does not move under somebody as they tick and untick.
 */
function colorFor(group) {
  const at = groups.indexOf(group);
  return COLORS[(at < 0 ? 0 : at) % COLORS.length];
}

function badge(text, kind) {
  const b = el('span', `wel-badge wel-badge--${kind}`, text);
  return b;
}

/** How long until this account's token stops working, when the token says. */
function expiryNote(at) {
  if (typeof at !== 'number') return null;
  const left = at - Date.now();
  if (left <= 0) return 'expired';
  const hours = Math.round(left / 3_600_000);
  if (hours < 1) return 'expires within the hour';
  if (hours < 48) return `expires in ${plural(hours, 'hour', 'hours')}`;
  return `expires in ${plural(Math.round(hours / 24), 'day', 'days')}`;
}

function paintList() {
  const list = $('list');
  list.replaceChildren();

  const shown = showAll ? groups : groups.filter((g) => g.signedIn);

  if (!groups.length) {
    list.append(
      el(
        'p',
        'empty',
        scanned === null ? 'READING THE PROFILE JAR' : 'NOTHING SIGNED IN THAT WE CAN SEE'
      )
    );
    return;
  }

  if (!shown.length) {
    const box = el('div', 'wel-none');
    box.append(
      el('p', null, 'Nothing here looks like a signed-in account.'),
      el(
        'p',
        null,
        'That usually means the accounts are held somewhere this cannot read, which is fine: sessions can be made by hand and they will pick the sites up as you sign in.'
      )
    );
    list.append(box);
    return;
  }

  for (const g of shown) {
    const row = el('label', 'wel-row');
    if (!g.fits) row.classList.add('wel-row--over');

    const box = el('input');
    box.type = 'checkbox';
    box.className = 'wel-check';
    box.checked = selected.has(g.key);
    box.disabled = !g.fits;
    box.addEventListener('change', () => {
      if (box.checked) selected.add(g.key);
      else selected.delete(g.key);
      row.classList.toggle('is-on', box.checked);
      paintMeter();
    });

    const dot = el('span', 'wel-dot');
    dot.style.setProperty('--dot-tone', hex(colorFor(g)));

    const main = el('div', 'wel-main-col');
    main.append(el('span', 'wel-name', g.label));

    const sites = el('span', 'wel-sites');
    sites.textContent = g.domains.join('  ·  ');
    main.append(sites);

    const marks = el('div', 'wel-marks');
    if (g.signedIn) marks.append(badge('signed in', 'ok'));
    // The count rather than the fact, because the count is what makes a
    // proposal recognisable: "four of my tabs" is a thing somebody can picture,
    // "tab open" is a flag.
    if (g.openTabs > 0) marks.append(badge(plural(g.openTabs, 'tab open', 'tabs open'), 'live'));
    else if (g.open) marks.append(badge('tab open', 'live'));
    const exp = expiryNote(g.expires);
    if (exp) marks.append(badge(exp, exp === 'expired' ? 'warn' : 'quiet'));
    if (!g.fits) marks.append(badge('too many sites for one session', 'warn'));
    if (marks.childElementCount) main.append(marks);

    const count = el('div', 'wel-count');
    count.append(
      el('span', 'wel-num', fmt(g.cookies)),
      el('span', 'wel-unit', g.cookies === 1 ? 'cookie' : 'cookies')
    );

    row.append(box, dot, main, count);
    row.classList.toggle('is-on', box.checked);
    list.append(row);
  }
}

function paintMeter() {
  const chosen = groups.filter((g) => selected.has(g.key));
  const sites = chosen.reduce((n, g) => n + g.domains.length, 0);
  const cookies = chosen.reduce((n, g) => n + g.cookies, 0);

  const meter = $('meter');
  meter.replaceChildren();
  if (!chosen.length) {
    meter.append(el('span', 'wel-meter-quiet', 'Nothing selected'));
  } else {
    meter.append(
      el('span', null, plural(chosen.length, 'session', 'sessions')),
      el('span', 'wel-meter-sep', '/'),
      el('span', null, plural(sites, 'site', 'sites')),
      el('span', 'wel-meter-sep', '/'),
      el('span', null, `${fmt(cookies)} cookies copied`)
    );
  }

  const go = $('go');
  go.disabled = chosen.length === 0;
  go.textContent = chosen.length
    ? `Set up ${plural(chosen.length, 'session', 'sessions')}`
    : 'Set up 0 sessions';
}

function paintStrip() {
  const strip = $('strip');
  // Left as it was until there is something to replace it with. Clearing first
  // and returning left the strip empty for as long as the scan took, which on a
  // cold worker reads as a broken header rather than as a wait.
  if (!scanned) return;
  strip.replaceChildren();
  const fields = [
    ['accounts', String(groups.filter((g) => g.signedIn).length)],
    ['sites carrying cookies', fmt(scanned.total ?? 0)],
    ['tabs open', fmt(scanned.tabs ?? 0)],
  ];
  for (const [label, value] of fields) {
    const cell = el('span', 'wel-stat');
    cell.append(el('span', 'wel-stat-v', value), el('span', 'wel-stat-l', label));
    strip.append(cell);
  }
}

async function scan() {
  /**
   * Retried, because the worker may be cold.
   *
   * This page is opened by the install event, which is the one moment the
   * worker is guaranteed to be doing several other things at once, and a
   * message that arrives before it has finished booting comes back undefined.
   * A setup screen that says "nothing found" because it asked too early is the
   * worst possible first impression: it is wrong, and it is wrong in the
   * direction of "this does not work".
   */
  let r = null;
  for (let i = 0; i < 12 && !r; i++) {
    r = await send({ cmd: 'adoptScan' });
    if (!r) await new Promise((res) => setTimeout(res, 400));
  }
  scanned = r ?? { groups: [], total: 0, tabs: 0 };
  groups = Array.isArray(scanned.groups) ? scanned.groups : [];
  selected = new Set(groups.filter((g) => g.preselect).map((g) => g.key));
  // Only worth offering when there is something behind it. A profile with three
  // hundred cookie-bearing domains and four accounts should not open on a list
  // of three hundred, but somebody looking for the other 296 must be able to
  // find them.
  showAll = groups.some((g) => g.signedIn) ? false : true;
  $('show-all').setAttribute('aria-pressed', String(showAll));
  paintStrip();
  paintList();
  paintMeter();
}

/**
 * Creates the sessions, one at a time, reporting each.
 *
 * Sequential rather than in parallel, and it matters: each adoption compiles a
 * rule set and re-registers the page scripts, so firing eight at once means
 * eight registrations racing each other for the same slot table. Slower and
 * correct beats faster and occasionally short of a session.
 */
async function run() {
  const chosen = groups.filter((g) => selected.has(g.key));
  const go = $('go');
  const results = [];

  go.disabled = true;
  $('skip').disabled = true;

  for (let i = 0; i < chosen.length; i++) {
    const g = chosen[i];
    go.textContent = `Setting up ${i + 1} of ${chosen.length}`;
    const r = await send({
      cmd: 'adopt',
      domains: g.domains,
      label: g.label,
      color: colorFor(g),
      bindOpenTabs: true,
    });
    results.push({ group: g, result: r ?? { ok: false, reason: 'no answer' } });
  }

  paintDone(results);
}

function paintDone(results) {
  const made = results.filter((r) => r.result.ok);
  const failed = results.filter((r) => !r.result.ok);

  const box = $('result');
  box.replaceChildren();

  for (const { group, result } of made) {
    const row = el('div', 'wel-done-row');
    row.append(
      el('span', 'wel-done-name', group.label),
      el(
        'span',
        'wel-done-detail',
        `${plural(result.cookies ?? 0, 'cookie', 'cookies')}, ${plural(result.tabs ?? 0, 'tab', 'tabs')} moved in`
      )
    );
    box.append(row);
  }

  for (const { group, result } of failed) {
    const row = el('div', 'wel-done-row wel-done-row--bad');
    row.append(
      el('span', 'wel-done-name', group.label),
      el('span', 'wel-done-detail', result.reason ?? 'could not be set up')
    );
    box.append(row);
  }

  if (!results.length) box.append(el('p', 'empty', 'NOTHING WAS SET UP'));

  const summary = el('p', 'note');
  summary.textContent = made.length
    ? 'Your open tabs on these sites are already in their sessions and did not reload. From here, a site exactly one session claims takes new tabs on its own, and a site two sessions claim asks you which one.'
    : 'Nothing was changed. You can make sessions by hand from the toolbar button at any time.';
  box.append(summary);

  document.querySelector('.wel-main').hidden = true;
  document.querySelector('.wel-hero .wel-lede').hidden = true;
  $('done').hidden = false;
  $('done').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Everything you have open, which is the selection this screen is really for.
 *
 * Somebody installing this has tabs open and a reason they wanted it, and the
 * reason is in those tabs. Offering the whole jar first answers a question
 * nobody asked; offering what is on screen answers the one they have.
 */
$('pick-open')?.addEventListener('click', () => {
  selected = new Set(groups.filter((g) => g.open && g.signedIn && g.fits).map((g) => g.key));
  paintList();
  paintMeter();
});

$('pick-signed')?.addEventListener('click', () => {
  selected = new Set(groups.filter((g) => g.signedIn && g.fits).map((g) => g.key));
  paintList();
  paintMeter();
});

$('pick-none')?.addEventListener('click', () => {
  selected = new Set();
  paintList();
  paintMeter();
});

$('show-all')?.addEventListener('click', () => {
  showAll = !showAll;
  $('show-all').setAttribute('aria-pressed', String(showAll));
  $('show-all').textContent = showAll ? 'Only accounts' : 'Show everything';
  paintList();
});

$('go')?.addEventListener('click', () => void run());

$('skip')?.addEventListener('click', () => {
  paintDone([]);
});

$('open-guide')?.addEventListener('click', () => {
  window.location.href = 'guide.html';
});

$('close')?.addEventListener('click', () => {
  window.close();
});

void scan();
