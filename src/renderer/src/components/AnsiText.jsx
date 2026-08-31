import React from 'react';

/** Minimal ANSI SGR → styled spans (the demo-suite logs use a handful of codes). */
const CLASS = { 2: 'ansi-dim', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow', 34: 'ansi-blue', 36: 'ansi-cyan', 90: 'ansi-dim' };

export default function AnsiText({ text }) {
  const parts = [];
  let cls = null;
  let buf = '';
  const flush = () => { if (buf) { parts.push({ cls, text: buf }); buf = ''; } };
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    buf += text.slice(last, m.index);
    flush();
    const codes = m[1].split(';').map(Number);
    cls = null;
    codes.forEach(c => { if (c === 0) cls = null; else if (CLASS[c]) cls = CLASS[c]; });
    last = re.lastIndex;
  }
  buf += text.slice(last);
  flush();
  return (
    <>
      {parts.map((p, i) => p.cls
        ? <span key={i} className={p.cls}>{p.text}</span>
        : <React.Fragment key={i}>{p.text}</React.Fragment>)}
    </>
  );
}
