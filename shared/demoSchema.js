'use strict';
/**
 * demoSchema.js — the demo.json contract shared by the editor UI, the
 * Gemini framing step, and the storyboard executor. Plain CJS, no deps.
 *
 * demo.json is the per-project source of truth and it is HAND-EDITABLE:
 * normalization must survive a human deleting an entry (a `null` in the
 * shots/narration arrays is skipped, not an error), disabling a shot with
 * `"disabled": true`, and adding keys this version does not know about
 * (unknown keys ride along untouched through load → edit → save).
 */
const path = require('path');

/**
 * Everything a shot can do, mapped 1:1 onto recorder.js `rec` primitives.
 * `subject` marks actions that target an element (compiled by subject.js
 * into the JS expression strings rec.frame/spot/click expect).
 */
const ACTIONS = {
  say: { fields: { caption: 'string', voKey: 'string?', holdMs: 'number?' } },
  frame: { subject: true, fields: { mode: 'string?', ms: 'number?', crawlIfTall: 'boolean?', crawlMs: 'number?' } },
  spot: { subject: true, fields: { ms: 'number?' } },
  spotOut: { fields: { ms: 'number?' } },
  crawl: { fields: { ms: 'number?' } },
  click: { subject: true, fields: { settleMs: 'number?' } },
  type: { fields: { selector: 'string', text: 'string', ms: 'number?' } },
  waitForVo: { fields: {} },
  atVo: { fields: { frac: 'number' } },
  hold: { fields: { ms: 'number' } },
  settle: { fields: { ms: 'number' } },
  caption: { fields: { text: 'string' } },
  cta: { fields: { lines: 'array', fadeMs: 'number?', caption: 'string?', voKey: 'string?' } },
  resetCamera: { fields: {} },
  run: { fields: { js: 'string' }, advanced: true },
};

const TARGET_KINDS = ['url', 'render', 'html'];
const ENGINES = ['google', 'say', 'gemini'];

