'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeGithubShare, rawVideoUrl, renderGithubReadme } = require('../shared/githubShare.js');

function loadGithubShare(projectDir, demo) {
  let raw = demo && demo.githubShare;
  const configPath = path.join(projectDir, 'github-share.json');
  if (raw == null && fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error('github-share.json is not valid JSON: ' + err.message);
    }
  }
  const { config, errors } = normalizeGithubShare(raw);
  if (errors.length) throw new Error('GitHub share settings have problems:\n- ' + errors.join('\n- '));
  return config;
}

function buildGithubShareKit({ projectDir, deliverPath, config }) {
  if (!config) return null;
  if (!deliverPath || !fs.existsSync(deliverPath)) {
    throw new Error('GitHub share kit needs the upload-safe delivery MP4');
  }

  const demoOut = path.resolve(projectDir, 'demo-out');
  const rootPath = path.resolve(demoOut, 'github-share');
  if (!rootPath.startsWith(demoOut + path.sep)) {
    throw new Error('refusing GitHub share output outside demo-out');
  }
  const repositoryPath = path.join(rootPath, 'repository');
  const demoPath = path.join(repositoryPath, 'demo');
  const videoPath = path.join(demoPath, config.videoFileName);
  const descriptionPath = path.join(rootPath, 'github-description.txt');

  fs.rmSync(rootPath, { recursive: true, force: true });
  fs.mkdirSync(demoPath, { recursive: true });
  fs.copyFileSync(deliverPath, videoPath);
  fs.writeFileSync(path.join(repositoryPath, 'README.md'), renderGithubReadme(config));
  fs.writeFileSync(descriptionPath, config.description + '\n');

  return {
    rootPath,
    repositoryPath,
    descriptionPath,
    videoPath,
    repository: config.repository,
    rawUrl: rawVideoUrl(config),
  };
}

module.exports = { loadGithubShare, buildGithubShareKit };
