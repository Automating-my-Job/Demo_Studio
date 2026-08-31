'use strict';
/**
 * env.js — builds the environment for every child process the app spawns.
 * Two jobs: (1) a Finder-launched .app inherits launchd's PATH, which lacks
 * /opt/homebrew/bin — where this machine's ffmpeg/ffprobe live — so it is
 * prepended for every child; (2) stored API keys are decrypted here, at
 * spawn time, and injected as the env vars narrate.js checks FIRST, so app
 * keys win over ~/.google_tts_key dotfiles with zero library changes (and
 * with no stored key the dotfiles keep working untouched).
 */
const PATH_PREPEND = ['/opt/homebrew/bin', '/usr/local/bin'];

function buildPath(basePath) {
  const base = basePath || '/usr/bin:/bin:/usr/sbin:/sbin';
  const parts = base.split(':');
  const add = PATH_PREPEND.filter(p => parts.indexOf(p) === -1);
  return add.concat(parts).join(':');
}

/**
 * @param {object} baseEnv - usually process.env.
 * @param {{decryptKeys: () => object}} settings
 */
function buildChildEnv(baseEnv, settings) {
  const env = Object.assign({}, baseEnv);
  env.PATH = buildPath(env.PATH);
  const keys = settings ? settings.decryptKeys() : {};
  Object.keys(keys).forEach(k => { env[k] = keys[k]; });
  return env;
}

module.exports = { buildChildEnv, buildPath, PATH_PREPEND };