const DEFAULTS = {
  camera: { pageSelector: '.demo-page', captionHeight: 104, margin: 48 },
  record: { width: 1920, height: 1080, fps: 60, stallMs: 5000, crf: 20 },
  voice: { engine: 'google', voice: 'en-US-Chirp3-HD-Charon', rate: 172, tempo: 0.90 },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Fill missing keys of `obj[key]` from defaults without discarding anything
 * the author wrote (including keys we do not know).
 */
function withDefaults_(obj, key) {
  const src = isPlainObject(obj[key]) ? obj[key] : {};
  obj[key] = Object.assign({}, DEFAULTS[key], src);
}

/**
 * Accept the flat subject shape Gemini emits ({selector, nth, textContains}
 * directly on the shot) as well as the nested {subject: {...}} form, and
 * normalize onto the nested form.
 */
function normalizeSubject_(shot) {
  if (isPlainObject(shot.subject)) return;
  if (shot.selector !== undefined || shot.expr !== undefined) {
    shot.subject = {};
    ['selector', 'nth', 'textContains', 'expr'].forEach(k => {
      if (shot[k] !== undefined) { shot.subject[k] = shot[k]; delete shot[k]; }
    });
  }
}

function validateShot_(shot, i, errors) {
  const where = 'shots[' + i + '] (' + (shot.id || 'no id') + ')';
  if (typeof shot.action !== 'string' || !ACTIONS[shot.action]) {
    errors.push(where + ': unknown action "' + shot.action + '"');
    return;
  }
  const def = ACTIONS[shot.action];
  if (def.subject) {
    const s = shot.subject;
    if (!isPlainObject(s) || (typeof s.selector !== 'string' && typeof s.expr !== 'string')) {
      errors.push(where + ': action "' + shot.action + '" needs a subject with a selector or expr');
    }
  }
  Object.keys(def.fields).forEach(f => {
    const spec = def.fields[f];
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const v = shot[f];
    if (v === undefined || v === null) {
      if (!optional) errors.push(where + ': missing required field "' + f + '"');
      return;
    }
    const ok = type === 'array' ? Array.isArray(v) : typeof v === type;
    if (!ok) errors.push(where + ': field "' + f + '" should be a ' + type);
  });
}

/**
 * Normalize a raw demo.json object in place-ish (a shallow-cloned copy is
 * returned; nested objects are the author's own, so unknown keys survive).
 *
 * @returns {{demo: object, errors: string[], warnings: string[]}} `errors`
 *   non-empty means the demo is not runnable; `warnings` are advisory.
 */
function normalizeDemo(raw) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { demo: null, errors: ['demo.json is not an object'], warnings };
  const demo = Object.assign({}, raw);
  if (demo.version === undefined) demo.version = 1;

  // Target ------------------------------------------------------------------
  if (!isPlainObject(demo.target)) {
    errors.push('missing "target"');
  } else {
    const t = demo.target;
    if (TARGET_KINDS.indexOf(t.kind) === -1) {
      errors.push('target.kind must be one of ' + TARGET_KINDS.join('/'));
    } else if (t.kind === 'url' && typeof t.url !== 'string') {
      errors.push('target.kind "url" needs target.url');
    } else if (t.kind === 'render' && typeof t.renderModule !== 'string') {
      errors.push('target.kind "render" needs target.renderModule');
    } else if (t.kind === 'html' && typeof t.htmlFile !== 'string') {
      errors.push('target.kind "html" needs target.htmlFile');
    }
  }

  withDefaults_(demo, 'camera');
  withDefaults_(demo, 'record');
  withDefaults_(demo, 'voice');
  if (ENGINES.indexOf(demo.voice.engine) === -1) {
    errors.push('voice.engine must be one of ' + ENGINES.join('/'));
  }

  // Narration ---------------------------------------------------------------
  // An array (order = clip order), tolerant of nulls and disabled entries.
  const narrRaw = Array.isArray(demo.narration) ? demo.narration : [];
  demo.narration = narrRaw.filter(e => e !== null && e !== undefined);
  const seenKeys = {};
  demo.narration.forEach((e, i) => {
    if (!isPlainObject(e) || typeof e.key !== 'string' || typeof e.text !== 'string') {
      errors.push('narration[' + i + ']: needs { key, text }');
      return;
    }
    if (seenKeys[e.key]) errors.push('narration[' + i + ']: duplicate key "' + e.key + '"');
    seenKeys[e.key] = true;
  });

  // Shots -------------------------------------------------------------------
  const shotsRaw = Array.isArray(demo.shots) ? demo.shots : [];
  demo.shots = shotsRaw.filter(s => s !== null && s !== undefined);
  const seenIds = {};
  demo.shots.forEach((shot, i) => {
    if (!isPlainObject(shot)) { errors.push('shots[' + i + '] is not an object'); return; }
    if (!shot.id) shot.id = 's' + (i + 1);
    if (seenIds[shot.id]) warnings.push('shots[' + i + ']: duplicate id "' + shot.id + '"');
    seenIds[shot.id] = true;
    normalizeSubject_(shot);
    if (shot.disabled) return; // a disabled shot is skipped, never validated hard
    validateShot_(shot, i, errors);
    if (shot.action === 'say' && shot.voKey && !seenKeys[shot.voKey]) {
      warnings.push('shots[' + i + ']: voKey "' + shot.voKey + '" has no narration entry — the beat will be silent');
    }
    if (shot.action === 'cta' && shot.voKey && !seenKeys[shot.voKey]) {
      warnings.push('shots[' + i + ']: cta voKey "' + shot.voKey + '" has no narration entry');
    }
  });

  // A script whose last spoken line is never waited on gets cut off.
  const lastSay = demo.shots.map(s => s.action).lastIndexOf('say');
  if (lastSay !== -1) {
    const after = demo.shots.slice(lastSay + 1).map(s => s.action);
    if (after.indexOf('waitForVo') === -1 && after.indexOf('cta') === -1) {
      warnings.push('the last "say" is never followed by waitForVo — its audio may be cut off');
    }
  }

  return { demo, errors, warnings };
}

/**
 * The narration array → the keyed, ordered object narrate.build() expects.
 * Skips disabled entries. Key order is clip order (verified: narrate.js
 * iterates Object.keys of this object).
 */
function narrationToObject(narration) {
  const out = {};
  (narration || []).forEach(e => {
    if (!e || e.disabled || typeof e.key !== 'string') return;
    const entry = { text: e.text };
    if (e.voice) entry.voice = e.voice;
    if (e.rate) entry.rate = e.rate;
    out[e.key] = entry;
  });
  return out;
}

/**
 * narrate.build() DELETES its outDir and replaces it wholesale
 * (narrate.js:598). Every outDir the app computes must therefore be a
 * directory the app owns: under the app's userData, or a `demo-out/…`
 * segment inside a project. Anything else is refused loudly.
 */
function guardOutDir(outDir, userDataDir) {
  const p = path.resolve(outDir);
  if (userDataDir && (p === path.resolve(userDataDir) || p.startsWith(path.resolve(userDataDir) + path.sep))) {
    if (p.split(path.sep).length < 4) throw new Error('refusing outDir too close to root: ' + p);
    return p;
  }
  const parts = p.split(path.sep);
  if (parts.indexOf('demo-out') === -1) {
    throw new Error('refusing narration outDir outside demo-out/ or app data ' +
      '(narrate.build deletes its outDir): ' + p);
  }
  if (parts.length < 4) throw new Error('refusing outDir too close to root: ' + p);
  return p;
}

module.exports = { ACTIONS, TARGET_KINDS, ENGINES, DEFAULTS, normalizeDemo, narrationToObject, guardOutDir };
