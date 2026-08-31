'use strict';
/**
 * projects.js — project folder classification, demo.json load/save,
 * scaffolding, and applying Gemini framing patches. demo.json on disk is the
 * single source of truth; the editor and the framing step both write
 * through here.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeDemo, DEFAULTS } = require('../../shared/demoSchema.js');

function classifyDir(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  if (has('demo.json')) return 'studio-project';
  if (has('build.js') && has('narration.js')) return 'classic-project';
  return null;
}

/** Classify a picked folder; for an app root, scan two levels for demos. */
function scan(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { kind: 'unknown', projects: [] };
  }
  const own = classifyDir(root);
  if (own) return { kind: own, projects: [{ dir: root, kind: own, name: path.basename(root) }] };

  const projects = [];
  const scanLevel = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    entries.forEach(e => {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) return;
      const full = path.join(dir, e.name);
      const kind = classifyDir(full);
      if (kind) projects.push({ dir: full, kind, name: e.name });
      else if (depth < 2) scanLevel(full, depth + 1);
    });
  };
  scanLevel(root, 1);
  return { kind: 'app-root', projects };
}

function loadDemo(projectDir) {
  const file = path.join(projectDir, 'demo.json');
  if (!fs.existsSync(file)) return { raw: null, demo: null, errors: ['no demo.json'], warnings: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    return { raw: null, demo: null, errors: ['demo.json is not valid JSON: ' + err.message], warnings: [] };
  }
  const { demo, errors, warnings } = normalizeDemo(raw);
  return { raw, demo, errors, warnings };
}

function saveDemo(projectDir, demoObj) {
  const { demo, errors, warnings } = normalizeDemo(demoObj);
  if (!demo) throw new Error(errors.join('; '));
  fs.writeFileSync(path.join(projectDir, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
  return { demo, errors, warnings };
}

/** Merge a framing result into demo.json, preserving target/voice/instructions. */
function applyFramingPatch(projectDir, patch) {
  const { raw } = loadDemo(projectDir);
  if (!raw) throw new Error('no demo.json to patch in ' + projectDir);
  if (Array.isArray(patch.narration)) raw.narration = patch.narration;
  if (Array.isArray(patch.shots)) raw.shots = patch.shots;
  return saveDemo(projectDir, raw);
}

function starterDemo(name, target) {
  return {
    version: 1,
    name,
    target,
    camera: Object.assign({}, DEFAULTS.camera, { pageSelector: target.readySelector || 'body' }),
    record: Object.assign({}, DEFAULTS.record),
    voice: Object.assign({}, DEFAULTS.voice),
    instructions: '',
    narration: [],
    shots: [],
  };
}

/** Scaffold a studio project folder for a live URL under ~/Demo Studio Projects. */
function createUrlProject(url) {
  let host = 'demo';
  try { host = new URL(url).hostname.replace(/[^\w.-]+/g, '') || 'demo'; } catch (err) { /* keep 'demo' */ }
  const base = path.join(os.homedir(), 'Demo Studio Projects');
  let dir = path.join(base, host);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, host + '-' + i);
  fs.mkdirSync(dir, { recursive: true });
  const demo = starterDemo(path.basename(dir), { kind: 'url', url, readySelector: '' });
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
  return dir;
}

/** Scaffold a new demo project inside an app root. */
function scaffold(appRoot, name) {
  const safe = (name || 'demo').replace(/[^\w-]+/g, '-');
  let dir = path.join(appRoot, 'demos', safe);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(appRoot, 'demos', safe + '-' + i);
  fs.mkdirSync(dir, { recursive: true });
  const demo = starterDemo(safe, { kind: 'url', url: '', readySelector: '' });
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
  return dir;
}

module.exports = { scan, classifyDir, loadDemo, saveDemo, applyFramingPatch, createUrlProject, scaffold, starterDemo };
