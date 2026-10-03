/**
 * ------------------------------------------------------------------
 *  Title    |  The held tab
 *  Ref      |  chooser.html, pick / pickerOptions / editSession
 *  ID       |  M6 (popup UI)
 * ------------------------------------------------------------------
 *  Purpose  |  Ask which session a tab belongs to before the site is
 *           |  contacted at all.
 *  How      |  Two questions. A site two sessions both claim: which
 *           |  account. A site no session has yet, opened from a fresh
 *           |  tab: which session is it for, remembered by default so
 *           |  it is asked once. Sessions can be made and renamed here,
 *           |  so nobody needs the panel, or a domain by heart, to put
 *           |  a site in a session.
 *  Note     |  Holding the navigation means nothing is requested and
 *           |  no cookie is set, so the answer arrives before the
 *           |  first byte does.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

const params = new URLSearchParams(location.search);
const target = params.get('url') ?? '';
const tabId = Number(params.get('tab'));

const RAMP = ['cyan', 'coral', 'jade', 'violet', 'amber', 'azure', 'magenta', 'chalk'];

const hex = (name) => {
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name ?? '')) return name;
  const style = getComputedStyle(document.documentElement);
  return style.getPropertyValue(`--s-${name}`).trim() || style.getPropertyValue('--unknown').trim() || '#4fd6ea';
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

let state = { reason: 'new', domain: '', options: [], palette: RAMP };
let answered = false;

/** The page breathes in the colour of whatever the pointer is over. */
function tint(color) {
  $('ambient').style.setProperty('--tone', color ? hex(color) : 'var(--signal)');
  setMark($('mark'), { state: 'ask', color: color ? hex(color) : undefined });
}

function leave() {
  answered = true;
  $('card').classList.add('going');
}

function answer(msg) {
  if (answered) return;
  leave();
  const remember = state.reason === 'new' && $('remember').checked;
  void send({ cmd: 'pick', tabId, url: target, remember, ...msg });
}

function swatchPicker(container, chosen, onPick) {
  container.replaceChildren();
  for (const name of state.palette) {
    const b = el('button', 'sw');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-checked', String(name === chosen));
    b.style.setProperty('--c', hex(name));
    b.addEventListener('click', () => {
      for (const s of container.children) s.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-checked', 'true');
      onPick(name);
    });
    container.append(b);
  }
}

/** Rename and recolour a session in place, without leaving the question. */
function editRow(li, opt) {
  if (li.querySelector('.editor')) return;
  let color = opt.color;
  const form = el('form', 'editor');
  const name = el('input', 'name-in');
  name.value = opt.label;
  name.maxLength = 40;
  name.setAttribute('aria-label', 'Session name');
  const sw = el('div', 'swatches');
  swatchPicker(sw, color, (c) => {
    color = c;
    li.style.setProperty('--tone', hex(c));
    tint(c);
  });
  const save = el('button', 'go go--ghost', 'Save');
  save.type = 'submit';
  form.append(name, sw, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = name.value.trim() || opt.label;
    await send({ cmd: 'editSession', sessionId: opt.sessionId, label, color });
    opt.label = label;
    opt.color = color;
    li.querySelector('.row-name').textContent = label;
    form.remove();
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      form.remove();
    }
  });
  li.append(form);
  name.focus();
  name.select();
}

