import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';

const StoreCtx = createContext(null);

const emptyJob = () => ({
  id: null, kind: null, running: false,
  phases: {}, // phase -> 'start' | 'done' | 'error'
  progress: null, // {phase, current, total, label}
  logs: [],
  result: null,
  error: null, // {phase, message, shotId?, stalls?}
  sample: null,
  framing: null, // {lint}
});

const initial = {
  screen: 'home',
  settings: null,
  diagnostics: null,
  project: null, // {dir, kind, demo, errors, warnings}
  job: emptyJob(),
  sampleJob: emptyJob(),
  auxJob: emptyJob(), // verify / review — runs beside the main result
};

function jobReduce(job, ev) {
  const j = { ...job };
  switch (ev.type) {
    case 'phase':
      j.phases = { ...j.phases, [ev.phase]: ev.status };
      if (ev.status === 'start') j.progress = { phase: ev.phase, current: 0, total: 0, label: ev.detail || '' };
      break;
    case 'progress':
      j.progress = ev;
      break;
    case 'log':
      j.logs = job.logs.length > 1500 ? [...job.logs.slice(-1200), ev] : [...job.logs, ev];
      break;
    case 'shot':
      break; // progress event carries the display info
    case 'result':
      j.result = ev; j.running = false;
      break;
    case 'sample':
      j.sample = ev; j.running = false;
      break;
    case 'framing':
      j.framing = { lint: ev.lint || [], applyError: ev.applyError || null };
      break;
    case 'review':
      break; // review results arrive on the result event
    case 'error':
      j.error = ev; j.running = false;
      break;
    case 'exit':
      j.running = false;
      if (ev.code !== 0 && !j.error && !j.result && !j.sample) {
        j.error = { phase: 'runner', message: ev.signal ? 'stopped (' + ev.signal + ')' : 'the runner exited with code ' + ev.code + ' — see the log' };
      }
      break;
    default:
      break;
  }
  return j;
}

function reducer(state, a) {
  switch (a.type) {
    case 'screen': return { ...state, screen: a.screen };
    case 'settings': return { ...state, settings: a.settings };
    case 'diagnostics': return { ...state, diagnostics: a.diagnostics };
    case 'project': return { ...state, project: a.project };
    case 'demo': return { ...state, project: { ...state.project, demo: a.demo, errors: a.errors || [], warnings: a.warnings || [] } };
    case 'job:new': return { ...state, job: { ...emptyJob(), id: a.jobId, kind: a.kind, running: true } };
    case 'sample:new': return { ...state, sampleJob: { ...emptyJob(), id: a.jobId, kind: 'sample', running: true } };
    case 'aux:new': return { ...state, auxJob: { ...emptyJob(), id: a.jobId, kind: a.kind, running: true } };
    case 'job:event': {
      if (state.job.id === a.jobId) return { ...state, job: jobReduce(state.job, a.ev) };
      if (state.sampleJob.id === a.jobId) return { ...state, sampleJob: jobReduce(state.sampleJob, a.ev) };
      if (state.auxJob.id === a.jobId) return { ...state, auxJob: jobReduce(state.auxJob, a.ev) };
      return state;
    }
    default: return state;
  }
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const api = window.demoStudio;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    api.getSettings().then(settings => dispatch({ type: 'settings', settings }));
    const off = api.onJobEvent(({ jobId, ev }) => {
      dispatch({ type: 'job:event', jobId, ev });
      // A framing result rewrites demo.json — reload so the editor shows it.
      if (ev.type === 'framing') {
        const dir = stateRef.current.project && stateRef.current.project.dir;
        if (dir) actions.openProject(dir, { keepScreen: true });
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = useMemo(() => ({
    go: (screen) => dispatch({ type: 'screen', screen }),

    refreshSettings: async () => dispatch({ type: 'settings', settings: await api.getSettings() }),
    saveSettings: async (partial) => dispatch({ type: 'settings', settings: await api.setSettings(partial) }),
    diagnose: async () => dispatch({ type: 'diagnostics', diagnostics: await api.diagnose() }),

    openProject: async (dir, opts) => {
      const project = await api.loadProject({ dir });
      dispatch({ type: 'project', project });
      await api.getSettings().then(settings => dispatch({ type: 'settings', settings }));
      if (!opts || !opts.keepScreen) dispatch({ type: 'screen', screen: 'target' });
      return project;
    },

    saveDemo: async (demo) => {
      const p = stateRef.current.project;
      if (!p) return;
      dispatch({ type: 'demo', demo }); // optimistic — keep typing snappy
      const saved = await api.saveProject({ dir: p.dir, demo });
      dispatch({ type: 'demo', demo: saved.demo, errors: saved.errors, warnings: saved.warnings });
      return saved;
    },

    startRun: async (overrides) => {
      const p = stateRef.current.project;
      if (!p) return;
      const kind = p.kind === 'classic-project' ? 'run-classic' : 'run-auto';
      const { jobId } = await api.startJob({ kind, projectDir: p.dir, overrides: overrides || {} });
      dispatch({ type: 'job:new', jobId, kind });
    },

    startFraming: async () => {
      const p = stateRef.current.project;
      if (!p) return;
      const { jobId } = await api.startJob({ kind: 'frame', projectDir: p.dir });
      dispatch({ type: 'job:new', jobId, kind: 'frame' });
    },

    playSample: async ({ engine, voice, text, rate, tempo }) => {
      const { jobId } = await api.startJob({ kind: 'sample', engine, voice, text, rate, tempo });
      dispatch({ type: 'sample:new', jobId });
    },

    startVerify: async () => {
      const p = stateRef.current.project;
      if (!p) return;
      const { jobId } = await api.startJob({ kind: 'verify', projectDir: p.dir });
      dispatch({ type: 'aux:new', jobId, kind: 'verify' });
    },

    startReview: async () => {
      const p = stateRef.current.project;
      if (!p) return;
      const { jobId } = await api.startJob({ kind: 'review', projectDir: p.dir });
      dispatch({ type: 'aux:new', jobId, kind: 'review' });
    },

    cancelJob: async () => {
      const id = stateRef.current.job.id;
      if (id) await api.cancelJob({ jobId: id });
    },
  }), [api]);

  return <StoreCtx.Provider value={{ state, actions, api }}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  return useContext(StoreCtx);
}
