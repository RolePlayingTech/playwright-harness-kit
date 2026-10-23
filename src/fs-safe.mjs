import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCENARIO_ID_RE = /^[A-Z]+-[A-Z0-9]+-[0-9]{2,3}$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const FORBIDDEN_COPY_ROOTS = new Set(['.git', 'node_modules', '.playwright-harness', 'src', 'bin', 'tests']);

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function readTextIfExists(path) {
  return existsSync(path) ? normalizeText(readFileSync(path, 'utf8')) : null;
}

export function validateSkillName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return 'skill name is required';
  }
  if (name.length > 64) {
    return `${name}: skill name longer than 64 characters`;
  }
  if (!SKILL_NAME_RE.test(name) || WINDOWS_RESERVED_RE.test(name)) {
    return `${name}: skill name must use lowercase ASCII letters, digits and single hyphens (a-z0-9-)`;
  }
  return null;
}

export function validateScenarioId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    return 'every scenario needs an id';
  }
  if (!SCENARIO_ID_RE.test(id)) {
    return `${id}: scenario id must follow PREFIX-AREA-NN format (e.g. M-AUTH-01 or M-UX-01)`;
  }
  return null;
}

export function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0')) {
    throw new Error(`Unsafe path ${JSON.stringify(relPath)}: empty or contains NUL.`);
  }
  const normalized = relPath.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || isAbsolute(relPath)) {
    throw new Error(`Unsafe path "${relPath}": absolute or root paths are not allowed.`);
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) ||
      WINDOWS_RESERVED_RE.test(part)
    ) {
      throw new Error(`Unsafe path "${relPath}": segment "${part}" is not allowed.`);
    }
  }
  return normalized;
}

export function validateCopyTarget(dest) {
  try {
    const normalized = normalizeRelPath(dest);
    const first = normalized.split('/')[0];
    if (FORBIDDEN_COPY_ROOTS.has(first)) {
      return `copySkillsTo target "${dest}" cannot write into reserved directory "${first}"`;
    }
    return null;
  } catch (error) {
    return `copySkillsTo target "${dest}" is unsafe: ${error.message}`;
  }
}

function realOrResolved(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function assertSafeTarget(root, fullPath) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(fullPath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe path: ${resolvedPath} is outside ${resolvedRoot}.`);
  }
  const rootStat = existsSync(resolvedRoot) ? lstatSync(resolvedRoot) : null;
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe path: root ${resolvedRoot} is a symbolic link.`);
  }
  const segments = rel.split(/[\\/]/);
  let current = resolvedRoot;
  let deepestExisting = resolvedRoot;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const isTarget = i === segments.length - 1;
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!stat) break;
    deepestExisting = current;
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsafe path: ${current} is a symbolic link or junction.`);
    }
    if (isTarget && (!stat.isFile() || stat.nlink > 1)) {
      throw new Error(`Unsafe path: ${current} is not a regular single-link file.`);
    }
    if (!isTarget && !stat.isDirectory()) {
      throw new Error(`Unsafe path: ${current} is not a directory.`);
    }
  }
  const realRoot = realOrResolved(resolvedRoot);
  const realDeepest = realOrResolved(deepestExisting);
  const realRel = relative(realRoot, realDeepest);
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new Error(`Unsafe path: ${resolvedPath} resolves outside ${realRoot}.`);
  }
}

export function safeJoin(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const full = join(resolve(root), normalized);
  assertSafeTarget(root, full);
  return full;
}

export function applyFilePlan(operations, assertSafe, io = fs) {
  const applied = [];
  const createdDirs = [];
  function ensureDirectory(dir) {
    if (io.existsSync(dir)) return;
    ensureDirectory(dirname(dir));
    io.mkdirSync(dir);
    createdDirs.push(dir);
  }
  try {
    for (const op of operations) {
      assertSafe(op.path);
      const current = io.existsSync(op.path) ? io.readFileSync(op.path) : null;
      if (current === null ? op.before !== null : op.before === null || !current.equals(op.before)) {
        throw new Error(`File changed after planning: ${op.path}`);
      }
      if (op.after !== null) ensureDirectory(dirname(op.path));
      if (op.after !== null && op.before === null) {
        const fd = io.openSync(op.path, 'wx');
        applied.push(op);
        try {
          io.writeFileSync(fd, op.after);
        } finally {
          io.closeSync(fd);
        }
      } else {
        applied.push(op);
        if (op.after === null) io.unlinkSync(op.path);
        else io.writeFileSync(op.path, op.after);
      }
    }
  } catch (cause) {
    const failures = [];
    for (const op of applied.reverse()) {
      try {
        assertSafe(op.path);
        if (op.before === null) {
          if (io.existsSync(op.path)) io.unlinkSync(op.path);
        } else {
          io.writeFileSync(op.path, op.before);
        }
      } catch (error) {
        failures.push(`${op.path}: ${error.message}`);
      }
    }
    for (const dir of createdDirs.reverse()) {
      try {
        io.rmdirSync(dir);
      } catch (error) {
        failures.push(`${dir}: ${error.message}`);
      }
    }
    throw new Error(
      failures.length
        ? `Build failed; rollback incomplete (${failures.join('; ')}). Original error: ${cause.message}`
        : `Build failed; prior file state restored: ${cause.message}`,
      { cause }
    );
  }
}

export function unifiedDiff(before, after, path, context = 3) {
  const a = before === null ? [] : normalizeText(before).replace(/\n$/, '').split('\n');
  const b = after === null ? [] : normalizeText(after).replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i], ai: i, bj: j });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ t: '-', s: a[i], ai: i, bj: j });
      i++;
    } else {
      ops.push({ t: '+', s: b[j], ai: i, bj: j });
      j++;
    }
  }
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (const k of changed.slice(1)) {
    if (k - context <= end + 1) end = Math.min(ops.length - 1, k + context);
    else {
      hunks.push([start, end]);
      start = Math.max(0, k - context);
      end = Math.min(ops.length - 1, k + context);
    }
  }
  hunks.push([start, end]);
  const lines = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const aStart = slice[0].ai + 1;
    const bStart = slice[0].bj + 1;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    lines.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of slice) lines.push(`${o.t}${o.s}`);
  }
  return lines.join('\n');
}
