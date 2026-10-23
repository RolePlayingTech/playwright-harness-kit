import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSpec } from '../src/spec.mjs';
import { applyBuild, findStaleSkills, planBuild, renderSkill, verifyManagedContent } from '../src/build.mjs';

const RAW_SPEC = {
  name: 'mumro-web',
  purpose: 'Browser verification contract.',
  copySkillsTo: ['.claude/skills', '.cursor/skills'],
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
  assert.ok(md.includes('Responsibility boundary:'));
  const verified = verifyManagedContent(md);
  assert.deepEqual(verified, { managed: true, unedited: true });
});

test('planBuild and applyBuild detect conflicts on hand-edited skills and respect --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-build-'));
  try {
    const spec = normalizeSpec({ ...RAW_SPEC, copySkillsTo: [] });
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

test('detects and safely prunes stale skills when a skill is renamed or copySkillsTo target is removed, preserving manual skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-prune-'));
  try {
    // 1. Initial build writes to .playwright-harness/skills, .claude/skills, and .cursor/skills
    const spec1 = normalizeSpec(RAW_SPEC);
    const planned1 = planBuild(spec1, dir);
    assert.equal(planned1.counts.create, 3);
    applyBuild(planned1);

    // Create an unrelated manual skill in .claude/skills/manual-review/SKILL.md
    const manualSkillDir = join(dir, '.claude/skills/manual-review');
    mkdirSync(manualSkillDir, { recursive: true });
    const manualSkillPath = join(manualSkillDir, 'SKILL.md');
    writeFileSync(manualSkillPath, '---\nname: manual-review\ndescription: Manual skill.\n---\n# Manual\n', 'utf8');

    // 2. Rename skill to "verify-browser-v2" and remove ".cursor/skills" from copySkillsTo
    const spec2 = normalizeSpec({
      ...RAW_SPEC,
      copySkillsTo: ['.claude/skills'],
      skills: [
        {
          name: 'verify-browser-v2',
          description: 'Run UI contract scenarios v2. Use when verifying M-UX-01.',
          covers: ['M-UX-01'],
        },
      ],
    });

    const staleDetected = findStaleSkills(spec2, dir);
    assert.equal(staleDetected.length, 2 + 1); // .playwright-harness/skills, .claude/skills, and .cursor/skills
    assert.deepEqual(
      staleDetected.map((s) => s.relPath),
      [
        '.claude/skills/verify-ui-contract/SKILL.md',
        '.cursor/skills/verify-ui-contract/SKILL.md',
        '.playwright-harness/skills/verify-ui-contract/SKILL.md',
      ]
    );

    // 3. Hand-edit one stale skill (.cursor/skills/verify-ui-contract/SKILL.md) -> should trigger conflict on prune without --force
    const cursorStalePath = join(dir, '.cursor/skills/verify-ui-contract/SKILL.md');
    writeFileSync(cursorStalePath, readFileSync(cursorStalePath, 'utf8') + '\nCustom note\n', 'utf8');

    const plannedPruneConflict = planBuild(spec2, dir, { prune: true });
    assert.equal(plannedPruneConflict.counts.conflict, 1);
    assert.equal(plannedPruneConflict.counts.prune, 2);
    assert.throws(() => applyBuild(plannedPruneConflict), /Refusing to overwrite conflicting skill file/);

    // Restore intact content on .cursor/skills/verify-ui-contract/SKILL.md and test rollback on mid-apply I/O failure
    applyBuild(planBuild(spec1, dir, { force: true }), { force: true });
    const plannedPrune = planBuild(spec2, dir, { prune: true });
    assert.equal(plannedPrune.counts.create, 2);
    assert.equal(plannedPrune.counts.prune, 3);
    assert.equal(plannedPrune.counts.conflict, 0);

    // Simulate I/O failure on the final operation -> all pruned files must be restored
    let writeCalls = 0;
    const failingIo = {
      ...fs,
      writeFileSync(target, data, ...rest) {
        writeCalls += 1;
        if (writeCalls === 2) {
          throw new Error('simulated disk full');
        }
        return fs.writeFileSync(target, data, ...rest);
      },
    };
    assert.throws(() => applyBuild(plannedPrune, { io: failingIo }), /prior file state restored/);
    assert.equal(existsSync(join(dir, '.claude/skills/verify-ui-contract/SKILL.md')), true);
    assert.equal(existsSync(join(dir, '.cursor/skills/verify-ui-contract/SKILL.md')), true);

    // 4. Now apply prune cleanly
    const freshPlanPrune = planBuild(spec2, dir, { prune: true });
    applyBuild(freshPlanPrune);

    assert.equal(existsSync(join(dir, '.claude/skills/verify-ui-contract/SKILL.md')), false);
    assert.equal(existsSync(join(dir, '.cursor/skills/verify-ui-contract/SKILL.md')), false);
    assert.equal(existsSync(join(dir, '.playwright-harness/skills/verify-ui-contract/SKILL.md')), false);
    assert.equal(existsSync(join(dir, '.claude/skills/verify-browser-v2/SKILL.md')), true);
    // Unrelated manual skill is still intact
    assert.equal(existsSync(manualSkillPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never deletes README.md, package.json, src/app.js, docs/notes.md, nested non-skill paths, or unmanaged SKILL.md injected into .managed-manifest.json even with --prune --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-harness-manifest-bound-'));
  try {
    const spec1 = normalizeSpec(RAW_SPEC);
    applyBuild(planBuild(spec1, dir));

    // Create unrelated repository files and a manual skill without ownership header
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, '.claude/skills/nested/sub'), { recursive: true });
    mkdirSync(join(dir, '.claude/skills/manual-unmanaged'), { recursive: true });

    const protectedPaths = [
      'README.md',
      'package.json',
      'src/app.js',
      'docs/notes.md',
      '.claude/skills/nested/sub/SKILL.md',
      '.claude/skills/manual-unmanaged/SKILL.md',
    ];
    for (const rel of protectedPaths) {
      writeFileSync(join(dir, rel), `unmanaged content of ${rel}\n`, 'utf8');
    }

    // Tamper with .playwright-harness/.managed-manifest.json by injecting all protected paths
    const manifestPath = join(dir, '.playwright-harness/.managed-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          targetRoots: ['.playwright-harness/skills', '.claude/skills', '.cursor/skills', 'src'],
          managedFiles: [
            ...protectedPaths,
            '.claude/skills/verify-ui-contract/SKILL.md',
            '.cursor/skills/verify-ui-contract/SKILL.md',
            '.playwright-harness/skills/verify-ui-contract/SKILL.md',
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    // Rename skill in spec so verify-ui-contract is genuinely stale, and run planBuild + applyBuild with { prune: true, force: true }
    const spec2 = normalizeSpec({
      ...RAW_SPEC,
      copySkillsTo: ['.claude/skills'],
      skills: [
        {
          name: 'verify-browser-v2',
          description: 'Run UI contract scenarios v2. Use when verifying M-UX-01.',
          covers: ['M-UX-01'],
        },
      ],
    });

    const planned = planBuild(spec2, dir, { prune: true, force: true });
    // Diagnostics must flag every untrusted/unmanaged manifest entry
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('README.md')));
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('package.json')));
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('src/app.js')));
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('docs/notes.md')));
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('.claude/skills/nested/sub/SKILL.md')));
    assert.ok(planned.manifestDiagnostics.some((d) => d.includes('.claude/skills/manual-unmanaged/SKILL.md')));

    applyBuild(planned, { force: true });

    // Every single protected file must survive untouched
    for (const rel of protectedPaths) {
      assert.equal(existsSync(join(dir, rel)), true, `Protected file "${rel}" must survive build --prune --force`);
      assert.equal(readFileSync(join(dir, rel), 'utf8'), `unmanaged content of ${rel}\n`);
    }

    // Legitimate stale managed skills were still pruned
    assert.equal(existsSync(join(dir, '.claude/skills/verify-ui-contract/SKILL.md')), false);
    assert.equal(existsSync(join(dir, '.cursor/skills/verify-ui-contract/SKILL.md')), false);
    assert.equal(existsSync(join(dir, '.playwright-harness/skills/verify-ui-contract/SKILL.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
