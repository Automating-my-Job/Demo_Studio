'use strict';
/**
 * wordTimings.js — word-level timestamps for every narration clip, so a
 * storyboard can land a camera move or spotlight ON the spoken word instead
 * of guessing a fraction of the line. NODE-ONLY; needs `pip3 install
 * mlx-whisper` (the same local ASR verifyNarration.js uses).
 *
 * Why: fraction cues ("move at 56% of the line") were the recurring cause of
 * misaligned beats — Chirp3-HD phrasing varies between syntheses of the same
 * text, and any edit to the line moves every word. Found directing the
 * Salesforce demo, where a lengthened hero-card line left four fraction cues
 * pointing at the wrong words.
 *
 * Usage:
 *   const { buildWordTimings, wordTime } = require('./wordTimings.js');
 *   const words = buildWordTimings('demo-out/vo/manifest.json');
 *   const t = wordTime(words, 'HERO', 'quarter');  // seconds into the clip
 *
 * Results are cached in words.json beside the manifest, keyed by each clip
 * file's content hash, so unchanged clips are never re-transcribed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PY = [
  'import json, sys',
  'import mlx_whisper',
  'jobs = json.loads(sys.argv[1])',
  'out = {}',
  'for key, f in jobs.items():',
  '    r = mlx_whisper.transcribe(f, path_or_hf_repo=sys.argv[2], word_timestamps=True)',
  '    out[key] = [{"w": w["word"].strip(), "s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3)}',
  '                for seg in r["segments"] for w in seg.get("words", [])]',
  'sys.stdout.write(json.dumps(out))',
].join('\n');

/** Lower-case letters and digits only: "On-track," → "ontrack", "aren’t" → "arent". */
function normalizeWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fileHash(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {string} manifestPath - narrate.js manifest.json
 * @param {{model?: string, python?: string}} [opts]
 * @returns {Object<string, Array<{w: string, s: number, e: number}>>}
 */
function buildWordTimings(manifestPath, opts) {
  const o = opts || {};
  const model = o.model || 'mlx-community/whisper-small.en-mlx';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cacheFile = path.join(path.dirname(manifestPath), 'words.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const result = {};
  const jobs = {};
  const hashes = {};
  Object.keys(manifest.clips).forEach((key) => {
    const file = manifest.clips[key].file;
    const hash = fileHash(file);
    hashes[key] = hash;
    if (cache[key] && cache[key].hash === hash && cache[key].model === model) result[key] = cache[key].words;
    else jobs[key] = file;
  });
  if (Object.keys(jobs).length) {
    const out = execFileSync(o.python || 'python3', ['-c', PY, JSON.stringify(jobs), model],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    const fresh = JSON.parse(out);
    Object.keys(fresh).forEach((key) => { result[key] = fresh[key]; });
  }
  const next = {};
  Object.keys(result).forEach((key) => { next[key] = { hash: hashes[key], model, words: result[key] }; });
  fs.writeFileSync(cacheFile, JSON.stringify(next, null, 1));
  return result;
}

/**
 * Seconds into clip `key` where the spoken `needle` starts. `needle` may be
 * several words ("lined up"); matching ignores case and punctuation. `nth`
 * picks a later occurrence (1-based). Returns null when not heard.
 */
function wordTime(words, key, needle, nth) {
  const list = (words && words[key]) || [];
  const want = String(needle).split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!want.length) return null;
  let seen = 0;
  for (let i = 0; i + want.length <= list.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (normalizeWord(list[i + j].w) !== want[j]) { ok = false; break; }
    }
    if (ok && ++seen === (nth || 1)) return list[i].s;
  }
  return null;
}

module.exports = { buildWordTimings, wordTime, normalizeWord };
