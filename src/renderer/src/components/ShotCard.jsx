import React, { useState } from 'react';

const ACTION_ICONS = {
  say: 'graphic_eq', frame: 'crop_free', spot: 'highlight', spotOut: 'blur_on',
  click: 'left_click', type: 'keyboard', waitForVo: 'hourglass_bottom', atVo: 'av_timer',
  hold: 'pause', settle: 'motion_photos_pause', caption: 'subtitles', cta: 'campaign',
  crawl: 'swap_vert', resetCamera: 'restart_alt', run: 'code',
};

function subjectLabel(s) {
  if (!s) return '';
  if (s.expr) return 'expr: ' + String(s.expr).slice(0, 48);
  let out = s.selector || '';
  if (s.textContains) out += ' ~"' + s.textContains + '"';
  else if (Number.isInteger(s.nth) && s.nth > 0) out += ' [' + s.nth + ']';
  return out;
}

function summary(shot) {
  switch (shot.action) {
    case 'say': return '“' + (shot.caption || '') + '”' + (shot.voKey ? '  ·  ' + shot.voKey : '');
    case 'frame': return subjectLabel(shot.subject) + '  ·  ' + (shot.mode || 'focus');
    case 'spot': case 'click': return subjectLabel(shot.subject);
    case 'type': return shot.selector + ' ← “' + (shot.text || '') + '”';
    case 'hold': case 'settle': case 'spotOut': case 'crawl': return shot.ms ? shot.ms + ' ms' : 'default timing';
    case 'atVo': return 'at ' + Math.round((shot.frac || 0) * 100) + '% of the line';
    case 'caption': return '“' + (shot.text || '') + '”';
    case 'cta': return (shot.lines && shot.lines[0] && (shot.lines[0].text || shot.lines[0])) || '';
    case 'run': return String(shot.js || '').slice(0, 60);
    default: return '';
  }
}

function Field({ label, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <span className="field-label" style={{ margin: '0 0 4px' }}>{label}</span>
      {children}
    </div>
  );
}

const TextIn = (props) => <input className="ds-input" {...props} />;

