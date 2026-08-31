import React, { useEffect, useState } from 'react';
import { useStore } from '../state/store.jsx';
import EngineWarning from '../components/EngineWarning.jsx';

function KeyField({ label, hint, masked, tooShortAt, onSave }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const short = value && value.length < tooShortAt;
  return (
    <div style={{ marginBottom: 8 }}>
      <span className="field-label">{label}</span>
      <div className="card-row">
        <input className="ds-input grow" type="password" value={value}
          placeholder={masked && masked.set ? 'saved — ends in ' + masked.last4 : 'paste the key…'}
          onChange={e => { setValue(e.target.value); setSaved(false); }} />
        <md-filled-button disabled={!value || undefined}
          onClick={async () => { await onSave(value); setValue(''); setSaved(true); }}>
          Save
        </md-filled-button>
        {masked && masked.set && (
          <md-text-button onClick={async () => { await onSave(''); setSaved(false); }}>Clear</md-text-button>
        )}
      </div>
      {short && <EngineWarning text="That looks too short to be a real key — double-check before saving." />}
      {saved && <EngineWarning level="info" icon="check_circle" text="Saved — encrypted with the macOS keychain." />}
      {hint && <p className="hint" style={{ marginTop: 6 }}>{hint}</p>}
    </div>
  );
}

function DiagRow({ what, r }) {
  return (
    <div className="diag-row">
      <span className={'msym ' + (r.ok ? 'diag-ok' : 'diag-bad')}>{r.ok ? 'check_circle' : 'cancel'}</span>
      <span className="what">{what}</span>
      <span className="detail">{r.detail}</span>
    </div>
  );
}

export default function SettingsScreen() {
  const { state, actions, api } = useStore();
  const s = state.settings;
  const d = state.diagnostics;
  const [paths, setPaths] = useState(null);
  useEffect(() => {
    if (s && !paths) setPaths({ demoSuitePath: s.demoSuitePath, chromePath: s.chromePath, framingModel: s.framingModel });
  }, [s, paths]);
  if (!s || !paths) return null;

  const savePath = (k) => (e) => setPaths({ ...paths, [k]: e.target.value });
  const commitPaths = () => actions.saveSettings(paths);

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Keys are encrypted with the macOS keychain and only ever handed to the pipeline as environment variables.</p>

      <div className="card">
        <h3>API keys</h3>
        <KeyField label="Google Cloud Text-to-Speech key" masked={s.googleTtsKey} tooShortAt={25}
          hint="Console → APIs & Services → Credentials → Create credentials → API key (restrict it to the Text-to-Speech API). Leave empty to keep using ~/.google_tts_key — multi-key rotation only works through that dotfile."
          onSave={v => actions.saveSettings({ googleTtsKey: v })} />
        <KeyField label="Gemini API key" masked={s.geminiKey} tooShortAt={25}
          hint="Used for framing (drafting the narration and shot list) and for the optional Gemini TTS engine."
          onSave={v => actions.saveSettings({ geminiKey: v })} />
      </div>

      <div className="card">
        <h3>Paths & model</h3>
        <span className="field-label">demo-suite engine folder (empty = the engine bundled with the app)</span>
        <input className="ds-input" value={paths.demoSuitePath} placeholder="bundled engine — set a path only to develop against a live checkout"
          onChange={savePath('demoSuitePath')} onBlur={commitPaths} />
        <span className="field-label">Chrome path (leave empty to auto-detect)</span>
        <input className="ds-input" value={paths.chromePath} placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          onChange={savePath('chromePath')} onBlur={commitPaths} />
        <span className="field-label">Gemini framing model</span>
        <input className="ds-input" value={paths.framingModel} onChange={savePath('framingModel')} onBlur={commitPaths} />
      </div>

      <div className="card">
        <div className="toolbar">
          <h3 style={{ margin: 0, flex: 1 }}>Environment</h3>
          <md-outlined-button onClick={() => actions.diagnose()}>
            <span className="msym" slot="icon">stethoscope</span>
            Check environment
          </md-outlined-button>
        </div>
        {d ? (<>
          <DiagRow what="ffmpeg" r={d.ffmpeg} />
          <DiagRow what="ffprobe" r={d.ffprobe} />
          <DiagRow what="Chrome" r={d.chrome} />
          <DiagRow what="macOS say" r={d.say} />
          <DiagRow what="mlx-whisper" r={d.mlxWhisper} />
          <DiagRow what="demo-suite" r={d.demoSuite} />
          <DiagRow what="Google TTS key" r={d.googleKey} />
          <DiagRow what="Gemini key" r={d.geminiKey} />
        </>) : <p className="hint">Run the check to verify ffmpeg, Chrome, keys and the demo-suite engine are all reachable.</p>}
      </div>
    </div>
  );
}
