/**
 * ------------------------------------------------------------------
 *  Title    |  Speech voice list
 *  Ref      |  keepVoices, navigator.languages, mask/index.ts
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  Trim the installed speech voice list, the strongest OS
 *           |  tell left in the page.
 *  How      |  Keep what is already predictable and drop what is not. A
 *           |  voice whose language the browser already advertises
 *           |  reveals nothing; a voice for a language it never claims
 *           |  is an optional pack, which is what distinguishes one
 *           |  machine from the next.
 *  Note     |  Never fabricates a voice (`SpeechSynthesisVoice` has no
 *           |  constructor), writes no name down (a list ages like a
 *           |  UA), and never hides the default even when its language
 *           |  does not match. An empty list is safe too, since
 *           |  `getVoices` returns nothing until loaded. Copied into
 *           |  `src/mask/index.ts` and held by test.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

export interface Voice {
  lang: string;
  name: string;
  default: boolean;
}

export function keepVoices<T extends Voice>(all: T[], languages: readonly string[]): T[] {
  if (!Array.isArray(all) || !all.length) return all;

  const spoken = new Set<string>();
  for (const tag of languages) {
    const primary = String(tag).split('-')[0];
    if (primary) spoken.add(primary.toLowerCase());
  }
  // A browser always reads at least one language, and a filter with nothing to
  // filter against would empty the list for everybody.
  if (!spoken.size) return all;

  const keep = all.filter((v) => {
    if (v.default) return true;
    const primary = String(v.lang ?? '').split('-')[0];
    return primary ? spoken.has(primary.toLowerCase()) : false;
  });

  /**
   * Sorted, for the same reason the WebGL extension list is: install order is a
   * fact about the machine and carries real bits. The default stays first,
   * because a page with no preference reaches for index zero and moving it
   * changes which voice speaks.
   */
  const rest = keep
    .filter((v) => !v.default)
    .sort((a, b) => String(a.lang).localeCompare(String(b.lang)) || String(a.name).localeCompare(String(b.name)));

  return [...keep.filter((v) => v.default), ...rest];
}
