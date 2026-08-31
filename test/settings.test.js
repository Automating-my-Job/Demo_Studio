'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../src/main/settings.js');
const { buildChildEnv, buildPath } = require('../src/main/env.js');

/** Reversible stand-in for Electron's safeStorage. */
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: b => { const s = b.toString('utf8'); if (!s.startsWith('ENC:')) throw new Error('bad blob'); return s.slice(4); },
};

function freshSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-settings-'));
  return createSettings({ file: path.join(dir, 'settings.json'), safeStorage: mockSafeStorage });
}

test('keys round-trip through encryption; raw never lands on disk', () => {
  const s = freshSettings();
  s.save({ googleTtsKey: 'test-google-key-1234' });
  const onDisk = s.load();
  assert.ok(!JSON.stringify(onDisk).includes('test-google-key-1234'));
  assert.deepStrictEqual(s.decryptKeys(), { GOOGLE_TTS_KEY: 'test-google-key-1234' });
});

test('masked exposes only set/last4', () => {
  const s = freshSettings();
  s.save({ geminiKey: 'test-gemini-key-9876' });
  const m = s.masked();
  assert.deepStrictEqual(m.geminiKey, { set: true, last4: '9876' });
  assert.deepStrictEqual(m.googleTtsKey, { set: false, last4: '' });
  assert.ok(!('geminiKeyEnc' in m));
});

test('an empty key clears the stored one', () => {
  const s = freshSettings();
  s.save({ googleTtsKey: 'abc123' });
  s.save({ googleTtsKey: '' });
  assert.deepStrictEqual(s.decryptKeys(), {});
  assert.strictEqual(s.masked().googleTtsKey.set, false);
});

test('refuses to store keys when encryption is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-settings-'));
  const s = createSettings({
    file: path.join(dir, 'settings.json'),
    safeStorage: Object.assign({}, mockSafeStorage, { isEncryptionAvailable: () => false }),
  });
  assert.throws(() => s.save({ googleTtsKey: 'x' }), /refusing/);
});

test('non-key settings persist and unknown fields are ignored', () => {
  const s = freshSettings();
  s.save({ chromePath: '/opt/chrome', hackField: 'nope' });
  assert.strictEqual(s.load().chromePath, '/opt/chrome');
  assert.strictEqual(s.load().hackField, undefined);
});

test('rememberProject keeps a deduped, capped MRU list', () => {
  const s = freshSettings();
  s.rememberProject('/a'); s.rememberProject('/b'); s.rememberProject('/a');
  assert.deepStrictEqual(s.load().recentProjects, ['/a', '/b']);
});

test('buildPath prepends homebrew without duplicating', () => {
  assert.strictEqual(buildPath('/usr/bin:/bin'), '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  assert.strictEqual(buildPath('/opt/homebrew/bin:/usr/bin'), '/usr/local/bin:/opt/homebrew/bin:/usr/bin');
});

test('buildChildEnv injects decrypted keys only when stored', () => {
  const s = freshSettings();
  let env = buildChildEnv({ PATH: '/usr/bin' }, s);
  assert.strictEqual(env.GOOGLE_TTS_KEY, undefined);
  s.save({ googleTtsKey: 'k123' });
  env = buildChildEnv({ PATH: '/usr/bin' }, s);
  assert.strictEqual(env.GOOGLE_TTS_KEY, 'k123');
  assert.ok(env.PATH.startsWith('/opt/homebrew/bin'));
});
