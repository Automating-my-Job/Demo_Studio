'use strict';
/**
 * index.js — Electron main: window, IPC wiring, protocol registration.
 * All pipeline work happens in forked runner processes (runManager.js);
 * nothing here ever require()s demo-suite or user project code.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createSettings } = require('./settings.js');
const { buildChildEnv } = require('./env.js');
const { createRunManager } = require('./runManager.js');
const projects = require('./projects.js');
const media = require('./media.js');
const { listSayVoices } = require('./voices.js');
const { ENGINES } = require('../../shared/voicesCatalog.js');

media.registerScheme(protocol);

let mainWindow = null;
const settings = createSettings({
  file: path.join(app.getPath('userData'), 'settings.json'),
  safeStorage,
});
const jobMeta = new Map();

const runs = createRunManager({
  appPath: app.getAppPath(),
  getWindow: () => mainWindow,
  buildEnv: () => buildChildEnv(process.env, settings),
  onEvent: (jobId, ev) => {
    // A framing result is written into the project's demo.json before the
    // renderer hears about it — the file stays the single source of truth.
    if (ev.type === 'framing') {
      const job = jobMeta.get(jobId);
      if (job && job.projectDir) {
        try { projects.applyFramingPatch(job.projectDir, ev.demoPatch); }
        catch (err) { ev.applyError = err.message; }
      }
    }
    if (ev.type === 'exit') jobMeta.delete(jobId);
    return true;
  },
});

/** The bundled engine unless the user pointed Settings at a live checkout. */
function resolveDemoSuitePath(s) {
  return s.demoSuitePath || path.join(app.getAppPath(), 'vendor', 'demo-suite');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    title: 'Demo Studio',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../out/renderer/index.html'));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function checkBin(bin, args, env) {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: 15000 }, (err, stdout) => {
      if (err) resolve({ ok: false, detail: err.code === 'ENOENT' ? 'not found on PATH' : String(err.message).slice(0, 120) });
      else resolve({ ok: true, detail: String(stdout).split('\n')[0].slice(0, 80) });
    });
  });
}

async function diagnose() {
  const env = buildChildEnv(process.env, settings);
  const s = settings.load();
  const chromeCandidates = [
    s.chromePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  const chromeHit = chromeCandidates.filter(c => fs.existsSync(c))[0];
  const suitePath = resolveDemoSuitePath(s);
  const suiteOk = fs.existsSync(path.join(suitePath, 'lib', 'narrate.js'));
  const masked = settings.masked();
  const dotfile = name => {
    const p = path.join(require('os').homedir(), name);
    try { return { exists: true, bytes: fs.statSync(p).size }; } catch (err) { return { exists: false, bytes: 0 }; }
  };
  const [ffmpeg, ffprobe, say, mlx] = await Promise.all([
    checkBin('ffmpeg', ['-version'], env),
    checkBin('ffprobe', ['-version'], env),
    process.platform === 'darwin' ? checkBin('say', ['-v', '?'], env) : { ok: false, detail: 'macOS only' },
    checkBin('python3', ['-c', 'import mlx_whisper; print("mlx-whisper", mlx_whisper.__version__)'], env),
  ]);
  return {
    ffmpeg, ffprobe, say,
    mlxWhisper: mlx.ok ? mlx : { ok: false, detail: 'pip3 install mlx-whisper (only needed for the Gemini TTS engine)' },
    chrome: chromeHit ? { ok: true, detail: chromeHit } : { ok: false, detail: 'install Google Chrome or set a path in Settings' },
    demoSuite: suiteOk
      ? { ok: true, detail: s.demoSuitePath ? suitePath : 'bundled engine' }
      : { ok: false, detail: 'demo-suite engine not found at ' + suitePath },
    googleKey: masked.googleTtsKey.set
      ? { ok: true, detail: 'app key ••••' + masked.googleTtsKey.last4 }
      : (dotfile('.google_tts_key').exists
        ? { ok: true, detail: '~/.google_tts_key (' + dotfile('.google_tts_key').bytes + ' bytes' + (dotfile('.google_tts_key').bytes < 25 ? ' — looks too short for a real key' : '') + ')' }
        : { ok: false, detail: 'no key — paste one in Settings (or use the free macOS say engine)' }),
    geminiKey: masked.geminiKey.set
      ? { ok: true, detail: 'app key ••••' + masked.geminiKey.last4 }
      : (dotfile('.gemini_tts_key').exists
        ? { ok: true, detail: '~/.gemini_tts_key' }
        : { ok: false, detail: 'no key — needed for Gemini framing' }),
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function wireIpc() {
  ipcMain.handle('settings:get', () => settings.masked());
  ipcMain.handle('settings:set', (e, partial) => settings.save(partial));
  ipcMain.handle('settings:diagnose', () => diagnose());

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('project:scan', (e, { root }) => projects.scan(root));
  ipcMain.handle('project:load', (e, { dir }) => {
    media.allowRoot(dir);
    settings.rememberProject(dir);
    const loaded = projects.loadDemo(dir);
    return Object.assign({ dir, kind: projects.classifyDir(dir) }, loaded);
  });
  ipcMain.handle('project:save', (e, { dir, demo }) => projects.saveDemo(dir, demo));
  ipcMain.handle('project:scaffold', (e, { appRoot, name }) => projects.scaffold(appRoot, name));
  ipcMain.handle('project:createUrl', (e, { url }) => projects.createUrlProject(url));

  ipcMain.handle('voices:list', async (e, { engine }) => {
    if (engine === 'say') return listSayVoices(buildChildEnv(process.env, settings));
    const cat = ENGINES.filter(x => x.id === engine)[0];
    return (cat && cat.voices) || [];
  });

  ipcMain.handle('job:start', (e, payload) => {
    const s = settings.load();
    const job = Object.assign({}, payload, {
      demoSuitePath: resolveDemoSuitePath(s),
      userDataDir: app.getPath('userData'),
      chromePath: s.chromePath || undefined,
      framingModel: s.framingModel,
    });
    if (job.projectDir) media.allowRoot(job.projectDir);
    media.allowRoot(app.getPath('userData'));
    const jobId = runs.start(job);
    jobMeta.set(jobId, job);
    return { jobId };
  });
  ipcMain.handle('job:cancel', (e, { jobId }) => runs.cancel(jobId));

  ipcMain.handle('shell:reveal', (e, { path: p }) => { shell.showItemInFolder(p); });
  ipcMain.handle('shell:openExternal', (e, { url }) => shell.openExternal(url));
}

app.whenReady().then(() => {
  media.registerHandler(protocol, net);
  media.allowRoot(app.getPath('userData'));
  wireIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => runs.cancelAll());
app.on('window-all-closed', () => { app.quit(); });