function paint() {
  const list = $('list');
  list.replaceChildren();
  const opts = state.options;

  if (!opts.length) {
    list.append(el('li', 'waiting', 'No sessions yet. Make one below.'));
    openNew();
    return;
  }

  opts.forEach((opt, i) => {
    const li = el('li', 'row');
    li.style.setProperty('--tone', hex(opt.color));
    li.style.animationDelay = `${Math.min(i * 40, 280)}ms`;

    const hit = el('button', 'row-hit');
    hit.type = 'button';
    hit.dataset.index = String(i);

    const body = el('span', 'row-body');
    body.append(el('span', 'row-name', opt.label));
    let meta = 'Not signed in here yet';
    if (opt.identity && opt.identity !== opt.label) meta = opt.identity;
    else if (opt.cookies > 0) meta = `Signed in here before`;
    body.append(el('span', 'row-meta', meta));

    const side = el('span', 'row-side');
    if (opt.lastUsed) side.append(el('span', 'badge', 'Last used'));
    else if (opt.cookies > 0) side.append(el('span', 'badge', 'Knows this site'));
    if (i < 9) side.append(el('kbd', '', String(i + 1)));

    hit.append(el('span', 'swatch'), body, side);
    hit.addEventListener('click', () => answer({ sessionId: opt.sessionId }));
    hit.addEventListener('mouseenter', () => tint(opt.color));
    hit.addEventListener('focus', () => tint(opt.color));

    const edit = el('button', 'edit');
    edit.type = 'button';
    edit.title = 'Rename or recolour';
    edit.setAttribute('aria-label', `Edit ${opt.label}`);
    edit.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      editRow(li, opt);
    });
    side.prepend(edit);

    li.append(hit);
    list.append(li);
  });

  list.querySelector('.row-hit')?.focus();
}

// ------------------------------------------------------------- new session

let newColor = RAMP[0];
function openNew() {
  const editor = $('new-editor');
  if (!editor.hidden) {
    $('new-name').focus();
    return;
  }
  editor.hidden = false;
  $('new-open').setAttribute('aria-expanded', 'true');
  const used = new Set(state.options.map((o) => o.color));
  newColor = state.palette.find((c) => !used.has(c)) ?? state.palette[0];
  swatchPicker($('new-swatches'), newColor, (c) => {
    newColor = c;
    tint(c);
  });
  const site = (state.domain || hostOf(target)).split('.')[0] ?? '';
  $('new-name').value = site ? site.charAt(0).toUpperCase() + site.slice(1) : 'New session';
  $('new-name').focus();
  $('new-name').select();
  tint(newColor);
}

$('new-open').addEventListener('click', openNew);
$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  answer({ create: true, label: $('new-name').value.trim() || undefined, color: newColor });
});

$('once').addEventListener('click', () => answer({ unmanaged: true }));
$('once').addEventListener('mouseenter', () => tint(null));

addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === 'Escape' && !typing) {
    answer({ unmanaged: true });
    return;
  }
  if (typing) return;
  if (/^[1-9]$/.test(e.key)) {
    const opt = state.options[Number(e.key) - 1];
    if (opt) answer({ sessionId: opt.sessionId });
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openNew();
  }
});

// ------------------------------------------------------------------ paint

function frame() {
  const host = hostOf(target);
  $('host').textContent = host || 'this site';
  $('remember-host').textContent = state.domain || host || 'this site';
  document.title = `NVX / ${host}`;
  $('dest').textContent = target ? `Holding ${target}` : 'Holding this navigation';

  if (state.reason === 'ambiguous') {
    $('eyebrow').textContent = 'More than one account';
    $('lead').textContent = 'Which account for';
    $('tail').textContent = '?';
    $('sub').textContent = 'More than one of your sessions signs in here. Nothing has been sent yet.';
    $('remember-row').hidden = true;
  } else {
    $('eyebrow').textContent = 'New site, before it loads';
    $('lead').textContent = 'Which session is';
    $('tail').textContent = ' for?';
    $('sub').textContent = 'Nothing has been sent to the site yet. Pick where it signs in.';
  }
}

mountMark($('mark'), { state: 'ask' });
frame();
void (async () => {
  const r = await send({ cmd: 'pickerOptions', url: target, tabId });
  state = {
    reason: r?.reason === 'ambiguous' ? 'ambiguous' : 'new',
    domain: typeof r?.domain === 'string' ? r.domain : '',
    options: Array.isArray(r?.options) ? r.options : [],
    palette: Array.isArray(r?.palette) && r.palette.length ? r.palette : RAMP,
  };
  if (state.domain) $('remember-host').textContent = state.domain;
  frame();
  paint();
})();
