'use strict';
/**
 * runManager.js — forks runner jobs and fans their events to the renderer.
 * The runner is forked `detached` so it leads its own process group: cancel
 * is a SIGTERM to the whole group, which reliably takes down headless
 * Chrome and a mid-flight ffmpeg (execFileSync blocks the runner's event
 * loop, so a polite single-process kill would leave orphans).
 */
const { fork } = require('child_process');
const path = require('path');

function createRunManager(deps) {
  // deps: { appPath, getWindow, buildEnv: () => env, onEvent?: (jobId, ev) => bool }
  const jobs = new Map();
  let nextId = 1;

  function send(jobId, ev) {
    if (deps.onEvent && deps.onEvent(jobId, ev) === false) return;
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('job:event', { jobId, ev });
  }

  function start(job) {
    const jobId = 'job' + (nextId++);
    const runnerPath = path.join(deps.appPath, 'runner', 'runner.js');
    const child = fork(runnerPath, [], {
      env: Object.assign(deps.buildEnv(), { ELECTRON_RUN_AS_NODE: '1' }),
      cwd: job.projectDir || deps.appPath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    jobs.set(jobId, { child, job });

    child.on('message', m => {
      if (m && m.type === 'ready') { child.send({ type: 'job', job }); return; }
      if (m && m.type) send(jobId, m);
    });

    const feed = stream => d => {
      String(d).split('\n').forEach(line => {
        if (line.trim()) send(jobId, { type: 'log', stream, text: line });
      });
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));

    child.on('exit', (code, signal) => {
      jobs.delete(jobId);
      send(jobId, { type: 'exit', code, signal: signal || null });
    });
    child.on('error', err => send(jobId, { type: 'error', phase: 'runner', message: err.message }));

    return jobId;
  }

  function cancel(jobId) {
    const entry = jobs.get(jobId);
    if (!entry) return false;
    try { process.kill(-entry.child.pid, 'SIGTERM'); } catch (err) {
      try { entry.child.kill('SIGTERM'); } catch (err2) { /* already gone */ }
    }
    return true;
  }

  function cancelAll() {
    for (const id of Array.from(jobs.keys())) cancel(id);
  }

  return { start, cancel, cancelAll, activeCount: () => jobs.size };
}

module.exports = { createRunManager };
