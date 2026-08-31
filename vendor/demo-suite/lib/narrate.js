#!/usr/bin/env node
'use strict';
/**
 * narrate.js — turns a demo's narration script into timed audio clips.
 * NODE-ONLY.
 *
 * Usage (CLI):
 *   node narrate.js --script=./narration.js --outDir=./demo-out/vo --engine=google --voice="en-US-Chirp3-HD-Charon"
 *   node narrate.js --script=./narration.js --list          show installed macOS voices
 *
 * `--script` must point at a Node module exporting an object shaped like:
 *   module.exports = {
 *     '__SOME_KEY__': { text: 'What is actually said.', voice: 'Zoe (Premium)' },
 *     ...
 *   };
 * The object's keys are arbitrary IDs your storyboard passes to `rec.say()`
 * as `voKey` — they do not have to match the on-screen caption. `voice` on
 * an entry is macOS-`say` CASTING ONLY and is ignored under other engines.
 *
 * Usage (library):
 *   const { build } = require('./narrate.js');
 *   const manifest = await build(require('./narration.js'), { outDir, engine, voice });
 *
 * ===========================================================================
 * WHY THE AUDIO IS BUILT FIRST, AND THE PICTURE TIMED TO IT
 * ===========================================================================
 * The obvious order is to record the film and then talk over it, and it is
 * the wrong one: a narrator who runs three seconds long has to be sped up or
 * cut. Speech has a natural length and a picture does not, so the speech is
 * generated first, each clip is measured, and the recorder (see
 * recorder.js's `say()`) holds each beat for as long as its line actually
 * takes. Nothing is time-stretched and nothing is clipped.
 *
 * ===========================================================================
 * THE ENGINE IS PLUGGABLE, AND THE DEFAULT MATTERS
 * ===========================================================================
 * Three engines, in the order you should actually reach for them:
 *
 *   - GOOGLE CLOUD TEXT-TO-SPEECH (Chirp3-HD), engine 'google'. THE DEFAULT
 *     HERE FOR A REASON: production-grade, 99.9% SLA, and NOT built on the
 *     autoregressive-LLM architecture that makes the next option unreliable.
 *     Needs an API key (or a service-account JSON — see synthesizeGoogle_).
 *     $30 per million characters, with 1M free per month — a typical demo
 *     script is a few thousand characters, so this is normally free.
 *
 *   - GEMINI TTS, engine 'gemini'. Read this before reaching for it: Gemini's
 *     native TTS models (both Flash and Pro tiers) have a DOCUMENTED,
 *     UNFIXED bug where they repeat a clause roughly 5-10% of the time
 *     (Google's own developer forum, "Gemini-2.5-flash-tts: Repeats text and
 *     reads out a section of the prompt" — no confirmed fix as of this
 *     writing). It happened in production use of this exact pipeline. Worse:
 *     asking another LLM to transcribe a clip and check for the repeat DOES
 *     NOT reliably catch it — the transcribing model shares the same bias
 *     toward clean output and was observed silently smoothing a real,
 *     audible duplicate away. `verifyNoRepeat_` here is kept as a
 *     best-effort check (better than nothing) but is not to be trusted as
 *     the final word — see verifyNarration.js for the check that actually
 *     works (a dedicated, non-generative ASR model). If you use this engine,
 *     run that verification, every time, on every clip.
 *
 *   - macOS `say`, engine 'say' (the default when nothing else is
 *     configured). Free, local, instant, needs no key — a pipeline that
 *     needs a cloud account to run at all is a pipeline that stops working
 *     the week the billing lapses. Also the weakest-sounding option. Premium
 *     system voices (System Settings > Accessibility > Spoken Content >
 *     Manage Voices) are a large step up and still fully local.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const B = '\x1b[1m';
const D = '\x1b[2m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const O = '\x1b[0m';

/** 0-999 in words, because a synthesiser reads "63" as "sixty three" only sometimes. */
function inWords(n) {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
    'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
    'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
    'eighty', 'ninety'];
  if (n < 20) return ones[n];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
  return ones[Math.floor(n / 100)] + ' hundred' +
    (n % 100 ? ' and ' + inWords(n % 100) : '');
}

