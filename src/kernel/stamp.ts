/**
 * ------------------------------------------------------------------
 *  Title    |  Work stamps
 *  Ref      |  src/pro/docs/licensing-and-abuse-brief.md (server half)
 *  ID       |  stamp
 * ------------------------------------------------------------------
 *  Purpose  |  Make every anonymous request to our servers cost the
 *           |  sender a second or two of CPU.
 *  How      |  Hashcash: find a nonce so that SHA-256 of
 *           |  "v1.<scope>.<day>.<subject>.<nonce>" starts with BITS
 *           |  zero bits. The server checks one hash. A real install
 *           |  mints one stamp per day for telemetry and one per bug
 *           |  report; somebody faking ten thousand installs has to
 *           |  mint ten thousand a day.
 *  Why      |  Anything shipped in the extension (a key, a secret
 *           |  header) can be read out of it in a minute, so nothing a
 *           |  client holds can prove it is a real install. Cost is the
 *           |  only lever left that does not identify anybody. Rate
 *           |  limits and per-install caps on the server do the rest.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

/** Leading zero bits required. 16 is ~65k hashes: about a second in a worker. */
export const STAMP_BITS = 16;

export type StampScope = 'telemetry' | 'report';

type Digest = (text: string) => Promise<Uint8Array>;

/** SHA-256 through WebCrypto, the digest every runtime we ship on has. */
export const sha256: Digest = async (text) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** The UTC day a stamp is good for, as YYYYMMDD. */
export function stampDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Whether a digest starts with at least `bits` zero bits. */
export function leadingZeros(hash: Uint8Array, bits: number): boolean {
  let left = bits;
  for (const byte of hash) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else {
      return byte >> (8 - left) === 0;
    }
  }
  return left <= 0;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Mint a stamp.
 *  Note     |  Yields to the event loop every 2048 tries so a worker
 *           |  minting one stays responsive to the tabs it serves.
 * ------------------------------------------------------------------
 */
export async function mintStamp(
  scope: StampScope,
  subject: string,
  now: number,
  opts: { bits?: number; digest?: Digest; maxTries?: number } = {}
): Promise<string | null> {
  const bits = opts.bits ?? STAMP_BITS;
  const digest = opts.digest ?? sha256;
  const max = opts.maxTries ?? 1 << (bits + 4);
  const prefix = `v1.${scope}.${stampDay(now)}.${subject}.`;
  for (let nonce = 0; nonce < max; nonce++) {
    const text = prefix + nonce.toString(36);
    if (leadingZeros(await digest(text), bits)) return text;
    if ((nonce & 2047) === 2047) await new Promise((r) => setTimeout(r, 0));
  }
  return null;
}

/** The server's check, kept here so the two halves are tested against each other. */
export async function checkStamp(
  stamp: string,
  scope: StampScope,
  subject: string,
  now: number,
  opts: { bits?: number; digest?: Digest } = {}
): Promise<boolean> {
  const parts = stamp.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== scope || parts[3] !== subject) return false;
  // Today or yesterday in UTC, so a stamp minted just before midnight still lands.
  const days = [stampDay(now), stampDay(now - 86_400_000)];
  if (!days.includes(parts[2]!)) return false;
  return leadingZeros(await (opts.digest ?? sha256)(stamp), opts.bits ?? STAMP_BITS);
}
