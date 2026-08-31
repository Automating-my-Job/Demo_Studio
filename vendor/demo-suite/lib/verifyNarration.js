#!/usr/bin/env node
'use strict';
/**
 * verifyNarration.js — confirms every clip in a narration manifest actually
 * says its line, once, correctly. NODE-ONLY.
 *
 * Usage (CLI):
 *   node verifyNarration.js ./demo-out/vo/manifest.json
 *
 * Usage (library):
 *   const { verifyManifest } = require('./verifyNarration.js');
 *   const { bad, results } = await verifyManifest(manifestPath);
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT DOES NOT USE AN LLM
 * ===========================================================================
 * A generative TTS model (see narrate.js's warning about the Gemini engine)
 * can repeat a clause. The natural instinct is to ask an LLM to transcribe
 * the clip back and check for the repeat — and that DOES NOT WORK: the
 * transcribing model shares the same bias toward clean, plausible output.
 * Confirmed directly in production: a clip that audibly repeated "and every
 * row" was transcribed as spoken once, by two different LLM transcription
 * attempts in a row.
 *
 * A DEDICATED ASR model does not have this bias — real speech-to-text
 * systems are trained to match a reference transcript that includes
 * disfluencies, stutters and repeats verbatim, because that is what the
 * training data actually contains. `mlx-whisper` (Apple Silicon, local, no
 * API key, no per-request cost) is used here for exactly that reason.
 *
 * Install once:  pip3 install mlx-whisper
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * @param {string} manifestPath - a manifest.json from narrate.js's build().
 * @param {Object} [opts]
 * @param {string} [opts.model='mlx-community/whisper-small.en-mlx']
 * @returns {Promise<{results: Array, bad: Array}>}
 */
async function verifyManifest(manifestPath, opts) {
  opts = opts || {};
  const model = opts.model || 'mlx-community/whisper-small.en-mlx';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const py = [
    'import mlx_whisper, json, sys',
    'clips = json.loads(sys.argv[1])',
    'out = []',
    'for key, file in clips:',
    '    r = mlx_whisper.transcribe(file, path_or_hf_repo=sys.argv[2], word_timestamps=False, verbose=False)',
    '    out.append({"key": key, "heard": r["text"].strip()})',
    'print(json.dumps(out))',
  ].join('\n');

  const pairs = Object.keys(manifest.clips).map(k => [k, manifest.clips[k].file]);
  const tmpPy = path.join(require('os').tmpdir(), 'verify_narration_' + Date.now() + '.py');
  fs.writeFileSync(tmpPy, py);
  let raw;
  try {
    raw = execFileSync('python3', [tmpPy, JSON.stringify(pairs), model],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new Error('mlx-whisper failed — is it installed? `pip3 install mlx-whisper`\n' +
      (err.stderr ? err.stderr.toString().slice(-800) : err.message));
  } finally {
    fs.unlinkSync(tmpPy);
  }
  const heard = {};
  JSON.parse(raw).forEach(r => { heard[r.key] = r.heard; });

  const norm = s => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const results = Object.keys(manifest.clips).map(key => {
    const source = norm(manifest.clips[key].text.replace(/\s*\|\|?\s*/g, ' '));
    const h = norm(heard[key] || '');
    const srcWords = source.split(' ').filter(Boolean);
    const heardWords = h.split(' ').filter(Boolean);
    // A real repeat inflates word count well past ordinary ASR noise
    // (numeral normalization, punctuation, "SVP" vs "S V P", etc.) — flag on
    // a meaningful length blow-up, not on every minor wording difference.
    const ratio = heardWords.length / Math.max(1, srcWords.length);
    return { key, source: manifest.clips[key].text, heard: heard[key] || '', ratio, suspect: ratio > 1.35 };
  });
  const bad = results.filter(r => r.suspect);
  return { results, bad };
}

if (require.main === module) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: node verifyNarration.js <manifest.json>');
    process.exit(1);
  }
  verifyManifest(path.resolve(manifestPath)).then(({ results, bad }) => {
    results.forEach(r => {
      console.log((r.suspect ? 'SUSPECT ' : 'ok      ') + r.key);
      console.log('  source: ' + r.source.replace(/\s*\|\|?\s*/g, ' '));
      console.log('  heard:  ' + r.heard);
      console.log('');
    });
    console.log(bad.length + ' of ' + results.length + ' clips look suspect' +
      (bad.length ? ' — listen to them directly before shipping' : ''));
    process.exit(bad.length ? 1 : 0);
  }).catch(err => { console.error('\n  ' + err.message + '\n'); process.exit(1); });
}

module.exports = { verifyManifest };
