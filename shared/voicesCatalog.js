'use strict';
/**
 * voicesCatalog.js — static engine/voice metadata for the Voice screen.
 * macOS `say` voices are listed live (src/main/voices.js); these are the
 * cloud catalogs plus per-engine facts the UI keys off.
 */
const CHIRP3_NAMES = ['Charon', 'Kore', 'Leda', 'Aoede', 'Puck', 'Fenrir'];

const ENGINES = [
  {
    id: 'google',
    label: 'Google Cloud',
    badge: 'Recommended',
    needsKey: 'google',
    blurb: 'Chirp3-HD studio voices. Free at demo scale (1M chars/month free tier).',
    voices: CHIRP3_NAMES.map(n => ({ id: 'en-US-Chirp3-HD-' + n, label: n + ' (Chirp3-HD)' })),
    defaultVoice: 'en-US-Chirp3-HD-Charon',
    // Chirp3-HD rejects speakingRate — narrate.js already omits it; the UI
    // hides the rate control entirely for these voices.
    supportsRate: false,
    warning: null,
  },
  {
    id: 'say',
    label: 'macOS say',
    badge: 'Free · offline',
    needsKey: null,
    blurb: 'Instant and free; draft quality. Premium voices (System Settings → Spoken Content) are a big upgrade.',
    voices: null, // listed live from `say -v ?`
    defaultVoice: 'Samantha',
    supportsRate: true,
    warning: null,
  },
  {
    id: 'gemini',
    label: 'Gemini TTS',
    badge: 'Advanced',
    needsKey: 'gemini',
    blurb: 'Gemini native TTS voices.',
    voices: CHIRP3_NAMES.map(n => ({ id: n, label: n })),
    defaultVoice: 'Charon',
    supportsRate: false,
    warning: 'Gemini TTS has a documented, unfixed bug: it repeats a clause in roughly 5–10% of clips. ' +
      'Every clip is automatically checked with mlx-whisper before recording — this check cannot be skipped.',
  },
];

function engineById(id) {
  return ENGINES.filter(e => e.id === id)[0] || null;
}

module.exports = { ENGINES, CHIRP3_NAMES, engineById };
