'use strict';
/**
 * geminiRest.js — raw REST client for the Gemini API, following narrate.js's
 * zero-dependency pattern (its postJson_/backoff helpers are internal, so
 * the recipe is reproduced here): explicit timeout on every request — a dead
 * request once hung a build for 35 minutes — and 429/5xx retries with
 * backoff.
 */
const https = require('https');

function postJson(host, urlPath, bodyObj, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request({
      host, path: urlPath, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (err) { /* non-JSON error body */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call models/<model>:generateContent with retries.
 * @returns {Promise<object>} the API response JSON.
 */
async function generateContent(opts) {
  const { key, model, body } = opts;
  if (!key) throw new Error('no Gemini API key — add one in Settings');
  const urlPath = '/v1beta/models/' + model + ':generateContent';
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await postJson('generativelanguage.googleapis.com', urlPath, body,
        { 'x-goog-api-key': key }, opts.timeoutMs);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (res.status === 200 && res.json) return res.json;
    const msg = (res.json && res.json.error && res.json.error.message) || ('HTTP ' + res.status);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(msg);
      await new Promise(r => setTimeout(r, res.status === 429 ? 15000 * attempt : 4000 * attempt));
      continue;
    }
    throw new Error('Gemini API: ' + msg);
  }
  throw new Error('Gemini API failed after retries: ' + (lastErr ? lastErr.message : 'unknown'));
}

/** Pull the text of the first candidate out of a generateContent response. */
function firstText(resp) {
  const parts = resp && resp.candidates && resp.candidates[0] &&
    resp.candidates[0].content && resp.candidates[0].content.parts;
  if (!parts) return null;
  const texts = parts.filter(p => typeof p.text === 'string').map(p => p.text);
  return texts.length ? texts.join('') : null;
}

module.exports = { postJson, generateContent, firstText };
