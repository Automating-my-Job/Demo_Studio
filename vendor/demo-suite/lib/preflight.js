'use strict';
/**
 * preflight.js — the wording check: every label a script quotes must be on
 * screen, exactly as written, when its beat plays. NODE-ONLY, pure.
 *
 * ===========================================================================
 * WHY
 * ===========================================================================
 * A live take narrates what the viewer sees ("open Manage Assignments"), and
 * the spotlight lands on the element with that label. Salesforce renames
 * things between releases and our own app's copy changes between builds, so
 * a script written last month can name a button that no longer exists. The
 * recorder runs the storyboard once WITHOUT filming (runDemo({dryRun:true}))
 * and checks each beat's labels against every frame of the live page; this
 * module holds the pure parts: which labels a beat quotes, which on-screen
 * text is closest to a missing one, and the script-vs-screen diff.
 */

/**
 * The labels a line quotes: “curly” or "straight" double quotes. Single
 * quotes are left alone; they collide with apostrophes ("isn't").
 */
function quotedLabels(text) {
  const out = [];
  const re = /“([^”]+)”|"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const label = (m[1] || m[2]).replace(/\s+/g, ' ').trim();
    if (label && out.indexOf(label) === -1) out.push(label);
  }
  return out;
}

/** The spoken form of a line: quote marks dropped, words unchanged. */
function spokenText(text) {
  return String(text || '').replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * The on-screen texts most like a missing label, best first. A case-only
 * difference or a containing phrase ranks above plain edit distance.
 */
function closest(label, candidates, n) {
  const L = String(label).toLowerCase();
  const scored = [];
  (candidates || []).forEach((c) => {
    const C = String(c).toLowerCase();
    let score;
    if (C === L) score = 0;                                   // case differs
    else if (C.indexOf(L) !== -1 || L.indexOf(C) !== -1) score = 0.2 + Math.abs(C.length - L.length) / Math.max(C.length, L.length);
    else score = 1 + levenshtein(L, C) / Math.max(L.length, C.length);
    if (score < 1.5) scored.push({ c: c, score: score });
  });
  scored.sort((a, b) => a.score - b.score || a.c.length - b.c.length);
  return scored.slice(0, n || 3).map((s) => s.c);
}

/**
 * The script-vs-screen diff for every beat with a label that never showed.
 * @param {Array<{key: string, say: string, misses: Array<{label, status, near}>}>} beats
 */
function formatReport(beats, totalLabels) {
  const bad = beats.filter((b) => b.misses && b.misses.length);
  if (!bad.length) return 'Wording preflight passed: ' + (totalLabels || 0) + ' label(s) on screen as scripted.';
  const missCount = bad.reduce((n, b) => n + b.misses.length, 0);
  const lines = ['Wording preflight FAILED: ' + missCount + ' of ' + (totalLabels || missCount) +
    ' label(s) not on screen as scripted. Fix the script or the app, then re-run.'];
  bad.forEach((b) => {
    lines.push('');
    lines.push('  ' + b.key + '  "' + spokenText(b.say || '').slice(0, 90) + '"');
    b.misses.forEach((m) => {
      lines.push('    - script: "' + m.label + '"   screen: ' + m.status +
        (m.near && m.near.length ? '   closest on screen: ' + m.near.map((x) => '"' + x + '"').join(', ') : ''));
    });
  });
  return lines.join('\n');
}

/**
 * Words for the after-filming check: lower case, "/" read as "slash" and
 * "&" as "and" (as Chirp 3 HD speaks them), punctuation dropped.
 */
function speechWords(text) {
  return String(text || '').toLowerCase().replace(/\//g, ' slash ').replace(/&/g, ' and ')
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/**
 * Word-for-word check of what Whisper heard against the script. ASR often
 * joins or splits compounds ("QuickFind" for "Quick Find"), so two runs that
 * spell the same letters are equal; otherwise the differing stretches are
 * listed. Returns {ok, diffs: [{script, heard}]}.
 */
function wordDiff(script, heard) {
  const a = speechWords(script), b = speechWords(heard);
  if (a.join('') === b.join('')) return { ok: true, diffs: [] };
  // LCS over words, then report each unmatched stretch side by side.
  const m = a.length, n = b.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const diffs = [];
  let i = 0, j = 0, sa = [], sb = [];
  const flush = () => {
    if (sa.length || sb.length) {
      if (sa.join('') !== sb.join('')) diffs.push({ script: sa.join(' '), heard: sb.join(' ') });
      sa = []; sb = [];
    }
  };
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < n && (i >= m || L[i][j + 1] >= L[i + 1][j])) sb.push(b[j++]);
    else sa.push(a[i++]);
  }
  flush();
  return { ok: diffs.length === 0, diffs: diffs };
}

module.exports = { quotedLabels: quotedLabels, spokenText: spokenText, closest: closest, formatReport: formatReport, levenshtein: levenshtein, speechWords: speechWords, wordDiff: wordDiff };
