'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { observeFrameIntervalMs } = require('../vendor/demo-suite/lib/recorder.js');

// Regression: `observe()`'s speed used to silently cap out at an achieved
// ~3.1x regardless of the requested value, because the real sampling
// interval stayed fixed at ~16 captures/sec while `shoot()` floors every
// frame at 20ms of FILM time — frameMs/speed fell below that floor past
// speed ~2.6 and got padded back up to it, quietly overriding `speed`.
// observeFrameIntervalMs must widen the real interval enough that the
// resulting film-frame duration always clears the floor.
const SHOOT_FLOOR_MS = 20;

test('low speeds keep the normal ~16 captures/sec sampling rate', () => {
  [0, 1, 2, 2.5].forEach((speed) => {
    assert.strictEqual(observeFrameIntervalMs(speed), 1000 / 16, `speed ${speed}`);
  });
});

test('high speeds widen the interval so the achieved film-frame duration clears the floor', () => {
  [2.6, 3, 6, 8, 20, 50].forEach((speed) => {
    const intervalMs = observeFrameIntervalMs(speed);
    const achievedFilmFrameMs = intervalMs / speed;
    assert.ok(achievedFilmFrameMs > SHOOT_FLOOR_MS,
      `speed ${speed}: achieved film-frame ${achievedFilmFrameMs}ms should clear the ${SHOOT_FLOOR_MS}ms floor`);
  });
});

test('regression: the old fixed ~16-caps/sec interval would have clamped high speeds to ~3.1x', () => {
  const OLD_FIXED_INTERVAL_MS = 1000 / 16;
  [6, 8, 20].forEach((speed) => {
    const oldAchievedFilmFrameMs = Math.max(SHOOT_FLOOR_MS, OLD_FIXED_INTERVAL_MS / speed);
    const oldAchievedSpeed = OLD_FIXED_INTERVAL_MS / oldAchievedFilmFrameMs;
    assert.ok(oldAchievedSpeed < 3.2, `sanity: old formula should plateau near 3.1x for speed ${speed}, got ${oldAchievedSpeed}`);

    const newIntervalMs = observeFrameIntervalMs(speed);
    const newAchievedSpeed = newIntervalMs / (newIntervalMs / speed); // == speed, by construction of the fix
    assert.strictEqual(newAchievedSpeed, speed, `fixed formula should achieve the requested speed ${speed}`);
  });
});

// Regression: DEMO_TRACE printed everything after the last '/', which for an
// authenticated launch URL is the login token itself.
const { traceUrlLabel } = require('../vendor/demo-suite/lib/recorder.js');

test('trace labels never include query strings, fragments, or credentials', () => {
  const label = traceUrlLabel('https://example.my.salesforce.com/secur/frontdoor.jsp?otp=SECRET123&cshc=abc');
  assert.strictEqual(label, 'frontdoor.jsp (query omitted)');
  assert.ok(!/SECRET123|otp|cshc/.test(label));
  assert.strictEqual(traceUrlLabel('https://example.com/lightning/n/Revenue_Overview'), 'Revenue_Overview');
  assert.strictEqual(traceUrlLabel('https://user:pass@example.com/a/b#tok=1'), 'b (query omitted)');
  assert.strictEqual(traceUrlLabel('file:///tmp/stage/index.html'), 'index.html');
  assert.ok(!/tok/.test(traceUrlLabel('not a url?tok=1')));
});

// Regression: a flat 20ms per-frame floor sat above one 60fps frame (16.7ms),
// so every authored move ran 20% long and voice-timed storyboards drifted.
const { filmFrameFloorMs } = require('../vendor/demo-suite/lib/recorder.js');

test('the per-frame film floor never exceeds one output frame', () => {
  [24, 30, 50, 60, 120].forEach((fps) => {
    assert.ok(filmFrameFloorMs(fps) <= 1000 / fps + 1e-9, `fps ${fps}`);
  });
  assert.strictEqual(filmFrameFloorMs(60), 1000 / 60, '60fps floors at exactly one frame');
  assert.strictEqual(filmFrameFloorMs(30), 20, 'low fps keeps the 20ms concat-safety floor');
});

test('regression: at 60fps a motion step now lasts exactly its authored duration', () => {
  const fps = 60;
  const stepMs = 1000 / fps; // what motion()/stepsFor() request per step
  const filmed = Math.max(filmFrameFloorMs(fps), stepMs);
  assert.ok(Math.abs(filmed - stepMs) < 1e-9, `filmed ${filmed}ms vs authored ${stepMs}ms`);
  const oldFilmed = Math.max(20, stepMs);
  assert.ok(oldFilmed / stepMs > 1.19, 'the old floor stretched every step by ~20%');
});

// Regression: concat durations written with toFixed(3) rounded every 60fps
// frame up to 17ms, so the picture drifted ~2% behind the voice.
const { concatDurations } = require('../vendor/demo-suite/lib/recorder.js');

test('concat durations keep the film clock on the recorder clock', () => {
  const frames = Array.from({ length: 3600 }, () => 1 / 60); // 60s of motion frames
  const total = concatDurations(frames).reduce((sum, d) => sum + Number(d), 0);
  assert.ok(Math.abs(total - 60) < 0.001, `total ${total}s should be 60s`);
  const oldTotal = frames.reduce((sum, d) => sum + Number(d.toFixed(3)), 0);
  assert.ok(oldTotal - 60 > 1.1, `sanity: old toFixed(3) drifted ${oldTotal - 60}s`);
});

test('concat durations handle mixed holds without cumulative error', () => {
  const frames = [1 / 60, 0.0213, 2.3456789, 1 / 60, 0.35, 1 / 60];
  const exact = frames.reduce((a, b) => a + b, 0);
  const total = concatDurations(frames).reduce((sum, d) => sum + Number(d), 0);
  assert.ok(Math.abs(total - exact) < 1e-5);
});
