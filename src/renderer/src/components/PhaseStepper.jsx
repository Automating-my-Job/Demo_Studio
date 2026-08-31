import React from 'react';

/**
 * The pipeline stepper. `steps` = [{id, label}]; `phases` maps phase id →
 * 'start' | 'done' | 'error'.
 */
export default function PhaseStepper({ steps, phases, progress }) {
  return (
    <div>
      <div className="stepper">
        {steps.map((s, i) => {
          const st = phases[s.id];
          const cls = st === 'done' ? 'done' : st === 'start' ? 'active' : st === 'error' ? 'error' : '';
          return (
            <div className={'step ' + cls} key={s.id}>
              <span className="dot">
                {st === 'done' ? <span className="msym" style={{ fontSize: 16 }}>check</span> : i + 1}
              </span>
              <span className="lbl">{s.label}</span>
              {i < steps.length - 1 && <span className="bar" />}
            </div>
          );
        })}
      </div>
      {progress && progress.total > 0 && (
        <div style={{ marginBottom: 14 }}>
          <md-linear-progress value={progress.total ? progress.current / progress.total : 0} style={{ width: '100%' }} />
          <div style={{ fontSize: 12.5, color: 'var(--md-sys-color-on-surface-variant)', marginTop: 6 }}>
            {progress.label}
          </div>
        </div>
      )}
    </div>
  );
}
