'use strict';
/**
 * voices.js — live macOS voice listing. narrate.js has its own parser but
 * does not export it, so the same `say -v ?` parse is reproduced here (~10
 * lines). Cloud voice catalogs are static (shared/voicesCatalog.js).
 */
const { execFile } = require('child_process');

function listSayVoices(env) {
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { env, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve([]); // not macOS, or say missing — empty list, UI copes
      const out = [];
      String(stdout).split('\n').forEach(line => {
        const m = /^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2,}(?:[_-][a-z0-9]+)?)\s/.exec(line);
        if (m) out.push({ id: m[1].trim(), label: m[1].trim(), locale: m[2] });
      });
      resolve(out);
    });
  });
}

module.exports = { listSayVoices };
