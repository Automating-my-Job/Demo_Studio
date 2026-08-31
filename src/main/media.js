'use strict';
/**
 * media.js — the studio-media:// protocol: how the renderer plays result
 * videos and voice samples without file:// access or turning webSecurity
 * off. Only allow-listed roots (app userData + opened project folders) are
 * servable; everything else 404s.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const allowedRoots = new Set();

function allowRoot(dir) {
  if (dir) allowedRoots.add(path.resolve(dir));
}

function isAllowed(p) {
  const r = path.resolve(p);
  for (const root of allowedRoots) {
    if (r === root || r.startsWith(root + path.sep)) return true;
  }
  return false;
}

/** studio-media:///absolute/path (URL-encoded). */
function toMediaUrl(filePath) {
  return 'studio-media://local' + encodeURI(path.resolve(filePath));
}

function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'studio-media', privileges: { standard: true, stream: true, supportFetchAPI: true, bypassCSP: false } },
  ]);
}

function registerHandler(protocol, net) {
  protocol.handle('studio-media', (request) => {
    const u = new URL(request.url);
    const filePath = decodeURI(u.pathname);
    if (!isAllowed(filePath)) return new Response('forbidden', { status: 403 });
    // net.fetch on a file URL handles range requests — video seeking works.
    return net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers });
  });
}

module.exports = { allowRoot, isAllowed, toMediaUrl, registerScheme, registerHandler };
