#!/usr/bin/env node
'use strict';
/**
 * runner.js — the pipeline child process. Forked from Electron (job arrives
 * over the IPC channel) or run under bare node for tests/debugging:
 *
 *   node runner/runner.js --job=/path/to/job.json
 *
 * Job shape: {
 *   kind: 'run-auto' | 'run-classic' | 'frame' | 'sample' | 'verify',
 *   projectDir, demoSuitePath, userDataDir, chromePath?,
 *   overrides?: {engine, voice},                    // run-auto / run-classic
 *   engine?, voice?, rate?, tempo?, text?,          // sample
 *   geminiKey?, framingModel?, instructions?,       // frame
 * }
 * Keys (GOOGLE_TTS_KEY / GEMINI_TTS_KEY) arrive via env, where narrate.js
 * already looks first.
 */
const fs = require('fs');
const path = require('path');
const { emit } = require('./protocol.js');
const events = require('../shared/events.js');
const { normalizeDemo, narrationToObject, guardOutDir } = require('../shared/demoSchema.js');
const { buildStoryboard, stallsToShots, parseStallError } = require('./executeShots.js');
const { resolveTarget } = require('./resolveTarget.js');
const { runClassic } = require('./classic.js');
const { synthesizeSample } = require('./sample.js');
const { frameProject } = require('./frame.js');
const { loadGithubShare, buildGithubShareKit } = require('./githubShareKit.js');

function loadDemo(projectDir) {
  const file = path.join(projectDir, 'demo.json');
  if (!fs.existsSync(file)) throw new Error('no demo.json in ' + projectDir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error('demo.json is not valid JSON: ' + err.message);
  }
  const { demo, errors, warnings } = normalizeDemo(raw);
  if (errors.length) throw new Error('demo.json has problems:\n- ' + errors.join('\n- '));
  warnings.forEach(w => emit(events.log('err', 'warning: ' + w)));
  return demo;
}

/** Poll the narration work dir so clip synthesis shows as real progress. */
function watchNarration(voDir, total) {
  const workDir = voDir + '.building';
  let last = -1;
  const timer = setInterval(() => {
    let count = 0;
    try { count = fs.readdirSync(workDir).filter(f => f.endsWith('.wav')).length; } catch (err) { return; }
    if (count !== last) {
      last = count;
      emit(events.progress('narrate', count, total, 'clip ' + count + ' of ' + total));
    }
  }, 400);
  timer.unref();
  return () => clearInterval(timer);
}

async function runAuto(job) {
  const demo = loadDemo(job.projectDir);
  const githubShareConfig = loadGithubShare(job.projectDir, demo);
  const ov = job.overrides || {};
  const engine = ov.engine || demo.voice.engine;
  const voice = ov.voice || demo.voice.voice;
  const outDir = path.join(job.projectDir, 'demo-out');
  const voDir = guardOutDir(path.join(outDir, 'vo'), job.userDataDir);
  const narrate = require(path.join(job.demoSuitePath, 'lib', 'narrate.js'));
  const { runDemo } = require(path.join(job.demoSuitePath, 'lib', 'recorder.js'));
  const { encode } = require(path.join(job.demoSuitePath, 'lib', 'deliverLinkedIn.js'));
  const { buildCameraClientJs } = require(path.join(job.demoSuitePath, 'lib', 'cameraClient.js'));

  // 1. Narration — always first: the picture is timed to the voice.
  const script = narrationToObject(demo.narration);
  const voKeys = Object.keys(script);
  if (!voKeys.length) throw new Error('the narration is empty — write it (or run Gemini framing) first');
  emit(events.phase('narrate', 'start', engine + ' / ' + voice));
  const stopWatch = watchNarration(voDir, voKeys.length);
  const narrOpts = { outDir: voDir, engine, log: true };
  if (voice) narrOpts.voice = voice;
  if (demo.voice.rate) narrOpts.rate = demo.voice.rate;
  if (demo.voice.tempo) narrOpts.tempo = demo.voice.tempo;
  if (demo.voice.googleRate) narrOpts.googleRate = demo.voice.googleRate;
  if (demo.voice.geminiModel) narrOpts.geminiModel = demo.voice.geminiModel;
  if (demo.voice.style) narrOpts.style = demo.voice.style;
  // Gemini TTS pads clips with silence; targetWpm > 0 turns on the engine's
  // trim + pace-normalize + retake loop (no effect on other engines' output).
  if (demo.voice.targetWpm) narrOpts.targetWpm = demo.voice.targetWpm;
  try {
    await narrate.build(script, narrOpts);
  } finally { stopWatch(); }
  emit(events.phase('narrate', 'done'));

  // 2. Gemini TTS is only allowed with the whisper check — non-negotiable
  // (documented clause-repetition bug; see demo-suite AGENTS.md §5).
  if (engine === 'gemini') {
    emit(events.phase('verify', 'start', 'mlx-whisper repeat check'));
    const { verifyManifest } = require(path.join(job.demoSuitePath, 'lib', 'verifyNarration.js'));
    const { bad } = await verifyManifest(path.join(voDir, 'manifest.json'));
    if (bad && bad.length) {
      throw new Error('narration verification flagged ' + bad.length + ' suspect clip(s): ' +
        bad.map(b => b.key).join(', ') + ' — re-run narration or switch to the Google engine');
    }
    emit(events.phase('verify', 'done'));
  }

  // 3. Record.
  emit(events.phase('record', 'start'));
  const target = await resolveTarget(demo, job.projectDir, job.demoSuitePath);
  const timeline = [];
  const storyboard = buildStoryboard(demo, {
    targetUrl: target.url,
    injectCameraJs: target.staged ? null : buildCameraClientJs(demo.camera),
    emit,
    timeline,
  });
  let result;
  try {
    result = await runDemo(storyboard, {
      outDir,
      outFile: 'demo.mp4',
      voManifestPath: path.join(voDir, 'manifest.json'),
      width: demo.record.width,
      height: demo.record.height,
      fps: demo.record.fps,
      stallMs: demo.record.stallMs,
      crf: demo.record.crf,
      chromePath: job.chromePath,
    });
  } catch (err) {
    if (/sits still AND silent/.test(err.message)) {
      const stalls = stallsToShots(parseStallError(err.message), timeline);
      emit(events.error('record', err.message, { stalls }));
      err.reported = true;
    } else if (err.name === 'ShotError') {
      emit(events.error('record', err.message, { shotId: err.shotId, shotIndex: err.index }));
      err.reported = true;
    }
    throw err;
  }
  emit(events.phase('record', 'done', result.durationSec.toFixed(1) + 's'));
  // The shot timeline is what the review pass and stall mapping key off —
  // persist it beside the cut.
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));

  // 4. Delivery encode (limited-range BT.709 — mandatory before sharing).
  emit(events.phase('deliver', 'start'));
  const deliverPath = path.join(outDir, 'demo-linkedin.mp4');
  encode(result.outPath, deliverPath);
  emit(events.phase('deliver', 'done'));

  // 5. Audio QA — measure the cut instead of trusting ears: cold open within
  // 1s, no dead-air stretch, no limp silent ending. Advisory, never fatal.
  const { measure } = require('./audioQa.js');
  let audioQa = null;
  try {
    audioQa = measure(deliverPath, result.durationSec);
    audioQa.issues.forEach(i => emit(events.log('err', 'audio QA: ' + i)));
  } catch (err) {
    emit(events.log('err', 'audio QA skipped: ' + err.message));
  }

  let githubShare = null;
  if (githubShareConfig) {
    githubShare = buildGithubShareKit({
      projectDir: job.projectDir,
      deliverPath,
      config: githubShareConfig,
    });
    emit(events.log('out', 'GitHub share kit ready: ' + githubShare.repositoryPath));
  }

  emit(events.result({
    outPath: result.outPath,
    deliverPath,
    durationSec: result.durationSec,
    bytes: result.bytes,
    audioQa,
    githubShare,
  }));
}

