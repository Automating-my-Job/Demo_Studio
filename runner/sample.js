'use strict';
/**
 * sample.js — synthesizes a short voice sample with the chosen engine and
 * voice via narrate.build itself, so what you hear is exactly what a build
 * produces (same pause shaping, same trim, same cache). The outDir is ALWAYS
 * app-owned scratch: narrate.build deletes and replaces its outDir, so it
 * must never point at anything the user picked.
 */
const path = require('path');
const crypto = require('crypto');
const { guardOutDir } = require('../shared/demoSchema.js');

const DEFAULT_TEXT = 'Here is how this dashboard keeps every portfolio honest, on one page.';

async function synthesizeSample(job, emit) {
  const narrate = require(path.join(job.demoSuitePath, 'lib', 'narrate.js'));
  const text = (job.text || DEFAULT_TEXT).trim();
  const stamp = crypto.createHash('sha256')
    .update([job.engine, job.voice || '', String(job.rate || ''), String(job.tempo || ''), text].join('|'))
    .digest('hex').slice(0, 16);
  const outDir = path.join(job.userDataDir, 'scratch', 'samples', stamp);
  guardOutDir(outDir, job.userDataDir);

  emit({ type: 'phase', phase: 'sample', status: 'start', detail: job.engine + ' / ' + (job.voice || 'default voice') });
  const opts = {
    outDir,
    cacheDir: path.join(job.userDataDir, 'scratch', 'sample-cache'),
    engine: job.engine,
    log: true,
  };
  if (job.voice) opts.voice = job.voice;
  if (job.rate) opts.rate = job.rate;
  if (job.tempo) opts.tempo = job.tempo;
  const manifest = await narrate.build({ __SAMPLE__: { text } }, opts);
  const clip = manifest.clips.__SAMPLE__;
  if (!clip) throw new Error('sample synthesis produced no clip');
  emit({ type: 'phase', phase: 'sample', status: 'done' });
  emit({ type: 'sample', path: clip.file, seconds: clip.seconds });
  return clip;
}

module.exports = { synthesizeSample, DEFAULT_TEXT };
