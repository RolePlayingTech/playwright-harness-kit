import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../src/spec.mjs';
import { checkSpec } from '../src/check.mjs';

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
