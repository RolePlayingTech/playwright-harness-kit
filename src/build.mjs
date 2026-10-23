import { existsSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  applyFilePlan,
  assertSafeTarget,
  normalizeRelPath,
  normalizeText,
  safeJoin,
  sha256,
  unifiedDiff,
  validateCopyTarget,
  validateSkillName,
} from './fs-safe.mjs';

const MANAGED_MARKER_RE = /<!-- playwright-harness-kit:managed sha256=([a-f0-9]{64}) -->/;
const ZERO_HASH = '0'.repeat(64);
const YAML_PLAIN_UNSAFE_RE = /[:#"'[\]{}&*!|>%@`\\]|^\s|\s$|^[-?:,]/;
export const MANAGED_MANIFEST_REL = '.playwright-harness/.managed-manifest.json';

export function formatYamlScalar(value) {
  const normalized = normalizeText(value).trim();
  if (!normalized) return '""';
  if (normalized.includes('\n')) {
    const lines = normalized.split('\n').map((line) => `  ${line}`);
    return `|-\n${lines.join('\n')}`;
  }
  if (YAML_PLAIN_UNSAFE_RE.test(normalized)) {
    return JSON.stringify(normalized);
  }
  return normalized;
}

export function parseSkillFrontmatter(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    return { ok: false, error: 'Frontmatter must start with `---` on line 1.' };
  }
  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) {
    return { ok: false, error: 'Frontmatter is missing closing `---`.' };
  }
  const data = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      return { ok: false, error: `Invalid YAML frontmatter at line ${i + 1}: ${line}` };
    }
    const [, key, rawRest] = match;
    const rest = rawRest.trim();
    if (rest === '|-' || rest === '|' || rest === '>-' || rest === '>') {
      const blockLines = [];
      while (i + 1 < closeIdx && (lines[i + 1].startsWith('  ') || lines[i + 1].trim() === '')) {
        i++;
        blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '');
      }
      data[key] = rest.startsWith('>') ? blockLines.join(' ').trim() : blockLines.join('\n').trimEnd();
    } else if (rest.startsWith('"')) {
      try {
        data[key] = JSON.parse(rest);
      } catch (error) {
        return { ok: false, error: `Invalid double-quoted YAML scalar at line ${i + 1}: ${error.message}` };
      }
    } else if (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) {
      data[key] = rest.slice(1, -1).replaceAll("''", "'");
    } else {
      if (/:(\s|$)/.test(rest) || /\s#/.test(rest)) {
        return { ok: false, error: `Unquoted YAML scalar at line ${i + 1} contains colon or comment syntax.` };
      }
      data[key] = rest;
    }
  }
  const nameErr = validateSkillName(data.name || '');
  if (nameErr) return { ok: false, error: nameErr, data };
  if (!data.description || typeof data.description !== 'string' || !data.description.trim()) {
    return { ok: false, error: 'Frontmatter is missing `description`.', data };
  }
  if (data.description.length > 1024) {
    return { ok: false, error: 'Frontmatter `description` exceeds 1024 characters.', data };
  }
  if (/[<>]/.test(data.description)) {
    return { ok: false, error: 'Frontmatter `description` cannot contain angle brackets (< or >).', data };
  }
  return { ok: true, data, body: lines.slice(closeIdx + 1).join('\n') };
}

export function verifyManagedContent(text) {
  const normalized = normalizeText(text);
  const match = MANAGED_MARKER_RE.exec(normalized);
  if (!match) return { managed: false, unedited: false };
  const recordedHash = match[1];
  const zeroed = normalized.replace(MANAGED_MARKER_RE, `<!-- playwright-harness-kit:managed sha256=${ZERO_HASH} -->`);
  const actualHash = sha256(zeroed);
  return { managed: true, unedited: actualHash === recordedHash };
}

