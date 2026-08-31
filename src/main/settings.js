'use strict';
/**
 * settings.js — app settings with API keys encrypted at rest. Pure logic
 * with injected deps (file path + safeStorage) so it tests under bare node.
 * Raw keys exist only transiently: the renderer sends them over settings:set,
 * they are encrypted immediately, and decryption happens only at job-spawn
 * time in env.js. settings:get never returns more than {set, last4}.
 */
const fs = require('fs');
const path = require('path');

const KEY_FIELDS = { googleTtsKey: 'googleTtsKeyEnc', geminiKey: 'geminiKeyEnc' };

const DEFAULTS = {
  // Empty means "use the demo-suite engine bundled with the app"
  // (vendor/demo-suite); set a path only to develop against a live checkout.
  demoSuitePath: '',
  chromePath: '',
  framingModel: 'gemini-3.6-flash',
  defaultEngine: 'google',
  defaultVoice: 'en-US-Chirp3-HD-Charon',
  recentProjects: [],
  googleTtsKeyEnc: '', googleTtsKeyLast4: '',
  geminiKeyEnc: '', geminiKeyLast4: '',
};

function createSettings(deps) {
  const file = deps.file;
  const safeStorage = deps.safeStorage;

  function load() {
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { /* first run */ }
    return Object.assign({}, DEFAULTS, stored);
  }

  function persist(s) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  }

  /** Apply a partial update; raw key fields are encrypted here and never stored. */
  function save(partial) {
    const s = load();
    Object.keys(partial || {}).forEach(k => {
      if (KEY_FIELDS[k]) {
        const raw = String(partial[k] || '').trim();
        if (!raw) { s[KEY_FIELDS[k]] = ''; s[k + 'Last4'] = ''; return; }
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('macOS keychain encryption is unavailable — refusing to store the key in plain text');
        }
        s[KEY_FIELDS[k]] = safeStorage.encryptString(raw).toString('base64');
        s[k + 'Last4'] = raw.slice(-4);
      } else if (k in DEFAULTS) {
        s[k] = partial[k];
      }
    });
    persist(s);
    return masked(s);
  }

  /** What the renderer is allowed to see. */
  function masked(s) {
    const cur = s || load();
    const out = {};
    Object.keys(DEFAULTS).forEach(k => {
      if (!k.endsWith('Enc') && !k.endsWith('Last4')) out[k] = cur[k];
    });
    Object.keys(KEY_FIELDS).forEach(k => {
      out[k] = { set: !!cur[KEY_FIELDS[k]], last4: cur[k + 'Last4'] || '' };
    });
    return out;
  }

  /** Decrypt stored keys → env-var map. Only env.js calls this, at spawn time. */
  function decryptKeys() {
    const s = load();
    const out = {};
    if (s.googleTtsKeyEnc) out.GOOGLE_TTS_KEY = safeStorage.decryptString(Buffer.from(s.googleTtsKeyEnc, 'base64'));
    if (s.geminiKeyEnc) out.GEMINI_TTS_KEY = safeStorage.decryptString(Buffer.from(s.geminiKeyEnc, 'base64'));
    return out;
  }

  function rememberProject(dir) {
    const s = load();
    s.recentProjects = [dir].concat((s.recentProjects || []).filter(p => p !== dir)).slice(0, 8);
    persist(s);
    return s.recentProjects;
  }

  return { load, save, masked, decryptKeys, rememberProject };
}

module.exports = { createSettings, DEFAULTS, KEY_FIELDS };
