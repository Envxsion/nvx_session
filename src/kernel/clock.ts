/**
 * ------------------------------------------------------------------
 *  Title    |  Trusted clock
 *  Ref      |  entitlement.ts, pack.ts
 *  ID       |  clock
 * ------------------------------------------------------------------
 *  Purpose  |  A "now" that winding the computer's clock back cannot
 *           |  move backwards.
 *  How      |  Keeps the latest time it has good reason to believe:
 *           |  the system clock as it moves forward, a licence token's
 *           |  issue time, and the Date header of our own licence
 *           |  server's replies. now() is never earlier than that
 *           |  floor. The floor is persisted, at most once an hour
 *           |  unless a server time moves it, so it survives restarts.
 *  Why      |  An offline licence runs until its token expires, so the
 *           |  cheapest way to keep a lapsed one going was to set the
 *           |  date back. With the floor, the expiry is measured from
 *           |  the last real time this install saw.
 *  Note     |  A clock that is merely wrong forward is not punished:
 *           |  the floor follows it, and a token issued "in the past"
 *           |  by that clock is still inside its exp once the clock is
 *           |  corrected, because exp is days, not minutes.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

export const CLOCK_KEY = 'nvx.clock.floor';
const WRITE_EVERY_MS = 3_600_000;
/** Times past 2100 are a bad header, not real time. */
const LATEST_BELIEVABLE = Date.UTC(2100, 0, 1);

interface ClockStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class TrustedClock {
  private floor = 0;
  private written = 0;

  constructor(
    private readonly storage: ClockStorage,
    private readonly system: () => number = () => Date.now()
  ) {}

  async load(): Promise<void> {
    const held = await this.storage.get([CLOCK_KEY]).catch(() => ({}) as Record<string, unknown>);
    const v = held[CLOCK_KEY];
    if (typeof v === 'number' && Number.isFinite(v)) {
      this.floor = Math.max(this.floor, v);
      this.written = v;
    }
  }

  now(): number {
    const sys = this.system();
    if (sys > this.floor) {
      this.floor = sys;
      if (sys - this.written > WRITE_EVERY_MS) this.persist();
    }
    return this.floor;
  }

  /** Whether the system clock is currently behind what this install has seen. */
  rolledBack(): boolean {
    return this.system() + 5 * 60_000 < this.floor;
  }

  /** A time from a trusted source (our server, a signed token). */
  observe(ms: number | null | undefined): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    // Deliberately no "too far ahead of the system clock" check: a clock set
    // back by months is exactly when the server's time is far ahead of it.
    if (ms > LATEST_BELIEVABLE) return;
    if (ms > this.floor) {
      this.floor = ms;
      this.persist();
    }
  }

  private persist(): void {
    this.written = this.floor;
    void this.storage.set({ [CLOCK_KEY]: this.floor }).catch(() => undefined);
  }
}
