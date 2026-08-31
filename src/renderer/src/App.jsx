import React from 'react';
import { useStore } from './state/store.jsx';
import HomeScreen from './screens/HomeScreen.jsx';
import TargetScreen from './screens/TargetScreen.jsx';
import ScriptScreen from './screens/ScriptScreen.jsx';
import VoiceScreen from './screens/VoiceScreen.jsx';
import RunScreen from './screens/RunScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';

const NAV = [
  { id: 'home', icon: 'home', label: 'Home', needsProject: false },
  { id: 'target', icon: 'center_focus_weak', label: 'Framing', needsProject: true },
  { id: 'script', icon: 'movie_edit', label: 'Script', needsProject: true },
  { id: 'voice', icon: 'record_voice_over', label: 'Voice', needsProject: true },
  { id: 'run', icon: 'smart_display', label: 'Run', needsProject: true },
  { id: 'settings', icon: 'settings', label: 'Settings', needsProject: false },
];

export default function App() {
  const { state, actions } = useStore();
  const hasProject = !!state.project;
  const running = state.job.running;

  const Screen = {
    home: HomeScreen, target: TargetScreen, script: ScriptScreen,
    voice: VoiceScreen, run: RunScreen, settings: SettingsScreen,
  }[state.screen] || HomeScreen;

  return (
    <div className="app">
      <nav className="rail">
        {NAV.map(item => (
          <button
            key={item.id}
            className={'rail-item' + (state.screen === item.id ? ' active' : '')}
            disabled={item.needsProject && !hasProject}
            onClick={() => actions.go(item.id)}
            title={item.needsProject && !hasProject ? 'Open a project first' : item.label}
          >
            <span className="pill">
              <span className="msym">{item.icon}</span>
            </span>
            {item.label}
            {item.id === 'run' && running ? <md-linear-progress indeterminate style={{ width: '48px', marginTop: '3px' }} /> : null}
          </button>
        ))}
        <div className="spacer" />
      </nav>
      <main className="content">
        <div className="content-inner">
          <Screen />
        </div>
      </main>
    </div>
  );
}
