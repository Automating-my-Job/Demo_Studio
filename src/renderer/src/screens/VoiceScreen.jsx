import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import EngineWarning from '../components/EngineWarning.jsx';

/* Card metadata — keep in sync with shared/voicesCatalog.js (the voice lists
   themselves come from the main process via voices:list). */
const ENGINE_CARDS = [
  { id: 'google', label: 'Google Cloud', badge: 'Recommended', needsKey: 'googleTtsKey', supportsRate: false,
    blurb: 'Chirp3-HD studio voices. Free at demo scale — 1M characters a month on the free tier.' },
  { id: 'say', label: 'macOS say', badge: 'Free · offline', needsKey: null, supportsRate: true,
    blurb: 'Instant and free; draft quality. Premium voices (System Settings → Spoken Content) are a big upgrade.' },
  { id: 'gemini', label: 'Gemini TTS', badge: 'Advanced', needsKey: 'geminiKey', supportsRate: false,
    blurb: 'Gemini native TTS. Only with a specific reason.',
    warning: 'Gemini TTS has a documented, unfixed bug: it repeats a clause in roughly 5–10% of clips. Every clip is checked automatically with mlx-whisper before recording — that check cannot be skipped.' },
];

export default function VoiceScreen() {
  const { state, actions, api } = useStore();
  const p = state.project;
  const sampleJob = state.sampleJob;
  const [voices, setVoices] = useState([]);
  const [sampleText, setSampleText] = useState('');
  const [draft, setDraft] = useState(null);
  const saveTimer = useRef(null);
  const audioRef = useRef(null);

  const demo = draft || (p && p.demo);
  const voice = (demo && demo.voice) || { engine: 'google', voice: '' };
  const engine = voice.engine || 'google';

  useEffect(() => { setDraft(null); }, [p && p.dir]);
  useEffect(() => {
    api.listVoices({ engine }).then(setVoices);
  }, [engine, api]);
  useEffect(() => {
    if (sampleJob.sample && audioRef.current) audioRef.current.play().catch(() => {});
  }, [sampleJob.sample]);

  if (!p || !demo) return <p>Open a project first.</p>;
  const classic = p.kind === 'classic-project';

  const patch = (fn) => {
    const next = JSON.parse(JSON.stringify(demo));
    fn(next);
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => actions.saveDemo(next), 500);
  };

  const card = ENGINE_CARDS.filter(c => c.id === engine)[0];
  const keyState = card && card.needsKey && state.settings ? state.settings[card.needsKey] : null;
  const keyMissing = card && card.needsKey && keyState && !keyState.set;
  const firstLine = (demo.narration || []).filter(Boolean)[0];
  const effectiveSampleText = sampleText || (firstLine && firstLine.text) || '';

  const setEngine = (id) => patch(d => {
    d.voice.engine = id;
    d.voice.voice = id === 'google' ? 'en-US-Chirp3-HD-Charon' : id === 'gemini' ? 'Charon' : 'Samantha';
  });

  return (
    <div>
      <h1 className="page-title">Voice</h1>
      <p className="page-sub">
        {classic
          ? 'This hand-written project is run with these as --engine/--voice overrides.'
          : 'The engine and voice the narration is synthesized with.'}
      </p>

      <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {ENGINE_CARDS.map(c => (
          <div key={c.id} className={'engine-card' + (engine === c.id ? ' selected' : '')} onClick={() => setEngine(c.id)}>
            <div className="name">{c.label}<span className="badge">{c.badge}</span></div>
            <div className="blurb">{c.blurb}</div>
          </div>
        ))}
      </div>

      {card && card.warning && <EngineWarning text={card.warning} />}
      {keyMissing && (
        <EngineWarning level="error" icon="key"
          text={'This engine needs an API key — add it in Settings, or a ~/.'.concat(engine === 'gemini' ? 'gemini_tts_key' : 'google_tts_key', ' dotfile also works.')} />
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Voice</h3>
        <div className="card-row" style={{ marginTop: 10 }}>
          <select className="ds-select" value={voice.voice || ''} onChange={e => patch(d => { d.voice.voice = e.target.value; })}>
            {voices.map(v => <option key={v.id} value={v.id}>{v.label}{v.locale ? ' · ' + v.locale : ''}</option>)}
            {voices.length === 0 && <option value="">(default)</option>}
          </select>
          {card && card.supportsRate && (<>
            <span className="field-label" style={{ margin: 0 }}>rate (wpm)</span>
            <input className="ds-input" type="number" style={{ width: 90 }} value={voice.rate || 172}
              onChange={e => patch(d => { d.voice.rate = Number(e.target.value); })} />
            <span className="field-label" style={{ margin: 0 }}>tempo</span>
            <input className="ds-input" type="number" step="0.05" style={{ width: 90 }} value={voice.tempo || 0.9}
              onChange={e => patch(d => { d.voice.tempo = Number(e.target.value); })} />
          </>)}
        </div>

        <span className="field-label">Hear a sample</span>
        <div className="card-row">
          <input className="ds-input grow" value={sampleText} placeholder={effectiveSampleText || 'Type a line to hear…'}
            onChange={e => setSampleText(e.target.value)} />
          <md-filled-button disabled={(sampleJob.running || keyMissing || !effectiveSampleText) || undefined}
            onClick={() => actions.playSample({
              engine, voice: voice.voice, text: effectiveSampleText,
              rate: voice.rate, tempo: voice.tempo,
            })}>
            <span className="msym" slot="icon">{sampleJob.running ? 'hourglass_top' : 'play_arrow'}</span>
            {sampleJob.running ? 'Synthesizing…' : 'Play sample'}
          </md-filled-button>
        </div>
        {sampleJob.error && <EngineWarning level="error" icon="error" text={sampleJob.error.message} />}
        {sampleJob.sample && (
          <div style={{ marginTop: 12 }}>
            <audio ref={audioRef} controls src={api.mediaUrl(sampleJob.sample.path)} style={{ width: '100%' }} />
          </div>
        )}
      </div>
    </div>
  );
}
