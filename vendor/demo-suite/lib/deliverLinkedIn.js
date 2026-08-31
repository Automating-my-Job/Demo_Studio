#!/usr/bin/env node
'use strict';
/**
 * deliverLinkedIn.js — re-encodes a finished demo video into the format
 * LinkedIn (and most social platforms) actually render correctly. NODE-ONLY.
 *
 * Usage (CLI):
 *   node deliverLinkedIn.js ./demo-out/demo.mp4 ./demo-out/demo-linkedin.mp4
 *
 * Usage (library):
 *   const { encode } = require('./deliverLinkedIn.js');
 *   encode(inPath, outPath);
 *
 * ===========================================================================
 * WHY THIS STEP EXISTS SEPARATELY FROM THE RECORDER'S OWN OUTPUT
 * ===========================================================================
 * The recorder's raw output is FULL-RANGE (0-255) YUV, which is what a
 * browser screenshot naturally is. LinkedIn's own transcoder handles
 * LIMITED-RANGE (16-235) BT.709 more reliably — a full-range upload risked
 * a dark-themed dashboard washing out or crushing blacks on their re-encode.
 * Verified against an actual re-encoded frame, not assumed from a spec.
 *
 * Spec (validated against LinkedIn's documented native-video requirements):
 * MP4 container, H.264 video (High profile), AAC audio, up to 5GB / 10min —
 * a typical demo is nowhere near either limit.
 */
const { execFileSync } = require('child_process');

/**
 * @param {string} inPath
 * @param {string} outPath
 * @param {Object} [opts]
 * @param {number} [opts.crf=21]
 */
function encode(inPath, outPath, opts) {
  opts = opts || {};
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
    '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf || 21), '-profile:v', 'high', '-level', '4.2',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart', outPath], { stdio: 'inherit' });
  return outPath;
}

if (require.main === module) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('usage: node deliverLinkedIn.js <in.mp4> <out.mp4>');
    process.exit(1);
  }
  encode(inPath, outPath);
  console.log('  ' + outPath);
}

module.exports = { encode };
