'use strict';
/**
 * audioQa.js — measures the finished cut's audio instead of trusting ears
 * (AGENTS.md §4.2). Runs ffmpeg silencedetect on the mp4 and asserts the
 * demo grammar: the first voice lands within ~1s of 0:00 (cold open), and
 * no silent stretch runs longer than a deliberate beat. Advisory — the
 * recorder's stallMs assert stays the hard gate; this catches what stallMs
 * cannot (a slow opening is "still but narrated" as far as the recorder
 * knows... until the narration itself starts late).
 */
const { execFileSync } = require('child_process');

/** Parse ffmpeg silencedetect stderr into [{startMs, endMs|null, durMs|null}]. */
function parseSilence(stderrText) {
  const out = [];
  let open = null;
  String(stderrText).split('\n').forEach(line => {
    let m = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (m) { open = { startMs: Math.max(0, Math.round(Number(m[1]) * 1000)), endMs: null, durMs: null }; out.push(open); return; }
    m = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if (m && open) {
      open.endMs = Math.round(Number(m[1]) * 1000);
      open.durMs = Math.round(Number(m[2]) * 1000);
      open = null;
    }
  });
  return out;
}

/**
 * Pure analysis over parsed silences. A silence that starts at 0 delays the
 * first voice; any interior silence longer than maxGapMs is dead air; a
 * long trailing silence is a limp ending.
 */
function analyze(silences, durationMs, opts) {
  const o = opts || {};
  const voiceStartMaxMs = o.voiceStartMaxMs === undefined ? 1000 : o.voiceStartMaxMs;
  const maxGapMs = o.maxGapMs === undefined ? 4000 : o.maxGapMs;
  const issues = [];
  const lead = silences.filter(s => s.startMs <= 50)[0];
  const firstVoiceMs = lead ? (lead.endMs === null ? durationMs : lead.endMs) : 0;
  if (firstVoiceMs > voiceStartMaxMs) {
    issues.push('the first voice lands at ' + (firstVoiceMs / 1000).toFixed(1) +
      's — a cold open should speak within ' + (voiceStartMaxMs / 1000) + 's');
  }
  silences.forEach(s => {
    if (s.startMs <= 50) return; // the lead-in is judged above
    const end = s.endMs === null ? durationMs : s.endMs;
    const dur = end - s.startMs;
    if (dur <= maxGapMs) return;
    const trailing = s.endMs === null || durationMs - end < 200;
    issues.push((trailing ? 'the ending goes silent for ' : 'dead air: ') +
      (dur / 1000).toFixed(1) + 's of silence from ' + (s.startMs / 1000).toFixed(1) + 's');
  });
  return { ok: issues.length === 0, firstVoiceMs, issues };
}

/** Run silencedetect on a file and analyze. */
function measure(mp4Path, durationSec, opts) {
  const o = opts || {};
  let stderr = '';
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-i', mp4Path,
      '-af', 'silencedetect=noise=' + (o.noiseDb || -45) + 'dB:d=' + (o.minSilenceSec || 0.3),
      '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // ffmpeg exits 0 here normally; stderr carries the detections either way
    stderr = err.stderr ? String(err.stderr) : '';
  }
  // execFileSync only exposes stderr on throw; run again capturing explicitly
  if (!stderr) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', mp4Path,
      '-af', 'silencedetect=noise=' + (o.noiseDb || -45) + 'dB:d=' + (o.minSilenceSec || 0.3),
      '-f', 'null', '-'], { encoding: 'utf8' });
    stderr = r.stderr || '';
  }
  return analyze(parseSilence(stderr), Math.round(durationSec * 1000), o);
}

module.exports = { parseSilence, analyze, measure };
