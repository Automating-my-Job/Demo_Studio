/**
 * mockBridge.js — a simulated window.demoStudio for running the renderer in
 * a plain browser (vite preview / design review / the app's own demo video).
 * Never active inside Electron, where the preload bridge exists first.
 * Everything here is sample data.
 */
const mockDemo = {
  version: 1,
  name: 'example-dashboard',
  target: { kind: 'url', url: 'https://dashboard.example.com', readySelector: '.app-page' },
  camera: { pageSelector: '.app-page', captionHeight: 104, margin: 48 },
  record: { width: 1920, height: 1080, fps: 60, stallMs: 5000, crf: 20 },
  voice: { engine: 'google', voice: 'en-US-Chirp3-HD-Charon', rate: 172, tempo: 0.9 },
  instructions: 'A 60-second walkthrough for an executive audience: lead with the KPIs, then open one section.',
  narration: [
    { key: '__HOOK__', text: 'What needs attention across every project, on one page.' },
    { key: '__KPIS__', text: 'The totals up top come straight off the model, and nothing here is typed by hand.' },
    { key: '__CTA__', text: 'That is the whole pattern, spotlight and never crop.' },
  ],
  shots: [
    { id: 's1', action: 'frame', subject: { selector: '.app-page' }, mode: 'wide', ms: 600 },
    { id: 's2', action: 'hold', ms: 1500 },
    { id: 's3', action: 'say', caption: 'One page, every project', voKey: '__HOOK__' },
    { id: 's4', action: 'spot', subject: { selector: '.kpi-row' }, ms: 320 },
    { id: 's5', action: 'waitForVo' },
    { id: 's6', action: 'spotOut' },
    { id: 's7', action: 'say', caption: 'The totals', voKey: '__KPIS__' },
    { id: 's8', action: 'spot', subject: { selector: '.kpi', nth: 1 }, ms: 260 },
    { id: 's9', action: 'waitForVo' },
    { id: 's10', action: 'cta', lines: [{ text: 'Spotlight, never crop.' }, { text: 'Demo Studio' }], voKey: '__CTA__' },
  ],
};

export function installMockBridge() {
  let settings = {
    demoSuitePath: '',
    chromePath: '', framingModel: 'gemini-3.6-flash',
    defaultEngine: 'google', defaultVoice: 'en-US-Chirp3-HD-Charon',
    recentProjects: ['~/Demo Studio Projects/example-dashboard'],
    googleTtsKey: { set: true, last4: '4kQz' },
    geminiKey: { set: true, last4: '9f2a' },
  };
  const listeners = [];
  const emit = (jobId, ev) => listeners.forEach(cb => cb({ jobId, ev }));
  let demo = JSON.parse(JSON.stringify(mockDemo));

  const simulateRun = (jobId) => {
    let t = 0;
    const at = (ms, ev) => setTimeout(() => emit(jobId, ev), (t += ms));
    at(200, { type: 'phase', phase: 'narrate', status: 'start', detail: 'google / Charon' });
    for (let i = 1; i <= 3; i++) at(500, { type: 'progress', phase: 'narrate', current: i, total: 3, label: 'clip ' + i + ' of 3' });
    at(300, { type: 'phase', phase: 'narrate', status: 'done' });
    at(200, { type: 'phase', phase: 'record', status: 'start' });
    demo.shots.forEach((s, i) => {
      at(320, { type: 'shot', index: i, id: s.id, action: s.action, atMs: i * 1400 });
      at(10, { type: 'progress', phase: 'record', current: i + 1, total: demo.shots.length, label: s.id + ': ' + s.action });
      at(10, { type: 'log', stream: 'out', text: '  shot ' + s.id + '  ' + s.action });
    });
    at(500, { type: 'phase', phase: 'record', status: 'done', detail: '40.7s' });
    at(200, { type: 'phase', phase: 'deliver', status: 'start' });
    at(700, { type: 'phase', phase: 'deliver', status: 'done' });
    at(100, { type: 'result', ok: true, outPath: '/demo-sample.mp4', deliverPath: '/demo-sample.mp4', durationSec: 40.7, bytes: 1498429, stalls: [] });
    at(100, { type: 'exit', code: 0, signal: null });
  };

  window.demoStudio = {
    getSettings: async () => settings,
    setSettings: async (p) => { settings = { ...settings, ...p }; return settings; },
    diagnose: async () => ({
      ffmpeg: { ok: true, detail: 'ffmpeg version 8.1' },
      ffprobe: { ok: true, detail: 'ffprobe version 8.1' },
      say: { ok: true, detail: 'say (macOS)' },
      mlxWhisper: { ok: true, detail: 'mlx-whisper 0.4' },
      chrome: { ok: true, detail: '/Applications/Google Chrome.app' },
      demoSuite: { ok: true, detail: 'bundled engine' },
      googleKey: { ok: true, detail: 'app key ••••4kQz' },
      geminiKey: { ok: true, detail: 'app key ••••9f2a' },
    }),
    pickFolder: async () => '~/Projects/example-dashboard',
    scanProject: async () => ({ kind: 'app-root', projects: [{ dir: '~/Projects/example-dashboard/demos/walkthrough', kind: 'studio-project', name: 'walkthrough' }] }),
    loadProject: async ({ dir }) => ({ dir, kind: 'studio-project', raw: demo, demo, errors: [], warnings: [] }),
    saveProject: async ({ demo: d }) => { demo = d; return { demo: d, errors: [], warnings: [] }; },
    scaffoldProject: async ({ appRoot }) => appRoot + '/demos/demo',
    createUrlProject: async ({ url }) => '~/Demo Studio Projects/' + (url || 'x').replace(/\W+/g, '-').slice(0, 24),
    listVoices: async ({ engine }) => engine === 'say'
      ? [{ id: 'Samantha', label: 'Samantha', locale: 'en_US' }, { id: 'Zoe (Premium)', label: 'Zoe (Premium)', locale: 'en_US' }]
      : ['Charon', 'Kore', 'Leda', 'Aoede', 'Puck', 'Fenrir'].map(n => ({ id: engine === 'google' ? 'en-US-Chirp3-HD-' + n : n, label: n })),
    startJob: async (payload) => {
      const jobId = 'mock' + Math.random().toString(36).slice(2, 7);
      if (payload.kind === 'run-auto' || payload.kind === 'run-classic') simulateRun(jobId);
      if (payload.kind === 'sample') {
        setTimeout(() => emit(jobId, { type: 'phase', phase: 'sample', status: 'start' }), 200);
        setTimeout(() => emit(jobId, { type: 'sample', path: '/demo-sample.mp4', seconds: 3.2 }), 1400);
        setTimeout(() => emit(jobId, { type: 'exit', code: 0 }), 1500);
      }
      if (payload.kind === 'frame') {
        setTimeout(() => emit(jobId, { type: 'phase', phase: 'frame', status: 'start', detail: 'capturing the page' }), 200);
        setTimeout(() => emit(jobId, { type: 'progress', phase: 'frame', current: 1, total: 3, label: 'page captured — asking Gemini' }), 900);
        setTimeout(() => emit(jobId, { type: 'framing', demoPatch: { narration: demo.narration, shots: demo.shots }, lint: [] }), 2400);
        setTimeout(() => emit(jobId, { type: 'phase', phase: 'frame', status: 'done' }), 2450);
        setTimeout(() => emit(jobId, { type: 'exit', code: 0 }), 2500);
      }
      return { jobId };
    },
    cancelJob: async () => true,
    reveal: async () => {},
    openExternal: async () => {},
    mediaUrl: (p) => p,
    onJobEvent: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
    __mock: true,
  };
}
