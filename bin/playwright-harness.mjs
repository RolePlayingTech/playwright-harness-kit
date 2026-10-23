#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyBuild, planBuild } from '../src/build.mjs';
import { checkSpec } from '../src/check.mjs';
import { explainData, formatExplain } from '../src/explain.mjs';
import { loadSpec, specPath } from '../src/spec.mjs';

const COMMANDS = ['explain', 'check', 'build', 'help'];

function help() {
  return `playwright-harness-kit: record, explain and check a Playwright & multimodal browser verification contract.

Usage: playwright-harness <command> [dir] [options]

Commands:
  explain   Print tiers, scenario IDs, session policy, visual rubrics and skill coverage.
  check     Validate the verification contract (exit 1 on errors, or warnings with --strict).
  build     Write SKILL.md files from spec.skills (--dry-run previews actions and diffs).
  help      Show this help.

Options:
  --strict    check/explain: treat warnings as failures (exit 1).
  --dry-run   build: preview create/update/unchanged/conflict status and diffs without writing.
  --force     build: overwrite conflicting hand-edited or unmanaged SKILL.md files.
  --json      Output machine-readable JSON (explain, check, build).
  -h, --help  Show this help.

Typical flow:
  playwright-harness explain examples/mumro-web
  playwright-harness check examples/mumro-web --strict
  playwright-harness build examples/mumro-web --dry-run
  playwright-harness build examples/mumro-web
`;
}

export function parse(argv) {
  const flags = { dryRun: false, force: false, strict: false, json: false };
  const positionals = [];
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '-h' || arg === '--help') positionals.unshift('help');
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positionals.push(arg);
  }
  const command = positionals[0] || 'help';
  if (positionals.length > 2) {
    throw new Error(`Unexpected argument "${positionals[2]}". Usage: playwright-harness <command> [dir] [options]`);
  }
  if ((flags.dryRun || flags.force) && command !== 'build' && command !== 'help') {
    throw new Error(`Option ${flags.dryRun ? '--dry-run' : '--force'} is only valid with "build".`);
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
  const check = checkSpec(spec);
  const passed = check.ok && (!flags.strict || check.warnings.length === 0);

  if (command === 'explain') {
    const data = explainData(spec, check);
    const payload = { ...data, strict: flags.strict, passed };
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
      passed,
      errorCount: check.errors.length,
      warningCount: check.warnings.length,
      errors: check.errors,
      warnings: check.warnings,
      summary: {
        name: spec.name,
        tiers: Object.keys(spec.tiers).length,
        scenarios: spec.scenarios.length,
        skills: spec.skills.length,
        uncoveredScenarios: data.uncoveredScenarios.length,
      },
    };
    if (flags.json) {
      return { code: passed ? 0 : 1, text: formatJson(payload), data: payload, check, spec };
    }
    const lines = [];
    if (passed) {
      lines.push(
        flags.strict
          ? 'PASS: Playwright verification spec is internally consistent (strict mode, 0 warnings).'
          : 'PASS: Playwright verification spec is internally consistent.'
      );
    } else if (!check.ok) {
      lines.push('FAIL:');
      for (const error of check.errors) lines.push(`  - ${error}`);
    } else {
      lines.push(`FAIL (strict mode: ${check.warnings.length} warning(s)):`);
    }
    for (const warning of check.warnings) lines.push(`warning: ${warning}`);
    return { code: passed ? 0 : 1, text: lines.join('\n'), data: payload, check, spec };
  }

  if (!check.ok) {
    const payload = {
      ok: false,
      dryRun: flags.dryRun,
      forced: flags.force,
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

  const planned = planBuild(spec, dir, { force: flags.force });
  const counts = planned.counts;
  const hasConflicts = counts.conflict > 0 && !flags.force;

  if (flags.dryRun) {
    const payload = {
      ok: !hasConflicts,
      dryRun: true,
      forced: flags.force,
      counts,
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
    const lines = [
      `Dry run (nothing written) — create: ${counts.create}, update: ${counts.update}, unchanged: ${counts.unchanged}, conflict: ${counts.conflict}:`,
      ...planned.map((file) => `  [${file.action.padEnd(9)}] ${file.relPath} (${file.reason})`),
    ];
    const diffs = planned
      .filter((f) => f.diff && ['create', 'update', 'conflict'].includes(f.action))
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
        : `Refusing to build; ${counts.conflict} conflicting file(s) would be overwritten:\n${conflictLines.join('\n')}`,
      data: payload,
      check,
      spec,
      files: planned,
    };
  }

  const files = applyBuild(planned, { dryRun: false, force: flags.force });
  const writtenCount = counts.create + counts.update;
  const payload = {
    ok: true,
    dryRun: false,
    forced: flags.force,
    written: writtenCount,
    counts,
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
  const lines = [
    writtenCount > 0
      ? `Wrote ${writtenCount} skill file(s) (create: ${counts.create}, update: ${counts.update}, unchanged: ${counts.unchanged}):`
      : `All ${files.length} skill file(s) already up to date:`,
    ...files.map((file) => `  [${file.action.padEnd(9)}] ${file.relPath}`),
  ];
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
