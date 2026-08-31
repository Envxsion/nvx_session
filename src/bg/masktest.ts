/**
 * ------------------------------------------------------------------
 *  Title    |  Fingerprint mask suite
 *  Ref      |  persona/compile.ts, persona/useragent.ts, mask worker
 *  ID       |  test (fingerprint mask)
 * ------------------------------------------------------------------
 *  Purpose  |  Snapshot proving the fingerprint is identical across
 *           |  reload, restart and window, plus every coherence
 *           |  property the mask claims.
 *  Note     |  Section 21 smoke tests are a floor, not the definition
 *           |  of passing. Checks, in order: the mask reaches the
 *           |  worker, the value never moves, the two read paths
 *           |  agree, and it fails closed.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { readBodyText } from '../platform.js';
import { cardFor, vendorOf } from '../persona/compile.js';
import { secChUa, type Brand } from '../persona/useragent.js';
import type { Os } from '../persona/types.js';
import type { Check } from './selftest.js';

export interface MaskTestResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

interface Report {
  /** getImageData on the main thread. */
  direct?: string;
  /** The same read again, in the same document. */
  directAgain?: string;
  /** toDataURL, hashed as a string. */
  encoded?: string;
  /** That data url decoded back into a canvas and read again. */
  roundTrip?: string;
  /** The same drawing on an OffscreenCanvas inside a Worker. */
  worker?: string;
  /** A direct read taken again, after the worker's fate is known. */
  afterWorker?: string;
  glVendor?: string;
  glRenderer?: string;
  /** `navigator.gpu`, which is untouched and therefore names the real vendor. */
  gpuVendor?: string;
  gpuArchitecture?: string;
  deviceKinds?: string;
  voiceCount?: number;
  voiceLangs?: string;
  voiceNames?: string;
  voiceProto?: string;
  voiceDefaultFirst?: boolean;
  glExtSorted?: boolean;
  glPixels?: string;
  glPixelsAgain?: string;
  glEncoded?: string;
  glBareUnmasked?: string;
  tsGetImageData?: boolean;
  tsToDataURL?: boolean;
  tsWorker?: boolean;
  tsItself?: boolean;
  tsPageFn?: boolean;
  shapeName?: string;
  shapeLength?: number;
  workerProtoWritable?: boolean;
  workerNoNew?: string;
  encodeMs?: number;
  audio?: string;
  audioReread?: string;
  audioRerender?: string;
  audioSilence?: boolean;
  audioError?: string;
  ua?: string;
  appVersion?: string;
  cores?: number;
  memory?: number;
  brands?: string;
  uaDataIntact?: boolean;
  uaIsAccessor?: boolean;
  tsUserAgent?: boolean;
  uaGetterName?: string;
  workerUa?: string;
  workerCores?: number;
  workerBrands?: string;
  sentUa?: string;
  sentChUa?: string;
  screenWidth?: number;
  dpr?: number;
  mqScreenAgrees?: boolean;
  mqDprAgrees?: boolean;
  touchPoints?: number;
  mqCoarse?: boolean;
  navError?: string;
  headerError?: string;
  introspectError?: string;
  workerError?: string;
  maskOn?: boolean;
  csp?: boolean;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The tab the suite measures in, boxed so a lost tab can
 *           |  be replaced mid run rather than ending the whole run.
 *  Note     |  Retiring a session takes its tabs with it, so the next
 *           |  tabs.update threw and discarded forty four passed
 *           |  checks. That is a harness fault, not a product one, so
 *           |  the surface is stood up again and said to have been.
 * ------------------------------------------------------------------
 */
interface Surface {
  id: number;
  replaced: number;
  windowId: number | undefined;
}

