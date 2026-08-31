/**
 * ------------------------------------------------------------------
 *  Title    |  Shared surface helpers
 *  Ref      |  popup.js, panel.js, guide.js, welcome.js
 *  ID       |  M6 (popup UI)
 * ------------------------------------------------------------------
 *  Purpose  |  The handful of things every surface needs.
 *  How      |  One $, one colour lookup, tone and toast, shared so no
 *           |  two surfaces compute a session colour apart and then
 *           |  disagree about the same session.
 *  Note     |  Talks to no worker and touches no DOM on load, so it is
 *           |  safe on a page with none of the panel's elements.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The identity ramp, in wheel order.
 *  Note     |  Eight, ordered so consecutive picks sit far apart in
 *           |  hue, so a user's second session does not look like the
 *           |  first under a dim screen. Chalk is a deliberate neutral
 *           |  and sits last, the least useful default but the most
 *           |  distinct.
 * ------------------------------------------------------------------
 */
const COLORS = ['cyan', 'coral', 'jade', 'violet', 'amber', 'azure', 'magenta', 'chalk'];
const RULES_PER_SESSION = 320;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Resolve a ramp name, or a raw hex if a session was
 *           |  given one directly.
 *  Note     |  Without the hex case the panel shows grey for a colour
 *           |  the tab mark draws right, so the two surfaces disagree
 *           |  about the same session.
 * ------------------------------------------------------------------
 */
const hex = (name) => {
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(name ?? '')) return name;
  const style = getComputedStyle(document.documentElement);
  return (
    style.getPropertyValue(`--s-${name}`).trim() ||
    style.getPropertyValue('--unknown').trim() ||
    '#4fd6ea'
  );
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Colour a dot through a custom property, not through
 *           |  background.
 *  Note     |  The dot draws its halo from the same value; setting
 *           |  background directly leaves the halo grey, ringing every
 *           |  coloured dot in the wrong colour.
 * ------------------------------------------------------------------
 */
function tone(node, color) {
  node.style.setProperty('--dot-tone', color ? hex(color) : 'var(--mute-5)');
  return node;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A brief message at the foot of the surface, with at
 *           |  most one action.
 *  How      |  Owns its host node and appends it on first use, so any
 *           |  page can call it without markup and nothing loads.
 *           |  Calling again replaces what showed; a plain message
 *           |  clears sooner than one carrying an action.
 *  Note     |  For things already done and undoable: a bulk move runs
 *           |  the instant it is asked, so "undo" is only honest after
 *           |  the fact.
 * ------------------------------------------------------------------
 */
let toastTimer = null;
function toast(message, action) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', 'toast-host');
    host.id = 'toast-host';
    document.body.append(host);
  }
  clearTimeout(toastTimer);
  host.replaceChildren();

  const box = el('div', 'toast');
  box.append(el('span', 'toast-msg', message));
  if (action && action.label && typeof action.onClick === 'function') {
    const doIt = el('button', 'toast-do', action.label);
    doIt.type = 'button';
    doIt.addEventListener('click', async () => {
      clearTimeout(toastTimer);
      host.replaceChildren();
      await action.onClick();
    });
    box.append(doIt);
  }
  host.append(box);

  toastTimer = setTimeout(() => host.replaceChildren(), action ? 6000 : 3200);
}
