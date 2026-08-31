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
 * @returns {Promise<{outPath: string, bytes: number, durationSec: number}>}
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
  const frames = [];
  let stillMs = 0;
  const stalls = [];

  try {
    await waitForPort(port, 20000);
    const targets = await httpJson(port, '/json/list');
    const page = targets.filter(t => t.type === 'page')[0];
    if (!page) throw new Error('no page target');

    client = await Cdp.connect(page.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    // FORCE THE VIEWPORT. --window-size is the WINDOW; headless still keeps
    // some of it back for chrome (browser chrome, not the Chrome binary),
    // producing letterboxed frames unless the device metrics are overridden
    // to exactly W x H.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });

    let n = 0;
    let elapsedMs = 0;
    let voEndsAt = 0;
    let voStartAt = 0;
    let voClipMs = 0;

    const shoot = async (durationMs) => {
      const r = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      const file = path.join(FRAME_DIR, String(n++).padStart(6, '0') + '.jpg');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const dur = Math.max(0.02, (durationMs || 1000 / FPS) / 1000);
      frames.push({ file: file, dur: dur });
      elapsedMs += dur * 1000;
    };

    const still = (ms) => {
      if (elapsedMs < voEndsAt) { stillMs = 0; return; }
      stillMs += ms;
      if (stillMs > stallCeilingMs) stalls.push({ atMs: elapsedMs, ms: stillMs });
    };

    const run = async (expr) => {
      const r = await client.send('Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true });
      if (r && r.exceptionDetails) {
        throw new Error(String(expr).slice(0, 70) + ' -> ' + JSON.stringify(r.exceptionDetails.text));
      }
      return r;
    };

    const hold = (ms) => { still(ms || 1000 / FPS); return shoot(ms); };
    const settle = async (ms) => { await sleep(ms); await hold(ms); };

    const motion = async (fnOfT, steps, totalMs) => {
      stillMs = 0;
      for (let i = 1; i <= steps; i++) {
        await run(fnOfT(i / steps));
        await shoot(totalMs / steps);
      }
    };
    const stepsFor = (ms) => Math.max(4, Math.round((ms / 1000) * FPS));

    const go = async (url) => {
      if (process.env.DEMO_TRACE) {
        console.log('  == ' + (elapsedMs / 1000).toFixed(1) + 's  PAGE: ' + String(url).split('/').pop());
      }
      await client.send('Page.navigate', { url: url });
      await sleep(1100);
    };

    const say = async (text, holdMs, voKey) => {
      if (voEndsAt > elapsedMs) await hold(voEndsAt - elapsedMs);
      await run('__caption(' + JSON.stringify(text) + ')');
      if (process.env.DEMO_TRACE) {
        console.log('    ' + (elapsedMs / 1000).toFixed(1) + 's  ' +
          (voKey || text).slice(0, 40) + '  "' + String(text).slice(0, 32) + '"');
      }
      const clip = VO && VO.clips[voKey || text];
      voStartAt = elapsedMs;
      voClipMs = clip ? clip.seconds * 1000 : 0;
      if (clip) {
        AUDIO.push({ file: clip.file, atMs: elapsedMs });
        voEndsAt = elapsedMs + clip.seconds * 1000 + 350;
      }
      await hold(holdMs || 900);
    };

    const atVo = async (frac) => {
      const target = voStartAt + voClipMs * frac;
      if (target > elapsedMs) await hold(target - elapsedMs);
    };

    const type = async (selectorOrId, text, ms) => {
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
    const click = async (selectorExpr) => {
      await run('(function(){var el=(' + selectorExpr + ');if(el)el.click();}())');
    };

    const frame = async (selectorExpr, mode, ms) => {
      const r = await run('__plan(' + selectorExpr + ',' + JSON.stringify(mode || 'focus') + ')');
      const kind = r && r.result ? r.result.value : 'none';
      await motion(t => '__lerp(' + t.toFixed(4) + ')', stepsFor(ms), ms);
      if (process.env.DEMO_TRACE) {
        console.log('      camera: ' + kind + '  ' + String(selectorExpr).slice(0, 46));
      }
      return kind;
    };

    const spot = async (selectorExpr, ms) => {
      await run('window.__spotSel=' + selectorExpr + ';');
      await motion(t => '__spot(window.__spotSel,' + t.toFixed(3) + ')',
        stepsFor(ms || 360), ms || 360);
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

    const rec = {
      go, say, atVo, type, click, frame, spot, spotOut, crawlThrough,
      hold, settle, motion, stepsFor, run,
      resetCamera: () => run('__cam={y:0,s:1};__apply();'),
      caption: (text) => run('__caption(' + JSON.stringify(text) + ')'),
      flash: (selector, v) => run('__flash(' + JSON.stringify(selector) + ',' + v + ')'),
      slide: (spec, alpha) => run('__slide(' + JSON.stringify(spec) + ',' + alpha + ')'),
      slideRow: (i, alpha) => run('__slideRow(' + i + ',' + alpha + ')'),
      slideGone: () => run('__slideGone()'),
      cta: (lines, alpha) => run('__cta(' + JSON.stringify(lines) + ',' + alpha + ')'),
      voManifest: VO,
      /** Wait for the CURRENT line's audio to finish before continuing. */
      waitForVo: async () => { if (voEndsAt > elapsedMs) await hold(voEndsAt - elapsedMs); },
      elapsedMs: () => elapsedMs,
    };

    await buildFn(rec);
  } finally {
    if (client) client.close();
    try { chrome.kill(); } catch (err) { /* already gone */ }
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
  frames.forEach(f => { list.push("file '" + f.file + "'"); list.push('duration ' + f.dur.toFixed(3)); });
  list.push("file '" + frames[frames.length - 1].file + "'");
  const listFile = path.join(STAGE_TMP, 'frames.txt');
  fs.writeFileSync(listFile, list.join('\n'));

  const silent = AUDIO.length ? OUT.replace(/\.mp4$/, '.silent.mp4') : OUT;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=' + FPS + ',scale=' + W + ':' + H,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf || 20),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: 'inherit' });

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
  }

  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.rmSync(STAGE_TMP, { recursive: true, force: true });

  const bytes = fs.statSync(OUT).size;
  const durationSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', OUT], { encoding: 'utf8' }).trim());
  return { outPath: OUT, bytes: bytes, durationSec: durationSec };
}

module.exports = { runDemo: runDemo };
