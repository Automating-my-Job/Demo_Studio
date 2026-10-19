import React from 'react';
import { useStore } from '../state/store.jsx';

function fmtBytes(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
}

export default function ResultCard({ result }) {
  const { api } = useStore();
  if (!result) return null;
  return (
    <div className="card">
      <h3>Finished</h3>
      <p className="hint">
        {result.durationSec ? result.durationSec.toFixed(1) + 's · ' : ''}
        {result.bytes ? fmtBytes(result.bytes) : ''}
      </p>
      {result.audioQa && !result.audioQa.ok && (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          <span className="msym">hearing_disabled</span>
          <span>Audio QA: {result.audioQa.issues.join(' · ')}</span>
        </div>
      )}
      {result.outPath && (
        <video className="result-video" controls src={api.mediaUrl(result.deliverPath || result.outPath)} />
      )}
      <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
        {result.deliverPath && (
          <md-filled-button onClick={() => api.reveal({ path: result.deliverPath })}>
            <span className="msym" slot="icon">folder_open</span>
            Reveal LinkedIn encode
          </md-filled-button>
        )}
        {result.outPath && (
          <md-text-button onClick={() => api.reveal({ path: result.outPath })}>Reveal raw master</md-text-button>
        )}
        <span className="chip">Share the “linkedin” file — it is the BT.709 upload-safe encode</span>
      </div>
      {result.githubShare && (
        <div className="banner info" style={{ marginTop: 14 }}>
          <span className="msym">ios_share</span>
          <span style={{ flex: 1 }}>
            <strong>GitHub share kit ready</strong><br />
            The repository folder contains only the delivery MP4 and a short README. The repository description is kept beside it so it is not accidentally published as a file.
          </span>
          <md-outlined-button onClick={() => api.reveal({ path: result.githubShare.repositoryPath })}>
            Reveal share kit
          </md-outlined-button>
        </div>
      )}
    </div>
  );
}
