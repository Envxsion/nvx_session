/**
 * ------------------------------------------------------------------
 *  Title    |  ISOLATED world seeder probe
 *  Ref      |  inject-main.js, background.js liveInjectionOrder
 *  ID       |  M0 (capability probe)
 * ------------------------------------------------------------------
 *  Purpose  |  Stand in for the real seeder, DESIGN sec 04 path B:
 *           |  leave the tab config where MAIN can read it first.
 *  How      |  document_start, ISOLATED world. sessionStorage is per
 *           |  tab per origin by spec, the granularity posture needs.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */
(() => {
  const el = document.documentElement;
  const prior = el.getAttribute('data-nvx-seq');
  el.setAttribute('data-nvx-seq', prior ? `${prior},iso` : 'iso');
  el.setAttribute('data-nvx-iso-at', String(performance.now()));

  try {
    sessionStorage.setItem(
      '__nvx_iso_seed',
      JSON.stringify({ session: 'probe', posture: 'persona', at: Date.now() })
    );
  } catch (e) {
    el.setAttribute('data-nvx-iso-error', e.name);
  }
})();