/** Every macOS voice this machine can actually use. */
function listVoices() {
  const raw = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
  return raw.split('\n').filter(Boolean).map(line => {
    const m = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/.exec(line);
    return m ? { name: m[1].trim(), locale: m[2] } : null;
  }).filter(Boolean);
}

/**
 * BREATH MARKS. A pipe in the script becomes a real pause.
 *
 * macOS `say` accepts [[slnc N]] for N milliseconds of real silence anywhere
 * in the text — the one lever that makes a local synthesiser sound less
 * metronomic. Mark where the narrator should THINK:
 *
 *   |    a short beat, 130ms  — the pause inside a sentence, after a clause
 *   ||   a real pause, 420ms  — landing a point before moving on
 *
 * Every other engine ignores the markers, so they are stripped to a plain
 * space instead — a cloud voice paces itself better than a fixed marker can.
 */
function shapePauses_(text, engine) {
  if (engine !== 'say') return text.replace(/\s*\|\|?\s*/g, ' ').trim();
  return text
    .replace(/\s*\|\|\s*/g, ' [[slnc 420]] ')
    .replace(/\s*\|\s*/g, ' [[slnc 130]] ')
    .trim();
}

/** macOS `say`. Writes AIFF; ffmpeg turns it into the wav everything else expects. */
function synthesizeSay_(text, outWav, opts) {
  const aiff = outWav.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', opts.voice, '-r', String(opts.rate), '-o', aiff,
    shapePauses_(text, 'say')]);
  // atempo changes tempo WITHOUT changing pitch, so a premium voice slowed to
  // 0.90 still sounds like itself, just less rushed.
  const tempo = (opts.tempo && opts.tempo > 0) ? opts.tempo : 1;
  const filt = (tempo === 1) ? [] : ['-filter:a', 'atempo=' + tempo];
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff]
    .concat(filt).concat(['-ar', '48000', '-ac', '1', outWav]));
  fs.unlinkSync(aiff);
}

/** See the module doc above before using this engine. */
function synthesizeGemini_(text, outWav, opts) {
  const key = opts.key || readKey_('GEMINI_TTS_KEY', '.gemini_tts_key');
  if (!key) {
    throw new Error('--engine=gemini needs a key. Either export GEMINI_TTS_KEY, ' +
      'or save it once with:  echo "YOUR_KEY" > ~/.gemini_tts_key && chmod 600 ~/.gemini_tts_key');
  }
  const model = opts.model || 'gemini-2.5-flash-preview-tts';
  // NO STYLE DIRECTION BY DEFAULT. A style prompt was twice observed being
  // read aloud by the model instead of followed, which is worse than useless
  // — it puts stray words in the finished clip. The default sends EXACTLY
  // the line and nothing else. Pass opts.style for a deliberate experiment;
  // it wraps the actual line in quotes so the boundary is at least explicit.
  const body = JSON.stringify({
    contents: [{ parts: [{ text: opts.style
      ? opts.style + ': "' + shapePauses_(text, 'gemini') + '"'
      : shapePauses_(text, 'gemini') }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
    },
  });
  return postWithBackoff_({
    host: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/' + model + ':generateContent',
    key: key, body: body,
  }).then(res => {
    let parsed;
    try { parsed = JSON.parse(res); } catch (err) {
      throw new Error('Gemini TTS returned non-JSON: ' + res.slice(0, 200));
    }
    const parts = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
    const inline = (parts[0] || {}).inlineData;
    if (!inline || !inline.data) throw new Error('Gemini TTS returned no audio: ' + res.slice(0, 300));
    const raw = outWav.replace(/\.wav$/, '.pcm');
    fs.writeFileSync(raw, Buffer.from(inline.data, 'base64'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw,
      '-ar', '48000', '-ac', '1', outWav]);
    fs.unlinkSync(raw);
  });
}

/**
 * A short-lived OAuth Bearer token from a Google service-account JSON key.
 *
 * The plain-API-key path (below) is simpler and is what you want if your GCP
 * org allows it. Some orgs enforce `iam.disableServiceAccountKeyCreation` —
 * a real security policy, not a bug, and not one to casually disable — in
 * which case a plain API key (Console: APIs & Services -> Credentials -> +
 * Create Credentials -> API key, restricted to the Text-to-Speech API,
 * "Authenticate through a service account" left UNCHECKED) is both simpler
 * and the only option anyway. This path exists for the org that requires
 * the opposite. No npm dependency needed — Node's `crypto` signs RS256
 * directly.
 */
let googleAccessToken_ = null;
let googleAccessTokenExpiresAt_ = 0;

function base64url_(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function googleServiceAccountToken_(keyFile) {
  const now = Date.now();
  if (googleAccessToken_ && now < googleAccessTokenExpiresAt_ - 60000) return googleAccessToken_;
  const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: iat, exp: exp,
  };
  const unsigned = base64url_(Buffer.from(JSON.stringify(header))) + '.' +
    base64url_(Buffer.from(JSON.stringify(claims)));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = base64url_(signer.sign(sa.private_key));
  const jwt = unsigned + '.' + signature;
  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
    '&assertion=' + encodeURIComponent(jwt);
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ code: r.statusCode, body: d })); });
    req.on('error', reject);
    req.write(body); req.end();
  });
  if (res.code >= 400) throw new Error('token exchange failed: HTTP ' + res.code + ': ' + res.body.slice(0, 300));
  const parsed = JSON.parse(res.body);
  googleAccessToken_ = parsed.access_token;
  googleAccessTokenExpiresAt_ = now + (parsed.expires_in || 3600) * 1000;
  return googleAccessToken_;
}

