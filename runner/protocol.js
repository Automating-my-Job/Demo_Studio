'use strict';
/**
 * protocol.js — how the runner talks to whoever launched it. Forked from
 * Electron there is an IPC channel (process.send); run under bare `node`
 * (tests, debugging) events fall back to JSON lines on stdout. Human/library
 * logs go to stderr in that mode so the two never share a stream.
 */
const events = require('../shared/events.js');

function emit(ev) {
  if (process.send) {
    try { process.send(ev); } catch (err) { /* channel closed mid-shutdown */ }
  } else {
    process.stdout.write(JSON.stringify(ev) + '\n');
  }
}

module.exports = { emit, events };
