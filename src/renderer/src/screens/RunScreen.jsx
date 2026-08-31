import React from 'react';
import { useStore } from '../state/store.jsx';
import PhaseStepper from '../components/PhaseStepper.jsx';
import LogConsole from '../components/LogConsole.jsx';
import ResultCard from '../components/ResultCard.jsx';
import EngineWarning from '../components/EngineWarning.jsx';

export default function RunScreen() {
  const { state, actions } = useStore();
  const p = state.project;
  const job = state.job;
  const aux = state.auxJob;
  if (!p || !p.demo) return <p>Open a project first.</p>;

  const classic = p.kind === 'classic-project';
  const engine = (p.demo.voice && p.demo.voice.engine) || 'google';
  const isRunJob = job.kind === 'run-auto' || job.kind === 'run-classic';

  const steps = classic
    ? [{ id: 'classic', label: 'Build (project’s own build.js)' }]
    : [
      { id: 'narrate', label: 'Narrate' },
      ...(engine === 'gemini' ? [{ id: 'verify', label: 'Verify voices' }] : []),
      { id: 'record', label: 'Record' },
      { id: 'deliver', label: 'Deliver' },
    ];

  const blocked = !classic && p.errors.length > 0;
  const stalls = (job.error && job.error.stalls) || [];

  return (
    <div>
      <h1 className="page-title">Run</h1>
      <p className="page-sub">
        {classic
          ? 'Runs this project’s own build.js and streams its output.'
          : 'Narration first (the picture is timed to the voice), then the recording, then the upload-safe encode.'}
      </p>

      {blocked && <EngineWarning level="error" icon="error" text={'Fix demo.json first: ' + p.errors.join(' · ')} />}

      <div className="card">
        <div className="toolbar">
          {!job.running ? (
            <md-filled-button disabled={blocked || undefined} onClick={() => actions.startRun()}>
              <span className="msym" slot="icon">play_arrow</span>
              {job.result || job.error ? 'Run again' : 'Run the demo'}
            </md-filled-button>
          ) : (
            <md-outlined-button onClick={() => actions.cancelJob()}>
              <span className="msym" slot="icon">stop</span>
              Cancel
            </md-outlined-button>
          )}
          <span className="chip">{engine === 'say' ? 'macOS say — free, draft quality' : engine === 'gemini' ? 'Gemini TTS + mandatory verification' : 'Google Chirp3-HD'}</span>
        </div>

        {isRunJob && <PhaseStepper steps={steps} phases={job.phases} progress={job.running ? job.progress : null} />}

        {isRunJob && job.error && (
          <EngineWarning level="error" icon="error"
            text={job.error.shotId
              ? 'Shot ' + job.error.shotId + ' failed: ' + job.error.message
              : job.error.message} />
        )}
        {stalls.length > 0 && (
          <EngineWarning
            text={'Dead air — the picture sat still and silent: ' +
              stalls.map(s => (s.atMs / 1000).toFixed(1) + 's (' + (s.ms / 1000).toFixed(1) + 's still' +
                (s.nearShotId ? ', after shot ' + s.nearShotId : '') + ')').join(' · ') +
              '. Give that stretch something to do (a spot, a frame, a crawl) or shorten the hold — don’t raise the stall limit.'} />
        )}

        {isRunJob && <LogConsole logs={job.logs} />}
      </div>

      {isRunJob && <ResultCard result={job.result} />}

      {isRunJob && job.result && !classic && (
        <div className="card">
          <h3>Quality passes</h3>
          <p className="hint">The director's loop, on demand: Gemini reviews one frame per shot against the demo grammar; whisper re-hears every narration clip.</p>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <md-outlined-button disabled={aux.running || undefined} onClick={() => actions.startReview()}>
              <span className="msym" slot="icon">rate_review</span>
              {aux.running && aux.kind === 'review' ? 'Reviewing…' : 'Review the cut with Gemini'}
            </md-outlined-button>
            <md-outlined-button disabled={aux.running || undefined} onClick={() => actions.startVerify()}>
              <span className="msym" slot="icon">hearing</span>
              {aux.running && aux.kind === 'verify' ? 'Listening…' : 'Check the voiceover (whisper)'}
            </md-outlined-button>
          </div>
          {aux.error && <EngineWarning level="error" icon="error" text={aux.error.message} />}
          {aux.result && aux.kind === 'verify' && (
            aux.result.verify && aux.result.verify.bad.length === 0
              ? <EngineWarning level="info" icon="check_circle" text="Voiceover verified — every clip matches its script." />
              : <EngineWarning level="error" icon="error"
                  text={'Suspect clips: ' + (aux.result.verify ? aux.result.verify.bad.map(b => b.key).join(', ') : '?') + ' — re-run narration before sharing.'} />
          )}
          {aux.result && aux.kind === 'review' && aux.result.review && (
            <div style={{ marginTop: 12 }}>
              {aux.result.review.critiques.length === 0
                ? <EngineWarning level="info" icon="check_circle" text="Gemini found nothing to flag across the cut." />
                : aux.result.review.critiques.map((c, i) => (
                  <div key={i} className="shot-card" style={{ marginBottom: 6 }}>
                    <span className="action-chip">{c.shotId}</span>
                    <div className="detail">
                      <div>{c.problem}</div>
                      {c.suggestion && <div className="sub">{c.suggestion}</div>}
                    </div>
                    <span className="chip">{c.severity}</span>
                  </div>
                ))}
              {aux.result.review.overall && <p className="hint" style={{ marginTop: 10 }}>{aux.result.review.overall}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
