/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry test fakes
 *  Ref      |  kernel/telemetry.ts
 *  ID       |  test (telemetry helpers)
 * ------------------------------------------------------------------
 *  Purpose  |  One in-memory storage area, endpoint and clock, shared
 *           |  by the telemetry suites.
 *  Note     |  The post fake answers with whatever status the test set,
 *           |  so retry and drop paths can be driven exactly.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { Telemetry, type TelemetryChannel, type TelemetryPorts } from '../src/kernel/telemetry.js';

export const ID_A = '11111111-1111-4111-8111-111111111111';
export const ID_B = '22222222-2222-4222-9222-222222222222';

/** An in-memory storage area, the same shape the worker injects. */
export function fakeStorage(seed: Record<string, unknown> = {}, broken = false) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const boom = async (): Promise<never> => {
    throw new Error('storage gone');
  };
  // Values are cloned on the way in and out, as chrome.storage does.
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    area: broken
      ? { get: boom, set: boom, remove: boom }
      : {
          get: async (keys: string | string[] | null) => {
            const list = keys === null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const k of list) if (map.has(k)) out[k] = clone(map.get(k));
            return out;
          },
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) map.set(k, clone(v));
          },
          remove: async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
          },
        },
    map,
  };
}

export interface Sent {
  url: string;
  body: string;
}

/** Midday UTC on a fixed date, so day arithmetic is unambiguous. */
export const DAY0 = Date.parse('2026-10-01T12:00:00Z');
export const DAY_MS = 86_400_000;

/** A telemetry instance wired to fakes, plus handles on what it did. */
export function make(
  opts: {
    endpoint?: string | null;
    consent?: boolean;
    seed?: Record<string, unknown>;
    postThrows?: boolean;
    ids?: string[];
    channel?: TelemetryChannel;
    brokenStorage?: boolean;
    storage?: ReturnType<typeof fakeStorage>;
  } = {}
) {
  const sent: Sent[] = [];
  const storage = opts.storage ?? fakeStorage(opts.seed, opts.brokenStorage);
  let n = 0;
  const ids = opts.ids ?? [ID_A];
  let clock = DAY0;
  let consent = opts.consent ?? true;
  let status = 204;
  const ports: TelemetryPorts = {
    storage: storage.area,
    endpoint: () => (opts.endpoint === undefined ? 'https://ingest.example/t' : opts.endpoint),
    consented: () => consent,
    post: async (url, body) => {
      if (opts.postThrows) throw new Error('network down');
      sent.push({ url, body });
      return status;
    },
    now: () => clock,
    newId: () => ids[n++ % ids.length]!,
    channel: () => opts.channel ?? 'store',
  };
  const t = new Telemetry(ports, { version: '1.2.3', mv: 3 });
  return {
    t,
    sent,
    storage,
    setConsent: (v: boolean) => (consent = v),
    /** The status every later post answers with. */
    fail: (s: number) => (status = s),
    /** Move the clock forward. */
    advance: (ms: number) => (clock += ms),
  };
}

/** Every envelope across every posted batch, flattened. */
export function envelopes(sent: Sent[]) {
  return sent.flatMap((s) => JSON.parse(s.body).batch as Array<Record<string, unknown>>);
}
