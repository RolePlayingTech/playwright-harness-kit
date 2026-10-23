#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyBuild, findStaleSkills, planBuild } from '../src/build.mjs';
import { checkSpec } from '../src/check.mjs';
import { explainData, formatExplain } from '../src/explain.mjs';
import { loadSpec, specPath } from '../src/spec.mjs';

const COMMANDS = ['explain', 'check', 'build', 'prune', 'help'];

function help() {
  return `playwright-harness-kit: record, explain and check a Playwright & multimodal browser verification contract.

Usage: playwright-harness <command> [dir] [options]

Commands:
  explain   Print tiers, scenario IDs, session policy, visual rubrics, evidence states and skill coverage.
  check     Validate the verification contract (exit 1 on errors, or warnings with --strict).
            Default check validates JSON declarations; add --verify-files to audit repo files/scripts.
  build     Write SKILL.md files from spec.skills (--dry-run previews actions and diffs, --prune removes stale skills).
  prune     Reconcile and remove stale managed SKILL.md files removed from spec.json (--dry-run previews).
  help      Show this help.

Options:
  --strict        check/explain: treat warnings as failures (exit 1).
  --verify-files  check/explain: verify declared .spec.ts files, scenario IDs, npm scripts, and .gitignore on disk.
  --prune         build: remove intact stale managed SKILL.md files that are no longer in spec.json.
  --dry-run       build/prune: preview create/update/prune/unchanged/conflict status and diffs without writing.
  --force         build/prune: overwrite or remove conflicting hand-edited SKILL.md files.
  --json          Output machine-readable JSON (explain, check, build, prune).
  -h, --help      Show this help.

Exit codes:
  0  Success (validation passed / build or dry-run succeeded without conflicts).
  1  Validation failure, conflict, or CLI error.

Typical flow:
  playwright-harness explain examples/offline-ui
  playwright-harness check examples/offline-ui --strict --verify-files
  playwright-harness build examples/offline-ui --dry-run
  playwright-harness build examples/offline-ui --prune
`;
}

export function parse(argv) {
  const flags = { dryRun: false, force: false, strict: false, json: false, verifyFiles: false, prune: false };
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--verify-files') flags.verifyFiles = true;
    else if (arg === '--prune') flags.prune = true;
    else if (arg === '-h' || arg === '--help') positionals.unshift('help');
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positionals.push(arg);
  }
  const command = positionals[0] || 'help';
  if (positionals.length > 2) {
    throw new Error(`Unexpected argument "${positionals[2]}". Usage: playwright-harness <command> [dir] [options]`);
  }
  if ((flags.dryRun || flags.force || flags.prune) && !['build', 'prune', 'help'].includes(command)) {
    const badFlag = flags.dryRun ? '--dry-run' : flags.force ? '--force' : '--prune';
    throw new Error(`Option ${badFlag} is only valid with "build" or "prune".`);
  }
  if (flags.verifyFiles && !['check', 'explain', 'help'].includes(command)) {
    throw new Error('Option --verify-files is only valid with "check" or "explain".');
  }
  if (command === 'prune') {
    flags.prune = true;
  }
  return { command, dir: resolve(positionals[1] || '.'), flags };
}

function formatJson(payload) {
  return JSON.stringify(payload, null, 2);
}

