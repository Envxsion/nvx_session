/**
 * Native messaging framing.
 *
 * Chrome speaks to a native host over stdio with a four byte little-endian
 * length prefix followed by UTF-8 JSON. The extension side never sees this:
 * chrome.runtime.connectNative does the framing and hands over parsed objects.
 * Only the host has to get it right, which is why this lives here rather than
 * in src/.
 *
 * The failure mode worth designing against is a partial read. stdin delivers
 * whatever the pipe had, which is not the same as whatever was written: a
 * message can arrive split across chunks, several can arrive in one, and a
 * length prefix itself can be split. A reader that assumes one chunk is one
 * message works perfectly until the day a message crosses a buffer boundary,
 * and then corrupts silently.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Chrome's own limits: a message from the extension may not exceed 4 GB in
 * theory but is capped at 1 MB in practice, and a message to it at 64 MB.
 * Anything past this is a framing error, not a large message, and continuing
 * to buffer on a bad length prefix is how a host eats all available memory.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function encode(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Accumulates chunks and yields whole messages.
 *
 * Deliberately a class with explicit buffering rather than a stream transform,
 * so the partial-read behaviour is directly testable without a pipe.
 */
export class FrameReader {
  #buffer = Buffer.alloc(0);

  /** Returns every complete message the new chunk completed, in order. */
  push(chunk) {
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk);

    const out = [];
    for (;;) {
      // Not even the length is here yet.
      if (this.#buffer.length < 4) break;

      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        throw new FrameError(`framed message of ${length} bytes exceeds the ceiling`);
      }
      // The body is still arriving. Wait rather than guessing.
      if (this.#buffer.length < 4 + length) break;

      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);

      try {
        out.push(JSON.parse(body.toString('utf8')));
      } catch (e) {
        throw new FrameError(`framed message was not valid JSON: ${e.message}`);
      }
    }
    return out;
  }

  /** Bytes held back waiting for the rest of a message. */
  get pending() {
    return this.#buffer.length;
  }
}