async function measure(tab: Surface, url: string): Promise<Report | null> {
  try {
    await chrome.tabs.update(tab.id, { url });
  } catch {
    const made = await chrome.tabs.create({
      url,
      active: false,
      ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
    });
    tab.id = made.id!;
    tab.replaced++;
  }
  const tabId = tab.id;
  await new Promise<void>((resolve) => {
    const done = (id: number, info: { status?: string | undefined }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 15_000);
  });

  // The page reports asynchronously: the round trip waits on an image decode and
  // the worker on a message. Polling the body is how every other suite here
  // reads a page and it avoids needing a channel into the fixture.
  for (let i = 0; i < 40; i++) {
    const text = await readBodyText(tabId);
    if (text && text.trim().startsWith('{')) {
      try {
        return JSON.parse(text) as Report;
      } catch {
        /* still the placeholder */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function runMaskTest(opts: {
  /** Flips the profile posture and waits for the registration to land. */
  setPosture: (p: 'mirror' | 'standardize' | 'persona') => Promise<void>;
  posture: () => 'mirror' | 'standardize' | 'persona';
  /** Domains the worker has withdrawn the posture from. See below. */
  degraded: () => string[];
  /**
   * Making and binding sessions, which the Persona phase needs and nothing
   * before it did.
   *
   * A persona is per session, so measuring one at all means a tab that is in a
   * session, and measuring that two of them differ means two tabs in two
   * sessions on one origin. Every earlier phase measures an unbound tab, which
   * is why these arrive this late.
   */
  createSession: (id: string, pinned: string[]) => Promise<void>;
  bindTab: (tabId: number, sessionId: string, url: string) => Promise<void>;
  dropSession: (id: string) => Promise<void>;
  clearDegraded: () => Promise<void>;
  /**
   * The bucket this machine should be presenting, from the compiler.
   *
   * Passed in rather than restated here, so the suite is asserting that the
   * page shows what the compiler decided rather than that it shows a string
   * somebody typed into a test twice.
   */
  /**
   * The operating system, so the expected card can be worked out from the real
   * renderer this run measures under Mirror.
   *
   * It cannot be passed in ready-made any more. The card bucket is chosen by the
   * machine's GPU vendor and the worker cannot read a renderer string: there is
   * no document and no canvas in a service worker. Deriving the expectation from
   * the measurement is also the stronger assertion, because it checks the mask
   * picked the bucket for the vendor the machine actually has.
   */
  os: Os;
  expect: {
    userAgent: string;
    brands: Brand[];
    cores: number;
    memory: number;
  };
  fixture?: string;
}): Promise<MaskTestResult> {
  const fixture = opts.fixture ?? 'http://localhost:8787';
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  const before = opts.posture();
  let surface: Surface | undefined;

  try {
    const probe = await fetch(`${fixture}/echo`, { cache: 'no-store' }).catch(() => null);
    if (!probe?.ok) {
      return {
        ok: false,
        checks: [],
        error: `The fixture origin at ${fixture} is not answering. Start it with: node tools/fixture/server.mjs`,
      };
    }

    const win = await chrome.windows.getCurrent();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
    surface = { id: tab.id!, replaced: 0, windowId: win.id };

    // ------------------------------------------------------ the real machine

    await opts.setPosture('mirror');
    const mirror = await measure(surface, `${fixture}/fp`);
    if (!mirror) return { ok: false, checks, error: 'the probe never reported under Mirror' };

    add(
      'Mirror leaves the canvas alone',
      mirror.maskOn === false,
      `mask present=${String(mirror.maskOn)}`
    );
    add(
      'and the worker and the main thread already agree',
      mirror.direct === mirror.worker,
      `main=${mirror.direct} worker=${mirror.worker}`
    );

    // ------------------------------------------------------------- masked

    await opts.setPosture('standardize');
    const masked = await measure(surface, `${fixture}/fp`);
    if (!masked) return { ok: false, checks, error: 'the probe never reported under Standardize' };

    add('Standardize installs the mask', masked.maskOn === true);
    add(
      'and the canvas is no longer the real one',
      Boolean(masked.direct) && masked.direct !== mirror.direct,
      `real=${mirror.direct} masked=${masked.direct}`
    );

    /**
     * The one that matters most. Without the Worker constructor rewrite this is
     * the check that fails, and the state it fails in is worse than not masking
     * at all: the page holds a patched main thread and a pristine worker, which
     * nothing on a real machine produces.
     */
    add(
      'the mask reaches inside a Worker',
      Boolean(masked.worker) && masked.worker !== mirror.worker,
      `real=${mirror.worker} masked=${masked.worker}`
    );
    add(
      'and the worker and the main thread still agree',
      masked.direct === masked.worker,
      `main=${masked.direct} worker=${masked.worker}`
    );

    // ------------------------------------------------------------- the webgl

    /**
     * The card the compiler would choose for the machine this is running on,
     * worked out from what Mirror measured rather than passed in. Null means
     * there is no bucket for this combination, and the correct behaviour then is
     * to leave the strings alone rather than to invent one.
     */
    const wanted = cardFor(opts.os, mirror.glRenderer ?? '');

    /**
     * The renderer string is the single most read fingerprint value after the
     * canvas, and the one this has to get exactly right rather than merely
     * change: it must match the claimed operating system, because an Apple GPU
     * on a Windows platform is the textbook incoherence.
     */
    if (wanted) {
      add(
        'the GPU it reports is the bucket, not the real card',
        Boolean(masked.glRenderer) &&
          masked.glRenderer !== mirror.glRenderer &&
          masked.glRenderer === wanted.renderer,
        `real=${mirror.glRenderer} masked=${masked.glRenderer}`
      );
      add(
        'and the vendor agrees with the renderer',
        masked.glVendor === wanted.vendor,
        `${masked.glVendor}`
      );
    } else {
      /**
       * Not a pass by omission. A machine with no bucket must report its real
       * card, because a string invented for a platform whose format this cannot
       * state is a tell of its own.
       */
      add(
        'a machine with no card bucket is left reporting its real one',
        masked.glRenderer === mirror.glRenderer && masked.glVendor === mirror.glVendor,
        `real=${mirror.glRenderer} masked=${masked.glRenderer}`
      );
    }

    /**
     * The check that came out of probing WebGPU, and the defect it found was
     * live.
     *
     * The card bucket used to be one per operating system, so every Windows
     * machine reported an NVIDIA RTX 3060. `navigator.gpu` is not masked and
     * reports the real vendor, so an AMD laptop claimed NVIDIA in one API and
     * AMD in the other. One line of script finds that, and it is worse than not
     * masking at all. Bucketing by vendor is what fixed it, and this is what
     * keeps it fixed.
     */
    add(
      'the vendor WebGPU reports is the vendor WebGL reports',
      // A missing reading fails rather than passes. A check that is satisfied by
      // the absence of its own measurement is how a suite goes green over a
      // surface nobody looked at.
      Boolean(masked.gpuVendor) &&
        (masked.gpuVendor === 'absent' ||
          vendorOf(masked.glRenderer ?? '') === masked.gpuVendor),
      `webgpu=${masked.gpuVendor} webgl=${vendorOf(masked.glRenderer ?? '')}`
    );
    add(
      'the supported extension list is in a stable order',
      masked.glExtSorted === true,
      `sorted=${String(masked.glExtSorted)}`
    );

    /**
     * readPixels is what a serious WebGL fingerprint hashes, as opposed to the
     * strings a lazy one reads. Both have to move or the two disagree about the
     * same machine.
     */
    add(
      'readPixels returns something other than the real buffer',
      Boolean(masked.glPixels) && masked.glPixels !== mirror.glPixels,
      `real=${mirror.glPixels} masked=${masked.glPixels}`
    );
    add(
      'and reading it twice gives the same answer',
      masked.glPixels === masked.glPixelsAgain,
      `${masked.glPixels} then ${masked.glPixelsAgain}`
    );

    /**
     * The gap that existed until this slice. Asking a canvas holding a WebGL
     * context for a 2D one returns null, so an encoder reading through the
     * source's own context could not mask it: readPixels came back masked and
     * toDataURL on the same canvas came back real, which is one canvas
     * answering two ways.
     */
    add(
      'and a WebGL canvas is masked when encoded, not only when read',
      Boolean(masked.glEncoded) && masked.glEncoded !== mirror.glEncoded,
      `real=${mirror.glEncoded} masked=${masked.glEncoded}`
    );

    // -------------------------------------------------------------- the audio

    /**
     * The classic shape: an oscillator through a compressor, rendered offline,
     * samples hashed. Two independent renders of the same graph, because the
     * guarantee is that the machine answers the same way twice, not merely that
     * one buffer reads the same twice.
     */
    add(
      'the rendered audio is not the real machine',
      Boolean(masked.audio) && masked.audio !== mirror.audio,
      `real=${mirror.audio} masked=${masked.audio}`
    );
    add(
      'and rendering the same graph again gives the same samples',
      masked.audio === masked.audioRerender,
      `${masked.audio} then ${masked.audioRerender}`
    );
    /**
     * getChannelData hands back a live view rather than a copy, so a transform
     * that is not idempotent drifts every time anybody reads the buffer, which
     * is the loudest possible version of per call instability.
     */
    add(
      'and reading the same buffer twice does not drift it',
      masked.audio === masked.audioReread,
      `first=${masked.audio} second=${masked.audioReread}`
    );
    add(
      'a buffer nobody rendered into stays silent',
      masked.audioSilence === true,
      `silent=${String(masked.audioSilence)}`
    );

    // ---------------------------------------------------------- the navigator

    /**
     * The surface that is not answerable inside the page.
     *
     * Every check above compares the page against itself. These compare it
     * against what its own origin received, because `navigator.userAgent` and
     * the `User-Agent` header are two reports of one fact and any server can
     * hold them up against each other. A mask that moved only the one the page
     * can see would manufacture exactly the contradiction it exists to prevent.
     */
    const brandList = opts.expect.brands.map((b) => `${b.brand} ${b.version}`).join(', ');

    add(
      'the user agent it reports is the normalised one',
      masked.ua === opts.expect.userAgent,
      `real=${mirror.ua} masked=${masked.ua}`
    );
    /**
     * The normalisation is a removal, so the version has to survive it. A
     * written down user agent passes this on the day it is written and fails
     * every day after.
     */
    add(
      'and it still claims the version the browser actually is',
      /Chrome\/(\d+)/.exec(masked.ua ?? '')?.[1] === /Chrome\/(\d+)/.exec(mirror.ua ?? '')?.[1],
      `real=${mirror.ua} masked=${masked.ua}`
    );
    add(
      'appVersion moved with it rather than staying behind',
      `Mozilla/${masked.appVersion}` === masked.ua,
      `${masked.appVersion}`
    );

    add(
      'the origin received the same user agent the page reports',
      Boolean(masked.sentUa) && masked.sentUa === masked.ua,
      `header=${masked.sentUa} page=${masked.ua}`
    );
    add(
      'and the same brand list, byte for byte',
      masked.sentChUa === secChUa(opts.expect.brands) && masked.brands === brandList,
      `header=${masked.sentChUa} page=${masked.brands}`
    );
    /**
     * Mirror rewrites nothing, so the header has to come back to the real one
     * when the posture goes off. A rule that outlived its posture would leave
     * the browser lying about itself with nothing in the page to match.
     */
    add(
      'Mirror puts the real user agent back on the wire',
      mirror.sentUa === mirror.ua,
      `header=${mirror.sentUa} page=${mirror.ua}`
    );

    add(
      'the worker reports the same browser as the page',
      masked.workerUa === masked.ua && masked.workerBrands === masked.brands,
      `worker=${masked.workerUa} page=${masked.ua}`
    );
    add(
      'the counts are the bucket, in both scopes',
      masked.cores === opts.expect.cores &&
        masked.memory === opts.expect.memory &&
        masked.workerCores === opts.expect.cores,
      `cores=${String(masked.cores)} memory=${String(masked.memory)} worker=${String(masked.workerCores)}`
    );

    /**
     * A property replaced the wrong way is found in one line. The real
     * `userAgent` is an accessor on the prototype whose getter is named
     * `get userAgent`, and a data property or a differently named function
     * where one of those belongs says something is standing in.
     */
    add(
      'userAgent is still an accessor named the way a native one is',
      masked.uaIsAccessor === true && masked.uaGetterName === 'get userAgent',
      `accessor=${String(masked.uaIsAccessor)} name=${masked.uaGetterName}`
    );
    add(
      'and its getter reports native source',
      masked.tsUserAgent === true,
      `native=${String(masked.tsUserAgent)}`
    );
    /**
     * Handing back a substitute for `navigator.userAgentData` would fail
     * `instanceof`, which is why the accessors on its prototype are patched
     * instead of the object being replaced.
     */
    add(
      'userAgentData is still the object the browser made',
      masked.uaDataIntact === true,
      `instanceof=${String(masked.uaDataIntact)}`
    );

    // -------------------------------------------------------------- the voices

    /**
     * The installed voice list, which is the strongest operating system tell
     * left in the page and was not in the applied list at all until the table
     * was re-read rather than trusted.
     *
     * What must survive the filter is every language the browser says it reads,
     * because a page speaking one of those has to find a voice for it. What must
     * not is a pack for a language the browser never claims to read, since that
     * is a fact about the machine nothing else on the page would predict.
     */
    add(
      'the voice list is not the machine version of itself',
      Boolean(masked.voiceCount) && (masked.voiceNames?.length ?? 0) > 0,
      `real=${String(mirror.voiceCount)} masked=${String(masked.voiceCount)}`
    );
    add(
      'and it keeps a voice for every language the browser says it reads',
      (masked.voiceCount ?? 0) > 0 && (masked.voiceCount ?? 0) <= (mirror.voiceCount ?? 0),
      `real=${mirror.voiceLangs} masked=${masked.voiceLangs}`
    );
    /**
     * Filtered, never fabricated. `SpeechSynthesisVoice` has no constructor, so
     * a made up list would be plain objects with the wrong prototype, which is
     * a one line find and would break `speak`.
     */
    add(
      'and every entry is still a voice the browser made',
      masked.voiceProto === 'SpeechSynthesisVoice',
      `${masked.voiceProto}`
    );
    add(
      'and the default voice is still the one a page reaches for first',
      masked.voiceDefaultFirst === true,
      `default first=${String(masked.voiceDefaultFirst)}`
    );

    // ------------------------------------------- what the engine still owns

    /**
     * Media devices, left alone, and measured before that was decided.
     *
     * With no permission granted Chrome already returns one placeholder entry
     * per kind of device that exists, every field empty: no id, no group, no
     * label. So what survives is which kinds exist, at most three bits, and the
     * browser has done the anonymising itself.
     *
     * Normalising that means claiming a camera on a machine that has none, which
     * changes what the page can do rather than what it can measure: a site would
     * offer a call button that fails when it is pressed. Three bits is not worth
     * that, so this asserts the list is untouched rather than that it moved.
     */
    add(
      'the device list is the real one, which the browser already anonymises',
      Boolean(masked.deviceKinds) && masked.deviceKinds === mirror.deviceKinds,
      `real=${mirror.deviceKinds} masked=${masked.deviceKinds}`
    );

    /**
     * The screen is deliberately not masked, and this is the check that keeps
     * it deliberate.
     *
     * A stylesheet can ask the engine for the device width and the pixel ratio
     * and the page can read the answer back, and no content script can reach
     * that evaluation. So a spoofed `screen.width` would be contradicted by the
     * page's own media queries, which is worse than not masking it: it is the
     * mask manufacturing the incoherence. The same argument covers touch
     * points, which `(any-pointer: coarse)` answers.
     */
    add(
      'the screen it reports is the one the CSS engine agrees with',
      masked.mqScreenAgrees === true && masked.mqDprAgrees === true,
      `screen=${String(masked.screenWidth)} dpr=${String(masked.dpr)} agree=${String(masked.mqScreenAgrees)}/${String(masked.mqDprAgrees)}`
    );
    /**
     * Stated as "unchanged" rather than as a fact about the hardware, because
     * this is an assertion about the mask and not about the machine it happens
     * to be running on.
     */
    add(
      'and the touch capability is left exactly as the machine reports it',
      masked.touchPoints === mirror.touchPoints && masked.mqCoarse === mirror.mqCoarse,
      `points=${String(mirror.touchPoints)} then ${String(masked.touchPoints)}`
    );

    // -------------------------------------------------- the disguise itself

    /**
     * A patch that can be found is worse than no patch, because it says
     * something is being hidden. Every check here is a one line probe a page can
     * run, and two of them found real defects.
     */
    add(
      'every patched function still reports native source',
      masked.tsGetImageData === true && masked.tsToDataURL === true && masked.tsWorker === true,
      `getImageData=${String(masked.tsGetImageData)} toDataURL=${String(masked.tsToDataURL)} Worker=${String(masked.tsWorker)}`
    );
    add(
      'and the trap survives being asked about itself',
      masked.tsItself === true,
      `toString.call(toString) native=${String(masked.tsItself)}`
    );
    add(
      'while a function nobody touched still reports its real source',
      masked.tsPageFn === true,
      `page function readable=${String(masked.tsPageFn)}`
    );
    add(
      'the replacement keeps the name and arity it replaced',
      masked.shapeName === 'getImageData' && masked.shapeLength === 4,
      `name=${masked.shapeName} length=${String(masked.shapeLength)}`
    );

    /**
     * A plain function standing in for a native constructor is callable without
     * `new` and has a writable `prototype`. Both are one line probes with no
     * false positives, and both were true here until they were not.
     */
    add(
      'the Worker constructor refuses to be called without new',
      masked.workerNoNew === 'TypeError',
      `${masked.workerNoNew}`
    );
    add(
      'and its prototype is non-writable the way a native one is',
      masked.workerProtoWritable === false,
      `writable=${String(masked.workerProtoWritable)}`
    );

    /**
     * Substituting on the enum alone answered anybody who passed the number,
     * including on a context that never obtained the extension, where the real
     * answer is null. One call on a fresh context found the mask.
     */
    add(
      'getParameter says nothing without the extension that unmasks it',
      masked.glBareUnmasked === 'null' || masked.glBareUnmasked === 'no-webgl',
      `bare context reported ${masked.glBareUnmasked}`
    );

    /**
     * Timing, measured rather than assumed.
     *
     * Section 11 lists a canvas patch timing anomaly as its own vector, and the
     * mask copies, reads, noises and re-encodes, which is real work. This began
     * at four and a half times native because the noise loop hashed every pixel
     * to keep one in 97; selecting one per block brought it to under twice.
     *
     * Three times is the bound because that is comfortably above what the loop
     * costs now and comfortably below what per pixel work costs, so a return to
     * it fails here rather than shipping. The floor covers a machine fast
     * enough that the baseline is a handful of milliseconds and absolute jitter
     * dominates the ratio.
     */
    const real = mirror.encodeMs ?? 0;
    const cost = masked.encodeMs ?? 0;
    add(
      'encoding a large canvas costs about what encoding it normally costs',
      cost >= 0 && cost <= Math.max(real * 3, 40),
      `real=${real}ms masked=${cost}ms`
    );

    // ------------------------------------------------------ the determinism

    add(
      'reading the same canvas twice gives the same answer',
      masked.direct === masked.directAgain,
      `${masked.direct} then ${masked.directAgain}`
    );

    /**
     * Idempotence, measured rather than assumed. Additive noise fails this: the
     * decode path is noised on the way out and again on the way back in, so a
     * site reading one canvas two ways sees two answers.
     */
    add(
      'a decode and re-read matches a direct read',
      masked.roundTrip === masked.direct,
      `direct=${masked.direct} roundTrip=${masked.roundTrip}`
    );

    const again = await measure(surface, `${fixture}/fp?again=1`);
    add(
      'and a fresh load of the page gives the same fingerprint',
      Boolean(again?.direct) && again?.direct === masked.direct,
      `first=${masked.direct} second=${again?.direct}`
    );

    // -------------------------------------------------------- failing closed

    /**
     * A policy of `worker-src 'none'` is the reachable version of the real
     * cause, which is a CSP hardened origin or a cross-origin worker script.
     * Either way the blob rewrite cannot happen, and the rule is that the mask
     * comes off rather than leaving the two scopes disagreeing.
     */
    const blocked = await measure(surface, `${fixture}/fp?csp=1`);
    if (!blocked) {
      add('a worker the mask cannot reach makes it fail closed', false, 'the probe never reported');
    } else {
      add(
        'a worker the mask cannot reach makes it fail closed',
        blocked.maskOn === false,
        `mask still on=${String(blocked.maskOn)}`
      );
      /**
       * The reading taken after the refusal, not the one taken before it.
       *
       * Only the constructor throwing is synchronous, and Chrome does not throw
       * for a worker-src violation: it constructs the object and reports the
       * refusal afterwards. So a value the page already took cannot be
       * un-noised, and asserting on it would be asserting something no
       * implementation can deliver. What can be delivered, and is what fail
       * closed actually means, is that every read from then on is the real
       * canvas, which also proves the natives were restored rather than a flag
       * being flipped.
       */
      add(
        'and every read after that is the real canvas again',
        blocked.afterWorker === mirror.direct,
        `real=${mirror.direct} after=${blocked.afterWorker}`
      );
    }

    add(
      'a mask that stays on keeps answering the same way throughout',
      masked.afterWorker === masked.direct,
      `direct=${masked.direct} after=${masked.afterWorker}`
    );

    // ------------------------------------------- and the half it could not reach

    /**
     * The rest of failing closed, which the mask cannot do for itself.
     *
     * Taking the patches off inside one document leaves the request headers
     * rewritten, because those are rules the worker installed and a MAIN world
     * script has no channel to withdraw them. The page then reports the real
     * browser while its own requests report the normalised one, which is a
     * contradiction the mask introduced by trying to end one.
     *
     * The refusal is reported by the isolated agent rather than by the mask,
     * because anything the mask can dispatch the page can dispatch, and a
     * fingerprinter that could ask to be excluded would simply ask. Only the
     * browser can raise a trusted policy violation event.
     */
    add(
      'the worker heard the refusal, not just the page',
      opts.degraded().length > 0,
      `withdrawn from ${opts.degraded().join(', ') || 'nothing'}`
    );

    /**
     * Both layers, measured on a fresh load rather than asserted. Excluding the
     * headers alone would leave the page patched and its requests real, so this
     * checks the page went back to the real browser too.
     */
    const after = await measure(surface, `${fixture}/fp?after=1`);
    add(
      'and the posture came off the whole origin rather than half of it',
      Boolean(after) && after?.maskOn === false && after?.sentUa === mirror.ua,
      `mask=${String(after?.maskOn)} header=${after?.sentUa}`
    );
    add(
      'so the page and the wire agree again',
      after?.ua === after?.sentUa,
      `page=${after?.ua} header=${after?.sentUa}`
    );

    // ------------------------------------------------------------ persona

    /**
     * One machine per session, and the three things that have to be true of it.
     *
     * It has to differ between sessions, or Persona is Standardize with extra
     * steps. It has to be identical every time one session asks, or it is
     * randomness, which is the single easiest thing to detect. And where the
     * material has not arrived yet it has to be the shared bucket rather than
     * the real machine, because that is what makes the first load of a tab a
     * smaller window rather than a hole.
     *
     * The third is measured first here, and it is measured by accident of how
     * the mechanism works, which is the best kind: the material lands in a tab
     * when the shim commits, so the first load after switching posture has none
     * and reads the bucket, and the second has it.
     */
    await opts.clearDegraded();
    await opts.createSession('mask_p1', ['localhost']);
    await opts.createSession('mask_p2', ['localhost']);
    await opts.setPosture('persona');
    await opts.bindTab(surface.id, 'mask_p1', `${fixture}/fp`);

    // Two loads, because the material is put into a tab by the document that
    // has it. This tab has been loading the fixture all run, so the re-answer
    // the bind triggers reaches a document that is already open and the very
    // next load already has it. The genuinely empty case is the fresh tab
    // below, which is where it is checked.
    await measure(surface, `${fixture}/fp`);
    const p1 = await measure(surface, `${fixture}/fp`);
    add(
      'a session gets a machine that is neither the bucket nor the real one',
      Boolean(p1?.direct) && p1?.direct !== masked.direct && p1?.direct !== mirror.direct,
      `persona=${p1?.direct} bucket=${masked.direct} real=${mirror.direct}`
    );

    const p1Again = await measure(surface, `${fixture}/fp`);
    add(
      'which is the same machine every time that session asks',
      Boolean(p1Again?.direct) && p1Again?.direct === p1?.direct,
      `first=${p1?.direct} again=${p1Again?.direct}`
    );
    add(
      'in the worker as well as on the main thread',
      p1?.direct === p1?.worker,
      `main=${p1?.direct} worker=${p1?.worker}`
    );
    add(
      'and the two read paths still agree about it',
      Boolean(p1?.roundTrip) && p1?.roundTrip === p1?.direct,
      `direct=${p1?.direct} roundTrip=${p1?.roundTrip}`
    );

    /**
     * The other session, on the same origin, in a tab of its own. This is the
     * check the whole posture exists for: two accounts on one site that do not
     * share a canvas hash.
     */
    const other = await chrome.tabs.create({
      url: 'about:blank',
      active: false,
      windowId: surface.windowId,
    });
    let p2First: Report | null = null;
    let p2: Report | null = null;
    let p2Again: Report | null = null;
    try {
      const second: Surface = { id: other.id!, replaced: 0, windowId: surface.windowId };
      await opts.bindTab(second.id, 'mask_p2', `${fixture}/fp`);
      // A tab that has never had a document on this origin, which is the case
      // the mask cannot be told about in time and the reason it resolves late.
      p2First = await measure(second, `${fixture}/fp`);
      p2 = await measure(second, `${fixture}/fp`);
      p2Again = await measure(second, `${fixture}/fp`);
    } finally {
      await chrome.tabs.remove(other.id!).catch(() => undefined);
    }

    /**
     * The first load of a tab, which is the case the design worried about and
     * which measurement turned out to be kinder than expected.
     *
     * A persona is per session and a registered script is per url, so nothing
     * can be handed to the mask before the document exists. The mask therefore
     * resolves late, on the first read of a masked surface rather than at
     * install, and the material lands while the document is still on the wire.
     * So even the first inline script of a tab's first document reads the
     * persona, because a page script cannot run before its own HTML arrives and
     * the worker's answer takes a fraction of that.
     *
     * What is asserted here is the guarantee rather than the timing, because the
     * timing is a race this does not control and the guarantee is not. Whatever
     * has landed, it is never the real machine, and it does not change between
     * that load and the next.
     */
    add(
      'the first load in a fresh tab is never the real machine',
      Boolean(p2First?.direct) &&
        p2First?.direct !== mirror.direct &&
        (p2First?.direct === masked.direct || p2First?.direct === p2?.direct),
      `first=${p2First?.direct} bucket=${masked.direct} settled=${p2?.direct} real=${mirror.direct}`
    );
    add(
      'and its worker agrees with it, whichever answer it got',
      p2First?.direct === p2First?.worker,
      `main=${p2First?.direct} worker=${p2First?.worker}`
    );

    add(
      'a second session on the same origin is a different machine',
      Boolean(p1?.direct && p2?.direct) && p1?.direct !== p2?.direct,
      `one=${p1?.direct} two=${p2?.direct}`
    );
    add(
      'and it is stable too, so neither is randomness',
      Boolean(p2Again?.direct) && p2Again?.direct === p2?.direct,
      `first=${p2?.direct} again=${p2Again?.direct}`
    );
    add(
      'their WebGL differs as well as their canvas',
      Boolean(p1?.glPixels && p2?.glPixels) && p1?.glPixels !== p2?.glPixels,
      `one=${p1?.glPixels} two=${p2?.glPixels}`
    );

    /**
     * The vendor does not move and the model does, which is the restraint the
     * card bucket was built on one level down: WebGPU names the real vendor and
     * nothing here fakes it, so a persona crossing vendors would contradict a
     * surface this build deliberately leaves alone.
     */
    if (wanted) {
      add(
        'a persona keeps the vendor and only moves the model',
        p1?.glVendor === wanted.vendor && p1?.glRenderer !== mirror.glRenderer,
        `vendor=${p1?.glVendor} renderer=${p1?.glRenderer}`
      );
      add(
        'and the vendor WebGPU reports still matches the one WebGL claims',
        !p1?.gpuVendor || vendorOf(p1.glRenderer ?? '') === vendorOf(p1.gpuVendor),
        `webgl=${p1?.glRenderer} webgpu=${p1?.gpuVendor}`
      );
    }

    /**
     * Everything a request header or a media query could contradict has to be
     * the same as it was under Standardize. A persona is a different
     * fingerprint, not a different computer.
     */
    add(
      'a persona reports the same browser as the bucket does',
      p1?.ua === masked.ua && p1?.sentUa === masked.sentUa,
      `page=${p1?.ua} header=${p1?.sentUa}`
    );
    add(
      'so the page and the wire still agree under Persona',
      p1?.ua === p1?.sentUa,
      `page=${p1?.ua} header=${p1?.sentUa}`
    );

    /**
     * Leaving Persona, which has to reach the tabs that are already open.
     *
     * The mask reads the material out of the tab at document_start, so what
     * decides the next page is what is sitting there now. The worker re-answers
     * every tab when the posture changes for exactly this reason, and without
     * that the next reload still showed a persona and the one after it showed
     * the bucket: a setting the user changed and did not get.
     */
    await opts.setPosture('standardize');
    const backToBucket = await measure(surface, `${fixture}/fp`);
    add(
      'leaving Persona puts the tab back on the shared bucket, on the next load',
      backToBucket?.direct === masked.direct,
      `now=${backToBucket?.direct} bucket=${masked.direct}`
    );

    await opts.dropSession('mask_p1');
    await opts.dropSession('mask_p2');

    /**
     * The same refusal, one frame down, which is where it went unheard.
     *
     * The listener that reports this is registered in every frame the mask runs
     * in. The agent is not: it binds tabs and draws the chooser, so it belongs
     * in the top frame only, and a policy inside an iframe used to take the mask
     * off there while the headers went on being rewritten over it.
     *
     * The top document of this page carries no policy, so nothing it can hear
     * raises a violation. A withdrawal after loading it can only have been
     * reported from inside the frame.
     */
    await opts.clearDegraded();
    add(
      'clearing the withdrawal puts the posture back',
      opts.degraded().length === 0,
      `withdrawn from ${opts.degraded().join(', ') || 'nothing'}`
    );

    const framed = await measure(surface, `${fixture}/fp-frame`);
    // The frame loads, fails closed and reports after the top document is
    // complete, so the answer is not ready the moment the page is.
    for (let i = 0; i < 20 && !opts.degraded().length; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    add(
      'a refusal inside a frame is heard too',
      Boolean(framed) && opts.degraded().length > 0,
      `withdrawn from ${opts.degraded().join(', ') || 'nothing'}`
    );

    if (surface.replaced) {
      // Reported rather than swallowed. A run that had to stand its surface back
      // up measured across two tabs, and anybody reading a green suite should
      // know that happened.
      add(
        'the suite kept one measuring surface throughout',
        false,
        `the tab went away ${surface.replaced} time(s) and was replaced`
      );
    }

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    return { ok: false, checks, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) };
  } finally {
    if (surface) await chrome.tabs.remove(surface.id).catch(() => undefined);
    // The withdrawal is meant to last for the life of the worker, which is right
    // in a browser and wrong here: the fixture is deliberately made to refuse
    // partway through, so leaving it withdrawn would have every later run
    // measuring an origin the posture had already been taken off.
    await opts.clearDegraded().catch(() => undefined);
    await opts.setPosture(before).catch(() => undefined);
  }
}
