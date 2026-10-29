'use strict';
/**
 * recorder.js — drives headless Chrome through a demo and assembles a real
 * screen-recording video from it. NODE-ONLY.
 *
 * ===========================================================================
 * A RECORDING, NOT A SLIDESHOW
 * ===========================================================================
 * This drives real pages — a local staged file, or a live deployed URL,
 * either works — and produces the page actually MOVING: text typed
 * character by character, a panel opening, a spotlight ringing the thing
 * being talked about.
 *
 * ===========================================================================
 * WHY MOTION IS PRODUCED, NOT OBSERVED
 * ===========================================================================
 * `Page.startScreencast` was the obvious approach and does not work
 * reliably in headless Chrome: the compositor does not run on its own here,
 * so a live-streamed capture produces almost nothing while the page is
 * merely sitting still between explicit changes. So every frame is instead
 * FORCED: each beat sets an exact intermediate state (a scroll position, a
 * character of typed text, a spotlight's fade amount) and takes one
 * screenshot of it (`Page.captureScreenshot`, which forces a render). A
 * still beat is one frame held for a long duration rather than sixty
 * identical ones — same result, a fraction of the shooting time.
 *
 * ===========================================================================
 * ONE FRAME RATE, EVERYWHERE
 * ===========================================================================
 * Every authored move samples at the SAME steps-per-second as the final
 * encode (see `stepsFor`). Mixing frame rates between different motion
 * helpers is what produces an uneven, "stuttery" feel — ffmpeg has to
 * duplicate frames unevenly to reconcile them. One rate removes the
 * question entirely.
 *
 * ===========================================================================
 * PICTURE TIMED TO VOICE, NOT THE OTHER WAY AROUND
 * ===========================================================================
 * If a narration manifest (see narrate.js) is supplied, `say()` holds each
 * beat for exactly as long as its line takes to say — nothing is
 * time-stretched, nothing is cut off mid-word. Build the audio first
 * (narrate.js), then record.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { Cdp, httpJson, waitForPort } = require('./cdp.js');
const { FrameRegistry, isGoneError } = require('./frames.js');
const { buildLiveKitJs } = require('./liveKit.js');
const { createLive } = require('./liveInput.js');
const { quotedLabels, spokenText, closest, formatReport } = require('./preflight.js');

// shoot() floors every frame at this many ms of FILM time (see below) so
// ffmpeg's concat demuxer never sees a near-zero-duration entry. Exported so
// observeFrameIntervalMs (and a test) can reason about it without duplicating
// the number.
const MIN_FILM_FRAME_MS = 0.02 * 1000;

/**
 * The real-time sampling interval `observe()` should capture at for a given
 * `speed`, in ms. Pure arithmetic, pulled out of `observe()` so it can be
 * tested without a live CDP connection.
 *
 * At the normal ~16-captures/sec rate, `frameMs / speed` drops below
 * `shoot()`'s own floor (`MIN_FILM_FRAME_MS`, `Math.max(0.02, ...)` there) for
 * any speed past ~2.6x — every frame then gets padded up to that floor
 * regardless of what was asked for, so the real thing plays back at an
 * ACHIEVED speed of ~3.1x no matter whether `speed` said 6, 8, or 20, with no
 * error to say so. Found directing Freedact's demo: a `speed: 8` `observe`
 * measured out at ~3.1x every time, throwing off an `untilVo` cap sized to
 * fit a voice line. Fix: widen the real sampling interval at high speed so
 * the resulting film-frame duration clears the floor with headroom —
 * capture less often in real time rather than shoot frames the floor was
 * going to pad anyway. Low speeds are unaffected (still ~16 captures/sec).
 */
function observeFrameIntervalMs(speed) {
  const targetCaptureMs = 1000 / 16; // ~16 captures/sec, the 12-20 band this was designed for
  const clearFloorMs = speed * (MIN_FILM_FRAME_MS + 4); // +4ms headroom above the exact floor
  return Math.max(targetCaptureMs, clearFloorMs);
}

/**
 * What DEMO_TRACE may print for a navigation: the last path segment only.
 * The old trace printed everything after the final '/', which for an
 * authenticated launch URL (e.g. a Salesforce frontdoor.jsp?otp=…) put a
 * one-time login token and the org id on the console. Query strings,
 * fragments, and credentials never reach the log now.
 */