/**
 * @param {string} [opts.serviceAccountFile] - defaults to
 *   ~/.google_tts_service_account.json if it exists.
 */
async function synthesizeGoogle_(text, outWav, opts) {
  const saFile = opts.serviceAccountFile ||
    path.join(process.env.HOME || '', '.google_tts_service_account.json');
  const hasServiceAccount = fs.existsSync(saFile);
  const key = hasServiceAccount ? null : (opts.key || readKey_('GOOGLE_TTS_KEY', '.google_tts_key'));
  if (!hasServiceAccount && !key) {
    throw new Error('--engine=google needs credentials. Either a service account at ' +
      saFile + ', or a plain key: export GOOGLE_TTS_KEY, ' +
      'or save it once with:  echo "YOUR_KEY" > ~/.google_tts_key && chmod 600 ~/.google_tts_key');
  }
  // CHIRP3-HD REJECTS speakingRate (and pitch, and SSML) OUTRIGHT -- documented
  // limitation, not a bug: only the older Studio/Neural2/WaveNet families take
  // a numeric rate.
  const isChirp3Hd = /Chirp3-HD/i.test(opts.voice || '');
  const audioConfig = { audioEncoding: 'LINEAR16', sampleRateHertz: 48000 };
  if (!isChirp3Hd && opts.googleRate) audioConfig.speakingRate = opts.googleRate;
  const body = JSON.stringify({
    input: { text: shapePauses_(text, 'google') },
    voice: { languageCode: opts.languageCode || 'en-US', name: opts.voice },
    audioConfig: audioConfig,
  });
  const authHeader = hasServiceAccount ? 'Authorization' : 'x-goog-api-key';
  const authValue = hasServiceAccount ? 'Bearer ' + await googleServiceAccountToken_(saFile) : key;
  const res = await postWithBackoff_({
    host: 'texttospeech.googleapis.com', path: '/v1/text:synthesize',
    key: authValue, authHeader: authHeader, body: body,
  });
  const parsed = JSON.parse(res);
  if (!parsed.audioContent) throw new Error('Google TTS returned no audio: ' + res.slice(0, 300));
  fs.writeFileSync(outWav, Buffer.from(parsed.audioContent, 'base64'));
}

/**
 * Does this clip say its line, and say it only once? BEST-EFFORT ONLY — see
 * the module doc's warning about the Gemini engine. Kept because it catches
 * SOME repeats and costs one extra request; not trusted as suficient on its
 * own. Use verifyNarration.js (dedicated ASR) for real confidence.
 */
