import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../bin/playwright-harness.mjs';

const MUMRO_EXAMPLE_DIR = resolve('examples/mumro-web');
const OFFLINE_EXAMPLE_DIR = resolve('examples/offline-ui');

test('CLI check --strict passes on examples/mumro-web (declaration-only check)', () => {
  const res = run(['check', MUMRO_EXAMPLE_DIR, '--strict']);
  assert.equal(res.code, 0);
  assert.equal(res.text, 'PASS: Playwright verification spec is internally consistent (strict mode, 0 warnings).');
});

test('CLI check --verify-files fails on spec-only examples/mumro-web and passes on runnable examples/offline-ui', () => {
  const resMumro = run(['check', MUMRO_EXAMPLE_DIR, '--strict', '--verify-files']);
  assert.equal(resMumro.code, 1);
  assert.ok(resMumro.text.includes('spec file "frontend/e2e/ui-contract/auth-session.spec.ts" does not exist'));

  const resOffline = run(['check', OFFLINE_EXAMPLE_DIR, '--strict', '--verify-files']);
  assert.equal(resOffline.code, 0);
  assert.ok(
    resOffline.text.includes('PASS: Playwright verification spec and repository files verified (strict mode, 0 warnings).')
  );
  assert.ok(resOffline.text.includes('[observed    ] scenarioSpecFiles'));
  assert.ok(resOffline.text.includes('[not-verified] uiContractNetworkIsolation'));
});

test('CLI explain outputs tiers, scenarios, skills, and evidence scope', () => {
  const res = run(['explain', OFFLINE_EXAMPLE_DIR, '--verify-files']);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes('Playwright verification contract: offline-ui-verification'));
  assert.ok(res.text.includes('DEMO-AUTH-01'));
  assert.ok(res.text.includes('DEMO-UX-01'));
  assert.ok(res.text.includes('verify-browser-scenarios'));
  assert.ok(res.text.includes('Evidence scope (static contract vs. runtime browser execution)'));
});

test('CLI build --dry-run previews SKILL.md without writing', () => {
  const res = run(['build', MUMRO_EXAMPLE_DIR, '--dry-run']);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes('Dry run (nothing written)'));
  assert.ok(res.text.includes('.playwright-harness/skills/verify-browser-scenarios/SKILL.md'));
});

test('CLI build --prune --force and prune --force never delete README.md or unrelated files from a tampered manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-cli-prune-'));
  try {
    mkdirSync(join(dir, '.playwright-harness'), { recursive: true });
    writeFileSync(
      join(dir, '.playwright-harness/spec.json'),
      readFileSync(join(MUMRO_EXAMPLE_DIR, '.playwright-harness/spec.json'), 'utf8'),
      'utf8'
    );
    writeFileSync(join(dir, 'README.md'), '# Unmanaged README\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), '{"name":"demo"}\n', 'utf8');

    // Minimal logical reproduction from Issue #6: {"managedFiles":["README.md"]}
    writeFileSync(
      join(dir, '.playwright-harness/.managed-manifest.json'),
      JSON.stringify({ managedFiles: ['README.md', 'package.json'] }),
      'utf8'
    );

    const buildRes = run(['build', dir, '--prune', '--force']);
    assert.equal(buildRes.code, 0);
    assert.ok(buildRes.text.includes('warning: managed manifest'));
    assert.ok(buildRes.text.includes('README.md'));
    assert.equal(existsSync(join(dir, 'README.md')), true);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# Unmanaged README\n');
    assert.equal(existsSync(join(dir, 'package.json')), true);

    // Re-inject and run `prune --force --json`
    writeFileSync(
      join(dir, '.playwright-harness/.managed-manifest.json'),
      JSON.stringify({ managedFiles: ['README.md'] }),
      'utf8'
    );
    const pruneJsonRes = run(['prune', dir, '--force', '--json']);
    assert.equal(pruneJsonRes.code, 0);
    const payload = JSON.parse(pruneJsonRes.text);
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.manifestDiagnostics));
    assert.ok(payload.manifestDiagnostics.some((d) => d.includes('README.md')));
    assert.equal(existsSync(join(dir, 'README.md')), true);
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), '# Unmanaged README\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
