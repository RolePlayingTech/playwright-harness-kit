import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSpec } from '../src/spec.mjs';
import { checkSpec, validateTierOrigin } from '../src/check.mjs';

const VALID_RAW = {
  name: 'mumro-web',
  purpose: 'Browser verification contract.',
  tiers: {
    'ui-contract': {
      command: 'npm run test:contract',
      origin: 'https://mumro-ui-contract.invalid',
      networkPolicy: 'deny-unhandled',
      purpose: 'Fast contract tests.',
    },
  },
  authSessionPolicy: {
    singleUseRefreshRotation: true,
    allowSharedStorageState: false,
    rationale: 'Single-use token rotation.',
  },
  artifactHygiene: {
    traceMode: 'on-first-retry',
    gitIgnore: ['playwright-report/', 'test-results/', 'playwright/.auth/'],
    forbidLiveMutations: true,
  },
  scenarios: [
    {
      id: 'M-AUTH-01',
      title: 'Single-flight token refresh',
      tier: 'ui-contract',
      spec: 'e2e/auth.spec.ts',
      locatorStrategy: 'role-and-label-first',
      visualCheck: { required: false },
    },
    {
      id: 'M-UX-01',
      title: 'Mobile layout check',
      tier: 'ui-contract',
      spec: 'e2e/ux.spec.ts',
      locatorStrategy: 'role-and-label-first',
      visualCheck: {
        required: true,
        viewports: [{ width: 390, height: 844 }],
        programmaticInvariants: ['documentElement.scrollWidth <= window.innerWidth'],
        multimodalRubric: ['No clipped headings'],
      },
    },
  ],
  skills: [
    {
      name: 'verify-ui-contract',
      description: 'Run UI contract scenarios. Use when verifying M-AUTH-01 or M-UX-01.',
      covers: ['M-AUTH-01', 'M-UX-01'],
    },
  ],
};

test('valid spec passes checkSpec with 0 errors and 0 warnings', () => {
  const spec = normalizeSpec(VALID_RAW);
  const res = checkSpec(spec);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
});

test('table-driven URL-parsed origin validation for ui-contract and integrated tiers', () => {
  const validUiContractOrigins = [
    'https://mumro-ui-contract.invalid',
    'http://offline.invalid:8080',
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'http://[::1]:3000',
  ];
  for (const origin of validUiContractOrigins) {
    const raw = structuredClone(VALID_RAW);
    raw.tiers['ui-contract'].origin = origin;
    const res = checkSpec(normalizeSpec(raw));
    assert.equal(res.ok, true, `Expected valid ui-contract origin "${origin}" to pass, got: ${res.errors.join('; ')}`);
    assert.deepEqual(res.warnings, []);
  }

  const invalidUiContractOrigins = [
    {
      origin: 'https://production.example/path/localhost',
      expectedMatch: /bare origin/,
    },
    {
      origin: 'https://localhost.attacker.example',
      expectedMatch: /not allowed for ui-contract/,
    },
    {
      origin: 'https://fakeinvalid.com',
      expectedMatch: /not allowed for ui-contract/,
    },
    {
      origin: 'https://app.mumro.io',
      expectedMatch: /not allowed for ui-contract/,
    },
    {
      origin: 'https://user:secret@mumro-ui-contract.invalid',
      expectedMatch: /embedded credentials/,
    },
    {
      origin: 'https://mumro-ui-contract.invalid/login?next=1#frag',
      expectedMatch: /bare origin/,
    },
    {
      origin: 'ftp://mumro-ui-contract.invalid',
      expectedMatch: /http: or https: protocol/,
    },
    {
      origin: 'not a url',
      expectedMatch: /not a valid URL/,
    },
  ];

  for (const { origin, expectedMatch } of invalidUiContractOrigins) {
    const check = validateTierOrigin('ui-contract', origin);
    assert.equal(check.ok, false, `Expected ui-contract origin "${origin}" to be rejected`);
    assert.match(check.error, expectedMatch);

    const raw = structuredClone(VALID_RAW);
    raw.tiers['ui-contract'].origin = origin;
    const specRes = checkSpec(normalizeSpec(raw));
    assert.equal(specRes.ok, false, `Expected checkSpec to fail on "${origin}"`);
  }
});