async function verifyNoRepeat_(file, key) {
  const model = 'gemini-3.6-flash'; // gemini-2.5-flash is deprecated (HTTP 404)
  const audioB64 = fs.readFileSync(file).toString('base64');
  const body = JSON.stringify({
    contents: [{ parts: [
      { inlineData: { mimeType: 'audio/wav', data: audioB64 } },
      { text: 'Write out every word in this audio in order, exactly as spoken. ' +
        'This is NOT a request for clean prose: if a word, phrase, or sentence ' +
        'is spoken twice, write it twice. Do not correct, clean up, paraphrase, ' +
        'or silently drop any repetition, stutter, or false start — reproduce ' +
        'the audio, not a polished version of it. Output only the words, ' +
        'nothing else.' },
    ] }],
  });
  const res = await postWithBackoff_({
    host: 'generativelanguage.googleapis.com', path: '/v1beta/models/' + model + ':generateContent',
    key: key, body: body,
  });
  let parsed;
  try { parsed = JSON.parse(res); } catch (err) { return { ok: true, reason: 'transcription returned non-JSON, not judged' }; }
  const parts = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
  const transcript = (parts[0] || {}).text || '';
  const words = transcript.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i + 8 <= words.length; i++) {
    const win = words.slice(i, i + 4).join(' ');
    for (let j = i + 4; j < Math.min(i + 11, words.length - 3); j++) {
      if (words.slice(j, j + 4).join(' ') === win) return { ok: false, reason: 'repeats "' + win + '"' };
    }
  }
  return { ok: true, transcript: transcript };
}

function sleep_(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postWithBackoff_(opts, attempt) {
  const n = attempt || 1;
  try {
    return await postJson_(opts);
  } catch (err) {
    const is429 = /HTTP 429/.test(err.message);
    const isTextInsteadOfAudio = /should only be used for TTS/i.test(err.message);
    const isServerBlip = /HTTP 50[03]|HTTP timeout/.test(err.message);
    if (isServerBlip && n <= 3) {
      process.stdout.write(D + '   server error, retrying…' + O + '\n');
      await sleep_(4000 * n);
      return postWithBackoff_(opts, n + 1);
    }
    if ((!is429 && !isTextInsteadOfAudio) || n > 20) throw err;
    if (isTextInsteadOfAudio) {
      process.stdout.write(D + '   model answered in text, retrying…' + O + '\n');
      await sleep_(2000);
      return postWithBackoff_(opts, n + 1);
    }
    const m = /"retryDelay"\s*:\s*"(\d+)s"/.exec(err.message);
    const waitMs = m ? (Number(m[1]) + 3) * 1000 : Math.min(65000, 15000 * n);
    process.stdout.write(D + '   rate limited, waiting ' + Math.round(waitMs / 1000) + 's…' + O + '\n');
    await sleep_(waitMs);
    return postWithBackoff_(opts, n + 1);
  }
}

function postJson_(opts) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(opts.body) };
    headers[opts.authHeader || 'x-goog-api-key'] = opts.key;
    const req = https.request({ hostname: opts.host, path: opts.path, method: 'POST', headers: headers }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', d => { out += d; });
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode + ': ' + out.slice(0, 300))); return; }
        resolve(out);
      });
    });
    // NO RESPONSE IS A FAILURE, NOT A WAIT — the preview TTS model sometimes
    // simply never answers; without this one dead socket froze a run for 35
    // minutes. Two minutes is generous for a clip this short.
    req.setTimeout(120000, () => req.destroy(new Error('HTTP timeout: no response after 120s')));
    req.on('error', err => reject(new Error('request failed: ' + err.message)));
    req.write(opts.body);
    req.end();
  });
}

/** An API key, from the environment or a file in the home directory (never logged). */
function readKey_(envName, fileName) {
  const all = readKeys_(envName, fileName);
  return all.length ? all[0] : '';
}

/** Every key available, one per line in the file, for round-robin rotation. */
function readKeys_(envName, fileName) {
  const out = [];
  if (process.env[envName]) out.push(String(process.env[envName]).trim());
  const file = path.join(process.env.HOME || '', fileName);
  try {
    if (fs.existsSync(file)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
        const v = line.split('#')[0].trim();
        if (v) out.push(v);
      });
    }
  } catch (err) { /* unreadable is the same as absent */ }
  return out.filter((k, i) => out.indexOf(k) === i);
}

