/**
 * ------------------------------------------------------------------
 *  Title    |  Native messaging frames
 *  Ref      |  native/protocol.mjs
 *  ID       |  test (native protocol)
 * ------------------------------------------------------------------
 *  Purpose  |  Length-prefixed frames survive any stdin split, and
 *           |  oversized or malformed input is rejected.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
// The host is plain Node, deliberately: it must run without the extension's
// build ever having happened.
import {
  encode,
  FrameError,
  FrameReader,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '../native/protocol.mjs';

const framesOf = (...messages: unknown[]) => Buffer.concat(messages.map((m) => encode(m)));

describe('native messaging frames', () => {
  it('round trips a message', () => {
    const reader = new FrameReader();
    expect(reader.push(encode({ type: 'ping', id: 1 }))).toEqual([{ type: 'ping', id: 1 }]);
  });

  it('writes a four byte little-endian length prefix', () => {
    const framed = encode({ a: 1 });
    const body = JSON.stringify({ a: 1 });
    expect(framed.readUInt32LE(0)).toBe(Buffer.byteLength(body));
    expect(framed.subarray(4).toString('utf8')).toBe(body);
  });

  /**
   * The bug this whole file exists for. stdin hands over whatever the pipe had,
   * which is not what was written, so any of these splits happens eventually.
   */
  it('reassembles a message split across chunks', () => {
    const framed = encode({ type: 'hello', protocol: PROTOCOL_VERSION });
    for (let at = 1; at < framed.length; at++) {
      const reader = new FrameReader();
      expect(reader.push(framed.subarray(0, at)), `split at ${at}`).toEqual([]);
      expect(reader.push(framed.subarray(at)), `split at ${at}`).toEqual([
        { type: 'hello', protocol: PROTOCOL_VERSION },
      ]);
    }
  });

  it('survives the length prefix itself being split', () => {
    const framed = encode({ type: 'ping' });
    const reader = new FrameReader();
    expect(reader.push(framed.subarray(0, 2))).toEqual([]);
    expect(reader.push(framed.subarray(2, 3))).toEqual([]);
    expect(reader.push(framed.subarray(3))).toEqual([{ type: 'ping' }]);
  });

  it('yields several messages delivered in one chunk', () => {
    const reader = new FrameReader();
    expect(reader.push(framesOf({ n: 1 }, { n: 2 }, { n: 3 }))).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
    ]);
  });

  it('keeps a trailing partial message for the next chunk', () => {
    const reader = new FrameReader();
    const all = framesOf({ n: 1 }, { n: 2 });
    const cut = all.length - 3;
    expect(reader.push(all.subarray(0, cut))).toEqual([{ n: 1 }]);
    expect(reader.pending).toBeGreaterThan(0);
    expect(reader.push(all.subarray(cut))).toEqual([{ n: 2 }]);
    expect(reader.pending).toBe(0);
  });

  it('handles multi-byte characters, which byte length and string length disagree about', () => {
    const message = { label: 'Monash 日本語 🛰' };
    const reader = new FrameReader();
    expect(reader.push(encode(message))).toEqual([message]);
  });

  it('refuses a length prefix past the ceiling rather than buffering forever', () => {
    const reader = new FrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
    expect(() => reader.push(header)).toThrow(FrameError);
  });

  it('reports malformed JSON rather than yielding undefined', () => {
    const body = Buffer.from('{not json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const reader = new FrameReader();
    expect(() => reader.push(Buffer.concat([header, body]))).toThrow(FrameError);
  });

  it('accepts an empty object, which frames to a non-zero length', () => {
    const reader = new FrameReader();
    expect(reader.push(encode({}))).toEqual([{}]);
  });

  it('is byte identical across a re-encode, so a wrapped key round trips', () => {
    const message = { key: Buffer.from('sixteen byte key').toString('base64') };
    const reader = new FrameReader();
    const [out] = reader.push(encode(message)) as [{ key: string }];
    expect(out.key).toBe(message.key);
    expect(Buffer.from(out.key, 'base64').toString()).toBe('sixteen byte key');
  });
});
