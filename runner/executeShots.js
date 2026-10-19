'use strict';
/**
 * executeShots.js — the generic storyboard: turns a demo.json shot list into
 * the async (rec) => {} function recorder.js's runDemo expects. This is what
 * lets a demo be authored as data (by the editor UI or by Gemini framing)
 * instead of hand-written JS.
 */
const { compileSubject, describeSubject } = require('./subject.js');
const { waitForReady } = require('./readiness.js');

const CTA_CSS = [
  'font:700 64px/1.1 ui-sans-serif,system-ui,sans-serif;color:#F2F7FC',
  'font:400 30px/1.3 ui-sans-serif,system-ui,sans-serif;color:#5EC8D8;margin-top:14px',
];

class ShotError extends Error {
  constructor(shot, index, cause) {
    super('shot ' + shot.id + ' (' + shot.action +
      (shot.subject ? ' ' + describeSubject(shot.subject) : '') + '): ' + cause.message);
    this.name = 'ShotError';
    this.shotId = shot.id;
    this.index = index;
    this.action = shot.action;
    this.causeMessage = cause.message;
  }
}

function ctaLines(lines) {
  return (lines || []).map((l, i) => ({
    text: typeof l === 'string' ? l : l.text,
    css: (l && l.css) || CTA_CSS[Math.min(i, CTA_CSS.length - 1)],
  }));
}

/**
 * @param {object} demo - a normalized demo (demoSchema.normalizeDemo).
 * @param {object} opts
 * @param {string} opts.targetUrl - where rec.go() points.
 * @param {string|null} opts.injectCameraJs - camera-client JS to inject after
 *   navigation. Required for live URLs (staged pages already carry it via
 *   stage.js); pass null for staged targets.
 * @param {(ev: object) => void} [opts.emit] - progress event sink.
 * @param {Array} [opts.timeline] - filled with {id, index, startMs} per shot,
 *   for mapping the recorder's post-hoc stall report back onto shots.
 */
function buildStoryboard(demo, opts) {
  const emit = opts.emit || (() => {});
  const timeline = opts.timeline || [];
  const shots = demo.shots.filter(s => !s.disabled);

  return async function storyboard(rec) {
    await rec.go(opts.targetUrl);
    await waitForReady(rec, { readySelector: demo.target && demo.target.readySelector });
    if (opts.injectCameraJs) await rec.run(opts.injectCameraJs);
    // Headless Chrome's default canvas is DARK, so when the camera scales a
    // light page down (the caption bar guarantees it never fills the frame),
    // the letterbox clashes. Paint the canvas with the page's own body
    // background so the composition reads as one surface. Learned making the
    // app-tour demo; harmless on dark pages.
    await rec.run('(function(){var b=getComputedStyle(document.body).backgroundColor;' +
      'if(b&&b!=="rgba(0, 0, 0, 0)"&&b!=="transparent")document.documentElement.style.background=b;}()); void 0');

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      timeline.push({ id: shot.id, index: i, startMs: rec.elapsedMs() });
      emit({ type: 'shot', index: i, id: shot.id, action: shot.action, atMs: Math.round(rec.elapsedMs()) });
      emit({ type: 'progress', phase: 'record', current: i + 1, total: shots.length,
        label: shot.id + ': ' + shot.action + (shot.subject ? ' ' + describeSubject(shot.subject) : '') });
      try {
        await runShot_(rec, shot);
      } catch (err) {
        throw new ShotError(shot, i, err);
      }
    }
  };
}

