/**
 * ------------------------------------------------------------------
 *  Title    |  Work stamps
 *  Ref      |  kernel/stamp.ts
 *  ID       |  test (stamp)
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import { checkStamp, leadingZeros, mintStamp, stampDay } from '../src/kernel/stamp.js';

const NOW = Date.UTC(2026, 9, 3, 12);
const ID = '4b0c7c1e-9a51-4d3e-8f2a-3f1d2b6c7a90';

describe('stamps', () => {
  it('counts leading zero bits across byte boundaries', () => {
    expect(leadingZeros(new Uint8Array([0, 0x0f]), 12)).toBe(true);
    expect(leadingZeros(new Uint8Array([0, 0x1f]), 12)).toBe(false);
    expect(leadingZeros(new Uint8Array([0, 0]), 16)).toBe(true);
    expect(leadingZeros(new Uint8Array([1]), 8)).toBe(false);
  });

  it('mints a stamp the server check accepts, for that scope and subject only', async () => {
    const stamp = await mintStamp('telemetry', ID, NOW, { bits: 10 });
    expect(stamp).toMatch(new RegExp(`^v1\\.telemetry\\.${stampDay(NOW)}\\.${ID}\\.`));
    expect(await checkStamp(stamp!, 'telemetry', ID, NOW, { bits: 10 })).toBe(true);
    expect(await checkStamp(stamp!, 'report', ID, NOW, { bits: 10 })).toBe(false);
    expect(await checkStamp(stamp!, 'telemetry', ID.replace('4', '5'), NOW, { bits: 10 })).toBe(false);
  });

  it('accepts yesterday, refuses older and tampered stamps', async () => {
    const stamp = (await mintStamp('report', 'abc12345', NOW, { bits: 10 }))!;
    expect(await checkStamp(stamp, 'report', 'abc12345', NOW + 86_400_000, { bits: 10 })).toBe(true);
    expect(await checkStamp(stamp, 'report', 'abc12345', NOW + 2 * 86_400_000, { bits: 10 })).toBe(false);
    expect(await checkStamp(`${stamp}x`, 'report', 'abc12345', NOW, { bits: 10 })).toBe(false);
  });

  it('gives up after maxTries rather than spinning forever', async () => {
    expect(await mintStamp('report', 'x', NOW, { bits: 30, maxTries: 50 })).toBeNull();
  });
});
