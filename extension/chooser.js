/**
 * ------------------------------------------------------------------
 *  Title    |  The held tab
 *  Ref      |  chooser.html, pick / pickerOptions messages
 *  ID       |  M6 (popup UI)
 * ------------------------------------------------------------------
 *  Purpose  |  Ask which session a tab belongs to before the site is
 *           |  contacted at all.
 *  How      |  Holding the navigation means nothing is requested and
 *           |  no cookie is set, so the answer arrives before the
 *           |  first byte does.
 *  Note     |  A federated site redirects to its identity provider in
 *           |  a second and takes an over-the-page question with it,
 *           |  completing sign-in as whatever jar the tab held.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

const params = new URLSearchParams(location.search);
const target = params.get('url') ?? '';
const tabId = Number(params.get('tab'));

const hex = (name) => {
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name ?? '')) return name;
  const style = getComputedStyle(document.documentElement);
  return (
    style.getPropertyValue(`--s-${name}`).trim() ||
    style.getPropertyValue('--unknown').trim() ||
    '#4fd6ea'
  );
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

/** Where this is going, shown in full so the destination is never a mystery. */
function paintDestination() {
  const host = hostOf(target);
  $('host').textContent = host;
  document.title = `NVX / ${host}`;
  $('dest').textContent = target ? `holding ${target}` : 'holding this navigation';
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Leave before the browser navigates, so the page does
 *           |  not sit there looking inert while the request goes out.
 *  Note     |  Purely cosmetic; the answer is already sent.
 * ------------------------------------------------------------------
 */
function leave() {
  $('card').classList.add('going');
}

function paint(options) {
  const list = $('list');
  list.replaceChildren();

  if (!options.length) {
    list.append(el('p', 'waiting', 'No session covers this site.'));
    return;
  }

  options.forEach((opt, i) => {
    const btn = el('button', 'opt');
    btn.type = 'button';
    btn.style.setProperty('--tone', hex(opt.color));
    btn.style.animationDelay = `${Math.min(i * 45, 260)}ms`;

    const body = el('div', 'body');
    body.append(el('div', 'name', opt.label));
    // The account, when we can name it. A session's label is what the user
    // called it; the identity is who the site will think they are, and on a
    // shared machine that difference is the entire question.
    if (opt.identity && opt.identity !== opt.label) {
      body.append(el('div', 'who', opt.identity));
    } else if (opt.cookies > 0) {
      body.append(el('div', 'who', `${opt.cookies} cookies here`));
    }

    let tag = `${opt.cookies}`;
    let cls = 'tag';
    if (opt.cookies === 0) {
      tag = 'SIGN IN';
      cls = 'tag tag--signin';
    } else if (opt.lastUsed) {
      tag = 'LAST USED';
      cls = 'tag tag--last';
    }

    btn.append(el('span', 'dot'), body, el('span', cls, tag));
    btn.addEventListener('click', () => {
      leave();
      void send({ cmd: 'pick', tabId, url: target, sessionId: opt.sessionId });
    });
    list.append(btn);
  });

  const first = list.querySelector('.opt');
  if (first) first.focus();
}

$('fresh').addEventListener('click', () => {
  leave();
  void send({ cmd: 'pick', tabId, url: target, create: true });
});

$('once').addEventListener('click', () => {
  leave();
  void send({ cmd: 'pick', tabId, url: target, unmanaged: true });
});

// Escape is the same answer as "just this once": the user wants the page, and
// refusing to give it to them until they choose a session would be a hostage
// situation rather than a chooser.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  leave();
  void send({ cmd: 'pick', tabId, url: target, unmanaged: true });
});

paintDestination();
void (async () => {
  const r = await send({ cmd: 'pickerOptions', url: target, tabId });
  paint(Array.isArray(r?.options) ? r.options : []);
})();
