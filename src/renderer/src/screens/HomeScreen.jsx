import React, { useState } from 'react';
import { useStore } from '../state/store.jsx';

export default function HomeScreen() {
  const { state, actions, api } = useStore();
  const [scan, setScan] = useState(null); // {root, kind, projects}
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const recents = (state.settings && state.settings.recentProjects) || [];

  const openFolder = async () => {
    const root = await api.pickFolder();
    if (!root) return;
    setBusy(true);
    try {
      const r = await api.scanProject({ root });
      if (r.kind === 'studio-project' || r.kind === 'classic-project') {
        await actions.openProject(root);
      } else {
        setScan({ root, ...r });
      }
    } finally { setBusy(false); }
  };

  const createFromUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const dir = await api.createUrlProject({ url: url.trim() });
      await actions.openProject(dir);
    } finally { setBusy(false); }
  };

  const scaffoldHere = async () => {
    const dir = await api.scaffoldProject({ appRoot: scan.root, name: 'demo' });
    await actions.openProject(dir);
  };

  return (
    <div>
      <h1 className="page-title">Demo Studio</h1>
      <p className="page-sub">Narrated demo videos of a real page — framed by Gemini, spoken by studio voices, recorded for you.</p>

      <div className="grid2">
        <div className="card">
          <h3>Open a project</h3>
          <p className="hint">A demo project folder, or your app's root — Demo Studio finds the demos inside it.</p>
          <div className="push-down card-row">
            <md-filled-button disabled={busy || undefined} onClick={openFolder}>
              <span className="msym" slot="icon">folder_open</span>
              Choose folder…
            </md-filled-button>
          </div>
          {scan && (
            <div style={{ marginTop: 14 }}>
              {scan.projects.length > 0 ? (<>
                <p className="hint">Demos found in {scan.root}:</p>
                {scan.projects.map(p => (
                  <button key={p.dir} className="recent-item" onClick={() => actions.openProject(p.dir)}>
                    <span className="msym">{p.kind === 'classic-project' ? 'data_object' : 'movie'}</span>
                    <span>
                      {p.name}
                      <div className="path">{p.kind === 'classic-project' ? 'hand-written build.js' : 'Demo Studio project'} · {p.dir}</div>
                    </span>
                  </button>
                ))}
              </>) : (
                <div className="banner info">
                  <span className="msym">info</span>
                  <span>No demo projects found in this folder yet.</span>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <md-outlined-button onClick={scaffoldHere}>
                  <span className="msym" slot="icon">add</span>
                  Start a new demo in this folder
                </md-outlined-button>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Demo a live URL</h3>
          <p className="hint">Point at any deployed page — a dashboard, a web app, a site — and build the demo around it.</p>
          <div className="push-down card-row">
            <input className="ds-input grow" placeholder="https://…" value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFromUrl(); }} />
            <md-filled-button disabled={busy || !url.trim() || undefined} onClick={createFromUrl}>Create</md-filled-button>
          </div>
        </div>
      </div>

      {recents.length > 0 && (
        <div className="card">
          <h3>Recent</h3>
          {recents.map(dir => (
            <button key={dir} className="recent-item" onClick={() => actions.openProject(dir)}>
              <span className="msym">history</span>
              <span>
                {dir.split('/').pop()}
                <div className="path">{dir}</div>
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="credit">
        <strong>Want a specialized demo tool for your needs?</strong>{' '}
        Reach out — <a href="mailto:Tom@OpsGS.com" onClick={e => { e.preventDefault(); api.openExternal({ url: 'mailto:Tom@OpsGS.com' }); }}>Tom@OpsGS.com</a>
        <br />Built by Tom@OpsGS.com · free for personal use, commercial licensing available
      </p>
    </div>
  );
}
