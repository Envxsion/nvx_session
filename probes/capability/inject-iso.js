/**
 * ISOLATED world, document_start.
 *
 * Stands in for the real seeder in DESIGN.html section 04 path B: resolve the
 * tab's config and leave it somewhere the MAIN world can read synchronously
 * before any page script runs. sessionStorage is per tab per origin by
 * specification, which is exactly the granularity per-tab posture needs.
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
