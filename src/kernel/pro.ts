/**
 * The Pro gate. The service worker imports License and Sync from here and
 * nowhere else.
 *
 * The committed default re-exports the free stub, so the public repository
 * builds and runs as the free product with no `pro` submodule present. A Pro
 * build points this at ../pro/index.js at package time (see tools/build.mjs),
 * which swaps in the real classes from the private submodule. Types come from
 * pro-types.js in both cases, so the two sides cannot drift.
 */

export * from './pro.free.js';
