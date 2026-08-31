'use strict';
/**
 * classic.js — runs a hand-written demo project (a folder with its own
 * build.js) exactly the way it runs from a terminal: `node build.js
 * --engine=… --voice=…` in the project dir, output streamed. Phase progress
 * is a best-effort parse of the conventional "n/4  doing thing…" lines the
 * example build scripts print; a build that prints nothing still works.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PHASE_LINE = /^(\d+)\s*\/\s*(\d+)\s+(.*)/;

function parsePhaseLine(line) {
  const m = PHASE_LINE.exec(String(line).trim());
  if (!m) return null;
  return { current: Number(m[1]), total: Number(m[2]), label: m[3].trim() };
}

function newestMp4s(dir) {
  if (!fs.existsSync(dir)) return { outPath: null, deliverPath: null };
  const mp4s = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'))
    .map(f => ({ f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const deliver = mp4s.filter(m => /linkedin/i.test(m.f))[0] || null;
  const raw = mp4s.filter(m => !/linkedin/i.test(m.f) && !/\.silent\.mp4$/.test(m.f))[0] || null;
  return { outPath: raw ? raw.full : null, deliverPath: deliver ? deliver.full : null };
}

function runClassic(job, emit) {
  return new Promise((resolve, reject) => {
    const buildPath = path.join(job.projectDir, 'build.js');
    if (!fs.existsSync(buildPath)) return reject(new Error('no build.js in ' + job.projectDir));
    const args = [buildPath];
    const ov = job.overrides || {};
    if (ov.engine) args.push('--engine=' + ov.engine);
    if (ov.voice) args.push('--voice=' + ov.voice);

    emit({ type: 'phase', phase: 'classic', status: 'start', detail: 'node ' + args.map(a => path.basename(a)).join(' ') });
    const child = spawn('node', args, { cwd: job.projectDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    const feed = (stream) => (d) => {
      String(d).split('\n').forEach(line => {
        if (!line.trim()) return;
        emit({ type: 'log', stream, text: line });
        const p = parsePhaseLine(line);
        if (p) emit({ type: 'progress', phase: 'classic', current: p.current, total: p.total, label: p.label });
      });
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('build.js exited with code ' + code));
      const found = newestMp4s(path.join(job.projectDir, 'demo-out'));
      if (!found.outPath) return reject(new Error('build.js finished but no mp4 found in demo-out/'));
      let durationSec = 0;
      try {
        durationSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
          'format=duration', '-of', 'default=nw=1:nk=1', found.outPath], { encoding: 'utf8' }).trim());
      } catch (err) { /* duration is cosmetic here */ }
      emit({ type: 'phase', phase: 'classic', status: 'done' });
      resolve({
        outPath: found.outPath,
        deliverPath: found.deliverPath,
        durationSec,
        bytes: fs.statSync(found.outPath).size,
      });
    });
  });
}

module.exports = { runClassic, parsePhaseLine, newestMp4s };
