/**
 * The installed speech voice list, which is the strongest operating system tell
 * left in the page.
 *
 * It was not in the applied table at all until the table was re-read rather than
 * trusted, and it is worth more than it looks. The machine this was written on
 * reports `Microsoft David`, `Mark` and `Zira` for en-US and `James` and
 * `Catherine` for en-AU. The first three ship with every English Windows. The
 * last two are an installed Australian language pack, and that is the part worth
 * removing: it is a fact about the machine that nothing else the page can see
 * would predict.
 *
 * So the rule is to keep what is already predictable and drop what is not. A
 * voice whose language the browser already advertises in `navigator.languages`
 * tells a page nothing it could not read from the `Accept-Language` header it
 * just sent. A voice for a language the browser never claims to read is an
 * optional pack, and those are what make one machine distinguishable from the
 * next.
 *
 * Three things this deliberately does not do.
 *
 * It never fabricates a voice. `SpeechSynthesisVoice` has no constructor, so a
 * made up list would be plain objects with the wrong prototype, which is a one
 * line find and would break `speak`. Everything returned is an object the
 * browser made.
 *
 * It writes no voice name down. A written down list ages with the operating
 * system exactly the way a written down user agent does, and for the same
 * reason: it is correct on the day it is typed.
 *
 * And it never hides the default voice, even when its language does not match.
 * The default is what a page reaches for when it has no preference, so removing
 * it changes what the machine sounds like rather than what it reveals.
 *
 * Returning an empty list would be safe even so: `getVoices` already returns
 * nothing until the list has loaded, which is the entire reason
 * `onvoiceschanged` exists, so every page that uses this already handles it.
 *
 * Copied into `src/mask/index.ts` and held there by test.
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