/**
 * Strips the silence the Gemini preview model pads clips with, before any
 * judgement. Measured: a 30-word line came back as 73s of audio, 44s of it
 * one trailing silence. Leading silence cut to nothing, internal pauses
 * capped at 0.55s, tail cut with it.
 */
function trimSilence_(file) {
  const tmp = file + '.trim.wav';
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af',
    'silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.10:' +
    'stop_periods=-1:stop_threshold=-38dB:stop_silence=0.55',
    '-ar', '48000', '-ac', '1', tmp]);
  fs.renameSync(tmp, file);
}

/** Nudges a clip's spoken pace toward targetWpm with a pitch-preserving tempo change. */
function normalizeWpm_(file, text, targetWpm) {
  const words = String(text).replace(/\s*\|\|?\s*/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  const secs = durationOf(file);
  if (!secs || words < 4) return null;
  const actual = words / (secs / 60);
  const factor = actual / targetWpm;
  if (factor > 0.95 && factor < 1.05) return actual;
  const tempo = Math.max(0.88, Math.min(1.12, 1 / factor));
  const tmp = file + '.tmp.wav';
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-filter:a', 'atempo=' + tempo.toFixed(4), '-ar', '48000', '-ac', '1', tmp]);
  fs.renameSync(tmp, file);
  return words / (durationOf(file) / 60);
}

function durationOf(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return Number(String(out).trim());
}

function clipName(caption, i) {
  const slug = caption.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40).replace(/_+$/, '');
  return String(i).padStart(2, '0') + '_' + (slug || 'line') + '.wav';
}

/**
 * Builds every clip for `script` and writes a manifest.json recorder.js can
 * consume. Safe to re-run: unfinished/first-attempt failures never delete a
 * working prior build (a new set is assembled in `<outDir>.building` and
 * swapped in only on success), and a cache directory means rewording one
 * line does not re-spend quota on the rest.
 *
 * @param {Object} script - keyed like the module doc at the top of this
 *   file: { key: { text, voice? } }. `voice` on an entry is macOS-say
 *   casting only.
 * @param {Object} opts
 * @param {string} opts.outDir - where clips + manifest.json land.
 * @param {string} [opts.cacheDir] - defaults to `<outDir>/../vo-cache`.
 * @param {'say'|'gemini'|'google'} [opts.engine='say']
 * @param {string} [opts.voice]
 * @param {number} [opts.rate=172] - macOS `say` words-per-minute knob (the
 *   premium voices mostly ignore it; use opts.tempo instead).
 * @param {number} [opts.tempo=0.90] - pitch-preserving tempo for `say`.
 * @param {number} [opts.googleRate=1.0] - speakingRate for non-Chirp3-HD
 *   Google voices (Chirp3-HD ignores this; see synthesizeGoogle_).
 * @param {string} [opts.style=''] - Gemini style direction. Leave empty; see
 *   the module doc.
 * @param {number} [opts.targetWpm=0] - 0 disables all pace-correction and
 *   retake logic (Gemini engine only); ships whatever the model returns.
 * @param {number} [opts.rpm=9] - requests per minute per key, for cloud engines.
 * @param {boolean} [opts.log=true]
 * @returns {Promise<Object>} the manifest object (also written to disk).
 */
