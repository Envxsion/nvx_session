/**
 * The handful of things every surface needs.
 *
 * Four pages load this: the popup, the diagnostics panel, the guide and the
 * setup screen. It exists because the alternative was each of them defining its
 * own `$` and its own colour lookup, and the moment two surfaces compute a
 * session colour separately is the moment they disagree about the same session.
 *
 * Nothing here talks to the worker on load or touches the DOM on load. It is
 * safe to include on a page that has none of the panel's elements, which is
 * exactly why it is separate from `panel.js`.
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

/**
 * The identity ramp, in wheel order.
 *
 * Eight rather than six, and ordered so that consecutive picks are far apart
 * in hue: sessions are handed colours in this order, so the second session a
 * user makes must not look like the first one under a dim screen. Chalk is a
 * neutral on purpose, and sits last because a session that reads as "no
 * colour" is the least useful default even though it is the most distinct.
 */
const COLORS = ['cyan', 'coral', 'jade', 'violet', 'amber', 'azure', 'magenta', 'chalk'];
const RULES_PER_SESSION = 320;

/**
 * A ramp name, or a raw hex if a session was ever given one directly. Without
 * the second case the panel shows grey for a colour the tab mark draws
 * correctly, and the two surfaces disagree about the same session.
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
 * Colours a dot through a custom property rather than through background.
 *
 * The dot draws its own halo from the same value, and setting background
 * directly leaves the halo on the default grey, so every coloured dot came out
 * ringed in the wrong colour.
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
 * A brief message at the foot of the surface, with at most one action.
 *
 * It exists for things that already happened and can be taken back: a bulk move
 * is done the instant it is asked for, so the only honest place to offer "undo"
 * is after the fact, and an undo the user cannot find is not an undo. The toast
 * owns its own host node and appends it on first use, so any of the pages that
 * load this file can call it without adding markup, and nothing is touched on
 * load. Calling it again replaces whatever was showing; a plain message clears
 * itself sooner than one carrying an action, because there is nothing to reach.
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
