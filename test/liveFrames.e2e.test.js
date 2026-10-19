'use strict';
// End to end, in real headless Chrome: a page on 127.0.0.1 embeds an iframe
// from localhost. Different sites, so Chrome runs the iframe out of process,
// exactly like Salesforce Setup's content frame inside Lightning. Skips when
// Chrome or ffmpeg is missing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { runDemo } = require('../vendor/demo-suite/lib/recorder.js');
const { buildCameraClientJs } = require('../vendor/demo-suite/lib/cameraClient.js');

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
let FFMPEG = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (err) { FFMPEG = false; }
const skip = !CHROME || !FFMPEG || process.env.DEMO_SKIP_E2E ? 'needs Chrome and ffmpeg' : false;

const FRAME_HTML = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<x-search></x-search>
<table><tr><td>Alex Admin</td><td id="user">alex.admin@example.invalid</td></tr></table>
<p>Revenue Execution Viewer</p>
<script>
customElements.define('x-search', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<input placeholder="Quick Find" style="margin:40px 0 0 30px;width:220px;height:28px">' +
      '<div style="margin:30px 0 0 30px"><input type="button" value="Manage Assignments" style="height:30px"></div>';
    root.querySelector('input[type=button]').addEventListener('click', () => { window.clicks = (window.clicks || 0) + 1; });
    root.querySelector('input').addEventListener('keydown', () => { window.keydowns = (window.keydowns || 0) + 1; });
  }
});
</script></body></html>`;

const topHtml = (framePort) => `<!doctype html><html><body style="margin:0;font:16px sans-serif;background:#fff">
<div id="oneHeader" style="height:60px;background:#eef">Signed in as pat@example.com</div>
<button title="App Launcher" style="margin:20px">::</button>
<iframe title="Permission Sets ~ Test" src="http://localhost:${framePort}/frame.html"
  style="position:absolute;left:200px;top:150px;width:900px;height:500px;border:3px solid #ccc"></iframe>
</body></html>`;

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('live frames: real typing, a cursor click, spotlight and redaction inside a cross-site iframe', { skip, timeout: 90000 }, async () => {
  const frameServer = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end(FRAME_HTML); });
  const fport = frameServer.address().port;
  const topServer = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end(topHtml(fport)); });
  const tport = topServer.address().port;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-live-e2e-'));
  const seen = {};
  try {
    const result = await runDemo(async (rec) => {
      await rec.go('http://127.0.0.1:' + tport + '/');
      await rec.waitFor({ text: 'Manage Assignments', frame: 'child' }, { maxMs: 15000 });
      seen.oopif = (await rec.inFrames('location.port')).some((r) => !r.top && r.value === String(fport));
      await rec.redact([['Alex Admin', 'Avery Admin']], { maskEmails: true });
      await rec.beat('B1', { say: 'Type in “Quick Find”, then open “Manage Assignments”.' });
      await rec.type({ text: 'Quick Find', frame: 'child' }, 'Perm Sets');
      await rec.spot({ text: 'Manage Assignments' }, 200);
      seen.ring = await rec.run('(function(){var s=document.getElementById("__demoSpot").style;return [s.left,s.top];})()');
      seen.button = await rec.find({ text: 'Manage Assignments' });
      await rec.click({ text: 'Manage Assignments' });
      await rec.hold(300);
      await rec.endBeat();
      seen.state = await rec.inFrames('({typed:(function(){var h=document.querySelector("x-search");return h?h.shadowRoot.querySelector("input").value:null;})(),clicks:window.clicks||0,keydowns:window.keydowns||0,user:(document.getElementById("user")||{}).textContent||null})');
      seen.header = await rec.run('document.getElementById("oneHeader").textContent');
      seen.cursor = await rec.run('!!document.getElementById("__demoCursor")');
      seen.audit = await rec.audit('end');
    }, {
      outDir, width: 1280, height: 720, fps: 30, frames: true, cursor: true, burnCaptions: false,
      strictSubjects: true, chromePath: CHROME,
      topFrameJs: buildCameraClientJs({ captionHeight: 0, margin: 8 }) + ';__band("Test",60);',
    });
    const frame = seen.state.find((r) => !r.top).value;
    assert.ok(seen.oopif, 'the iframe is a separate site');
    assert.strictEqual(frame.typed, 'Perm Sets', 'real keystrokes reached the field inside the shadow root of a cross-site iframe');
    assert.strictEqual(frame.keydowns, 9, 'one keydown per character');
    assert.strictEqual(frame.clicks, 1, 'the cursor click landed on the button in the iframe');
    assert.strictEqual(frame.user, '••••••', 'the username is masked inside the iframe');
    assert.strictEqual(seen.header.result.value, 'Signed in as ••••••', 'and in the top frame');
    assert.ok(seen.cursor.result.value, 'the cursor overlay is on screen');
    // Ring = the button's top-frame rect (iframe at 200,150 + 3px border) less 12px padding.
    const b = seen.button.rect;
    assert.ok(b.l > 203 && b.t > 153, 'the iframe offset is applied');
    assert.deepStrictEqual(seen.ring.result.value, [Math.round(b.l - 12) + 'px', Math.round(b.t - 12) + 'px']);
    assert.strictEqual(seen.audit.email, 0);
    assert.strictEqual(seen.audit.redactLeft, 0);
    assert.deepStrictEqual(result.beats.map((x) => [x.key, x.misses.length]), [['B1', 0]]);
    assert.ok(fs.statSync(result.outPath).size > 1000, 'the take rendered');
  } finally {
    frameServer.close(); topServer.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the wording preflight fails before filming, with a script-vs-screen diff', { skip, timeout: 60000 }, async () => {
  const frameServer = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end(FRAME_HTML); });
  const fport = frameServer.address().port;
  const topServer = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end(topHtml(fport)); });
  const tport = topServer.address().port;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-live-pre-'));
  try {
    const board = async (rec) => {
      await rec.go('http://127.0.0.1:' + tport + '/');
      await rec.waitFor({ text: 'Manage Assignments', frame: 'child' }, { maxMs: 15000 });
      await rec.redact([], { maskEmails: true });
      // "App Launcher" sits just below the band; the header text sits under it.
      await rec.beat('B1', { say: 'Open “App Launcher”.', labels: ['App Launcher', 'Signed in as'] });
      await rec.beat('B2', { say: 'Open “Revenue Execution Viewer”, then “Manage Assignment”.' });
    };
    const opts = { outDir, width: 1280, height: 720, frames: true, burnCaptions: false, dryRun: true, chromePath: CHROME,
      topFrameJs: buildCameraClientJs({ captionHeight: 0, margin: 8 }) + ';__band("Test","#oneHeader");' };
    await assert.rejects(runDemo(board, opts), (err) => {
      assert.match(err.message, /^Wording preflight FAILED: 2 of 4 label\(s\) not on screen as scripted/);
      assert.match(err.message, /- script: "Signed in as" {3}screen: covered/);
      assert.match(err.message, /B2 {2}"Open Revenue Execution Viewer, then Manage Assignment\."/);
      assert.match(err.message, /- script: "Manage Assignment" {3}screen: missing {3}closest on screen: "Manage Assignments"/);
      assert.ok(!/script: "App Launcher"|script: "Revenue Execution Viewer"/.test(err.message), 'labels on screen pass');
      assert.ok(!fs.readdirSync(outDir).some((x) => x.endsWith('.mp4')), 'nothing was filmed');
      return true;
    });
  } finally {
    frameServer.close(); topServer.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
