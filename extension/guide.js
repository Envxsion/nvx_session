/**
 * ------------------------------------------------------------------
 *  Title    |  The guide, rendered
 *  Ref      |  guide-data.js (NVX_GUIDE), guide.html
 *  ID       |  M6 (popup UI)
 * ------------------------------------------------------------------
 *  Purpose  |  Render the guide as a full page and as a popup stack
 *           |  from one array.
 *  How      |  renderGuideFull fills guide.html; renderGuidePopup
 *           |  fills the popup's Guide view with the same chapters,
 *           |  opening one at a time.
 *  Note     |  Text goes in through textContent, always; only the SVG
 *           |  figure is trusted, set via a template element so a
 *           |  malformed figure cannot half-apply to the document.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

/* node() is el() from base.js under a name that does not collide with the
   local svg element below. */
const node = (tag, className, text) => el(tag, className, text);

/** Parses a figure once and returns a node, or null if it will not parse. */
function figureNode(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = svg.trim();
  const first = tpl.content.firstElementChild;
  return first && first.tagName.toLowerCase() === 'svg' ? first : null;
}

function figureBox(svg) {
  const drawing = figureNode(svg);
  if (!drawing) return null;
  const box = node('div', 'guide-fig');
  box.append(drawing);
  return box;
}

function stepsList(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const ul = node('ul', 'guide-steps');
  for (const [what, why] of steps) {
    const li = node('li');
    li.append(node('b', null, what), node('span', null, why));
    ul.append(li);
  }
  return ul;
}

function bodyBlock(paragraphs) {
  const box = node('div', 'guide-body');
  for (const p of paragraphs ?? []) box.append(node('p', null, p));
  return box;
}

const pad = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------- the full page

function renderGuideFull(root) {
  const chapters = globalThis.NVX_GUIDE ?? [];
  const limits = globalThis.NVX_LIMITS ?? [];

  const toc = node('nav', 'guide-toc');
  toc.setAttribute('aria-label', 'Contents');
  for (const ch of chapters) {
    const a = node('a', null, ch.title);
    a.href = `#${ch.id}`;
    toc.append(a);
  }
  root.querySelector('[data-toc]')?.replaceWith(toc);

  const body = node('div');
  chapters.forEach((ch, i) => {
    const section = node('section', 'guide-ch');
    section.id = ch.id;
    section.append(node('span', 'n', pad(i + 1)), node('h2', null, ch.title));
    if (ch.lede) section.append(node('p', 'guide-lede', ch.lede));

    const split = node('div', 'guide-split');
    const prose = node('div');
    prose.append(bodyBlock(ch.body));
    const steps = stepsList(ch.steps);
    if (steps) prose.append(steps);
    split.append(prose);

    const fig = figureBox(ch.figure);
    if (fig) {
      split.classList.add('has-fig');
      split.append(fig);
    }
    section.append(split);
    body.append(section);
  });

  if (limits.length) {
    const box = node('section', 'guide-limits');
    box.id = 'limits';
    box.append(
      node('h2', null, 'What it does not do'),
      node(
        'p',
        null,
        'Every one of these is deliberate. A tool that lists only what it can do is why people conclude it is broken when it is working exactly as designed.'
      )
    );
    const dl = node('dl');
    for (const [what, why] of limits) {
      dl.append(node('dt', null, what), node('dd', null, why));
    }
    box.append(dl);
    body.append(box);
  }

  root.querySelector('[data-chapters]')?.replaceWith(body);
}

// -------------------------------------------------------------- the popup

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The same chapters, collapsed.
 *  Note     |  Rendered once and left in the DOM, not rebuilt when the
 *           |  view opens: rebuilding would close every chapter the
 *           |  reader had opened, and the popup is reopened constantly.
 * ------------------------------------------------------------------
 */
function renderGuidePopup(mount) {
  if (!mount || mount.dataset.built === '1') return;
  mount.dataset.built = '1';

  const chapters = globalThis.NVX_GUIDE ?? [];
  const stack = node('div', 'guide-pop');

  chapters.forEach((ch, i) => {
    const d = node('details');
    const s = node('summary');
    s.append(node('span', 'n', pad(i + 1)), node('span', 't', ch.title), node('span', 'chev', '›'));
    d.append(s);

    const inner = node('div', 'inner');
    if (ch.lede) inner.append(node('p', null, ch.lede));
    const fig = figureBox(ch.figure);
    if (fig) inner.append(fig);
    for (const p of ch.body ?? []) inner.append(node('p', null, p));
    const steps = stepsList(ch.steps);
    if (steps) inner.append(steps);
    d.append(inner);
    stack.append(d);
  });

  const limits = globalThis.NVX_LIMITS ?? [];
  if (limits.length) {
    const d = node('details');
    const s = node('summary');
    s.append(
      node('span', 'n', pad(chapters.length + 1)),
      node('span', 't', 'What it does not do'),
      node('span', 'chev', '›')
    );
    d.append(s);
    const inner = node('div', 'inner');
    inner.append(stepsList(limits));
    d.append(inner);
    stack.append(d);
  }

  mount.append(stack);
}

// The full page has no other script, so it renders itself. The popup calls
// renderGuidePopup when its view is first opened.
if (document.body?.dataset.guide === 'full') {
  renderGuideFull(document);
}
