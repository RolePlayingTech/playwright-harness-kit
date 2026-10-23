import { normalizeRelPath, validateCopyTarget, validateScenarioId, validateSkillName } from './fs-safe.mjs';
import { LOCATOR_STRATEGIES, NETWORK_POLICIES, TRACE_MODES } from './spec.mjs';

const USE_WHEN = /use when|używaj, gdy|używać, gdy/i;
const MULTI_AGENT_SKILL_DIRS = new Set(['.agents/skills', '.claude/skills', '.cursor/skills']);

export function checkSpec(spec) {
  const errors = [];
  const warnings = [];

  for (const msg of spec.invalidFields || []) {
    errors.push(msg);
  }
  if (!spec.name) errors.push('spec.name is required.');
  if (!spec.purpose) errors.push('spec.purpose is required (one sentence).');

  const tierEntries = Object.entries(spec.tiers || {});
  if (!tierEntries.length) {
    errors.push('spec.tiers must define at least one execution tier (e.g. "ui-contract").');
  }
  for (const [tierName, tier] of tierEntries) {
    if (!tier.command) errors.push(`tiers.${tierName}: command is required`);
    if (!tier.origin) errors.push(`tiers.${tierName}: origin is required`);
    if (!NETWORK_POLICIES.includes(tier.networkPolicy)) {
      errors.push(`tiers.${tierName}: networkPolicy must be one of ${NETWORK_POLICIES.join(', ')}`);
    }
    if (!tier.purpose) errors.push(`tiers.${tierName}: purpose is required`);
    if (tierName === 'ui-contract') {
      if (tier.networkPolicy && tier.networkPolicy !== 'deny-unhandled') {
        errors.push(
          `tiers.ui-contract: networkPolicy must be "deny-unhandled" so contract tests fail closed on unmocked requests`
        );
      }
      if (tier.origin && !/(\.invalid(?:\/|$)|localhost|127\.0\.0\.1)/i.test(tier.origin)) {
        warnings.push(
          `tiers.ui-contract: origin "${tier.origin}" should use a reserved .invalid domain or localhost`
        );
      }
    }
  }

  const auth = spec.authSessionPolicy || {};
  if (auth.singleUseRefreshRotation && auth.allowSharedStorageState) {
    errors.push(
      'authSessionPolicy: allowSharedStorageState cannot be true when singleUseRefreshRotation is true (parallel workers sharing one single-use refresh token trigger reuse detection and revoke the session family)'
    );
  }
  if (auth.singleUseRefreshRotation && !auth.rationale) {
    warnings.push('authSessionPolicy: add a rationale explaining why single-use refresh rotation requires isolated sessions');
  }

  const hygiene = spec.artifactHygiene || {};
  if (hygiene.traceMode && !TRACE_MODES.includes(hygiene.traceMode)) {
    errors.push(`artifactHygiene.traceMode must be one of ${TRACE_MODES.join(', ')}`);
  } else if (hygiene.traceMode === 'on') {
    warnings.push(
      'artifactHygiene.traceMode is "on"; prefer "on-first-retry" or "retain-on-failure" so passing runs do not store sensitive session payloads'
    );
  }
  if (hygiene.forbidLiveMutations !== true) {
    errors.push(
      'artifactHygiene.forbidLiveMutations must be true so browser verification never mutates live third-party accounts'
    );
  }
  const ignoreSet = new Set((hygiene.gitIgnore || []).map((item) => item.replace(/\/+$/, '')));
  if (!ignoreSet.has('playwright/.auth')) {
    errors.push('artifactHygiene.gitIgnore must include "playwright/.auth/" so session state is never committed');
  }
  if (!ignoreSet.has('playwright-report') || !ignoreSet.has('test-results')) {
    warnings.push(
      'artifactHygiene.gitIgnore should include both "playwright-report/" and "test-results/" to prevent trace and screenshot leaks'
    );
  }

  const seenCopyTargets = new Set();
  const overlappingAgentDirs = [];
  for (const dest of spec.copySkillsTo || []) {
    const targetErr = validateCopyTarget(dest);
    if (targetErr) {
      errors.push(targetErr);
      continue;
    }
    const normalized = normalizeRelPath(dest);
    if (seenCopyTargets.has(normalized)) {
      errors.push(`duplicate copySkillsTo target: ${normalized}`);
    }
    seenCopyTargets.add(normalized);
    if (MULTI_AGENT_SKILL_DIRS.has(normalized)) {
      overlappingAgentDirs.push(normalized);
    }
  }
  if (overlappingAgentDirs.length > 1) {
    warnings.push(
      `copySkillsTo lists multiple shared agent skill directories (${overlappingAgentDirs.join(', ')}); hosts like Cursor read both .agents/skills and .claude/skills and will list each skill twice`
    );
  }

  if (!spec.scenarios.length) {
    errors.push('spec.scenarios must list at least one scenario.');
  }

  const byId = new Map();
  for (const [idx, scenario] of spec.scenarios.entries()) {
    const label = scenario.id || `scenarios[${idx}]`;
    for (const msg of scenario.invalidFields || []) {
      errors.push(`${label}: ${msg}`);
    }
    const idErr = validateScenarioId(scenario.id);
    if (idErr) {
      errors.push(idErr);
      if (!scenario.id) continue;
    }
    if (byId.has(scenario.id)) {
      errors.push(`duplicate scenario id: ${scenario.id}`);
    }
    byId.set(scenario.id, scenario);

    if (!scenario.title) errors.push(`${scenario.id}: title is required`);
    if (!scenario.tier || !spec.tiers[scenario.tier]) {
      errors.push(`${scenario.id}: tier "${scenario.tier || ''}" is not defined in spec.tiers`);
    }
    if (!scenario.spec) {
      errors.push(`${scenario.id}: spec file path is required`);
    } else {
      try {
        const normalizedSpec = normalizeRelPath(scenario.spec);
        if (!/\.(spec|test)\.[cm]?[jt]sx?$/.test(normalizedSpec)) {
          warnings.push(`${scenario.id}: spec path "${scenario.spec}" does not end with .spec.ts / .test.ts`);
        }
      } catch (error) {
        errors.push(`${scenario.id}: ${error.message}`);
      }
    }

    if (!LOCATOR_STRATEGIES.includes(scenario.locatorStrategy)) {
      errors.push(
        `${scenario.id}: locatorStrategy "${scenario.locatorStrategy || ''}" is not allowed; use "role-and-label-first" (ARIA role/label locators instead of brittle pixel coordinates or CSS chains)`
      );
    }

    const vc = scenario.visualCheck || {};
    if (vc.required) {
      if (!vc.viewports || vc.viewports.length === 0) {
        errors.push(`${scenario.id}: visualCheck.required=true requires at least one viewport in visualCheck.viewports`);
      }
      if (!vc.programmaticInvariants || vc.programmaticInvariants.length === 0) {
        errors.push(
          `${scenario.id}: visualCheck.required=true requires at least one DOM geometry check in visualCheck.programmaticInvariants (e.g. "documentElement.scrollWidth <= window.innerWidth")`
        );
      }
      if (!vc.multimodalRubric || vc.multimodalRubric.length === 0) {
        errors.push(
          `${scenario.id}: visualCheck.required=true requires at least one VLM criterion in visualCheck.multimodalRubric`
        );
      }
    }
  }

  const coveredScenarios = new Set();
  const seenSkills = new Set();
  for (const [skillIdx, skill] of spec.skills.entries()) {
    const label = skill.name || `skills[${skillIdx}]`;
    for (const msg of skill.invalidFields || []) {
      errors.push(`${label}: ${msg}`);
    }
    const skillNameErr = validateSkillName(skill.name);
    if (skillNameErr) {
      errors.push(skillNameErr);
    } else if (seenSkills.has(skill.name)) {
      errors.push(`duplicate skill name: ${skill.name}`);
    }
    if (skill.name) seenSkills.add(skill.name);

    if (!skill.description) {
      errors.push(`${label}: description is required`);
    } else {
      if (!USE_WHEN.test(skill.description)) {
        errors.push(`${label}: description must say when to use it ("Use when …")`);
      }
      if (skill.description.length > 1024) {
        errors.push(`${label}: description longer than 1024 characters`);
      }
      if (/[<>]/.test(skill.description)) {
        errors.push(`${label}: description cannot contain XML/HTML angle brackets (< or >)`);
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(skill.description)) {
        errors.push(`${label}: description cannot contain control characters`);
      }
    }

    if (!skill.covers.length) {
      errors.push(`${label}: covers must list at least one scenario id`);
    }
    const seenInSkill = new Set();
    for (const id of skill.covers) {
      if (!byId.has(id)) {
        errors.push(`${label}: covers unknown scenario ${id}`);
      } else if (seenInSkill.has(id)) {
        errors.push(`${label}: duplicate scenario ${id} in covers`);
      } else {
        seenInSkill.add(id);
        coveredScenarios.add(id);
      }
    }
  }

  for (const scenario of spec.scenarios) {
    if (scenario.id && !coveredScenarios.has(scenario.id)) {
      warnings.push(`${scenario.id}: scenario is not referenced by any skill in spec.skills`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
