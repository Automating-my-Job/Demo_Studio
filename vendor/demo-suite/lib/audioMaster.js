'use strict';
/**
 * audioMaster.js — the delivered sound: narration placed on the timeline,
 * an optional music bed ducked under it, then a two-pass loudness master.
 * NODE-ONLY (ffmpeg).
 *
 * ===========================================================================
 * WHY
 * ===========================================================================
 * The live takes shipped mono, -19.9 LUFS integrated with a -0.1 dBFS peak
 * (M1, 2026-10-26): quiet next to every other video in a feed, and one
 * platform transcode away from clipping. Web delivery wants about -16 LUFS
 * and a true peak at or under -1.5 dBTP; loudnorm's two-pass linear mode
 * gets there without pumping the voice.
 *
 * The bed is a slot, not a bundled asset: music is licensed per track and
 * never committed (Demo Studio is public). With no bed file, a silent one
 * runs through the same ducking chain, so swapping a track in changes
 * nothing else.
 */
const { execFileSync, spawnSync } = require('child_process');

const DEFAULT_TARGET = { I: -16, TP: -1.5, LRA: 11 };

/**
 * ffmpeg args that mix narration clips onto one stereo timeline.
 * clips: [{file, atMs}], durationSec, bed: {file?, gainDb=-20, duckDb=9}
 * Output: an uncompressed WAV ready for masterWavArgs.
 */
function mixArgs(clips, durationSec, out, bed) {
  const b = Object.assign({ gainDb: -20, duckDb: 9 }, bed || {});
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  clips.forEach((c) => args.push('-i', c.file));
  const D = durationSec.toFixed(3);
  if (b.file) args.push('-stream_loop', '-1', '-i', b.file);
  else args.push('-f', 'lavfi', '-t', D, '-i', 'anullsrc=r=48000:cl=stereo');
  const bedIdx = clips.length;
  const chains = clips.map((c, i) => '[' + i + ':a]aresample=48000,pan=stereo|c0=c0|c1=c0,' +
    'afade=t=in:st=0:d=0.02,adelay=' + Math.round(c.atMs) + '|' + Math.round(c.atMs) + '[v' + i + ']');
  const vo = clips.map((c, i) => '[v' + i + ']').join('') +
    'amix=inputs=' + clips.length + ':normalize=0:duration=longest,apad=whole_dur=' + D + ',atrim=0:' + D + ',asplit=2[vo][key]';
  // The voice keys a compressor on the bed: the music dips about duckDb under
  // every line and recovers between them.
  const ratio = Math.max(2, Math.round(Math.pow(10, b.duckDb / 20) * 2));
  const bedChain = '[' + bedIdx + ':a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:' + D +
    ',volume=' + b.gainDb + 'dB,afade=t=in:st=0:d=1.2,afade=t=out:st=' + Math.max(0, durationSec - 2).toFixed(3) + ':d=2[bed]';
  const duck = '[bed][key]sidechaincompress=threshold=0.015:ratio=' + ratio + ':attack=25:release=420:makeup=1[ducked]';
  const mix = '[vo][ducked]amix=inputs=2:normalize=0:duration=first[out]';
  args.push('-filter_complex', chains.concat([vo, bedChain, duck, mix]).join(';'),
    '-map', '[out]', '-c:a', 'pcm_s24le', '-ar', '48000', out);
  return args;
}

/** Pass 1 of loudnorm: the measured values, from any file with audio. */
function measureLoudness(file, target) {
  const t = Object.assign({}, DEFAULT_TARGET, target || {});
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'loudnorm=I=' + t.I + ':TP=' + t.TP + ':LRA=' + t.LRA + ':print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(String(r.stderr || ''));
  if (!m) throw new Error('loudness measurement failed');
  return JSON.parse(m[0]);
}

/** The pass-2 filter: linear gain to the target, then back to 48 kHz stereo. */
function loudnormFilter(measured, target) {
  const t = Object.assign({}, DEFAULT_TARGET, target || {});
  return 'loudnorm=I=' + t.I + ':TP=' + t.TP + ':LRA=' + t.LRA +
    ':measured_I=' + measured.input_i + ':measured_TP=' + measured.input_tp +
    ':measured_LRA=' + measured.input_lra + ':measured_thresh=' + measured.input_thresh +
    ':offset=' + measured.target_offset + ':linear=true,aresample=48000,aformat=channel_layouts=stereo';
}

/** Args that re-master an mp4's audio (video copied) to stereo AAC at the target. */
function masterAudioArgs(input, output, measured, target) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-af', loudnormFilter(measured, target),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', output];
}

/** Integrated loudness (LUFS) and true peak (dBTP) of a finished file. */
function loudnessReport(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = String(r.stderr || '');
  const tail = out.slice(out.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(tail);
  const P = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail);
  const ch = /Stream #0:\d+[^:]*: Audio: [^,]+, (\d+) Hz, (\w+)/.exec(out);
  return { lufs: I ? +I[1] : null, truePeakDb: P ? +P[1] : null, sampleRate: ch ? +ch[1] : null, layout: ch ? ch[2] : null };
}

/** Mixes and masters to an AAC-ready WAV; returns its path. */
function buildSoundtrack(clips, durationSec, outWav, o) {
  const raw = outWav.replace(/\.wav$/, '.raw.wav');
  execFileSync('ffmpeg', mixArgs(clips, durationSec, raw, o && o.bed), { stdio: 'inherit' });
  const measured = measureLoudness(raw, o && o.target);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', loudnormFilter(measured, o && o.target),
    '-c:a', 'pcm_s24le', outWav], { stdio: 'inherit' });
  require('fs').unlinkSync(raw);
  return outWav;
}

module.exports = { DEFAULT_TARGET, mixArgs, measureLoudness, loudnormFilter, masterAudioArgs, loudnessReport, buildSoundtrack };