async function build(script, opts) {
  opts = opts || {};
  const engine = opts.engine || 'say';
  const voice = opts.voice ||
    (engine === 'google' ? 'en-US-Chirp3-HD-Charon' : engine === 'gemini' ? 'Charon' : 'Samantha');
  const rate = opts.rate || 172;
  const tempo = opts.tempo === undefined ? 0.90 : opts.tempo;
  const googleRate = opts.googleRate || 1.0;
  const style = opts.style || '';
  const geminiModel = opts.geminiModel || 'gemini-2.5-flash-preview-tts';
  const targetWpm = opts.targetWpm || 0;
  const log = opts.log === undefined ? true : opts.log;
  const OUT_DIR = opts.outDir;
  const CACHE_DIR = opts.cacheDir || path.join(OUT_DIR, '..', 'vo-cache');
  const MANIFEST = path.join(OUT_DIR, 'manifest.json');
  const p = (s) => { if (log) process.stdout.write(s); };

  const missingVoices = {};
  if (engine === 'say') {
    const have = listVoices().map(v => v.name);
    const wanted = [voice].concat(Object.keys(script)
      .map(k => (typeof script[k] === 'object' ? script[k].voice : null)).filter(Boolean));
    if (have.indexOf(voice) === -1) {
      throw new Error('no voice named "' + voice + '". Run with --list to see what is installed.');
    }
    wanted.slice(1).filter(v => have.indexOf(v) === -1).filter((v, i, a) => a.indexOf(v) === i)
      .forEach(v => {
        missingVoices[v] = true;
        p(Y + '  "' + v + '" is not installed — those lines will use ' + voice + O + '\n');
      });
  }

  const workDir = OUT_DIR + '.building';
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  p(B + '\nBuilding narration' + O + '\n');
  p(D + '  engine ' + engine + ', voice ' + voice +
    (engine === 'say' ? ', ' + rate + ' wpm, tempo ' + tempo : '') + O + '\n');

  const captions = Object.keys(script);
  const clips = {};
  let total = 0;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let reused = 0;
  const rpm = opts.rpm || 9;
  const KEYS = engine === 'gemini' ? readKeys_('GEMINI_TTS_KEY', '.gemini_tts_key')
    : engine === 'google' ? readKeys_('GOOGLE_TTS_KEY', '.google_tts_key') : [];
  const gapMs = Math.ceil(60000 / Math.max(1, rpm));
  const lastCallByKey = {};
  let keyIndex = 0;
  if (KEYS.length > 1) {
    p(D + '  ' + KEYS.length + ' keys in rotation — about ' + (KEYS.length * rpm) +
      ' requests a minute instead of ' + rpm + O + '\n');
  }

  async function nextKey_() {
    if (!KEYS.length) return '';
    let waited = 0;
    for (;;) {
      for (let k = 0; k < KEYS.length; k++) {
        const key = KEYS[(keyIndex + k) % KEYS.length];
        const since = Date.now() - (lastCallByKey[key] || 0);
        if (since >= gapMs) {
          keyIndex = (keyIndex + k + 1) % KEYS.length;
          lastCallByKey[key] = Date.now();
          return key;
        }
      }
      const soonest = Math.min.apply(null, KEYS.map(key => gapMs - (Date.now() - (lastCallByKey[key] || 0))));
      waited += Math.max(250, soonest);
      await sleep_(Math.max(250, soonest));
      if (waited > 180000) throw new Error('every key stayed rate limited for three minutes');
    }
  }

  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const entry = script[caption];
    const spec = (typeof entry === 'string') ? { text: entry } : entry;
    const text = spec.text;
    const lineVoice = (engine === 'say' && spec.voice && !missingVoices[spec.voice]) ? spec.voice : voice;
    const lineRate = spec.rate || rate;
    const file = path.join(workDir, clipName(caption, i));

    const fingerprint = crypto.createHash('sha256')
      .update([engine, lineVoice, engine === 'say' ? String(lineRate) + ':' + String(tempo)
        : style + ':' + geminiModel + ':' + String(targetWpm), text].join(' '))
      .digest('hex').slice(0, 24);
    const cached = path.join(CACHE_DIR, fingerprint + '.wav');

    if (fs.existsSync(cached)) {
      fs.copyFileSync(cached, file);
      reused++;
    } else {
      const key = await nextKey_();
      if (engine === 'google') await synthesizeGoogle_(text, file, { voice: lineVoice, googleRate, key, serviceAccountFile: opts.serviceAccountFile });
      else if (engine === 'gemini') await synthesizeGemini_(text, file, { voice: lineVoice, style, key, model: geminiModel });
      else synthesizeSay_(text, file, { voice: lineVoice, rate: lineRate, tempo });

      let goodTake = true;
      if (engine === 'gemini' && targetWpm > 0) {
        trimSilence_(file);
        let wpm = normalizeWpm_(file, text, targetWpm);
        let rolls = 0;
        while (wpm !== null && (wpm < targetWpm * 0.88 || wpm > targetWpm * 1.19) && rolls < 3) {
          rolls++;
          p(Y + '   bad take (' + Math.round(wpm) + ' wpm) — retake ' + rolls + ' of 3' + O + '\n');
          const key2 = await nextKey_();
          await synthesizeGemini_(text, file, { voice: lineVoice, style, key: key2, model: geminiModel });
          trimSilence_(file);
          wpm = normalizeWpm_(file, text, targetWpm);
        }
        if (wpm !== null && (wpm < targetWpm * 0.88 || wpm > targetWpm * 1.19)) {
          goodTake = false;
          p(Y + '   still ' + Math.round(wpm) + ' wpm after ' + rolls + ' retakes — used but not cached' + O + '\n');
        }
      }
      if (engine === 'gemini' && goodTake && opts.verifyRepeats !== false) {
        let verifyRolls = 0;
        let verdict = await verifyNoRepeat_(file, await nextKey_());
        while (!verdict.ok && verifyRolls < 3) {
          verifyRolls++;
          p(Y + '   ' + verdict.reason + ' — retake ' + verifyRolls + ' of 3' + O + '\n');
          const key3 = await nextKey_();
          await synthesizeGemini_(text, file, { voice: lineVoice, style, key: key3, model: geminiModel });
          if (targetWpm > 0) { trimSilence_(file); normalizeWpm_(file, text, targetWpm); }
          verdict = await verifyNoRepeat_(file, await nextKey_());
        }
        if (!verdict.ok) {
          goodTake = false;
          p(Y + '   still ' + verdict.reason + ' after ' + verifyRolls + ' retakes — used but not cached' + O + '\n');
        }
      }
      if (goodTake) fs.copyFileSync(file, cached);
    }

    const secs = durationOf(file);
    total += secs;
    clips[caption] = { file: file, seconds: secs, text: text };
    p(D + '  ' + secs.toFixed(1) + 's  ' + O + text.slice(0, 60) + (text.length > 60 ? '…' : '') + '\n');
  }
  if (reused) p(D + '  (' + reused + ' reused from cache, ' + (captions.length - reused) + ' newly synthesised)' + O + '\n');

  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.renameSync(workDir, OUT_DIR);
  Object.keys(clips).forEach(k => { clips[k].file = path.join(OUT_DIR, path.basename(clips[k].file)); });

  const manifest = { engine, voice, rate, totalSeconds: total, clips };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  p('\n  ' + G + captions.length + ' clips, ' + total.toFixed(1) + 's of narration' + O + '\n');
  p('  ' + MANIFEST + '\n');
  if (total > 150) p('  ' + Y + 'that is long for a demo — trim the script' + O + '\n');
  return manifest;
}