export function run(argv = process.argv.slice(2)) {
  const { command, dir, flags } = parse(argv);
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command ${command}. Try playwright-harness help.`);
  }
  if (command === 'help') return { code: 0, text: help() };

  const path = specPath(dir);
  if (!existsSync(path)) {
    throw new Error(`No ${path}. Write .playwright-harness/spec.json first.`);
  }
  const spec = loadSpec(dir);
  const staleSkills = findStaleSkills(spec, dir);
  const check = checkSpec(spec, {
    rootDir: dir,
    verifyFiles: flags.verifyFiles,
    staleSkills: command === 'check' || command === 'explain' ? staleSkills : [],
  });
  const passed = check.ok && (!flags.strict || check.warnings.length === 0);

  if (command === 'explain') {
    const data = explainData(spec, check);
    const payload = { ...data, strict: flags.strict, verifyFiles: flags.verifyFiles, passed };
    return {
      code: passed ? 0 : 1,
      text: flags.json ? formatJson(payload) : formatExplain(spec, check),
      data: payload,
      check,
      spec,
    };
  }

  if (command === 'check') {
    const data = explainData(spec, check);
    const payload = {
      ok: passed,
      strict: flags.strict,
      verifyFiles: flags.verifyFiles,
      passed,
      errorCount: check.errors.length,
      warningCount: check.warnings.length,
      errors: check.errors,
      warnings: check.warnings,
      evidence: check.evidence,
      summary: {
        name: spec.name,
        tiers: Object.keys(spec.tiers).length,
        scenarios: spec.scenarios.length,
        skills: spec.skills.length,
        uncoveredScenarios: data.uncoveredScenarios.length,
        staleSkills: staleSkills.length,
      },
    };
    if (flags.json) {
      return { code: passed ? 0 : 1, text: formatJson(payload), data: payload, check, spec };
    }
    const lines = [];
    if (passed) {
      if (flags.verifyFiles) {
        lines.push(
          flags.strict
            ? 'PASS: Playwright verification spec and repository files verified (strict mode, 0 warnings).'
            : 'PASS: Playwright verification spec and repository files verified.'
        );
      } else {
        lines.push(
          flags.strict
            ? 'PASS: Playwright verification spec is internally consistent (strict mode, 0 warnings).'
            : 'PASS: Playwright verification spec is internally consistent.'
        );
      }
    } else if (!check.ok) {
      lines.push('FAIL:');
      for (const error of check.errors) lines.push(`  - ${error}`);
    } else {
      lines.push(`FAIL (strict mode: ${check.warnings.length} warning(s)):`);
    }
    for (const warning of check.warnings) lines.push(`warning: ${warning}`);
    if (flags.verifyFiles && check.evidence?.length) {
      lines.push('', 'Evidence summary:');
      for (const item of check.evidence) {
        lines.push(`  [${item.status.padEnd(12)}] ${item.policy}: ${item.detail}`);
      }
    }
    return { code: passed ? 0 : 1, text: lines.join('\n'), data: payload, check, spec };
  }

  if (!check.ok) {
    const payload = {
      ok: false,
      dryRun: flags.dryRun,
      forced: flags.force,
      pruned: flags.prune,
      errors: check.errors,
      warnings: check.warnings,
    };
    return {
      code: 1,
      text: flags.json
        ? formatJson(payload)
        : `Refusing to build; fix check first:\n${check.errors.map((e) => `  - ${e}`).join('\n')}`,
      data: payload,
      check,
      spec,
    };
  }

  const planned = planBuild(spec, dir, { force: flags.force, prune: flags.prune });
  const counts = planned.counts;
  const hasConflicts = counts.conflict > 0 && !flags.force;

  if (flags.dryRun) {
    const payload = {
      ok: !hasConflicts,
      dryRun: true,
      forced: flags.force,
      pruned: flags.prune,
      counts,
      staleCount: planned.stale.length,
      files: planned.map((f) => ({
        path: f.relPath,
        fullPath: f.path,
        action: f.action,
        reason: f.reason,
        ...(f.diff ? { diff: f.diff } : {}),
      })),
    };
    if (flags.json) {
      return { code: hasConflicts ? 1 : 0, text: formatJson(payload), data: payload, check, spec, files: planned };
    }
    const prunePart = flags.prune || counts.prune > 0 ? `, prune: ${counts.prune}` : '';
    const lines = [
      `Dry run (nothing written) — create: ${counts.create}, update: ${counts.update}${prunePart}, unchanged: ${counts.unchanged}, conflict: ${counts.conflict}:`,
      ...planned.map((file) => `  [${file.action.padEnd(9)}] ${file.relPath} (${file.reason})`),
    ];
    if (!flags.prune && planned.stale.length > 0) {
      lines.push(
        '',
        `Note: ${planned.stale.length} stale generated skill file(s) detected: ${planned.stale.map((s) => s.relPath).join(', ')} (pass --prune to reconcile).`
      );
    }
    for (const diag of planned.manifestDiagnostics || []) {
      lines.push(`warning: ${diag}`);
    }
    const diffs = planned
      .filter((f) => f.diff && ['create', 'update', 'prune', 'conflict'].includes(f.action))
      .map((f) => f.diff);
    if (diffs.length) {
      lines.push('', ...diffs);
    }
    if (hasConflicts) {
      lines.push('', `${counts.conflict} conflict(s) detected: build will refuse to overwrite without --force.`);
    }
    return { code: hasConflicts ? 1 : 0, text: lines.join('\n'), data: payload, check, spec, files: planned };
  }

  if (hasConflicts) {
    const payload = {
      ok: false,
      dryRun: false,
      forced: false,
      pruned: flags.prune,
      counts,
      conflicts: planned
        .filter((f) => f.action === 'conflict')
        .map((f) => ({ path: f.relPath, fullPath: f.path, reason: f.reason, diff: f.diff })),
    };
    const conflictLines = planned
      .filter((f) => f.action === 'conflict')
      .map((f) => `  - ${f.relPath}: ${f.reason}`);
    return {
      code: 1,
      text: flags.json
        ? formatJson(payload)
        : `Refusing to build; ${counts.conflict} conflicting file(s) would be overwritten or removed:\n${conflictLines.join('\n')}`,
      data: payload,
      check,
      spec,
      files: planned,
    };
  }

  const files = applyBuild(planned, { dryRun: false, force: flags.force });
  const writtenCount = counts.create + counts.update;
  const prunedCount = counts.prune;
  const payload = {
    ok: true,
    dryRun: false,
    forced: flags.force,
    pruned: flags.prune,
    written: writtenCount,
    prunedCount,
    counts,
    staleCount: flags.prune ? 0 : planned.stale.length,
    files: files.map((f) => ({
      path: f.relPath,
      fullPath: f.path,
      action: f.action,
      reason: f.reason,
    })),
  };
  if (flags.json) {
    return { code: 0, text: formatJson(payload), data: payload, check, spec, files };
  }
  const pruneSummary = flags.prune || prunedCount > 0 ? `, prune: ${prunedCount}` : '';
  const lines = [
    writtenCount + prunedCount > 0
      ? `Processed ${writtenCount + prunedCount} skill file(s) (create: ${counts.create}, update: ${counts.update}${pruneSummary}, unchanged: ${counts.unchanged}):`
      : `All ${files.length} skill file(s) already up to date:`,
    ...files.map((file) => `  [${file.action.padEnd(9)}] ${file.relPath}`),
  ];
  if (!flags.prune && planned.stale.length > 0) {
    lines.push(
      '',
      `Note: ${planned.stale.length} stale generated skill file(s) remain on disk: ${planned.stale.map((s) => s.relPath).join(', ')} (run "playwright-harness build --prune" to remove).`
    );
  }
  for (const diag of planned.manifestDiagnostics || []) {
    lines.push(`warning: ${diag}`);
  }
  return { code: 0, text: lines.join('\n'), data: payload, check, spec, files };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const wantJson = process.argv.slice(2).includes('--json');
  try {
    const result = run();
    if (result.text) console.log(result.text);
    process.exitCode = result.code;
  } catch (error) {
    const msg = String(error.message || error);
    if (wantJson) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
  }
}
