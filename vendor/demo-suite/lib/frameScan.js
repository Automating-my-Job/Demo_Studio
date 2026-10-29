'use strict';
/**
 * frameScan.js — the after-filming never-show check: read the text in the
 * finished video's frames and flag anything shaped like an email address,
 * a URL, an org or record id, or a sensitive Setup page. NODE-ONLY, macOS.
 *
 * ===========================================================================
 * WHY READ THE PIXELS
 * ===========================================================================
 * The recorder redacts the DOM before every frame and audits it before every
 * beat, but both look at the page's text, not at what was drawn: a canvas, an
 * image, a tooltip in a frame we failed to track, or a label rendered by CSS
 * would slip past. This reads the frames themselves with macOS Vision (the
 * on-device OCR the system uses; no network), so "no never-show item in any
 * frame" is checked on the video a viewer would actually see.
 *
 * Like every audit here it reports COUNTS and TIMESTAMPS, never the text it
 * read: a hit is re-checked by looking at that frame, not by printing it.
 *
 *   const { scanVideo } = require('./frameScan.js');
 *   const r = scanVideo('demo-out/take.mp4', { fps: 4 });
 *   // r = { frames: 84, hits: [{ atSec: 12.25, kinds: ['email'] }], counts: { email: 1, ... } }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KINDS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  url: /\bhttps?:\/\/|\bwww\.|\b[\w-]+(?:\.[\w-]+)*\.(?:force|salesforce|salesforce-setup|visualforce|documentforce|cloudforce)\.com\b/i,
  orgId: /\b00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?\b/,
  // Pages and fields that must never be filmed. Not the bare word "Password":
  // Setup's Users list has a "Reset Password(s)" button on every take.
  sensitivePage: /\b(Consumer Secret|Consumer Key|Security Token|Session ID|Organization ID|Verification Code|Login History|Client Secret|Forgot Your Password|Verify Your Identity|Remember me|Login As|Log in as)\b/,
};
const RECORD_ID = /\b[0a-zA-Z][0-9A-Za-z]{14}(?:[0-9A-Za-z]{3})?\b/g;

/** The never-show categories one frame's OCR lines fall into (pure). */
function classifyLines(lines, allowEmails) {
  const kinds = new Set();
  const allow = (allowEmails || []).map((e) => String(e).toLowerCase());
  const emails = new RegExp(KINDS.email.source, 'g');
  (lines || []).forEach((line) => {
    const s = String(line);
    Object.keys(KINDS).forEach((k) => {
      if (k === 'email') {
        // Public addresses the take may show (the app footer's support address).
        if ((s.match(emails) || []).some((m) => allow.indexOf(m.toLowerCase()) === -1)) kinds.add(k);
      } else if (KINDS[k].test(s)) kinds.add(k);
    });
    (s.match(RECORD_ID) || []).forEach((m) => {
      if ((m.match(/[0-9]/g) || []).length >= 3 && /[A-Za-z]/.test(m)) kinds.add('recordId');
    });
  });
  return Array.from(kinds).sort();
}

/** Compiles frameScan.swift once per source version; returns the binary. */
function ocrBinary() {
  const src = path.join(__dirname, 'frameScan.swift');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const dir = path.join(os.homedir(), '.cache', 'demo-suite');
  const bin = path.join(dir, 'frameScan-' + hash);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return bin;
}

/**
 * OCR every `1/fps` seconds of a video. Returns {frames, hits, counts}; a
 * hit carries its time and categories only.
 */
function scanVideo(videoPath, opts) {
  const o = opts || {};
  const fps = o.fps || 4;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-scan-'));
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vf', 'fps=' + fps, path.join(tmp, '%05d.png')]);
    const lines = JSON.parse(execFileSync(ocrBinary(), [tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const names = Object.keys(lines).sort();
    const hits = [];
    const counts = { email: 0, url: 0, orgId: 0, recordId: 0, sensitivePage: 0 };
    names.forEach((name, i) => {
      const kinds = classifyLines(lines[name], o.allowEmails);
      if (!kinds.length) return;
      kinds.forEach((k) => { counts[k]++; });
      hits.push({ atSec: Math.round((i / fps) * 100) / 100, kinds: kinds });
    });
    return { frames: names.length, hits: hits, counts: counts };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * OCR still images (the compose stage's captures). Returns {frames, hits,
 * counts}; a hit carries the image's file name and categories only.
 */
function scanImages(files, opts) {
  const o = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-scan-'));
  try {
    files.forEach((f, i) => fs.copyFileSync(f, path.join(tmp, String(i).padStart(5, '0') + '.png')));
    const lines = JSON.parse(execFileSync(ocrBinary(), [tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const names = Object.keys(lines).sort();
    const hits = [];
    const counts = { email: 0, url: 0, orgId: 0, recordId: 0, sensitivePage: 0 };
    names.forEach((name, i) => {
      const kinds = classifyLines(lines[name], o.allowEmails);
      if (!kinds.length) return;
      kinds.forEach((k) => { counts[k]++; });
      hits.push({ name: path.basename(files[i]), kinds: kinds });
    });
    return { frames: names.length, hits: hits, counts: counts };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { scanVideo: scanVideo, scanImages: scanImages, classifyLines: classifyLines };
