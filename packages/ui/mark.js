/**
 * ------------------------------------------------------------------
 *  Title    |  The NVX mark, alive
 *  Ref      |  tools/icons.mjs (same geometry), tokens.css
 *  ID       |  ui
 * ------------------------------------------------------------------
 *  Purpose  |  One mark for every surface: three broken rings, like
 *           |  the leaves of an aperture, each turning at its own pace.
 *  How      |  SVG built once per host element, animated in CSS so it
 *           |  costs nothing on the main thread. State is a data
 *           |  attribute: idle drifts, live locks onto a session's
 *           |  colour, ask closes in and pulses, paused stops grey.
 *  Note     |  Same ring radii, gaps and turns as the toolbar icon, so
 *           |  the mark in the popup is never nearly the logo.
 *           |  mountMark(el, { state, color, size })
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

(() => {
  const RINGS = [
    { r: 14.5, gap: 66, turn: 0, o: 1 },
    { r: 9.5, gap: 78, turn: 132, o: 0.68 },
    { r: 4.5, gap: 96, turn: 262, o: 0.4 },
  ];
  const NS = 'http://www.w3.org/2000/svg';

  /** An arc of a ring, leaving `gap` degrees open, starting at `turn`. */
  function arc(r, gap, turn) {
    const start = ((turn + gap / 2) * Math.PI) / 180;
    const end = ((turn + 360 - gap / 2) * Math.PI) / 180;
    const x1 = 17 + r * Math.cos(start);
    const y1 = 17 + r * Math.sin(start);
    const x2 = 17 + r * Math.cos(end);
    const y2 = 17 + r * Math.sin(end);
    const large = 360 - gap > 180 ? 1 : 0;
    return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
  }

  function mountMark(host, opts = {}) {
    if (!host) return null;
    let svg = host.querySelector('svg.nvx-mark');
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'nvx-mark');
      svg.setAttribute('viewBox', '0 0 34 34');
      svg.setAttribute('aria-hidden', 'true');
      RINGS.forEach((ring, i) => {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', `ring ring-${i + 1}`);
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', arc(ring.r, ring.gap, ring.turn));
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-width', '2');
        p.setAttribute('stroke-linecap', 'round');
        p.style.opacity = String(ring.o);
        g.append(p);
        svg.append(g);
      });
      const core = document.createElementNS(NS, 'circle');
      core.setAttribute('class', 'core');
      core.setAttribute('cx', '17');
      core.setAttribute('cy', '17');
      core.setAttribute('r', '1.6');
      svg.append(core);
      host.replaceChildren(svg);
    }
    setMark(host, opts);
    return svg;
  }

  function setMark(host, { state, color, size } = {}) {
    const svg = host?.querySelector('svg.nvx-mark');
    if (!svg) return;
    if (state) svg.dataset.state = state;
    if (size) {
      svg.style.width = `${size}px`;
      svg.style.height = `${size}px`;
    }
    svg.style.setProperty('--mark-tone', color || 'var(--signal)');
  }

  globalThis.mountMark = mountMark;
  globalThis.setMark = setMark;
})();
