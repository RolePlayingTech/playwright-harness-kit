import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSpec } from '../src/spec.mjs';
import { applyBuild, planBuild, renderSkill, verifyManagedContent } from '../src/build.mjs';

const RAW_SPEC = {
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
      description: 'Run UI contract scenarios. Use when verifying M-UX-01.',
      covers: ['M-UX-01'],
    },
  ],
};

test('renderSkill embeds verifiable SHA-256 marker and hybrid workflow instructions', () => {
  const spec = normalizeSpec(RAW_SPEC);
  const md = renderSkill(spec, spec.skills[0]);
  assert.match(md, /<!-- playwright-harness-kit:managed sha256=[a-f0-9]{64} -->/);
  assert.ok(md.includes('Hybrid visual check at `390x844`'));
  const verified = verifyManagedContent(md);
  assert.deepEqual(verified, { managed: true, unedited: true });
});

test('planBuild and applyBuild detect conflicts on hand-edited skills and respect --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-build-'));
  try {
    const spec = normalizeSpec(RAW_SPEC);
    const planned1 = planBuild(spec, dir);
    assert.equal(planned1.counts.create, 1);
    applyBuild(planned1);

    const skillPath = join(dir, '.playwright-harness/skills/verify-ui-contract/SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    assert.deepEqual(verifyManagedContent(content), { managed: true, unedited: true });

    // Hand-edit the file -> should trigger conflict
    writeFileSync(skillPath, content + '\n# Hand edit\n', 'utf8');
    const plannedConflict = planBuild(spec, dir);
    assert.equal(plannedConflict.counts.conflict, 1);

    // Force overwrite resolves conflict
    const plannedForce = planBuild(spec, dir, { force: true });
    assert.equal(plannedForce.counts.update, 1);
    applyBuild(plannedForce, { force: true });
    assert.deepEqual(verifyManagedContent(readFileSync(skillPath, 'utf8')), { managed: true, unedited: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
