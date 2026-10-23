import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { run } from '../bin/playwright-harness.mjs';

const EXAMPLE_DIR = resolve('examples/mumro-web');

test('CLI check --strict passes on examples/mumro-web', () => {
  const res = run(['check', EXAMPLE_DIR, '--strict']);
  assert.equal(res.code, 0);
  assert.equal(res.text, 'PASS: Playwright verification spec is internally consistent (strict mode, 0 warnings).');
});

test('CLI explain outputs tiers, scenarios, and skills', () => {
  const res = run(['explain', EXAMPLE_DIR]);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes('Playwright verification contract: mumro-web-verification'));
  assert.ok(res.text.includes('M-AUTH-01'));
  assert.ok(res.text.includes('M-UX-01'));
  assert.ok(res.text.includes('verify-browser-scenarios'));
});

test('CLI build --dry-run previews SKILL.md without writing', () => {
  const res = run(['build', EXAMPLE_DIR, '--dry-run']);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes('Dry run (nothing written)'));
  assert.ok(res.text.includes('.playwright-harness/skills/verify-browser-scenarios/SKILL.md'));
});
