'use strict';
/**
 * compose.js — the COMPOSE stage: turns a capture (recorder.js capture mode)
 * plus narration into the finished film, offline. NODE-ONLY.
 *
 * ===========================================================================
 * WHY A SECOND STAGE
 * ===========================================================================
 * A live take is also the final film, so every change to copy, captions, an
 * end card or the aspect ratio meant filming the real app again: 6 of the 23
 * Revenue Execution takes (2026-10-27) were re-films for exactly that. Here
 * the app is touched once, by a short capture of audited stills; the camera,
 * cursor, titles, music and every aspect ratio are rendered from them, in
 * minutes, with no org access.
 *
 *   const { renderComposition } = require('./compose.js');
 *   await renderComposition({ captureDir, timeline, voManifestPath, words,
 *     aspect: '16:9', outFile: 'demo-out/m1-16x9.mp4', bed: { file } });
 *
 * Every frame is a pure function of time (composeStage.js), screenshotted
 * losslessly and piped to x264: limited-range BT.709, tagged.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { Cdp, httpJson, waitForPort } = require('./cdp.js');
const { findChrome, BT709_TAGS } = require('./recorder.js');
const { planComposition, overlayTexts } = require('./composePlan.js');
const { buildStageHtml } = require('./composeStage.js');
const { buildSoundtrack } = require('./audioMaster.js');
const { classifyLines } = require('./frameScan.js');

/**
 * Every word the stage draws comes from the timeline, and none of it may be
 * shaped like a never-show item (an email, a URL, an id). Throws, naming the
 * category only.
 */
function assertOverlaySafe(tl, allowEmails) {
  const texts = overlayTexts(tl);
  texts.forEach((s, i) => {
    const kinds = classifyLines([s], allowEmails);
    if (kinds.length) throw new Error('Overlay text #' + (i + 1) + ' looks like ' + kinds.join('+') + '; titles and cards may not carry it.');
  });
  return texts.length;
}

/** Where speech starts and ends in a clip (seconds), from silencedetect. */
function speechBounds(file, seconds) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = String(r.stderr || '');
  const starts = [...out.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, +m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  let s = 0, e = seconds;
  if (starts.length && starts[0] < 0.02 && ends.length) s = ends[0];
  const lastStart = starts[starts.length - 1];
  if (lastStart !== undefined && lastStart > s && (ends.length < starts.length || ends[ends.length - 1] >= seconds - 0.02)) e = lastStart;
  return [Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000];
}

/** Narration clips with measured speech bounds: {KEY: {file, seconds, speech}}. */
function loadAudio(voManifestPath) {
  const m = JSON.parse(fs.readFileSync(voManifestPath, 'utf8'));
  const dir = path.dirname(voManifestPath);
  const out = {};
  Object.keys(m.clips).forEach((k) => {
    const c = m.clips[k];
    // The manifest may come from another checkout: the clip sits beside it.
    const file = fs.existsSync(c.file) ? c.file : path.join(dir, path.basename(c.file));
    out[k] = { file: file, seconds: c.seconds, speech: speechBounds(file, c.seconds) };
  });
  return out;
}

async function launch(W, H, chromePath) {
  const chrome = spawn(findChrome(chromePath), ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=' + W + ',' + H, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('Chrome did not report a debug port in time')), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
  });
  await waitForPort(port, 20000);
  const page = (await httpJson(port, '/json/list')).filter((t) => t.type === 'page')[0];
  const client = await Cdp.connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return { chrome, client };
}

const evaluate = async (client, expression) => {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('stage: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
};

/**
 * Renders one aspect. o: {captureDir, timeline, voManifestPath, words,
 * aspect, outFile, bed?, target?, allowEmails?, chromePath?, frames?}.
 * Returns {outPath, durationSec, plan, frames}.
 */
async function renderComposition(o) {
  const tl = o.timeline;
  assertOverlaySafe(tl, o.allowEmails);
  const cap = JSON.parse(fs.readFileSync(path.join(o.captureDir, 'capture.json'), 'utf8'));
  if ((cap.audits || []).some((a) => !a.ok) || (cap.scan && cap.scan.hits)) throw new Error('The capture did not pass its audits; re-capture.');
  const audio = loadAudio(o.voManifestPath);
  const P = planComposition(tl, cap, audio, o.words, o.aspect);
  const stills = Object.fromEntries(Object.keys(cap.stills).map((k) => [k, path.join(o.captureDir, cap.stills[k].file)]));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-compose-'));
  const stage = path.join(tmp, 'stage.html');
  fs.writeFileSync(stage, buildStageHtml(P, stills, tl.brand));
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  const silent = path.join(tmp, 'picture.mp4');
  const fps = P.fps;
  const total = o.frames || Math.ceil(P.duration / 1000 * fps);

  const { chrome, client } = await launch(P.W, P.H, o.chromePath);
  try {
    await client.send('Page.navigate', { url: 'file://' + stage });
    for (let i = 0; i < 100 && !(await evaluate(client, 'typeof window.__ready')).startsWith('object'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await evaluate(client, 'window.__ready'))) throw new Error('stage: the title font did not load');
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(o.crf || 16)].concat(BT709_TAGS, ['-movflags', '+faststart', silent]),
    { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg exited ' + c)))));
    for (let i = 0; i < total; i++) {
      await evaluate(client, '__render(' + (i * 1000 / fps).toFixed(3) + ')');
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
      if (o.onFrame) o.onFrame(i, total);
    }
    ff.stdin.end();
    await done;
  } finally {
    client.close();
    try { chrome.kill(); } catch (err) { /* gone */ }
  }

  const wav = buildSoundtrack(P.audio, total / fps, path.join(tmp, 'sound.wav'), { bed: o.bed, target: o.target });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', wav,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', o.outFile], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { outPath: o.outFile, durationSec: total / fps, plan: P, frames: total };
}

module.exports = { renderComposition, assertOverlaySafe, speechBounds, loadAudio };
