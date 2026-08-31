'use strict';
/**
 * events.js — the runner → app event protocol. Every event the runner emits
 * is built through these constructors so the shape is enforced in one place;
 * the renderer switches on `type` alone.
 */
const PHASES = ['narrate', 'verify', 'record', 'mux', 'deliver', 'frame', 'sample', 'classic', 'review'];
const STATUSES = ['start', 'done', 'error'];

function phase(name, status, detail) {
  if (PHASES.indexOf(name) === -1) throw new Error('unknown phase: ' + name);
  if (STATUSES.indexOf(status) === -1) throw new Error('unknown status: ' + status);
  const ev = { type: 'phase', phase: name, status };
  if (detail) ev.detail = String(detail);
  return ev;
}

function progress(phaseName, current, total, label) {
  return { type: 'progress', phase: phaseName, current: Number(current), total: Number(total), label: label || '' };
}

function shot(index, id, action, atMs) {
  return { type: 'shot', index, id, action, atMs: Math.round(atMs || 0) };
}

function log(stream, text) {
  return { type: 'log', stream: stream === 'err' ? 'err' : 'out', text: String(text) };
}

function framing(demoPatch, lint) {
  return { type: 'framing', demoPatch, lint: lint || [] };
}

function sample(pathToWav, seconds) {
  return { type: 'sample', path: pathToWav, seconds: Number(seconds) || 0 };
}

function result(fields) {
  return Object.assign({ type: 'result', ok: true, stalls: [] }, fields);
}

function error(phaseName, message, extra) {
  return Object.assign({ type: 'error', phase: phaseName, message: String(message) }, extra || {});
}

/** Parse one JSON line from a bare-node runner's stdout; null if not an event. */
function parseLine(line) {
  const t = String(line).trim();
  if (!t.startsWith('{')) return null;
  try {
    const ev = JSON.parse(t);
    return ev && typeof ev.type === 'string' ? ev : null;
  } catch (err) {
    return null;
  }
}

module.exports = { PHASES, phase, progress, shot, log, framing, sample, result, error, parseLine };
