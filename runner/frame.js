'use strict';
/**
 * frame.js — Gemini auto-framing: screenshot + DOM outline + the user's
 * instructions go in; a validated, linted {narration, shots} patch for
 * demo.json comes out. The model only ever speaks the structured schema
 * below (selector/nth/textContains — never raw JS), and every proposed
 * selector is evaluated against the live page before the user sees it.
 */
const { FRAMING_RULES } = require('../shared/rules.js');
const { normalizeDemo } = require('../shared/demoSchema.js');
const { compileSubject } = require('./subject.js');
const { capturePage, evalJs } = require('./capturePage.js');
const gemini = require('./geminiRest.js');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    narration: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { key: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['key', 'text'],
      },
    },
    shots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', enum: ['say', 'frame', 'spot', 'spotOut', 'click', 'waitForVo', 'hold', 'cta'] },
          caption: { type: 'STRING' },
          voKey: { type: 'STRING' },
          selector: { type: 'STRING' },
          nth: { type: 'INTEGER' },
          textContains: { type: 'STRING' },
          mode: { type: 'STRING', enum: ['wide', 'focus'] },
          ms: { type: 'INTEGER' },
          settleMs: { type: 'INTEGER' },
          crawlIfTall: { type: 'BOOLEAN' },
          lines: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] },
          },
          note: { type: 'STRING' },
        },
        required: ['action'],
      },
    },
  },
  required: ['narration', 'shots'],
};

function buildFramingRequest(demo, outline, screenshotB64, feedback) {
  const parts = [
    { text: FRAMING_RULES },
    {
      text: '\nUSER INSTRUCTIONS for this demo:\n' + (demo.instructions || '(none given — tell the page\'s obvious story)') +
        '\n\nPAGE OUTLINE (visible elements; use ONLY these selectors, with "nth" when matches > 1):\n' +
        JSON.stringify(outline) +
        '\n\nThe screenshot shows the page at recording size. Return the narration and shot list.',
    },
  ];
  if (screenshotB64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshotB64 } });
  if (feedback) {
    parts.push({ text: '\nYour previous attempt was rejected. Fix these problems and return the full corrected result:\n- ' + feedback.join('\n- ') });
  }
  return {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
    },
  };
}

/**
 * Validate a framing response by running it through the same normalization
 * demo.json itself gets. Returns {narration, shots, errors, warnings}.
 */
function parseFraming(text, demo) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    return { errors: ['response was not valid JSON: ' + err.message], warnings: [] };
  }
  const synthetic = Object.assign({}, demo, { narration: parsed.narration, shots: parsed.shots });
  const { demo: norm, errors, warnings } = normalizeDemo(synthetic);
  if (errors.length) return { errors, warnings };
  return { narration: norm.narration, shots: norm.shots, errors: [], warnings };
}

/**
 * Evaluate every subject-bearing shot against the live page: a selector that
 * matches nothing, or matches a 0x0 (hidden/collapsed) box, gets flagged.
 * Framing a 0x0 element silently does not move the camera — the single most
 * common "the demo looks broken" cause.
 */
async function lintLive(client, shots) {
  const lint = [];
  for (const shot of shots) {
    if (!shot.subject || shot.disabled) continue;
    let expr;
    try { expr = compileSubject(shot.subject); } catch (err) {
      lint.push({ shotId: shot.id, level: 'error', problem: err.message });
      continue;
    }
    const probe = '(function(){var el=(' + expr + ');if(!el)return "missing";' +
      'var r=el.getBoundingClientRect();return (r.width<2||r.height<2)?"hidden":"ok";}())';
    let verdict;
    try { verdict = await evalJs(client, probe); } catch (err) { verdict = 'error: ' + err.message; }
    if (verdict === 'missing') {
      lint.push({ shotId: shot.id, level: 'error', problem: 'selector matches nothing on the page' });
    } else if (verdict === 'hidden') {
      lint.push({ shotId: shot.id, level: 'warning', problem: 'element measures 0×0 (hidden or collapsed) — the camera will not move; click its toggle open first' });
    } else if (verdict !== 'ok') {
      lint.push({ shotId: shot.id, level: 'error', problem: String(verdict) });
    }
  }
  return lint;
}

