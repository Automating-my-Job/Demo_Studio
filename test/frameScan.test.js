'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { classifyLines, scanVideo } = require('../vendor/demo-suite/lib/frameScan.js');
const { runDemo } = require('../vendor/demo-suite/lib/recorder.js');
const { buildCameraClientJs } = require('../vendor/demo-suite/lib/cameraClient.js');

test('classifyLines names never-show categories and ignores ordinary Setup text', () => {
  assert.deepStrictEqual(classifyLines(['Alex Admin', 'Revenue Execution Viewer', '1-9 of 9', 'Current Assignments']), []);
  assert.deepStrictEqual(classifyLines(['alex.admin@example.invalid']), ['email']);
  assert.deepStrictEqual(classifyLines(['acme.my.salesforce.com/lightning']), ['url']);
  assert.deepStrictEqual(classifyLines(['Org 00D5g000004XyZ1']), ['orgId', 'recordId']);
  assert.deepStrictEqual(classifyLines(['0PS5g000000AbCd Clone']), ['recordId']);
  assert.deepStrictEqual(classifyLines(['Consumer Secret']), ['sensitivePage']);
  assert.deepStrictEqual(classifyLines(['New User', 'Reset Password(s)', 'Add Multiple Users']), [], 'a button label is not a password');
  assert.deepStrictEqual(classifyLines(['Forgot Your Password?']), ['sensitivePage'], 'a sign-in page is');
  assert.deepStrictEqual(classifyLines(['Need help? support@opsgs.com'], ['support@opsgs.com']), [], 'an allowed public address');
  assert.deepStrictEqual(classifyLines(['support@opsgs.com, pat@example.invalid'], ['support@opsgs.com']), ['email'], 'any other address still counts');
});

let tools = true;
try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (err) { tools = false; }
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const skip = !tools || !CHROME || process.env.DEMO_SKIP_E2E ? 'needs swiftc, ffmpeg and Chrome' : false;

test('scanVideo reads the frames: an unredacted email is caught, the redacted take is clean', { skip, timeout: 180000 }, async () => {
  const page = '<!doctype html><body style="margin:60px;font:28px sans-serif;background:#fff">' +
    '<h1>Current Assignments</h1><p>Alex Admin</p><p id="u">alex.admin@example.invalid</p></body>';
  const server = await new Promise((resolve) => { const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-scan-'));
  const take = async (redact) => runDemo(async (rec) => {
    await rec.go('http://127.0.0.1:' + server.address().port + '/');
    await rec.waitFor({ text: 'Current Assignments', frame: 'top' }, { maxMs: 10000 });
    if (redact) await rec.redact([], { maskEmails: true });
    for (let i = 0; i < 12; i++) await rec.hold(125);   // a still is one frame; the recorder wants ten
  }, { outDir, outFile: redact ? 'clean.mp4' : 'leak.mp4', width: 960, height: 540, fps: 10, frames: true, burnCaptions: false,
    chromePath: CHROME, topFrameJs: buildCameraClientJs({ captionHeight: 0, margin: 8 }) });
  try {
    const leak = scanVideo((await take(false)).outPath, { fps: 2 });
    assert.ok(leak.frames >= 2);
    assert.ok(leak.counts.email >= 1, 'the positive control: OCR sees the address');
    assert.ok(leak.hits.every((h) => typeof h.atSec === 'number' && Array.isArray(h.kinds)), 'times and kinds only');
    const clean = scanVideo((await take(true)).outPath, { fps: 2 });
    assert.deepStrictEqual(clean.hits, [], 'redacted before every frame: nothing to find');
  } finally {
    server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
