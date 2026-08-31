import React, { useEffect, useRef } from 'react';
import AnsiText from './AnsiText.jsx';

export default function LogConsole({ logs }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);
  if (!logs.length) return null;
  return (
    <div className="log-console" ref={ref}>
      {logs.map((l, i) => (
        <div key={i} className={l.stream === 'err' ? 'err' : ''}>
          <AnsiText text={l.text} />
        </div>
      ))}
    </div>
  );
}
