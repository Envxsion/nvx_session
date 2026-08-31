/**
 * ------------------------------------------------------------------
 *  Title    |  Native messaging framing
 *  Ref      |  host.mjs, chrome.runtime.connectNative
 *  ID       |  native host
 * ------------------------------------------------------------------
 *  Purpose  |  Frame native-host stdio: a 4-byte little-endian length
 *           |  prefix, then UTF-8 JSON.
 *  How      |  connectNative frames the extension side and hands over
 *           |  parsed objects, so only the host has to, which is why
 *           |  this lives here rather than in src/.
 *  Note     |  Designed against the partial read: a message can split
 *           |  across chunks, several can arrive in one, the length
 *           |  prefix itself can split. A one-chunk-one-message reader
 *           |  works until a message crosses a buffer boundary, then
 *           |  corrupts silently.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

export const PROTOCOL_VERSION = 1;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Chrome's own message-size ceiling.
 *  Note     |  From the extension is capped at 1 MB in practice (4 GB
 *           |  in theory), to it at 64 MB. Past this is a framing
 *           |  error, not a large message, and buffering on a bad
 *           |  length prefix is how a host eats all available memory.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  Accumulate chunks and yield whole messages.
 *  Note     |  A class with explicit buffering rather than a stream
 *           |  transform, so the partial-read behaviour is directly
 *           |  testable without a pipe.
 * ------------------------------------------------------------------
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
