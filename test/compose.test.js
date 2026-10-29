'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { mixArgs, loudnormFilter, loudnessReport, buildSoundtrack } = require('../vendor/demo-suite/lib/audioMaster.js');
const { assertOverlaySafe, speechBounds, renderComposition } = require('../vendor/demo-suite/lib/compose.js');
const { runDemo, stillRect } = require('../vendor/demo-suite/lib/recorder.js');
const { buildCameraClientJs } = require('../vendor/demo-suite/lib/cameraClient.js');
const { wordDiff, KNOWN_ASR_QUIRKS } = require('../vendor/demo-suite/lib/preflight.js');

let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (err) { ffmpeg = false; }
let swift = true;
try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); } catch (err) { swift = false; }
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const e2e = !ffmpeg || !swift || !CHROME || process.env.DEMO_SKIP_E2E ? 'needs ffmpeg, swiftc and Chrome' : false;

const tone = (file, sec, delay) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
  'sine=frequency=220:sample_rate=24000:duration=' + sec, '-af', 'adelay=' + delay + ',apad=pad_dur=0.3,volume=-12dB', '-ac', '1', file]);

test('the mix keys a ducking compressor on the voice, with a silent bed when none is licensed', () => {
  const a = mixArgs([{ file: 'a.wav', atMs: 300 }, { file: 'b.wav', atMs: 2000 }], 6, 'out.wav');
  const graph = a[a.indexOf('-filter_complex') + 1];
  assert.ok(a.includes('anullsrc=r=48000:cl=stereo'), 'a silent bed');
  assert.ok(/\[bed\]\[key\]sidechaincompress/.test(graph), 'the voice ducks the bed');
  assert.ok(/adelay=300\|300/.test(graph) && /adelay=2000\|2000/.test(graph));
  assert.ok(/pan=stereo\|c0=c0\|c1=c0/.test(graph), 'mono narration, centred in stereo');
  const b = mixArgs([{ file: 'a.wav', atMs: 0 }], 6, 'out.wav', { file: 'bed.m4a' });
  assert.deepStrictEqual(b.slice(b.indexOf('-stream_loop'), b.indexOf('-stream_loop') + 4), ['-stream_loop', '-1', '-i', 'bed.m4a'], 'a licensed bed loops');
  assert.ok(/linear=true/.test(loudnormFilter({ input_i: -20, input_tp: -1, input_lra: 3, input_thresh: -30, target_offset: 0 })));
});