test('rejects shared storageState when singleUseRefreshRotation is true', () => {
  const broken = structuredClone(VALID_RAW);
  broken.authSessionPolicy.allowSharedStorageState = true;
  const res = checkSpec(normalizeSpec(broken));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('allowSharedStorageState cannot be true')));
});

test('rejects pixel-coordinate locator strategy and missing hybrid visual invariants', () => {
  const broken = structuredClone(VALID_RAW);
  broken.scenarios[0].locatorStrategy = 'pixel-coordinates';
  broken.scenarios[1].visualCheck.programmaticInvariants = [];
  broken.scenarios[1].visualCheck.multimodalRubric = [];
  const res = checkSpec(normalizeSpec(broken));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('locatorStrategy "pixel-coordinates" is not allowed')));
  assert.ok(res.errors.some((e) => e.includes('programmaticInvariants')));
  assert.ok(res.errors.some((e) => e.includes('multimodalRubric')));
});

test('rejects unknown fields with helpful suggestions', () => {
  const broken = {
    ...VALID_RAW,
    project: 'wrong-key',
    authSessionPolicy: {
      ...VALID_RAW.authSessionPolicy,
      sharedStorageState: false,
    },
  };
  const res = checkSpec(normalizeSpec(broken));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('unknown field "project" (did you mean "name"?)')));
  assert.ok(res.errors.some((e) => e.includes('unknown field "authSessionPolicy.sharedStorageState"')));
});

test('checkSpec with verifyFiles=true detects missing spec files, missing scripts, missing scenario IDs, and reports runtime policies as not-verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-verify-'));
  try {
    const spec = normalizeSpec(VALID_RAW);

    // 1. Empty repo -> fails with missing spec files and missing package.json
    const resEmpty = checkSpec(spec, { rootDir: dir, verifyFiles: true });
    assert.equal(resEmpty.ok, false);
    assert.ok(resEmpty.errors.some((e) => e.includes('M-AUTH-01: spec file "e2e/auth.spec.ts" does not exist')));
    assert.ok(resEmpty.errors.some((e) => e.includes('M-UX-01: spec file "e2e/ux.spec.ts" does not exist')));
    assert.ok(resEmpty.errors.some((e) => e.includes('references missing package.json')));

    // 2. Create spec files (one missing scenario ID), package.json with wrong script name, and incomplete .gitignore
    mkdirSync(join(dir, 'e2e'), { recursive: true });
    writeFileSync(join(dir, 'e2e/auth.spec.ts'), 'test("M-AUTH-01 refresh", () => {});\n', 'utf8');
    writeFileSync(join(dir, 'e2e/ux.spec.ts'), 'test("mobile check without id", () => {});\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'other-script': 'echo ok' } }), 'utf8');
    writeFileSync(join(dir, '.gitignore'), 'playwright-report/\n', 'utf8');

    const resPartial = checkSpec(spec, { rootDir: dir, verifyFiles: true });
    assert.equal(resPartial.ok, false);
    assert.ok(resPartial.errors.some((e) => e.includes('npm script "test:contract" was not found in package.json')));
    assert.ok(resPartial.warnings.some((w) => w.includes('M-UX-01: scenario ID "M-UX-01" was not found')));
    assert.ok(resPartial.warnings.some((w) => w.includes('"playwright/.auth/" is declared in spec.json but missing from .gitignore')));

    // 3. Fix script, scenario ID, and .gitignore -> passes with 0 errors and 0 warnings, while runtime policies remain "not-verified"
    writeFileSync(join(dir, 'e2e/ux.spec.ts'), 'test("M-UX-01 mobile layout check", () => {});\n', 'utf8');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:contract': 'playwright test' } }), 'utf8');
    writeFileSync(
      join(dir, '.gitignore'),
      'playwright-report/\ntest-results/\nplaywright/.auth/\n',
      'utf8'
    );

    const resValid = checkSpec(spec, { rootDir: dir, verifyFiles: true });
    assert.equal(resValid.ok, true);
    assert.deepEqual(resValid.errors, []);
    assert.deepEqual(resValid.warnings, []);

    const netEvidence = resValid.evidence.find((item) => item.policy === 'uiContractNetworkIsolation');
    assert.equal(netEvidence?.status, 'not-verified');
    const specEvidence = resValid.evidence.find((item) => item.policy === 'scenarioSpecFiles');
    assert.equal(specEvidence?.status, 'observed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
