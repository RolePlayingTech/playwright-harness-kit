import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
  assert.ok(res.text.includes('M-AUTH-01'));
  assert.ok(res.text.includes('M-UX-01'));
  assert.ok(res.text.includes('verify-browser-scenarios'));
  assert.ok(res.text.includes('Evidence scope (static contract vs. runtime browser execution)'));
});

test('CLI build --dry-run previews SKILL.md without writing', () => {
  const res = run(['build', MUMRO_EXAMPLE_DIR, '--dry-run']);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes('Dry run (nothing written)'));
  assert.ok(res.text.includes('.playwright-harness/skills/verify-browser-scenarios/SKILL.md'));
});