function traceUrlLabel(url) {
  try {
    const u = new URL(String(url));
    const last = u.pathname.split('/').filter(Boolean).pop() || '/';
    return last + (u.search || u.hash ? ' (query omitted)' : '');
  } catch (err) {
    return String(url).split(/[?#]/)[0].split('/').pop() || '(url)';
  }
}

/**
 * The shortest film duration shoot() will give one captured frame, in ms.
 * It exists so ffmpeg's concat demuxer never sees a near-zero entry, but it
 * must never exceed one output frame: the old flat 20ms floor sat above a
 * 60fps frame (16.7ms), so every motion()/frame()/spot() step was padded to
 * 20ms and every authored move ran 20% long at 60fps. Storyboards timed to
 * the voice drifted late by a fifth of every camera move (found on the
 * Salesforce demo: a 5.7s hero-card walk overran its line by ~1s). Low fps
 * keeps the 20ms floor; 60fps floors at exactly one frame.
 */
function filmFrameFloorMs(fps) {
  return Math.min(MIN_FILM_FRAME_MS, 1000 / (fps || 60));
}

/**
 * Concat-demuxer duration strings for a run of frame durations (seconds),
 * written with error diffusion so the film's cumulative clock matches the
 * recorder's `elapsedMs` — the clock the narration audio is placed on.
 * Plain `toFixed(3)` rounded a 60fps frame (16.667ms) up to 17ms: +0.33ms
 * per frame, a ~2% drift that put the picture ~0.85s behind the voice by
 * 51s into the Salesforce demo and padded its ending by ~1.4s.
 */
function concatDurations(secs) {
  let exact = 0;
  let written = 0;
  return secs.map((d) => {
    exact += d;
    const next = Math.round(exact * 1e6) / 1e6;
    const out = next - written;
    written = next;
    return out.toFixed(6);
  });
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome(explicit) {
  if (explicit) return explicit;
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Chromium found. Pass { chromePath } explicitly.');
}

// Every delivered file is limited-range BT.709 and tagged so: the JPEG
// frames are full-range BT.601, and untagged output played back washed out
// or crushed depending on the player (every 2026-10-27 take was tagged
// pc/bt470bg). setparams tags the frames too: without it x264 wrote the
// primaries and transfer as unknown.
const BT709_TAGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
const BT709_FROM_JPEG = (W, H) => 'scale=' + W + ':' + H + ':in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

/** Re-masters an mp4's audio in place (video copied): stereo, two-pass loudnorm. */
function masterInPlace(file, target) {
  const { masterAudioArgs, measureLoudness } = require('./audioMaster.js');
  const tmp = file.replace(/\.mp4$/, '.master.mp4');
  const measured = measureLoudness(file, target);
  execFileSync('ffmpeg', masterAudioArgs(file, tmp, measured, target), { stdio: 'inherit' });
  fs.renameSync(tmp, file);
}

/** A subject's top-frame rect, padded, in the still's own px (below the band). */
function stillRect(rect, pad, top, W, H) {
  const p = Array.isArray(pad) ? pad : [pad || 0, pad || 0, pad || 0, pad || 0];
  const r = [rect.l - p[3], rect.t - p[0] - top, rect.r + p[1], rect.b + p[2] - top];
  return [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H - top, r[3])].map((v) => Math.round(v));
}

/** Writes capture.json (labels, boxes, audit counts; never a URL) and OCRs every still. */
function finishCapture(cap, o) {
  const manifest = {
    version: 1, viewport: [o.W, o.H], scale: o.scale,
    stills: Object.fromEntries(o.stills.map((s) => [s.key, { file: s.file, width: s.width, height: s.height, subjects: s.subjects }])),
    audits: o.audits.map((a) => ({ where: a.where, ok: a.ok })),
    preflight: o.report,
  };
  let scan = null;
  if (cap.scan !== false && o.stills.length) {
    const { scanImages } = require('./frameScan.js');
    scan = scanImages(o.stills.map((s) => path.join(cap.dir, s.file)), { allowEmails: cap.allowEmails });
    manifest.scan = { images: scan.frames, hits: scan.hits.length, counts: scan.counts };
    if (scan.hits.length) {
      throw new Error('Still OCR found never-show items: ' + scan.hits.map((h) => h.name + ' ' + h.kinds.join('+')).join(', ') + '. Capture rejected.');
    }
  }
  fs.writeFileSync(path.join(cap.dir, 'capture.json'), JSON.stringify(manifest, null, 2));
  return { capture: true, dir: cap.dir, manifest: manifest, report: o.report, beats: o.beats, audits: o.audits, scan: scan };
}

/**
 * Runs `buildFn(rec)` against a fresh headless Chrome instance and produces
 * a finished mp4.
 *
 * @param {(rec: object) => Promise<void>} buildFn - your storyboard. Called
 *   with a `rec` object exposing the primitives documented on each method
 *   below. Throwing from here aborts the recording.
 * @param {Object} opts
 * @param {string} opts.outDir - directory for frames + the finished video.
 * @param {string} [opts.outFile='demo.mp4'] - output filename, inside outDir.
 * @param {number} [opts.width=1920]
 * @param {number} [opts.height=1080]
 * @param {number} [opts.fps=60]
 * @param {string} [opts.voManifestPath] - path to a manifest.json produced
 *   by narrate.js. Omit for a silent build (captions still work; `say()`
 *   just holds for `holdMs` with no audio).
 * @param {number} [opts.stallMs=5000] - a beat's picture may sit still for
 *   at most this long while NOTHING is speaking before the build fails.
 *   Silence while narration is still playing never counts — a composed
 *   held frame under a spoken line is intentional, not dead air.
 * @param {string} [opts.chromePath]
 * @param {number} [opts.crf=20] - x264 quality (lower = better/larger).
 * @param {string} [opts.everyFrameJs] - JS evaluated in the page before
 *   EVERY captured frame (e.g. '__redact()' for display-only redaction that
 *   must survive re-renders). Throwing aborts the take.
 * @param {boolean} [opts.strictSubjects=false] - throw when a frame()/spot()
 *   subject resolves to nothing, instead of warning and filming on.
 *
 * LIVE-APP OPTIONS (all off by default; staged demos are unchanged):
 * @param {boolean} [opts.frames=false] - follow every frame, including
 *   cross-site iframes (Salesforce Setup), see frames.js. Enables subject
 *   OBJECTS ({text}, {q}, {expr}, each with an optional `frame`) in click(),
 *   type(), spot(), spotMove() and waitFor(); real keystrokes and mouse
 *   events; rec.beat() label checks; and per-frame redaction in every frame.
 * @param {string} [opts.topFrameJs] - with frames: JS (re)installed in the
 *   top frame whenever its document is new (the camera client, the band,
 *   a per-frame hook), so a navigation can never film an unprepared page.
 * @param {boolean} [opts.cursor=false] - draw a pointer that glides to each
 *   clicked or typed-into subject. [opts.cursorStart=[x,y]] where it rests.
 * @param {boolean} [opts.burnCaptions=true] - false: say() draws no caption
 *   bar (captions ship as WebVTT instead).
 * @param {Object} [opts.capture] - CAPTURE mode, for the compose stage
 *   (compose.js): run the storyboard like the preflight (no film, no
 *   narration waits; every beat's labels are still checked), but at 2x
 *   device pixels, and enable rec.still(key, {subjects}). Each still is a
 *   lossless PNG of the page below the band (the global header is never
 *   saved), taken only after a never-show audit reads zero, with its named
 *   subjects' boxes. Writes {dir}/stills/*.png and {dir}/capture.json (no
 *   URLs, no ids), then OCRs every still. {dir, scale=2, allowEmails, scan=true}
 * @param {boolean} [opts.dryRun=false] - the wording PREFLIGHT: run the whole
 *   storyboard against the live page without capturing a frame or waiting
 *   on narration, check every beat's labels in every frame, and throw a
 *   script-vs-screen diff if any label never appeared. Resolves to
 *   {dryRun: true, report, beats} when all labels were on screen. Storyboard
 *   steps that WRITE should check rec.dryRun and skip.
 * @returns {Promise<{outPath: string, bytes: number, durationSec: number, beats: Array}>}
 */
async function runDemo(buildFn, opts) {
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const FPS = opts.fps || 60;
  const OUT_DIR = opts.outDir;
  const OUT = path.join(OUT_DIR, opts.outFile || 'demo.mp4');
  const FRAME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-frames-'));
  const STAGE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-mux-'));
  const stallCeilingMs = opts.stallMs === undefined ? 5000 : opts.stallMs;
  const CAPTURE = opts.capture || null;
  if (CAPTURE && !opts.frames) throw new Error('capture needs runDemo({frames: true})');
  // Capture runs like the preflight: nothing is filmed or timed.
  const DRY = !!opts.dryRun || !!CAPTURE;
  const SCALE = CAPTURE ? (CAPTURE.scale || 2) : 1;
  const chromeBin = findChrome(opts.chromePath);

  const VO = opts.voManifestPath && fs.existsSync(opts.voManifestPath)
    ? JSON.parse(fs.readFileSync(opts.voManifestPath, 'utf8'))
    : null;
  const AUDIO = [];

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=' + W + ',' + H,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // --remote-debugging-port=0 picks a free port and Chrome reports it on
  // stderr as "DevTools listening on ws://...:PORT/..." -- avoids colliding
  // with another instance (another demo build running on the same machine,
  // say) if both happen to run at once.
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('Chrome did not report a debug port in time')), 20000);
    chrome.stderr.on('data', d => {
      buf += d.toString();
      const m = /ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
  });

  let client = null;
  let live = null;
  let frameReg = null;
  const beats = [];
  const audits = [];
  const stills = [];
  const frames = [];
  let stillMs = 0;
  const stalls = [];

  try {
    await waitForPort(port, 20000);
    const targets = await httpJson(port, '/json/list');
    const page = targets.filter(t => t.type === 'page')[0];
    if (!page) throw new Error('no page target');

    client = await Cdp.connect(page.webSocketDebuggerUrl);
    // The frame registry must hear the contexts Runtime.enable announces.
    if (opts.frames) {
      frameReg = new FrameRegistry(client, { kitJs: buildLiveKitJs() });
      frameReg.listen();
    }
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    if (frameReg) {
      await frameReg.enable();
      // Headless has no focused window; without this, real keystrokes and
      // :focus styles behave as if the page were in the background.
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    }

    // FORCE THE VIEWPORT. --window-size is the WINDOW; headless still keeps
    // some of it back for chrome (browser chrome, not the Chrome binary),
    // producing letterboxed frames unless the device metrics are overridden
    // to exactly W x H.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
    });

    let n = 0;
    let elapsedMs = 0;
    let voEndsAt = 0;
    let voStartAt = 0;
    let voClipMs = 0;

    // Live takes: before EVERY frame, (re)install the top frame's kit on a
    // fresh document and re-apply the redaction in every frame, iframes
    // included. A frame that is mid-navigation is retried, never skipped.
    // A frame mid-navigation answers "context destroyed" for a moment;
    // retry those, never skip them (a skipped frame is an unredacted frame).
    const retryGone = async (fn) => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(); } catch (err) {
          if (attempt >= 20 || !(isGoneError(err) || /Cannot find default execution context/.test(err.message))) throw err;
          await sleep(100);
        }
      }
    };
    // (Re)installs opts.topFrameJs on a fresh top document, then puts the
    // cursor back where it was.
    const ensureTop = async () => {
      if (!opts.topFrameJs) return;
      const fresh = await client.send('Runtime.evaluate', { expression: '!window.__dsTop', returnByValue: true });
      if (fresh && fresh.result && fresh.result.value === true) {
        await run(opts.topFrameJs + ';window.__dsTop=1;true');
        if (live) await live.restoreCursor();
      }
    };
    // Live takes: before EVERY frame, prepare the top frame and re-apply the
    // redaction in every frame, iframes included.
    const prepareFrames = () => retryGone(async () => { await ensureTop(); await frameReg.redactAll(); });

    const shoot = async (durationMs) => {
      // The preflight captures nothing, but the page is still prepared (band,
      // redaction) so label checks see exactly what the film would.
      if (frameReg) await prepareFrames();
      if (DRY) { elapsedMs += Math.max(filmFrameFloorMs(FPS), durationMs || 1000 / FPS); return; }
      if (opts.everyFrameJs) {
        // e.g. '__redact()': re-applied before EVERY capture so nothing the
        // page re-renders between frames can reach the film. A failure here
        // is fatal — a redaction step that silently stopped is a leak.
        const pre = await client.send('Runtime.evaluate', { expression: opts.everyFrameJs, returnByValue: true });
        if (pre && pre.exceptionDetails) {
          throw new Error('everyFrameJs failed: ' + JSON.stringify(pre.exceptionDetails.text));
        }
      }
      const r = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      const file = path.join(FRAME_DIR, String(n++).padStart(6, '0') + '.jpg');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const dur = Math.max(filmFrameFloorMs(FPS) / 1000, (durationMs || 1000 / FPS) / 1000);
      frames.push({ file: file, dur: dur });
      elapsedMs += dur * 1000;
    };

    const still = (ms) => {
      if (DRY || elapsedMs < voEndsAt) { stillMs = 0; return; }
      stillMs += ms;
      if (stillMs > stallCeilingMs) stalls.push({ atMs: elapsedMs, ms: stillMs });
    };

    const run = async (expr) => {
      const r = await client.send('Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        // The exception's own first line ("TypeError: …"), not just "Uncaught".
        const why = d.exception && d.exception.description ? String(d.exception.description).split('\n')[0] : d.text;
        throw new Error(String(expr).slice(0, 70) + ' -> ' + JSON.stringify(why));
      }
      return r;
    };

    const hold = (ms) => { still(ms || 1000 / FPS); return shoot(ms); };
    const settle = async (ms) => { await sleep(ms); await hold(ms); };

    const motion = async (fnOfT, steps, totalMs) => {
      stillMs = 0;
      // A move draws with the top frame's overlays: install them first.
      if (frameReg) await retryGone(ensureTop);
      // The preflight only needs where a move ENDS, not its frames.
      if (DRY) { await run(fnOfT(1)); await shoot(totalMs); return; }
      for (let i = 1; i <= steps; i++) {
        await run(fnOfT(i / steps));
        await shoot(totalMs / steps);
      }
    };
    const stepsFor = (ms) => Math.max(4, Math.round((ms / 1000) * FPS));

    const go = async (url) => {
      if (process.env.DEMO_TRACE) {
        console.log('  == ' + (elapsedMs / 1000).toFixed(1) + 's  PAGE: ' + traceUrlLabel(url));
      }
      await client.send('Page.navigate', { url: url });
      await sleep(1100);
    };

    const say = async (text, holdMs, voKey) => {
      if (voEndsAt > elapsedMs) await hold(voEndsAt - elapsedMs);
      if (opts.burnCaptions !== false) await run('__caption(' + JSON.stringify(text) + ')');
      if (process.env.DEMO_TRACE) {
        console.log('    ' + (elapsedMs / 1000).toFixed(1) + 's  ' +
          (voKey || text).slice(0, 40) + '  "' + String(text).slice(0, 32) + '"');
      }
      const clip = VO && VO.clips[voKey || text];
      voStartAt = elapsedMs;
      voClipMs = clip ? clip.seconds * 1000 : 0;
      if (clip && !DRY) {
        AUDIO.push({ file: clip.file, atMs: elapsedMs });
        voEndsAt = elapsedMs + clip.seconds * 1000 + 350;
      }
      await hold(holdMs || 900);
    };

    const atVo = async (frac) => {
      const target = voStartAt + voClipMs * frac;
      if (target > elapsedMs) await hold(target - elapsedMs);
    };

    // A subject OBJECT (frames mode) means real keystrokes into whatever the
    // subject resolves to, in any frame; a selector string keeps the staged
    // behavior of setting the value by script.
    const type = async (selectorOrId, text, ms, o) => {
      if (selectorOrId && typeof selectorOrId === 'object') {
        await needLive('type').typeInto(selectorOrId, text, Object.assign({ ms: ms }, o || {}));
        return afterAction();
      }
      const isId = /^[A-Za-z_][\w-]*$/.test(selectorOrId) &&
        !/[.#\[\] >]/.test(selectorOrId);
      const getEl = isId ? 'document.getElementById(' + JSON.stringify(selectorOrId) + ')'
        : 'document.querySelector(' + JSON.stringify(selectorOrId) + ')';
      const steps = stepsFor(ms);
      await motion(t => {
        const upto = Math.max(1, Math.round(text.length * t));
        return getEl + '.value=' + JSON.stringify(text.slice(0, upto));
      }, steps, ms);
    };

    // Takes a JS EXPRESSION, exactly like frame()/spot() — evaluated as
    // `(<expr>).click()`. Pass 'document.querySelector(".foo")', a saved
    // reference like 'window.__cell', or any expression that yields an
    // element. This is deliberate: real storyboards routinely need
    // '__qa(".card").filter(c => c.textContent.includes("X"))[0]' or a
    // value stashed by an earlier step, and a plain-selector-only click()
    // could not express either.
    const click = async (selectorExpr, o) => {
      if (selectorExpr && typeof selectorExpr === 'object') {
        await needLive('click').clickOn(selectorExpr, o);
        return afterAction();
      }
      await run('(function(){var el=(' + selectorExpr + ');if(el)el.click();}())');
    };

    // A subject that resolves to nothing used to be silent: frame() held the
    // camera still and spot() dimmed an empty screen. Say so every time, and
    // throw under opts.strictSubjects (recommended for live-app recordings,
    // where a changed class name must stop the take, not ruin it quietly).
    const missingSubject = (verb, selectorExpr) => {
      const msg = verb + '() subject resolved to nothing: ' + String(selectorExpr).slice(0, 120);
      if (opts.strictSubjects) throw new Error(msg);
      console.warn('  ! ' + msg);
    };

    const frame = async (selectorExpr, mode, ms) => {
      const r = await run('__plan(' + selectorExpr + ',' + JSON.stringify(mode || 'focus') + ')');
      const kind = r && r.result ? r.result.value : 'none';
      if (kind === 'none') missingSubject('frame', selectorExpr);
      await motion(t => '__lerp(' + t.toFixed(4) + ')', stepsFor(ms), ms);
      if (process.env.DEMO_TRACE) {
        console.log('      camera: ' + kind + '  ' + String(selectorExpr).slice(0, 46));
      }
      return kind;
    };

    const spot = async (selectorExpr, ms) => {
      if (selectorExpr && typeof selectorExpr === 'object') {
        await needLive('spot').spotOn(selectorExpr, ms);
        return afterAction();
      }
      // `, void 0` keeps CDP from serializing the element (React/LWC object
      // graphs overflow its serializer); the follow-up read is a boolean.
      await run('window.__spotSel=' + selectorExpr + ', void 0;');
      const has = await run('!!window.__spotSel');
      if (!(has && has.result && has.result.value)) missingSubject('spot', selectorExpr);
      await motion(t => '__spot(window.__spotSel,' + t.toFixed(3) + ')',
        stepsFor(ms || 360), ms || 360);
    };
    // Moves a live spotlight to a new subject without fading it: the ring
    // glides (eased) and the dim stays on. Use between related subjects;
    // spot()/spotOut() remain the entrance and exit.
    const spotMove = async (selectorExpr, ms) => {
      if (selectorExpr && typeof selectorExpr === 'object') {
        await needLive('spotMove').spotMoveTo(selectorExpr, ms);
        return afterAction();
      }
      await run('window.__glideTarget=' + selectorExpr + ', void 0;');
      const has = await run('!!window.__glideTarget');
      if (!(has && has.result && has.result.value)) missingSubject('spotMove', selectorExpr);
      await motion(t => '__spotGlide(window.__glideTarget,' + t.toFixed(3) + ')',
        stepsFor(ms || 420), ms || 420);
    };
    const spotOut = async (ms) => {
      await motion(t => '__spot(null,' + (1 - t).toFixed(3) + ')',
        stepsFor(ms || 280), ms || 280);
      await run('__spotOff()');
    };

    const crawlThrough = async (ms) => {
      await run('__crawlStart()');
      await hold(500);
      await motion(t => '__crawlTo(' + t.toFixed(4) + ')', stepsFor(ms), ms);
      await hold(500);
    };

    // observe(opts) — for a page that changes ON ITS OWN (a live view fed by
    // polling, a CSS-driven progress bar, anything not moved by `run()`).
    // Every other primitive here FORCES the next state and shoots one frame
    // of it; observe instead shoots a steady stream of frames of whatever the
    // page is already doing, each held for the slice of real time that
    // elapsed before the next capture (divided by `speed`, so `speed: 2` is a
    // 2x fast-forward of the real thing). It counts as motion, never as a
    // stall (stillMs reset once, like motion()).
    //   opts.ms          - stop once this much FILM time has elapsed.
    //   opts.untilVo     - stop when the current narration line ends. With
    //                      speed > 1 more real/stage time is condensed into
    //                      that same spoken duration.
    //   opts.untilSelector (+ opts.textContains) - stop once that selector
    //                      exists (and, if given, its text contains the
    //                      substring).
    //   opts.maxMs       - hard ceiling in REAL time regardless of the above
    //                      (default 30000); a runaway wait can never hang.
    //   opts.speed       - real-seconds-per-film-second (default 1).
    // Whichever of ms/untilVo/untilSelector is given, maxMs always applies.
    // The real sampling interval is `observeFrameIntervalMs(speed)` (see its
    // own doc above) — widened at high speed so `shoot()`'s per-frame floor
    // never silently caps the achieved speed below what was asked for.
    const observe = async (opts) => {
      opts = opts || {};
      const speed = (opts.speed && opts.speed > 0) ? opts.speed : 1;
      const maxMs = opts.maxMs === undefined ? 30000 : opts.maxMs;
      const targetFrameMs = observeFrameIntervalMs(speed);
      stillMs = 0;
      const startFilmAt = elapsedMs;
      const startReal = Date.now();
      let lastCapture = null;

      // untilExpr: any JS expression that turns truthy when the wait is over
      // — the escape hatch for state document.querySelector cannot see (a
      // component's shadow DOM: '(__q("c-app >>> .count")||{}).textContent==="2"').
      const selectorExpr = opts.untilExpr ? '!!(' + opts.untilExpr + ')' : opts.untilSelector && (
        '(function(){var el=document.querySelector(' + JSON.stringify(opts.untilSelector) + ');' +
        'if(!el)return false;' +
        (opts.textContains ? 'return (el.textContent||"").indexOf(' + JSON.stringify(opts.textContains) + ')!==-1;' : 'return true;') +
        '}())'
      );

      const isDone = async () => {
        const realElapsed = Date.now() - startReal;
        if (realElapsed >= maxMs) return true;
        const filmElapsed = realElapsed / speed;
        if (opts.ms !== undefined && filmElapsed >= opts.ms) return true;
        if (opts.untilVo && voEndsAt && startFilmAt + filmElapsed >= voEndsAt) return true;
        if (selectorExpr) {
          const r = await run(selectorExpr);
          if (r && r.result && r.result.value) return true;
        }
        return false;
      };

      let iter = 0;
      for (;;) {
        const now = Date.now();
        const frameMs = lastCapture === null ? targetFrameMs : (now - lastCapture);
        await shoot(Math.max(1, frameMs) / speed);
        lastCapture = now;
        const done = await isDone();
        if (process.env.DEMO_TRACE && (iter++ % 10 === 0 || done)) {
          console.log('    observe iter ' + iter + '  realElapsed=' + (Date.now() - startReal) + 'ms  maxMs=' + maxMs + '  speed=' + speed + '  done=' + done);
        }
        if (done) break;
        const sinceCapture = Date.now() - now;
        if (sinceCapture < targetFrameMs) await sleep(targetFrameMs - sinceCapture);
      }
    };

    // waitFor(expr, {maxMs, everyMs, label}) — REAL-time poll, zero film
    // time, for state a storyboard must reach before it shoots: an
    // authenticated redirect chain, a component rendering, a server-produced
    // count. Unlike a page-side Promise passed to run(), it survives the page
    // navigating underneath it: a destroyed execution context ("Inspected
    // target navigated or closed", "Execution context was destroyed") is
    // retried, not thrown. Found on the Salesforce demo, where a poll issued
    // during the frontdoor.jsp login redirect killed the take at 0.0s.
    const waitFor = async (expr, o) => {
      o = o || {};
      if (expr && typeof expr === 'object') {
        const t0 = Date.now();
        await needLive('waitFor').waitForSubject(expr, o);
        await afterAction();
        return Date.now() - t0;
      }
      const maxMs = o.maxMs === undefined ? 20000 : o.maxMs;
      const everyMs = o.everyMs || 150;
      const started = Date.now();
      let lastErr = null;
      for (;;) {
        try {
          // Apply the per-frame hook first (e.g. redaction), so the predicate
          // sees the page exactly as the film would. Found on the Salesforce
          // demo: a wait keyed on a redacted label never matched, because the
          // component's re-render restored the real text between frames.
          if (opts.everyFrameJs) await client.send('Runtime.evaluate', { expression: opts.everyFrameJs, returnByValue: true });
          const r = await client.send('Runtime.evaluate',
            { expression: '(function(){try{return !!(' + expr + ');}catch(e){return false;}})()', returnByValue: true });
          if (r && r.result && r.result.value === true) return Date.now() - started;
        } catch (err) { lastErr = err; }
        if (Date.now() - started > maxMs) {
          throw new Error((o.label || 'waitFor') + ' timed out after ' + maxMs + 'ms' +
            (lastErr ? ' (last error: ' + lastErr.message + ')' : ''));
        }
        await sleep(everyMs);
      }
    };

    // ---- live-app beats: wording checks and never-show audits -------------
    const needLive = (verb) => {
      if (!live) throw new Error(verb + '() with a subject object needs runDemo({frames: true})');
      return live;
    };
    if (frameReg) {
      live = createLive({
        client: client, frames: frameReg, run: run, motion: motion, stepsFor: stepsFor,
        frame: async (ms) => { stillMs = 0; await shoot(ms); },
        opts: opts, dry: !!opts.dryRun, width: W, height: H,
      });
    }
    const RANK = { visible: 3, covered: 2, hidden: 1, missing: 0 };
    let beat = null;

    // Marks every pending label of the current beat that is on screen NOW.
    // Runs at the beat's start and after every live action, so a label that
    // shows only mid-beat (a search result before it is clicked) counts.
    const checkLabels = async () => {
      if (!beat || !live) return;
      const pending = beat.labels.filter((l) => !beat.seen.has(l));
      if (!pending.length) return;
      await prepareFrames();
      const res = await live.labelCheck(pending);
      res.forEach((r) => {
        if (r.status === 'visible') beat.seen.add(r.label);
        else if (!beat.best[r.label] || RANK[r.status] > RANK[beat.best[r.label]]) beat.best[r.label] = r.status;
      });
      if (DRY && res.some((r) => r.status !== 'visible')) {
        (await live.visibleTexts()).forEach((t) => { if (beat.texts.size < 3000) beat.texts.add(t); });
      }
    };
    const afterAction = async () => { await checkLabels(); };

    const closeBeat = async () => {
      if (!beat) return;
      await checkLabels();
      const b = beat;
      beat = null;
      const missing = b.labels.filter((l) => !b.seen.has(l));
      const texts = Array.from(b.texts);
      const out = { key: b.key, say: b.say, atMs: b.atMs, labels: b.labels.slice(),
        misses: missing.map((l) => ({ label: l, status: b.best[l] || 'missing', near: closest(l, texts) })) };
      beats.push(out);
      if (!DRY && missing.length) throw new Error(formatReport([out], b.labels.length));
    };

    // The never-show audit (counts only): redact, then count emails, URLs,
    // org and record ids, and sensitive-page labels in visible text across
    // every frame. Nonzero stops a take; the preflight reports it.
    const audit = async (where) => {
      if (!frameReg) throw new Error('audit() needs runDemo({frames: true})');
      let counts = null;
      for (let attempt = 0; ; attempt++) {
        try { await prepareFrames(); counts = await frameReg.neverShowAll(); break; } catch (err) {
          if (attempt >= 10 || !isGoneError(err)) throw err;
          await sleep(150);
        }
      }
      const bad = Object.keys(counts).filter((k) => counts[k] > 0);
      audits.push({ where: where, atMs: Math.round(elapsedMs), ok: !bad.length, counts: counts });
      if (bad.length) {
        const msg = 'Never-show audit failed at ' + where + ': ' + bad.map((k) => k + '=' + counts[k]).join(', ');
        if (!DRY) throw new Error(msg + '. Take aborted.');
        console.warn('  ! ' + msg);
      }
      return counts;
    };

    // One script sentence = one beat. Closes the previous beat (every label
    // it quoted must have been on screen), audits the screen, then speaks the
    // line. Labels default to the line's quoted text.
    const beatFn = async (key, o) => {
      o = o || {};
      await closeBeat();
      if (frameReg && o.audit !== false) await audit(key);
      beat = { key: key, say: o.say || '', labels: o.labels || quotedLabels(o.say), seen: new Set(),
        best: {}, texts: new Set(), atMs: Math.round(elapsedMs) };
      await checkLabels();
      if (o.say !== undefined) await say(o.caption !== undefined ? o.caption : spokenText(o.say), o.holdMs || 1, key);
    };

    // CAPTURE: one audited, lossless 2x still of the page below the band,
    // with its named subjects' boxes in the still's own CSS px.
    const captureStill = async (key, o) => {
      if (!CAPTURE) throw new Error('still() needs runDemo({capture})');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || stills.some((x) => x.key === key)) throw new Error('still(): bad or repeated key ' + JSON.stringify(key));
      o = o || {};
      await retryGone(ensureTop);
      await run('(window.__spotOff&&__spotOff(),window.__cursorHide&&__cursorHide(),true)');
      // No focus ring in a still: the app's own focus outline reads as our
      // highlight (a blue box on M1's chart card). Focus is not data.
      await run('(function(){var a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;' +
        'if(a&&a!==document.body&&a.blur)a.blur();return true})()');
      const top = o.clipTop !== undefined ? o.clipTop
        : ((await run('(function(){var b=document.getElementById("__demoBand");return b&&b.style.display!=="none"?Math.round(b.getBoundingClientRect().bottom):0})()')).result.value || 0);
      const subjects = {};
      for (const name of Object.keys(o.subjects || {})) {
        const s = o.subjects[name];
        const hit = await needLive('still').resolve(s);
        if (!hit) throw new Error('still ' + key + ': subject "' + name + '" is not on screen');
        subjects[name] = stillRect(hit.rect, s && s.pad, top, W, H);
      }
      const counts = await audit('still:' + key);
      if (Object.keys(counts).some((k) => counts[k] > 0)) {
        throw new Error('Never-show audit failed at still ' + key + ': ' + Object.keys(counts).filter((k) => counts[k] > 0).map((k) => k + '=' + counts[k]).join(', '));
      }
      // The still is what the viewer sees during its beat: its labels count.
      await checkLabels();
      // Redaction again right before the pixels are taken, as every film frame does.
      await prepareFrames();
      if (opts.everyFrameJs) await run(opts.everyFrameJs);
      // The clip is in DOCUMENT px: offset it by the scroll, or a scrolled
      // page films the blank region above the viewport (M1's first capture).
      const lm = await client.send('Page.getLayoutMetrics');
      const vv = lm.cssVisualViewport || lm.visualViewport || {};
      const r = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: vv.pageX || 0, y: (vv.pageY || 0) + top, width: W, height: H - top, scale: 1 } });
      const file = path.join('stills', key + '.png');
      fs.mkdirSync(path.join(CAPTURE.dir, 'stills'), { recursive: true });
      fs.writeFileSync(path.join(CAPTURE.dir, file), Buffer.from(r.data, 'base64'));
      stills.push({ key: key, file: file, width: W, height: H - top, scale: SCALE, subjects: subjects });
      console.log('     still ' + key + ': ' + Object.keys(subjects).length + ' subject(s), audit zero');
    };

    const rec = {
      go, say, atVo, type, click, frame, spot, spotMove, spotOut, crawlThrough, observe, waitFor,
      hold, settle, motion, stepsFor,
      // In live mode a storyboard's own run() may come before the first
      // filmed frame (e.g. __band right after sign-in): install the top
      // frame's kit first, as every shot does.
      run: async (expr) => { if (frameReg) await retryGone(ensureTop); return run(expr); },
      resetCamera: () => run('__cam={y:0,s:1};__apply();'),
      caption: (text) => run('__caption(' + JSON.stringify(text) + ')'),
      flash: (selector, v) => run('__flash(' + JSON.stringify(selector) + ',' + v + ')'),
      slide: (spec, alpha) => run('__slide(' + JSON.stringify(spec) + ',' + alpha + ')'),
      slideRow: (i, alpha) => run('__slideRow(' + i + ',' + alpha + ')'),
      slideGone: () => run('__slideGone()'),
      cta: (lines, alpha) => run('__cta(' + JSON.stringify(lines) + ',' + alpha + ')'),
      voManifest: VO,
      dryRun: !!opts.dryRun,
      capturing: !!CAPTURE,
      still: captureStill,
      beat: beatFn,
      endBeat: closeBeat,
      audit: audit,
      /** Real-time label check across all frames: [{label, status, frame}]. */
      labels: (list) => needLive('labels').labelCheck(list),
      /** Resolves a subject: {rect, cx, cy} in top-frame px, or null. */
      find: (subject) => needLive('find').resolve(subject),
      cursorTo: async (subject, ms) => { await needLive('cursorTo').cursorTo(subject, ms); return afterAction(); },
      press: async (key) => { await needLive('press').press(key); return afterAction(); },
      /** Real mouse-wheel scrolling of o.within until target is visible (filmed). */
      scrollTo: async (target, o) => { await needLive('scrollTo').scrollTo(target, o); return afterAction(); },
      /** Display-only redaction in EVERY frame, re-applied before each shot. */
      redact: (pairs, o) => { if (!frameReg) throw new Error('redact() needs runDemo({frames: true})'); frameReg.setRedaction(pairs, o); return frameReg.redactAll(); },
      /** Evaluates an expression in every frame: [{top: bool, value}]. */
      inFrames: async (expr) => (await frameReg.evalAll(() => expr)).map((r) => ({ top: frameReg.isTop(r.ctx), value: r.value })),
      /** Wait for the CURRENT line's audio to finish before continuing. */
      waitForVo: async () => { if (voEndsAt > elapsedMs) await hold(voEndsAt - elapsedMs); },
      elapsedMs: () => elapsedMs,
    };

    await buildFn(rec);
    await closeBeat();
  } finally {
    if (client) client.close();
    try { chrome.kill(); } catch (err) { /* already gone */ }
  }

  if (DRY) {
    fs.rmSync(FRAME_DIR, { recursive: true, force: true });
    fs.rmSync(STAGE_TMP, { recursive: true, force: true });
    const total = beats.reduce((n, b) => n + b.labels.length, 0);
    const report = formatReport(beats, total);
    const failedAudits = audits.filter((a) => !a.ok);
    if (beats.some((b) => b.misses.length) || failedAudits.length) {
      const err = new Error(report + (failedAudits.length ? '\n\nNever-show audit: ' + failedAudits.map((a) => a.where + ' ' +
        Object.keys(a.counts).filter((k) => a.counts[k] > 0).map((k) => k + '=' + a.counts[k]).join(', ')).join('; ') : ''));
      err.preflight = { beats: beats, audits: audits };
      throw err;
    }
    if (CAPTURE) return finishCapture(CAPTURE, { W: W, H: H, scale: SCALE, stills: stills, report: report, beats: beats, audits: audits });
    return { dryRun: true, report: report, beats: beats, audits: audits };
  }

  if (frames.length < 10) {
    throw new Error('only ' + frames.length + ' frames captured — the recording did not run');
  }

  if (stalls.length) {
    const worst = [];
    stalls.forEach(x => {
      const last = worst[worst.length - 1];
      if (last && x.atMs - last.atMs < last.ms + 500) { worst[worst.length - 1] = x; }
      else worst.push(x);
    });
    const lines = worst.map(x => '    ' + (x.atMs / 1000).toFixed(1) + 's  \u2014 ' +
      (x.ms / 1000).toFixed(1) + 's still').join('\n');
    throw new Error('the picture sits still AND silent for longer than ' +
      (stallCeilingMs / 1000) + 's:\n' + lines);
  }

  const list = [];
  concatDurations(frames.map(f => f.dur)).forEach((d, i) => {
    list.push("file '" + frames[i].file + "'"); list.push('duration ' + d);
  });
  list.push("file '" + frames[frames.length - 1].file + "'");
  const listFile = path.join(STAGE_TMP, 'frames.txt');
  fs.writeFileSync(listFile, list.join('\n'));

  const silent = AUDIO.length ? OUT.replace(/\.mp4$/, '.silent.mp4') : OUT;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=' + FPS + ',' + BT709_FROM_JPEG(W, H),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf || 20),
    '-pix_fmt', 'yuv420p'].concat(BT709_TAGS, ['-movflags', '+faststart', silent]), { stdio: 'inherit' });

  if (AUDIO.length) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent];
    AUDIO.forEach(a => { args.push('-i', a.file); });
    const chains = AUDIO.map((a, i) => {
      const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'format=duration', '-of', 'default=nw=1:nk=1', a.file], { encoding: 'utf8' }).trim());
      return '[' + (i + 1) + ':a]' +
        'afade=t=in:st=0:d=0.025,' +
        'afade=t=out:st=' + Math.max(0, d - 0.025).toFixed(3) + ':d=0.025,' +
        'adelay=' + Math.round(a.atMs) + '|' + Math.round(a.atMs) + '[a' + i + ']';
    });
    const mix = AUDIO.map((a, i) => '[a' + i + ']').join('') +
      'amix=inputs=' + AUDIO.length + ':normalize=0[out]';
    args.push('-filter_complex', chains.join(';') + ';' + mix,
      '-map', '0:v', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', OUT);
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
    fs.unlinkSync(silent);
    // Stereo at -16 LUFS / -1.5 dBTP: the raw mix measured -19.9 LUFS with
    // a -0.1 dBFS peak in mono (M1, 2026-10-26).
    if (opts.master !== false) masterInPlace(OUT, opts.loudness);
  }

  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.rmSync(STAGE_TMP, { recursive: true, force: true });

  const bytes = fs.statSync(OUT).size;
  const durationSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', OUT], { encoding: 'utf8' }).trim());
  return { outPath: OUT, bytes: bytes, durationSec: durationSec, beats: beats, audits: audits };
}

module.exports = { runDemo: runDemo, observeFrameIntervalMs: observeFrameIntervalMs, traceUrlLabel: traceUrlLabel, filmFrameFloorMs: filmFrameFloorMs, concatDurations: concatDurations, findChrome: findChrome, stillRect: stillRect, BT709_TAGS: BT709_TAGS };