export function renderSkill(spec, skill) {
  const nameErr = validateSkillName(skill?.name);
  if (nameErr) throw new Error(`Cannot render skill: ${nameErr}`);
  const byId = new Map(spec.scenarios.map((s) => [s.id, s]));
  const scenarios = [];
  for (const id of skill.covers) {
    const s = byId.get(id);
    if (!s) {
      throw new Error(`Cannot render skill "${skill.name}": covers unknown scenario "${id}".`);
    }
    scenarios.push(s);
  }

  const steps = scenarios.map((s, index) => {
    const tierObj = spec.tiers[s.tier];
    const cmd = tierObj ? tierObj.command : s.tier;
    const net = tierObj ? tierObj.networkPolicy : 'unknown';
    let visualClause = 'DOM & ARIA assertions only (`visualCheck.required=false`).';
    if (s.visualCheck?.required) {
      const vps = s.visualCheck.viewports.map((v) => `${v.width}x${v.height}`).join(', ');
      const invs = s.visualCheck.programmaticInvariants.join('; ');
      const rubric = s.visualCheck.multimodalRubric.join('; ');
      visualClause = `Hybrid visual check at \`${vps}\` — assert DOM geometry (${invs}) and inspect targeted screenshot against VLM rubric (${rubric}).`;
    }
    return `${index + 1}. \`${s.id}\` (**${s.title}**, tier: \`${s.tier}\` / \`${net}\`, spec: \`${s.spec}\`, locators: \`${s.locatorStrategy}\`) — Run via \`${cmd}\`. ${visualClause}`;
  });

  const sessionNote = spec.authSessionPolicy.singleUseRefreshRotation
    ? 'Single-use refresh token rotation is active (`singleUseRefreshRotation=true`, `allowSharedStorageState=false`). Never share a single `storageState` file across concurrent Playwright workers.'
    : 'Follow the workspace session isolation rules defined in `.playwright-harness/spec.json`.';

  const template = `---
name: ${skill.name}
description: ${formatYamlScalar(skill.description)}
---

# ${skill.name}

<!-- playwright-harness-kit:managed sha256=${ZERO_HASH} -->

Generated by playwright-harness-kit from \`.playwright-harness/spec.json\` for **${spec.name}**.
Edit the spec and re-run \`playwright-harness build\`; do not hand-edit this file.

## Modality, session & boundary rules

- Prefer ARIA accessibility snapshots (\`browser_snapshot\` in \`@playwright/mcp\`, or \`@playwright/cli\`) and semantic role/label locators (\`getByRole\`, \`getByLabel\`) for navigation and actions; reserve coordinate-based clicks for justified canvas, WebGL, or custom-gesture exceptions.
- ${sessionNote}
- Artifact hygiene: \`traceMode=${spec.artifactHygiene.traceMode}\`, \`forbidLiveMutations=${spec.artifactHygiene.forbidLiveMutations}\`. Keep \`${spec.artifactHygiene.gitIgnore.join('`, `')}\` untracked in Git.
- Responsibility boundary: \`.playwright-harness/spec.json\` is a declarative contract. Runtime network isolation (\`context.route\`, \`serviceWorkers: "block"\`) is enforced only when executing the Playwright suite, and this \`SKILL.md\` is agent guidance — never run browser agents with live production credentials.

## Scenarios

${steps.join('\n') || '1. No scenarios listed in `covers`. Add them in the spec.'}
`;

  const digest = sha256(template);
  const rendered = template.replace(
    `<!-- playwright-harness-kit:managed sha256=${ZERO_HASH} -->`,
    `<!-- playwright-harness-kit:managed sha256=${digest} -->`
  );
  const parsed = parseSkillFrontmatter(rendered);
  if (!parsed.ok) {
    throw new Error(`Generated invalid frontmatter for skill "${skill.name}": ${parsed.error}`);
  }
  return rendered;
}

function readManagedManifest(root) {
  let manifestPath;
  try {
    manifestPath = safeJoin(root, MANAGED_MANIFEST_REL);
  } catch {
    return [];
  }
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.managedFiles)) return [];
    const valid = [];
    for (const item of parsed.managedFiles) {
      try {
        valid.push(normalizeRelPath(String(item)));
      } catch {
        // Ignore malformed manifest entries
      }
    }
    return valid;
  } catch {
    return [];
  }
}

function collectTargetRoots(spec) {
  const targetRoots = ['.playwright-harness/skills'];
  const seenRoots = new Set(targetRoots);
  for (const dest of spec.copySkillsTo || []) {
    const err = validateCopyTarget(dest);
    if (err) throw new Error(err);
    const normalized = normalizeRelPath(dest);
    if (!seenRoots.has(normalized)) {
      seenRoots.add(normalized);
      targetRoots.push(normalized);
    }
  }
  return targetRoots;
}