function flag(name, fallback) {
  const hit = process.argv.filter(a => a.indexOf('--' + name + '=') === 0)[0];
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function cli() {
  if (process.argv.indexOf('--list') !== -1) {
    const voices = listVoices().filter(v => /^en_/.test(v.locale));
    console.log(B + '\nEnglish voices on this machine' + O);
    voices.forEach(v => console.log('  ' + v.name + '   ' + D + v.locale + O));
    console.log(D + '\n  Better ones are free: System Settings > Accessibility > ' +
      'Spoken Content > System Voice > Manage Voices.' + O);
    return;
  }
  const scriptPath = flag('script');
  if (!scriptPath) throw new Error('--script=<path> is required (a module exporting the narration object)');
  const script = require(path.resolve(scriptPath));
  const outDir = flag('outDir', './demo-out/vo');
  const manifest = await build(script, {
    outDir: path.resolve(outDir),
    engine: flag('engine', 'say'),
    voice: flag('voice'),
    rate: Number(flag('rate', '172')),
    tempo: Number(flag('tempo', '0.90')),
    googleRate: Number(flag('googleRate', '1.0')),
    style: flag('style', ''),
    geminiModel: flag('geminiModel', 'gemini-2.5-flash-preview-tts'),
    targetWpm: Number(flag('targetWpm', '0')),
    rpm: Number(flag('rpm', '9')),
    serviceAccountFile: flag('serviceAccountFile'),
  });
  console.log(D + '\n  Now run your storyboard against ' + manifest.voice + O + '\n');
}

if (require.main === module) {
  cli().catch(err => { console.error('\n  ' + err.message + '\n'); process.exit(1); });
}

module.exports = { build, inWords, readKey_, readKeys_ };
