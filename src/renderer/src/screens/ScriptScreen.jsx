import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.jsx';
import ShotCard from '../components/ShotCard.jsx';
import EngineWarning from '../components/EngineWarning.jsx';

const ADDABLE = ['say', 'frame', 'spot', 'spotOut', 'click', 'waitForVo', 'hold', 'settle', 'type', 'atVo', 'caption', 'crawl', 'cta', 'run'];

function newShot(action, shots) {
  const id = 's' + (shots.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0), 0) + 1);
  const base = { id, action };
  if (action === 'say') return { ...base, caption: '', voKey: undefined };
  if (action === 'frame') return { ...base, subject: { selector: '' }, mode: 'focus', ms: 600 };
  if (action === 'spot' || action === 'click') return { ...base, subject: { selector: '' } };
  if (action === 'hold') return { ...base, ms: 1000 };
  if (action === 'settle') return { ...base, ms: 500 };
  if (action === 'atVo') return { ...base, frac: 0.5 };
  if (action === 'caption') return { ...base, text: '' };
  if (action === 'type') return { ...base, selector: '', text: '', ms: 800 };
  if (action === 'cta') return { ...base, lines: [{ text: '' }, { text: '' }] };
  if (action === 'run') return { ...base, js: '' };
  return base;
}

export default function ScriptScreen() {
  const { state, actions } = useStore();
  const p = state.project;
  const [draft, setDraft] = useState(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState(null);
  const [addAction, setAddAction] = useState('say');
  const saveTimer = useRef(null);

  useEffect(() => { setDraft(null); setRawMode(false); }, [p && p.dir]);
  if (!p || !p.demo) return <p>Open a project first.</p>;
  if (p.kind === 'classic-project') {
    return (<>
      <h1 className="page-title">Script</h1>
      <EngineWarning level="info" icon="data_object"
        text="This is a hand-written project — its narration.js and storyboard.js are edited in your editor, not here. The Run tab records it as-is." />
    </>);
  }
  const demo = draft || p.demo;
  const lintByShot = {};
  ((state.job.framing && state.job.framing.lint) || []).forEach(l => { lintByShot[l.shotId] = l; });

  const commit = (next) => {
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => actions.saveDemo(next), 600);
  };
  const patch = (fn) => {
    const next = JSON.parse(JSON.stringify(demo));
    fn(next);
    commit(next);
  };

  const narrationKeys = (demo.narration || []).map(n => n && n.key).filter(Boolean);

  const enterRaw = () => { setRawText(JSON.stringify(demo, null, 2)); setRawError(null); setRawMode(true); };
  const applyRaw = () => {
    try {
      const parsed = JSON.parse(rawText);
      setRawError(null);
      setRawMode(false);
      commit(parsed);
    } catch (err) { setRawError(err.message); }
  };

  return (
    <div>
      <div className="toolbar">
        <h1 className="page-title" style={{ margin: 0, flex: 1 }}>Script</h1>
        {rawMode
          ? (<>
            <md-text-button onClick={() => setRawMode(false)}>Cancel</md-text-button>
            <md-filled-button onClick={applyRaw}>Apply JSON</md-filled-button>
          </>)
          : <md-outlined-button onClick={enterRaw}><span className="msym" slot="icon">data_object</span>Raw JSON</md-outlined-button>}
      </div>

      {p.errors.length > 0 && <EngineWarning level="error" icon="error" text={p.errors.join(' · ')} />}
      {p.warnings.length > 0 && <EngineWarning text={p.warnings.join(' · ')} />}

      {rawMode ? (
        <div className="card">
          <p className="hint">The whole demo.json — hand-edit anything; unknown fields are kept.</p>
          {rawError && <EngineWarning level="error" icon="error" text={rawError} />}
          <textarea className="json-editor" value={rawText} onChange={e => setRawText(e.target.value)} spellCheck={false} />
        </div>
      ) : (
        <div className="grid2" style={{ gridTemplateColumns: '1.2fr 1fr', marginTop: 12 }}>
          <div>
            <div className="card">
              <h3>Shots</h3>
              <p className="hint">The camera work, in order. Disable a shot to keep it in the file but out of the cut.</p>
              {(demo.shots || []).map((shot, i) => shot && (
                <ShotCard
                  key={shot.id || i}
                  shot={shot} index={i} count={demo.shots.length}
                  narrationKeys={narrationKeys}
                  lint={lintByShot[shot.id]}
                  onChange={chg => patch(d => { d.shots[i] = { ...d.shots[i], ...chg }; })}
                  onDelete={() => patch(d => { d.shots.splice(i, 1); })}
                  onMove={dir => patch(d => {
                    const [s] = d.shots.splice(i, 1);
                    d.shots.splice(i + dir, 0, s);
                  })}
                />
              ))}
              <div className="card-row" style={{ marginTop: 12 }}>
                <select className="ds-select" value={addAction} onChange={e => setAddAction(e.target.value)}>
                  {ADDABLE.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <md-outlined-button onClick={() => patch(d => { d.shots.push(newShot(addAction, d.shots)); })}>
                  <span className="msym" slot="icon">add</span>Add shot
                </md-outlined-button>
              </div>
            </div>
          </div>
          <div>
            <div className="card">
              <h3>Narration</h3>
              <p className="hint">What the voice says — order is clip order. Captions on shots are labels; these lines carry the argument.</p>
              {(demo.narration || []).map((n, i) => n && (
                <div className="narr-row" key={n.key || i}>
                  <span className="narr-key" title={n.key}>{n.key}</span>
                  <textarea className="narr-text grow" value={n.text || ''}
                    onChange={e => patch(d => { d.narration[i] = { ...d.narration[i], text: e.target.value }; })} />
                  <button className="icon-btn" title="Delete line" style={{ marginTop: 4 }}
                    onClick={() => patch(d => { d.narration.splice(i, 1); })}>
                    <span className="msym">delete</span>
                  </button>
                </div>
              ))}
              <md-outlined-button onClick={() => patch(d => {
                const k = '__LINE_' + (d.narration.length + 1) + '__';
                d.narration.push({ key: k, text: '' });
              })}>
                <span className="msym" slot="icon">add</span>Add line
              </md-outlined-button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
