'use strict';

const GITHUB_REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/;
const SAFE_BRANCH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]+$/;
const SAFE_VIDEO = /^[A-Za-z0-9._-]+\.mp4$/i;

function normalizeGithubShare(raw) {
  const errors = [];
  if (raw === undefined || raw === null) return { config: null, errors };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: ['githubShare must be an object'] };
  }

  const config = Object.assign({ branch: 'main', videoFileName: 'demo.mp4' }, raw);
  ['repository', 'title', 'description', 'summary'].forEach(key => {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      errors.push('githubShare.' + key + ' must be a non-empty string');
    } else {
      config[key] = config[key].trim();
    }
  });

  if (typeof config.repository === 'string') {
    config.repository = config.repository.replace(/\.git\/?$/, '');
    if (!GITHUB_REPOSITORY.test(config.repository)) {
      errors.push('githubShare.repository must be an https://github.com/OWNER/REPOSITORY URL');
    }
  }
  if (typeof config.description === 'string' && config.description.length > 350) {
    errors.push('githubShare.description must be 350 characters or fewer');
  }
  if (typeof config.description === 'string' && /[\r\n]/.test(config.description)) {
    errors.push('githubShare.description must stay on one line');
  }
  if (typeof config.branch !== 'string' || !SAFE_BRANCH.test(config.branch)) {
    errors.push('githubShare.branch must be a safe Git branch name');
  }
  if (typeof config.videoFileName !== 'string' || !SAFE_VIDEO.test(config.videoFileName)) {
    errors.push('githubShare.videoFileName must be a plain .mp4 filename');
  }
  if (!Array.isArray(config.features) || !config.features.length || config.features.length > 12 ||
      config.features.some(item => typeof item !== 'string' || !item.trim())) {
    errors.push('githubShare.features must contain 1–12 non-empty strings');
  } else {
    config.features = config.features.map(item => item.trim());
  }
  if (config.availability !== undefined) {
    if (typeof config.availability !== 'string' || !config.availability.trim()) {
      errors.push('githubShare.availability must be a non-empty string when provided');
    } else {
      config.availability = config.availability.trim();
    }
  }

  return { config, errors };
}

function rawVideoUrl(config) {
  const branch = config.branch.split('/').map(encodeURIComponent).join('/');
  return config.repository + '/raw/refs/heads/' + branch + '/demo/' + encodeURIComponent(config.videoFileName);
}

function renderGithubReadme(config) {
  const featureLines = config.features.map(feature => '- ' + feature).join('\n');
  const availability = config.availability ? '\n> **' + config.availability + '**\n' : '';
  return '# ' + config.title + '\n\n' +
    'This repository is only for sharing the demo video. It does not contain application source code.\n\n' +
    config.summary + '\n' + availability + '\n' +
    '## Watch the demo\n\n' +
    '[Watch or download the demo](' + rawVideoUrl(config) + ')\n\n' +
    '## What it shows\n\n' + featureLines + '\n';
}

module.exports = { normalizeGithubShare, rawVideoUrl, renderGithubReadme };