export default function ShotCard({ shot, index, count, narrationKeys, lint, onChange, onDelete, onMove }) {
  const [open, setOpen] = useState(false);
  const sub = shot.subject || {};
  const setSub = (patch) => onChange({ subject: { ...sub, ...patch } });
  const num = (v) => (v === '' ? undefined : Number(v));

  return (
    <div className={'shot-card' + (shot.disabled ? ' disabled' : '') + (lint && lint.level === 'error' ? ' flagged' : '')}>
      <span className="action-chip" title={shot.id}>
        <span className="msym" style={{ fontSize: 14, verticalAlign: -2, marginRight: 4 }}>{ACTION_ICONS[shot.action] || 'movie'}</span>
        {shot.action}
      </span>
      <div className="detail">
        <div>{summary(shot)}</div>
        {shot.note && <div className="sub">{shot.note}</div>}
        {lint && (
          <div className="lint">
            <span className="msym" style={{ fontSize: 15 }}>{lint.level === 'error' ? 'error' : 'warning'}</span>
            {lint.problem}
          </div>
        )}
        {open && (
          <div style={{ marginTop: 6 }}>
            {shot.action === 'say' && (<>
              <Field label="Caption (short label shown on screen)">
                <TextIn value={shot.caption || ''} onChange={e => onChange({ caption: e.target.value })} />
              </Field>
              <Field label="Narration line">
                <select className="ds-select" value={shot.voKey || ''} onChange={e => onChange({ voKey: e.target.value || undefined })}>
                  <option value="">(silent)</option>
                  {narrationKeys.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </Field>
            </>)}
            {(shot.action === 'frame' || shot.action === 'spot' || shot.action === 'click') && (<>
              <Field label="CSS selector">
                <TextIn value={sub.selector || ''} onChange={e => setSub({ selector: e.target.value })} />
              </Field>
              <div className="grid2">
                <Field label="Match # (0 = first)">
                  <TextIn type="number" min="0" value={sub.nth ?? ''} onChange={e => setSub({ nth: num(e.target.value) })} />
                </Field>
                <Field label="…whose text contains">
                  <TextIn value={sub.textContains || ''} onChange={e => setSub({ textContains: e.target.value || undefined })} />
                </Field>
              </div>
              <Field label="Advanced: raw JS expression (overrides the selector)">
                <TextIn value={sub.expr || ''} placeholder="document.querySelector(…)" onChange={e => setSub({ expr: e.target.value || undefined })} />
              </Field>
            </>)}
            {shot.action === 'frame' && (
              <div className="grid2">
                <Field label="Mode">
                  <select className="ds-select" value={shot.mode || 'focus'} onChange={e => onChange({ mode: e.target.value })}>
                    <option value="focus">focus</option>
                    <option value="wide">wide</option>
                  </select>
                </Field>
                <Field label="Move duration (ms)">
                  <TextIn type="number" value={shot.ms ?? ''} placeholder="600" onChange={e => onChange({ ms: num(e.target.value) })} />
                </Field>
              </div>
            )}
            {(shot.action === 'spot' || shot.action === 'spotOut' || shot.action === 'hold' ||
              shot.action === 'settle' || shot.action === 'crawl') && (
              <Field label="Duration (ms)">
                <TextIn type="number" value={shot.ms ?? ''} onChange={e => onChange({ ms: num(e.target.value) })} />
              </Field>
            )}
            {shot.action === 'click' && (
              <Field label="Settle after click (ms, 0 = none)">
                <TextIn type="number" value={shot.settleMs ?? ''} placeholder="500" onChange={e => onChange({ settleMs: num(e.target.value) })} />
              </Field>
            )}
            {shot.action === 'atVo' && (
              <Field label="Fraction of the spoken line (0–1)">
                <TextIn type="number" step="0.05" min="0" max="1" value={shot.frac ?? ''} onChange={e => onChange({ frac: num(e.target.value) })} />
              </Field>
            )}
            {shot.action === 'caption' && (
              <Field label="Caption text">
                <TextIn value={shot.text || ''} onChange={e => onChange({ text: e.target.value })} />
              </Field>
            )}
            {shot.action === 'run' && (
              <Field label="JS to run in the page">
                <TextIn value={shot.js || ''} onChange={e => onChange({ js: e.target.value })} />
              </Field>
            )}
            {shot.action === 'cta' && (<>
              <Field label="Headline">
                <TextIn value={(shot.lines && shot.lines[0] && (shot.lines[0].text ?? shot.lines[0])) || ''}
                  onChange={e => onChange({ lines: [{ text: e.target.value }, ...(shot.lines || []).slice(1)] })} />
              </Field>
              <Field label="Sub-line">
                <TextIn value={(shot.lines && shot.lines[1] && (shot.lines[1].text ?? shot.lines[1])) || ''}
                  onChange={e => onChange({ lines: [(shot.lines && shot.lines[0]) || { text: '' }, { text: e.target.value }] })} />
              </Field>
              <Field label="Closing narration line">
                <select className="ds-select" value={shot.voKey || ''} onChange={e => onChange({ voKey: e.target.value || undefined })}>
                  <option value="">(silent)</option>
                  {narrationKeys.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </Field>
            </>)}
          </div>
        )}
      </div>
      <div className="tools">
        <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
          <span className="msym">arrow_upward</span>
        </button>
        <button className="icon-btn" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
          <span className="msym">arrow_downward</span>
        </button>
        <button className="icon-btn" title={shot.disabled ? 'Enable' : 'Disable (kept in the file, skipped in the cut)'}
          onClick={() => onChange({ disabled: shot.disabled ? undefined : true })}>
          <span className="msym">{shot.disabled ? 'visibility_off' : 'visibility'}</span>
        </button>
        <button className="icon-btn" title={open ? 'Collapse' : 'Edit'} onClick={() => setOpen(!open)}>
          <span className="msym">{open ? 'expand_less' : 'edit'}</span>
        </button>
        <button className="icon-btn" title="Delete" onClick={onDelete}>
          <span className="msym">delete</span>
        </button>
      </div>
    </div>
  );
}