test('the soundtrack masters to -16 LUFS, under -1.5 dBTP, 48 kHz stereo', { skip: !ffmpeg && 'needs ffmpeg', timeout: 60000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-audio-'));
  tone(path.join(dir, 'a.wav'), 1.5, 250);
  tone(path.join(dir, 'b.wav'), 2, 300);
  const wav = buildSoundtrack([{ file: path.join(dir, 'a.wav'), atMs: 200 }, { file: path.join(dir, 'b.wav'), atMs: 2600 }], 6, path.join(dir, 's.wav'));
  const r = loudnessReport(wav);
  assert.ok(Math.abs(r.lufs + 16) <= 1, 'integrated ' + r.lufs);
  assert.ok(r.truePeakDb <= -1.4, 'true peak ' + r.truePeakDb);
  assert.strictEqual(r.sampleRate, 48000);
  assert.strictEqual(r.layout, 'stereo');
  const sp = speechBounds(path.join(dir, 'b.wav'), 2.6);
  assert.ok(Math.abs(sp[0] - 0.3) < 0.06 && Math.abs(sp[1] - 2.3) < 0.06, 'speech bounds ' + sp);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('titles and cards may never carry an email, a URL or an id', () => {
  const tl = (text) => ({ shots: [{ key: 'A', title: text }] });
  assert.strictEqual(assertOverlaySafe(tl('Late deals, owners, next steps')), 1);
  assert.strictEqual(assertOverlaySafe({ shots: [{ key: 'E', type: 'end', lines: [{ text: 'revenue.opsgs.com' }] }] }), 1, 'the public site is fine');
  assert.throws(() => assertOverlaySafe(tl('Ask pat@example.invalid')), /email/);
  assert.throws(() => assertOverlaySafe(tl('https://acme.my.salesforce.com')), /url/);
  assert.throws(() => assertOverlaySafe(tl('Org 00D5g000004XyZaEAK')), /orgId/);
});

test('known Whisper quirks are accepted and listed; real misses still fail', () => {
  const ok = wordDiff('Become a partner at revenue dot opsgs dot com.', 'Become a partner at revenue.opsgs.com.', { accept: KNOWN_ASR_QUIRKS });
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.accepted.length >= 1);
  const bad = wordDiff('Close reasons shows the reasons.', 'Clothes reasons shows the reasons.', { accept: KNOWN_ASR_QUIRKS });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(wordDiff('a dot b', 'a b').ok, false, 'without the list, nothing is excused');
});

test('stillRect pads, shifts below the band and clamps to the still', () => {
  assert.deepStrictEqual(stillRect({ l: 10, t: 120, r: 50, b: 140 }, 4, 100, 1920, 1080), [6, 16, 54, 44]);
  assert.deepStrictEqual(stillRect({ l: -5, t: 90, r: 2000, b: 1100 }, [2, 8, 2, 8], 100, 1920, 1080), [0, 0, 1920, 980]);
});

test('capture → compose: audited 2x stills below the band, then a tagged BT.709 stereo film', { skip: e2e, timeout: 300000 }, async () => {
  const page = '<!doctype html><html><body style="margin:0;font:16px sans-serif">' +
    '<div id="hdr" style="height:60px;background:#333;color:#fff">Global header</div>' +
    '<h1 style="margin:20px">Product mix</h1><table style="margin:20px"><tr id="row"><td>Data Governance [Fictional]</td><td>Needs help</td></tr></table>' +
    '<button id="go" style="margin:20px" onclick="document.querySelector(\'h1\').textContent=\'Close reasons\'">Open</button>' +
    '<div style="height:900px"></div><div id="mark" style="width:200px;height:80px;background:rgb(255,0,0)"></div><div style="height:900px"></div></body></html>';
  const server = await new Promise((resolve) => { const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-capture-'));
  try {
    const cap = await runDemo(async (rec) => {
      await rec.go('http://127.0.0.1:' + server.address().port + '/');
      await rec.run('__band("", "#hdr"),true');
      await rec.beat('ONE', { say: 'The “Product mix” flags it.' });
      await rec.still('mix', { subjects: { row: { q: '#row', pad: 4 }, go: { q: '#go' } } });
      await rec.click({ q: '#go' });
      await rec.still('reasons', { subjects: { title: { text: 'Close reasons' } } });
      await rec.run('window.scrollTo(0, 900),true');
      await rec.still('scrolled', { subjects: { mark: { q: '#mark' } } });
    }, { outDir: dir, width: 960, height: 540, frames: true, chromePath: CHROME, capture: { dir: dir },
      topFrameJs: buildCameraClientJs({ captionHeight: 0, margin: 8 }) });
    assert.strictEqual(cap.capture, true);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(m.stills), ['mix', 'reasons', 'scrolled']);
    // A scrolled page: the subject's box and the pixels agree (the red marker sits there).
    const mk = m.stills.scrolled.subjects.mark;
    const px = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, m.stills.scrolled.file), '-vf',
      'crop=1:1:' + (mk[0] + mk[2]) + ':' + (mk[1] + mk[3]), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    assert.deepStrictEqual(Array.from(px), [255, 0, 0], 'the still shows the scrolled viewport');
    assert.strictEqual(m.stills.mix.height, 480, 'clipped below the 60 px header');
    assert.ok(m.stills.mix.subjects.row[1] > 0 && m.stills.mix.subjects.row[1] < 200, 'subject boxes in still px');
    assert.ok(m.audits.every((a) => a.ok) && m.scan.hits === 0);
    assert.ok(!/127\.0\.0\.1|http/.test(JSON.stringify(m)), 'no URL in the bundle');
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, m.stills.mix.file)], { encoding: 'utf8' }).trim();
    assert.strictEqual(dims, '1920,960', '2x device pixels');

    tone(path.join(dir, 'one.wav'), 1.2, 200);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ clips: { ONE: { file: path.join(dir, 'one.wav'), seconds: 1.7 } } }));
    const out = path.join(dir, 'film.mp4');
    const r = await renderComposition({ captureDir: dir, voManifestPath: path.join(dir, 'manifest.json'), words: { ONE: [{ w: 'The', s: 0.2 }, { w: 'flags', s: 0.8 }] },
      timeline: { shots: [{ key: 'ONE', still: 'mix', title: 'Products losing more', moves: [{ focus: 'row', word: 'flags' }, { click: 'go', then: 'reasons', at: 1400 }] }], tailMs: 300 },
      aspect: '1:1', outFile: out, chromePath: CHROME });
    assert.ok(r.frames > 20);
    const v = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,color_range,color_space,channels', '-of', 'compact', out], { encoding: 'utf8' });
    assert.ok(/width=1080\|height=1080\|color_range=tv\|color_space=bt709/.test(v), v);
    assert.ok(/channels=2/.test(v), 'stereo');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live takes deliver limited-range BT.709 video and a stereo master at -16 LUFS', { skip: e2e, timeout: 180000 }, async () => {
  const server = await new Promise((resolve) => { const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><body style="background:#fff"><h1>Pipeline Schedule</h1></body>'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-live-'));
  try {
    tone(path.join(dir, 'one.wav'), 1.5, 200);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ clips: { ONE: { file: path.join(dir, 'one.wav'), seconds: 2, text: 'Pipeline Schedule.' } } }));
    const r = await runDemo(async (rec) => {
      await rec.go('http://127.0.0.1:' + server.address().port + '/');
      await rec.beat('ONE', { say: 'Pipeline Schedule.' });
      for (let i = 0; i < 24; i++) await rec.hold(100);
    }, { outDir: dir, outFile: 'take.mp4', width: 640, height: 360, fps: 10, frames: true, burnCaptions: false, chromePath: CHROME,
      voManifestPath: path.join(dir, 'manifest.json'), topFrameJs: buildCameraClientJs({ captionHeight: 0, margin: 8 }) });
    const v = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=color_range,color_space,channels', '-of', 'compact', r.outPath], { encoding: 'utf8' });
    assert.ok(/color_range=tv\|color_space=bt709/.test(v), v);
    const l = loudnessReport(r.outPath);
    assert.strictEqual(l.layout, 'stereo');
    assert.ok(Math.abs(l.lufs + 16) <= 1.5 && l.truePeakDb <= -1.4, JSON.stringify(l));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