async function runShot_(rec, shot) {
  switch (shot.action) {
    case 'say':
      return rec.say(shot.caption, shot.holdMs || 300, shot.voKey);
    case 'frame': {
      const mode = shot.mode || 'focus';
      const kind = await rec.frame(compileSubject(shot.subject), mode, shot.ms || 600);
      // Auto-crawl is for reading a tall FOCUSED subject. A "wide" shot is an
      // overview — a page barely taller than the caption-reserved area would
      // otherwise trigger a silent 2.8s crawl (this once pushed the first
      // voice line 5s into a demo). Wide crawls only when asked explicitly.
      const wantsCrawl = shot.crawlIfTall === true ||
        (shot.crawlIfTall !== false && mode !== 'wide');
      if (kind === 'crawl' && wantsCrawl) {
        await rec.crawlThrough(shot.crawlMs || 1800);
      }
      return kind;
    }
    case 'spot':
      // rec.spot evaluates `window.__spotSel=<expr>;` with returnByValue, so
      // the assignment's completion value gets serialized. On React pages the
      // element drags its whole fiber graph along and CDP fails with "Object
      // reference chain is too long" — the comma-void keeps the assignment
      // while making the completion value undefined. Plain pages are
      // unaffected.
      return rec.spot('(' + compileSubject(shot.subject) + '), void 0', shot.ms || 360);
    case 'spotOut':
      return rec.spotOut(shot.ms || 280);
    case 'crawl':
      return rec.crawlThrough(shot.ms || 1800);
    case 'click': {
      await rec.click(compileSubject(shot.subject));
      if (shot.settleMs !== 0) await rec.settle(shot.settleMs || 500);
      return;
    }
    case 'type':
      return rec.type(shot.selector, shot.text, shot.ms || 800);
    case 'observe':
      return rec.observe({
        ms: shot.ms, untilVo: shot.untilVo, untilSelector: shot.untilSelector,
        textContains: shot.textContains, maxMs: shot.maxMs, speed: shot.speed,
      });
    case 'waitForVo':
      return rec.waitForVo();
    case 'atVo':
      return rec.atVo(shot.frac);
    case 'hold':
      return rec.hold(shot.ms);
    case 'settle':
      return rec.settle(shot.ms);
    case 'caption':
      return rec.caption(shot.text);
    case 'resetCamera':
      return rec.resetCamera();
    case 'run':
      return rec.run(shot.js);
    case 'cta': {
      // The example storyboard's closing pattern, reproduced: drop the
      // caption bar, mount the card invisible, start the closing line, fade
      // the card in, and hold through the end of the audio.
      const lines = ctaLines(shot.lines);
      await rec.run('var c=document.getElementById("__demoCap"); if(c) c.remove();' +
        'document.documentElement.style.paddingTop="0px";');
      await rec.cta(lines, 0);
      if (shot.voKey) await rec.say(shot.caption || ' ', 200, shot.voKey);
      const fadeMs = shot.fadeMs || 500;
      await rec.motion(t => '__cta(' + JSON.stringify(lines) + ',' + t.toFixed(3) + ')',
        rec.stepsFor(fadeMs), fadeMs);
      await rec.waitForVo();
      await rec.hold(1200);
      return;
    }
    default:
      throw new Error('unknown action "' + shot.action + '"');
  }
}

/**
 * Map the recorder's stall report ("sits still AND silent at Xs") back onto
 * shot ids using the timeline captured during the run.
 */
function stallsToShots(stalls, timeline) {
  return (stalls || []).map(s => {
    let near = null;
    timeline.forEach(t => { if (t.startMs <= s.atMs) near = t; });
    return { atMs: s.atMs, ms: s.ms, nearShotId: near ? near.id : null };
  });
}

/** Parse the recorder's stall error message into [{atMs, ms}]. */
function parseStallError(message) {
  const out = [];
  const re = /(\d+(?:\.\d+)?)s\s+—\s+(\d+(?:\.\d+)?)s still/g;
  let m;
  while ((m = re.exec(String(message)))) {
    out.push({ atMs: Math.round(Number(m[1]) * 1000), ms: Math.round(Number(m[2]) * 1000) });
  }
  return out;
}

module.exports = { buildStoryboard, ShotError, stallsToShots, parseStallError, ctaLines };
