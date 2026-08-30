/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam
 *  Ref      |  pro.free.ts, pro-types.ts, tools/build.mjs
 *  ID       |  Pro tier (DESIGN sec 30)
 * ------------------------------------------------------------------
 *  Purpose  |  The one import point for License and Sync.
 *  How      |  The committed default re-exports the free stub, so the
 *           |  public tree builds and runs as the free product. A Pro
 *           |  build repoints this at the private submodule at package
 *           |  time.
 *  Note     |  Types come from pro-types.js either way, so the two
 *           |  sides cannot drift.
 *  Author   |  Ojas Kekre, 30/08/2026
 * ------------------------------------------------------------------
 */

export * from './pro.free.js';
