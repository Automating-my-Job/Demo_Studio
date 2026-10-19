'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeGithubShare, rawVideoUrl } = require('../shared/githubShare.js');
const { loadGithubShare, buildGithubShareKit } = require('../runner/githubShareKit.js');

function profile() {
  return {
    repository: 'https://github.com/example/demo-repo',
    title: 'Example App — Demo',
    description: 'Demo video for Example App.',
    summary: 'Example App helps teams see what needs attention.',
    features: ['See the executive summary.', 'Drill into supporting records.'],
    availability: 'Publishing soon. Free for pilot customers who provide feedback.',
  };
}

test('validates settings and builds the direct GitHub raw URL', () => {
  const { config, errors } = normalizeGithubShare(profile());
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(rawVideoUrl(config),
    'https://github.com/example/demo-repo/raw/refs/heads/main/demo/demo.mp4');
});

test('rejects unsafe repositories, branches, filenames, and long descriptions', () => {
  const raw = profile();
  raw.repository = 'https://example.com/repo';
  raw.branch = '../main';
  raw.videoFileName = '../demo.mp4';
  raw.description = 'x'.repeat(351) + '\nsecond line';
  const { errors } = normalizeGithubShare(raw);
  assert.ok(errors.some(error => error.includes('github.com')));
  assert.ok(errors.some(error => error.includes('branch')));
  assert.ok(errors.some(error => error.includes('filename')));
  assert.ok(errors.some(error => error.includes('350')));
  assert.ok(errors.some(error => error.includes('one line')));
});

test('loads classic-project settings and produces a two-file repository kit', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-studio-share-'));
  try {
    fs.writeFileSync(path.join(projectDir, 'github-share.json'), JSON.stringify(profile()));
    const outDir = path.join(projectDir, 'demo-out');
    fs.mkdirSync(outDir);
    const deliverPath = path.join(outDir, 'demo-linkedin.mp4');
    fs.writeFileSync(deliverPath, Buffer.from('video-bytes'));

    const config = loadGithubShare(projectDir, null);
    const result = buildGithubShareKit({ projectDir, deliverPath, config });
    assert.deepStrictEqual(fs.readdirSync(result.repositoryPath).sort(), ['README.md', 'demo']);
    assert.deepStrictEqual(fs.readdirSync(path.join(result.repositoryPath, 'demo')), ['demo.mp4']);
    assert.strictEqual(fs.readFileSync(result.videoPath, 'utf8'), 'video-bytes');
    assert.match(fs.readFileSync(path.join(result.repositoryPath, 'README.md'), 'utf8'),
      /does not contain application source code/);
    assert.match(fs.readFileSync(path.join(result.repositoryPath, 'README.md'), 'utf8'),
      /raw\/refs\/heads\/main\/demo\/demo\.mp4/);
    assert.strictEqual(fs.readFileSync(result.descriptionPath, 'utf8'), 'Demo video for Example App.\n');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
