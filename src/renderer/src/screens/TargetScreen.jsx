import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import EngineWarning from '../components/EngineWarning.jsx';

export default function TargetScreen() {
  const { state, actions, api } = useStore();
  const p = state.project;
  const job = state.job;
  const framing = job.kind === 'frame';
  const [draft, setDraft] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => { setDraft(null); }, [p && p.dir]);
  if (!p || !p.demo) return <p>Open a project first.</p>;
  const demo = draft || p.demo;

  const patch = (fn) => {
    const next = JSON.parse(JSON.stringify(demo));
    fn(next);
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => actions.saveDemo(next), 600);
  };

  const geminiSet = state.settings && state.settings.geminiKey && state.settings.geminiKey.set;
  const t = demo.target || {};
  const classic = p.kind === 'classic-project';

  return (
    <div>
      <h1 className="page-title">{demo.name || p.dir.split('/').pop()}</h1>
      <p className="page-sub">{p.dir}</p>

      {p.errors && p.errors.length > 0 && (
        <EngineWarning level="error" icon="error" text={'demo.json needs attention: ' + p.errors.join(' · ')} />
      )}

      {classic ? (
        <div className="card">
          <h3>Hand-written project</h3>
          <p className="hint">
            This folder has its own build.js and storyboard — Demo Studio runs it exactly as
            <code> node build.js</code> would. Voice and engine can still be overridden on the Run screen;
            framing and the shot editor apply only to Demo Studio projects.
          </p>
        </div>
      ) : (<>
        <div className="card">
          <h3>Target</h3>
          <p className="hint">The page the demo records.</p>
          {t.kind === 'url' ? (
            <div>
              <span className="field-label">Live URL</span>
              <input className="ds-input" value={t.url || ''}
                onChange={e => patch(d => { d.target.url = e.target.value; })} placeholder="https://…" />
            </div>
          ) : (
            <p>
              <span className="chip">{t.kind === 'html' ? 'Static HTML: ' + (t.htmlFile || '') : 'Node render: ' + (t.renderModule || '')}</span>
            </p>
          )}
          <span className="field-label">Ready when this element exists (CSS selector, optional)</span>
          <input className="ds-input" value={t.readySelector || ''}
            onChange={e => patch(d => { d.target.readySelector = e.target.value; })}
            placeholder=".app-root — leave empty to wait for page load only" />
          <span className="field-label">Camera page wrapper (the element the camera moves)</span>
          <input className="ds-input" value={(demo.camera && demo.camera.pageSelector) || ''}
            onChange={e => patch(d => { d.camera.pageSelector = e.target.value; })}
            placeholder=".demo-page — falls back to the whole body" />
        </div>

        <div className="card">
          <h3>Voiceover instructions</h3>
          <p className="hint">
            What story should this demo tell, to whom, in what tone? Gemini reads the page and these
            instructions, then drafts the narration and the shot list for you to edit.
          </p>
          <textarea className="ds-textarea" value={demo.instructions || ''}
            onChange={e => patch(d => { d.instructions = e.target.value; })}
            placeholder="e.g. 45 seconds for an executive audience. Lead with the KPIs, open one section, confident tone, end on the main takeaway." />
          <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
            <md-filled-button disabled={(framing && job.running) || undefined} onClick={() => actions.startFraming()}>
              <span className="msym" slot="icon">auto_awesome</span>
              {framing && job.running ? 'Framing…' : 'Capture & frame with Gemini'}
            </md-filled-button>
            {!geminiSet && <span className="chip">Uses ~/.gemini_tts_key if present — or add a key in Settings</span>}
          </div>
          {framing && job.running && job.progress && (
            <div style={{ marginTop: 12 }}>
              <md-linear-progress indeterminate style={{ width: '100%' }} />
              <div style={{ fontSize: 12.5, color: 'var(--md-sys-color-on-surface-variant)', marginTop: 6 }}>{job.progress.label}</div>
            </div>
          )}
          {framing && job.error && <EngineWarning level="error" icon="error" text={job.error.message} />}
          {framing && !job.running && job.framing && (
            <div style={{ marginTop: 6 }}>
              <EngineWarning level="info" icon="check_circle"
                text="Gemini drafted the narration and shot list — review them in the Script tab." />
              {job.framing.lint.length > 0 && (
                <EngineWarning
                  text={'Heads-up on ' + job.framing.lint.length + ' shot(s): ' +
                    job.framing.lint.map(l => l.shotId + ' — ' + l.problem).join(' · ')} />
              )}
              <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
                <md-outlined-button onClick={() => actions.go('script')}>Open the Script tab</md-outlined-button>
              </div>
            </div>
          )}
        </div>
      </>)}
    </div>
  );
}