async function runVerify(job) {
  const { verifyManifest } = require(path.join(job.demoSuitePath, 'lib', 'verifyNarration.js'));
  emit(events.phase('verify', 'start'));
  const manifestPath = path.join(job.projectDir, 'demo-out', 'vo', 'manifest.json');
  const { results, bad } = await verifyManifest(manifestPath);
  emit(events.phase('verify', 'done'));
  emit(events.result({ ok: !bad.length, verify: { results, bad } }));
}

async function dispatch(job) {
  if (job.kind === 'run-auto') return runAuto(job);
  if (job.kind === 'run-classic') {
    const githubShareConfig = loadGithubShare(job.projectDir, null);
    const r = await runClassic(job, emit);
    if (githubShareConfig) {
      r.githubShare = buildGithubShareKit({
        projectDir: job.projectDir,
        deliverPath: r.deliverPath,
        config: githubShareConfig,
      });
      emit(events.log('out', 'GitHub share kit ready: ' + r.githubShare.repositoryPath));
    }
    return emit(events.result(r));
  }
  if (job.kind === 'sample') return synthesizeSample(job, emit);
  if (job.kind === 'verify') return runVerify(job);
  if (job.kind === 'frame') {
    job.demo = loadDemo(job.projectDir);
    const r = await frameProject(job, emit);
    emit(events.phase('frame', 'done'));
    return emit(events.framing(Object.assign({ capturePath: r.capturePath }, r.demoPatch), r.lint));
  }
  if (job.kind === 'review') {
    job.demo = loadDemo(job.projectDir);
    const { reviewCut } = require('./review.js');
    const r = await reviewCut(job, emit);
    return emit(events.result({ ok: true, review: r }));
  }
  throw new Error('unknown job kind: ' + job.kind);
}

function getJob() {
  if (process.send) {
    return new Promise(resolve => {
      process.on('message', m => { if (m && m.type === 'job') resolve(m.job); });
      process.send({ type: 'ready' });
    });
  }
  const hit = process.argv.filter(a => a.startsWith('--job='))[0];
  if (!hit) { console.error('usage: node runner.js --job=/path/to/job.json'); process.exit(2); }
  return Promise.resolve(JSON.parse(fs.readFileSync(hit.slice('--job='.length), 'utf8')));
}

getJob().then(job => dispatch(job)).then(() => {
  process.exit(0);
}).catch(err => {
  if (!err.reported) emit(events.error('runner', err.message));
  if (!process.send) console.error(err.stack || err.message);
  process.exit(1);
});