/** Static variant for tests and offline checks: selector must appear in the outline. */
function lintStatic(shots, outline) {
  const known = {};
  (outline.nodes || []).forEach(n => { known[n.sel] = true; });
  const lint = [];
  shots.forEach(shot => {
    if (!shot.subject || shot.disabled || shot.subject.expr) return;
    const sel = shot.subject.selector;
    if (!known[sel]) lint.push({ shotId: shot.id, level: 'warning', problem: 'selector "' + sel + '" not seen in the page outline' });
  });
  return lint;
}

/**
 * The whole framing job. `deps` is injectable for tests:
 *   {transport: (req) => Promise<responseJson>, capture: (job) => Promise<...>}
 */
async function frameProject(job, emit, deps) {
  const d = deps || {};
  const capture = d.capture || capturePage;
  // Key resolution mirrors narrate.js: explicit > env > ~/.gemini_tts_key
  // (readKey_ is exported by narrate.js for exactly this kind of reuse).
  const resolveKey = () => {
    if (job.geminiKey || process.env.GEMINI_TTS_KEY) return job.geminiKey || process.env.GEMINI_TTS_KEY;
    try {
      const narrate = require(require('path').join(job.demoSuitePath, 'lib', 'narrate.js'));
      return narrate.readKey_('GEMINI_TTS_KEY', '.gemini_tts_key');
    } catch (err) { return null; }
  };
  const transport = d.transport || (req => gemini.generateContent({
    key: resolveKey(),
    model: job.framingModel || 'gemini-3.6-flash', body: req,
  }));

  emit({ type: 'phase', phase: 'frame', status: 'start', detail: 'capturing the page' });
  const cap = await capture(job);
  try {
    emit({ type: 'progress', phase: 'frame', current: 1, total: 3, label: 'page captured — asking Gemini' });
    let feedback = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const req = buildFramingRequest(job.demo, cap.outline, cap.screenshotB64, feedback);
      const resp = await transport(req);
      const text = gemini.firstText(resp);
      if (!text) { feedback = ['the response contained no text part']; continue; }
      const parsed = parseFraming(text, job.demo);
      if (parsed.errors.length) { feedback = parsed.errors; continue; }
      emit({ type: 'progress', phase: 'frame', current: 2, total: 3, label: 'checking selectors against the live page' });
      const lint = cap.session ? await lintLive(cap.session.client, parsed.shots) : lintStatic(parsed.shots, cap.outline);
      // Auto re-frame: hard lint failures (selector matches nothing) go back
      // to Gemini once before the user ever sees the draft. Warnings
      // (hidden elements etc.) pass through — they may be intentional.
      const hardLint = lint.filter(l => l.level === 'error');
      if (attempt === 1 && hardLint.length) {
        feedback = hardLint.map(l => 'shot ' + l.shotId + ': ' + l.problem);
        emit({ type: 'log', stream: 'out', text: 'framing: ' + hardLint.length + ' selector problem(s) — asking Gemini to revise' });
        continue;
      }
      emit({ type: 'progress', phase: 'frame', current: 3, total: 3, label: 'done' });
      return {
        demoPatch: { narration: parsed.narration, shots: parsed.shots },
        lint,
        warnings: parsed.warnings,
        capturePath: cap.capturePath,
      };
    }
    throw new Error('Gemini could not produce a valid shot list: ' + (feedback || []).join('; '));
  } finally {
    if (cap.session) cap.session.close();
  }
}

module.exports = { RESPONSE_SCHEMA, buildFramingRequest, parseFraming, lintLive, lintStatic, frameProject };
