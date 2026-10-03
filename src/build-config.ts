/**
 * ------------------------------------------------------------------
 *  Title    |  Build configuration
 *  Ref      |  tools/build.mjs (writes the real values over this)
 *  ID       |  build
 * ------------------------------------------------------------------
 *  Purpose  |  The tier, telemetry endpoint and licence material a build
 *           |  was made with.
 *  How      |  These used to be custom keys in manifest.json, which the
 *           |  browser flags as unrecognised on the extensions page and
 *           |  a store reviewer sees. The build now overwrites the
 *           |  compiled copy of this module instead. The values here are
 *           |  what a plain compile gets: free, with nothing to call.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

export interface BuildConfig {
  tier: 'free' | 'pro' | 'dev';
  telemetryEndpoint: string | null;
  /** Where problem reports go. Null: the report is copied for the support page instead. */
  reportEndpoint: string | null;
  license: { endpoint?: string; keys?: Record<string, string> } | null;
}

export const BUILD: BuildConfig = {
  tier: 'free',
  telemetryEndpoint: null,
  reportEndpoint: null,
  license: null,
};
