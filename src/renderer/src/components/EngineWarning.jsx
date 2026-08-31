import React from 'react';

export default function EngineWarning({ text, level = 'warn', icon = 'warning' }) {
  if (!text) return null;
  return (
    <div className={'banner ' + level}>
      <span className="msym">{icon}</span>
      <span>{text}</span>
    </div>
  );
}