export function findStaleSkills(spec, dir, { force = false } = {}) {
  const root = resolve(dir);
  let targetRoots;
  try {
    targetRoots = collectTargetRoots(spec);
  } catch {
    targetRoots = ['.playwright-harness/skills'];
  }

  const expectedRelPaths = new Set();
  for (const skill of spec.skills || []) {
    if (!skill?.name || validateSkillName(skill.name)) continue;
    for (const targetRoot of targetRoots) {
      expectedRelPaths.add(`${targetRoot}/${skill.name}/SKILL.md`);
    }
  }

  const candidateRelPaths = new Set();
  const manifestSet = new Set(readManagedManifest(root));
  for (const relPath of manifestSet) {
    if (!expectedRelPaths.has(relPath)) {
      candidateRelPaths.add(relPath);
    }
  }

  // Also scan current targetRoots for managed SKILL.md files (even if created before manifest existed)
  for (const targetRoot of targetRoots) {
    let fullRoot;
    try {
      fullRoot = safeJoin(root, targetRoot);
    } catch {
      continue;
    }
    if (!existsSync(fullRoot)) continue;
    let entries = [];
    try {
      entries = readdirSync(fullRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (validateSkillName(entry.name)) continue;
      const relPath = `${targetRoot}/${entry.name}/SKILL.md`;
      if (expectedRelPaths.has(relPath) || candidateRelPaths.has(relPath)) continue;
      let fullSkillPath;
      try {
        fullSkillPath = safeJoin(root, relPath);
      } catch {
        continue;
      }
      if (!existsSync(fullSkillPath)) continue;
      try {
        const text = normalizeText(readFileSync(fullSkillPath, 'utf8'));
        const ownership = verifyManagedContent(text);
        if (ownership.managed) {
          candidateRelPaths.add(relPath);
        }
      } catch {
        // Ignore unreadable files
      }
    }
  }

  const stale = [];
  for (const relPath of [...candidateRelPaths].sort()) {
    let fullPath;
    try {
      fullPath = safeJoin(root, relPath);
    } catch {
      continue;
    }
    if (!existsSync(fullPath)) continue;
    const raw = readFileSync(fullPath);
    const current = normalizeText(raw.toString('utf8'));
    const ownership = verifyManagedContent(current);
    if (ownership.managed && ownership.unedited) {
      stale.push({
        path: fullPath,
        relPath,
        contents: null,
        raw,
        before: current,
        action: 'prune',
        isStale: true,
        reason: 'stale managed skill removed from spec',
        diff: unifiedDiff(current, null, relPath),
      });
    } else if (ownership.managed || manifestSet.has(relPath)) {
      if (force) {
        stale.push({
          path: fullPath,
          relPath,
          contents: null,
          raw,
          before: current,
          action: 'prune',
          isStale: true,
          reason: 'forced removal of modified stale skill',
          diff: unifiedDiff(current, null, relPath),
        });
      } else {
        stale.push({
          path: fullPath,
          relPath,
          contents: null,
          raw,
          before: current,
          action: 'conflict',
          isStale: true,
          reason: 'stale managed skill was modified by hand (pass --force with --prune to remove)',
          diff: unifiedDiff(current, null, relPath),
        });
      }
    }
  }
  return stale;
}

function classifyTarget(root, relPath, contents, { force = false } = {}) {
  const fullPath = safeJoin(root, relPath);
  const raw = existsSync(fullPath) ? readFileSync(fullPath) : null;
  const current = raw !== null ? normalizeText(raw.toString('utf8')) : null;
  if (current === null) {
    return {
      path: fullPath,
      relPath,
      contents,
      raw: null,
      before: null,
      action: 'create',
      reason: 'new file',
      diff: unifiedDiff(null, contents, relPath),
    };
  }
  if (current === contents) {
    return {
      path: fullPath,
      relPath,
      contents,
      raw,
      before: current,
      action: 'unchanged',
      reason: 'up to date',
      diff: '',
    };
  }
  const ownership = verifyManagedContent(current);
  if (ownership.managed && ownership.unedited) {
    return {
      path: fullPath,
      relPath,
      contents,
      raw,
      before: current,
      action: 'update',
      reason: 'spec changed',
      diff: unifiedDiff(current, contents, relPath),
    };
  }
  if (force) {
    return {
      path: fullPath,
      relPath,
      contents,
      raw,
      before: current,
      action: 'update',
      reason: ownership.managed
        ? 'forced overwrite of hand-edited managed skill'
        : 'forced overwrite of unmanaged existing file',
      diff: unifiedDiff(current, contents, relPath),
    };
  }
  return {
    path: fullPath,
    relPath,
    contents,
    raw,
    before: current,
    action: 'conflict',
    reason: ownership.managed
      ? 'managed skill file was modified by hand since last build (pass --force to overwrite)'
      : 'existing file was not generated by playwright-harness-kit (pass --force to overwrite)',
    diff: unifiedDiff(current, contents, relPath),
  };
}

export function planBuild(spec, dir, { force = false, prune = false } = {}) {
  const root = resolve(dir);
  const files = [];
  const targetRoots = collectTargetRoots(spec);

  const seenSkillNames = new Set();
  for (const skill of spec.skills) {
    const nameErr = validateSkillName(skill?.name);
    if (nameErr) throw new Error(`Refusing to build skill with invalid name: ${nameErr}`);
    if (seenSkillNames.has(skill.name)) {
      throw new Error(`Refusing to build duplicate skill name: ${skill.name}`);
    }
    seenSkillNames.add(skill.name);
    const rendered = renderSkill(spec, skill);
    for (const targetRoot of targetRoots) {
      const relPath = `${targetRoot}/${skill.name}/SKILL.md`;
      files.push(classifyTarget(root, relPath, rendered, { force }));
    }
  }

  const stale = findStaleSkills(spec, root, { force });
  if (prune) {
    files.push(...stale);
  }

  Object.defineProperty(files, 'root', { value: root, enumerable: false });
  Object.defineProperty(files, 'stale', { value: stale, enumerable: false });
  Object.defineProperty(files, 'conflicts', {
    value: files.filter((f) => f.action === 'conflict'),
    enumerable: false,
  });
  Object.defineProperty(files, 'counts', {
    value: {
      create: files.filter((f) => f.action === 'create').length,
      update: files.filter((f) => f.action === 'update').length,
      prune: files.filter((f) => f.action === 'prune').length,
      unchanged: files.filter((f) => f.action === 'unchanged').length,
      conflict: files.filter((f) => f.action === 'conflict').length,
    },
    enumerable: false,
  });
  return files;
}

export function applyBuild(files, { dryRun = false, force = false, io } = {}) {
  if (dryRun) return files;
  const conflicts = files.filter((f) => f.action === 'conflict');
  if (conflicts.length && !force) {
    const details = conflicts.map((c) => `${c.relPath || c.path}: ${c.reason}`).join('; ');
    throw new Error(`Refusing to overwrite conflicting skill file(s): ${details}`);
  }
  const root = files.root;
  const writes = files.filter(
    (f) => f.action === 'create' || f.action === 'update' || f.action === 'prune' || (force && f.action === 'conflict')
  );

  const ops = writes.map((f) => {
    if (f.action === 'prune' || (force && f.action === 'conflict' && f.isStale)) {
      return {
        path: f.path,
        before: f.raw ?? (existsSync(f.path) ? readFileSync(f.path) : null),
        after: null,
      };
    }
    const crlf = f.raw !== null && f.raw !== undefined && f.raw.includes('\r\n');
    const encoded = Buffer.from(crlf ? f.contents.replace(/\n/g, '\r\n') : f.contents, 'utf8');
    return {
      path: f.path,
      before: f.raw ?? (existsSync(f.path) ? readFileSync(f.path) : null),
      after: encoded,
    };
  });

  if (root && files.length > 0) {
    const activeManagedPaths = files
      .filter((f) => !f.isStale && f.action !== 'prune')
      .map((f) => f.relPath);
    const unprunedStalePaths = (files.stale || [])
      .filter((s) => !writes.some((w) => w.relPath === s.relPath))
      .map((s) => s.relPath);
    const nextManaged = [...new Set([...activeManagedPaths, ...unprunedStalePaths])].sort();
    const manifestFullPath = safeJoin(root, MANAGED_MANIFEST_REL);
    const manifestBefore = existsSync(manifestFullPath) ? readFileSync(manifestFullPath) : null;
    const manifestAfter = Buffer.from(`${JSON.stringify({ managedFiles: nextManaged }, null, 2)}\n`, 'utf8');
    if (writes.length > 0 || (manifestBefore !== null && !manifestBefore.equals(manifestAfter))) {
      ops.push({
        path: manifestFullPath,
        before: manifestBefore,
        after: manifestAfter,
      });
    }
  }

  if (!ops.length) return files;

  applyFilePlan(
    ops,
    (fullPath) => {
      if (root) assertSafeTarget(root, fullPath);
    },
    io
  );

  // Clean up empty parent directories of pruned skills (best-effort after atomic commit succeeds)
  for (const f of writes) {
    if (f.action === 'prune' || (force && f.isStale)) {
      try {
        const parentDir = dirname(f.path);
        if (existsSync(parentDir) && readdirSync(parentDir).length === 0) {
          rmdirSync(parentDir);
        }
      } catch {
        // Ignore non-empty or locked parent directory
      }
    }
  }

  return files;
}
