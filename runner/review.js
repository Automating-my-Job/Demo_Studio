'use strict';
/**
 * review.js — the post-run review pass (AGENTS.md §4.1): extract one frame
 * per shot from the finished cut, show the strip to Gemini vision along
 * with the demo grammar, and get critiques mapped to shot ids — the same
 * "never ship a first take" inspection a human director does, automated.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FRAMING_RULES } = require('../shared/rules.js');
const gemini = require('./geminiRest.js');

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    critiques: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          shotId: { type: 'STRING' },
          severity: { type: 'STRING', enum: ['error', 'warning', 'note'] },
          problem: { type: 'STRING' },
          suggestion: { type: 'STRING' },
        },
        required: ['shotId', 'severity', 'problem'],
      },
    },
    overall: { type: 'STRING' },
  },
  required: ['critiques', 'overall'],
};

/** One representative frame per timeline entry, capped. */
function extractFrames(mp4Path, timeline, durationMs, outDir, cap) {
  fs.mkdirSync(outDir, { recursive: true });
  const picked = timeline.slice(0, cap || 40);
  return picked.map(t => {
    const atMs = Math.min(Math.max(0, t.startMs + 400), Math.max(0, durationMs - 100));
    const file = path.join(outDir, t.id + '.jpg');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (atMs / 1000).toFixed(3), '-i', mp4Path,
      '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '6', file], { stdio: 'ignore' });
    return { id: t.id, atMs, file };
  });
}

function buildReviewRequest(demo, frames) {
  const shotById = {};
  (demo.shots || []).forEach(s => { if (s) shotById[s.id] = s; });
  const parts = [
    { text: FRAMING_RULES },
    {
      text: '\nYou are now REVIEWING a finished cut of this demo, one representative frame per shot. ' +
        'Judge each frame against the grammar above: is the spotlight on the thing the caption names, ' +
        'is anything cropped or empty, does a wide shot waste the frame, is a caption covering the subject, ' +
        'is the closing card correct? Report only real problems (severity error/warning) and sharp ' +
        'observations (note) — do not pad. Each critique names the shotId of the frame it is about.\n' +
        'The demo\'s narration, for context:\n' +
        (demo.narration || []).map(n => n && (n.key + ': ' + n.text)).filter(Boolean).join('\n'),
    },
  ];
  frames.forEach(f => {
    const s = shotById[f.id] || {};
    parts.push({
      text: '\nShot ' + f.id + ' (' + (s.action || '?') +
        (s.caption ? ', caption "' + s.caption + '"' : '') + ') at ' + (f.atMs / 1000).toFixed(1) + 's:',
    });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(f.file).toString('base64') } });
  });
  return {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA, temperature: 0.2 },
  };
}

/**
 * The whole review job. Needs a prior run's demo-out/timeline.json.
 * `deps.transport` injectable for tests.
 */
async function reviewCut(job, emit, deps) {
  const d = deps || {};
  const outDir = path.join(job.projectDir, 'demo-out');
  const mp4 = path.join(outDir, 'demo.mp4');
  const timelineFile = path.join(outDir, 'timeline.json');
  if (!fs.existsSync(mp4)) throw new Error('no demo-out/demo.mp4 — run the demo first');
  if (!fs.existsSync(timelineFile)) throw new Error('no demo-out/timeline.json — re-run the demo once to record shot timings');
  const timeline = JSON.parse(fs.readFileSync(timelineFile, 'utf8'));
  const durationMs = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', mp4], { encoding: 'utf8' }).trim()) * 1000);

  emit({ type: 'phase', phase: 'review', status: 'start', detail: 'extracting one frame per shot' });
  const frames = (d.extract || extractFrames)(mp4, timeline, durationMs, path.join(outDir, 'review'), 40);
  emit({ type: 'progress', phase: 'review', current: 1, total: 2, label: frames.length + ' frames — asking Gemini to review the cut' });

  const transport = d.transport || (req => gemini.generateContent({
    key: job.geminiKey || process.env.GEMINI_TTS_KEY || readDotfileKey_(job.demoSuitePath),
    model: job.framingModel || 'gemini-3.6-flash', body: req,
  }));
  const resp = await transport(buildReviewRequest(job.demo, frames));
  const text = gemini.firstText(resp);
  if (!text) throw new Error('the review response contained no text');
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw new Error('review response was not valid JSON: ' + err.message); }
  const critiques = Array.isArray(parsed.critiques) ? parsed.critiques : [];
  emit({ type: 'progress', phase: 'review', current: 2, total: 2, label: 'done' });
  emit({ type: 'phase', phase: 'review', status: 'done', detail: critiques.length + ' finding(s)' });
  return { critiques, overall: parsed.overall || '', frames: frames.length };
}

function readDotfileKey_(demoSuitePath) {
  try {
    const narrate = require(path.join(demoSuitePath, 'lib', 'narrate.js'));
    return narrate.readKey_('GEMINI_TTS_KEY', '.gemini_tts_key');
  } catch (err) { return null; }
}

module.exports = { reviewCut, buildReviewRequest, extractFrames, REVIEW_SCHEMA };
