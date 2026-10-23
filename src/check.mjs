import { existsSync, readFileSync } from 'node:fs';
import {
  normalizeRelPath,
  normalizeText,
  safeJoin,
  validateCopyTarget,
  validateScenarioId,
  validateSkillName,
} from './fs-safe.mjs';
import { LOCATOR_STRATEGIES, NETWORK_POLICIES, TRACE_MODES } from './spec.mjs';

const USE_WHEN = /use when|używaj, gdy|używać, gdy/i;
const MULTI_AGENT_SKILL_DIRS = new Set(['.agents/skills', '.claude/skills', '.cursor/skills']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const NPM_RUN_RE = /^npm\s+(?:--prefix\s+([^\s]+)\s+)?run(?:-script)?\s+([a-zA-Z0-9_:-]+)(?:\s|$)/;

export function isAllowedUiContractHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === 'invalid' || host.endsWith('.invalid')) return true;
  return false;
}

export function validateTierOrigin(tierName, originValue) {
  const raw = String(originValue || '').trim();
  if (!raw) {
    return { ok: false, error: `tiers.${tierName}: origin is required` };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      error: `tiers.${tierName}: origin "${raw}" is not a valid URL (expected http:// or https:// origin)`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `tiers.${tierName}: origin "${raw}" must use http: or https: protocol (got "${parsed.protocol}")`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: `tiers.${tierName}: origin "${raw}" must not contain embedded credentials`,
    };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return {
      ok: false,
      error: `tiers.${tierName}: origin "${raw}" must be a bare origin (scheme + host + optional port) without path, query, or hash`,
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return {
      ok: false,
      error: `tiers.${tierName}: origin "${raw}" has an empty hostname`,
    };
  }
  if (tierName === 'ui-contract' && !isAllowedUiContractHost(hostname)) {
    return {
      ok: false,
      error: `tiers.ui-contract: origin "${raw}" (host "${hostname}") is not allowed for ui-contract; use a reserved "*.invalid" domain (RFC 2606) or an explicit loopback host ("localhost", "127.0.0.1", "[::1]")`,
    };
  }
  return { ok: true, hostname, origin: parsed.origin };
}

export function checkRepositoryEvidence(spec, rootDir) {
  const errors = [];
  const warnings = [];
  const evidence = [];

  // 1. Verify scenario spec files and scenario IDs on disk
  let allSpecsExist = spec.scenarios.length > 0;
  let allIdsObserved = spec.scenarios.length > 0;
  for (const scenario of spec.scenarios) {
    if (!scenario.id || !scenario.spec) {
      allSpecsExist = false;
      allIdsObserved = false;
      continue;
    }
    let fullSpecPath;
    try {
      fullSpecPath = safeJoin(rootDir, scenario.spec);
    } catch (error) {
      allSpecsExist = false;
      allIdsObserved = false;
      errors.push(`${scenario.id}: ${error.message}`);
      continue;
    }
    if (!existsSync(fullSpecPath)) {
      allSpecsExist = false;
      allIdsObserved = false;
      errors.push(`${scenario.id}: spec file "${scenario.spec}" does not exist on disk`);
      continue;
    }
    const content = normalizeText(readFileSync(fullSpecPath, 'utf8'));
    if (!content.includes(scenario.id)) {
      allIdsObserved = false;
      warnings.push(
        `${scenario.id}: scenario ID "${scenario.id}" was not found inside "${scenario.spec}" (reference the ID in test titles or comments)`
      );
    }
  }
  evidence.push({
    policy: 'scenarioSpecFiles',
    status: allSpecsExist && allIdsObserved ? 'observed' : 'not-verified',
    detail: allSpecsExist
      ? allIdsObserved
        ? 'All declared scenario .spec files exist on disk and reference their canonical scenario IDs.'
        : 'All declared scenario .spec files exist on disk, but one or more scenario IDs were not found inside the files.'
      : 'One or more declared scenario .spec files are missing on disk.',
  });

  // 2. Verify tier npm script commands where statically resolvable
  let tierScriptsStatus = 'observed';
  for (const [tierName, tier] of Object.entries(spec.tiers || {})) {
    if (!tier.command) continue;
    const match = NPM_RUN_RE.exec(tier.command.trim());
    if (!match) {
      if (tierScriptsStatus === 'observed') tierScriptsStatus = 'declared';
      warnings.push(
        `tiers.${tierName}: command "${tier.command}" is not a standard "npm run <script>" invocation; script existence cannot be verified statically`
      );
      continue;
    }
    const [, prefixDir, scriptName] = match;
    const pkgRel = prefixDir ? `${normalizeRelPath(prefixDir)}/package.json` : 'package.json';
    let pkgPath;
    try {
      pkgPath = safeJoin(rootDir, pkgRel);
    } catch (error) {
      tierScriptsStatus = 'not-verified';
      errors.push(`tiers.${tierName}: ${error.message}`);
      continue;
    }
    if (!existsSync(pkgPath)) {
      tierScriptsStatus = 'not-verified';
      errors.push(`tiers.${tierName}: command "${tier.command}" references missing ${pkgRel}`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      tierScriptsStatus = 'not-verified';
      errors.push(`tiers.${tierName}: failed to parse ${pkgRel}: ${error.message}`);
      continue;
    }
    if (!pkg?.scripts || typeof pkg.scripts[scriptName] !== 'string') {
      tierScriptsStatus = 'not-verified';
      errors.push(`tiers.${tierName}: npm script "${scriptName}" was not found in ${pkgRel}`);
    }
  }
  evidence.push({
    policy: 'tierCommands',
    status: tierScriptsStatus,
    detail:
      tierScriptsStatus === 'observed'
        ? 'All declared tier npm scripts exist in their target package.json files.'
        : tierScriptsStatus === 'declared'
          ? 'Tier commands are declared, including non-npm commands that require runtime execution to verify.'
          : 'One or more declared tier commands reference missing package.json files or missing npm scripts.',
  });

  // 3. Verify .gitignore coverage for artifactHygiene.gitIgnore
  const gitignorePath = safeJoin(rootDir, '.gitignore');
  const requiredIgnores = (spec.artifactHygiene?.gitIgnore || []).map((item) => item.replace(/^\/+|\/+$/g, ''));
  if (!existsSync(gitignorePath)) {
    warnings.push('artifactHygiene.gitIgnore: .gitignore was not found in repository root');
    evidence.push({
      policy: 'gitIgnoreHygiene',
      status: 'not-verified',
      detail: 'No .gitignore file found in repository root.',
    });
  } else {
    const rawLines = normalizeText(readFileSync(gitignorePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.replace(/^\/+|\/+$/g, ''));
    const ignoreEntries = new Set(rawLines);
    const missingIgnores = requiredIgnores.filter((req) => !ignoreEntries.has(req));
    for (const missing of missingIgnores) {
      warnings.push(`artifactHygiene.gitIgnore: "${missing}/" is declared in spec.json but missing from .gitignore`);
    }
    evidence.push({
      policy: 'gitIgnoreHygiene',
      status: missingIgnores.length === 0 ? 'observed' : 'not-verified',
      detail:
        missingIgnores.length === 0
          ? 'All declared artifactHygiene.gitIgnore paths are present in .gitignore.'
          : `Missing .gitignore entries: ${missingIgnores.join(', ')}.`,
    });
  }

  // 4. Runtime-only security & network policies: explicitly report as not-verified by static analysis
  evidence.push({
    policy: 'uiContractNetworkIsolation',
    status: 'not-verified',
    detail:
      'Declared in spec.json, but default-deny browser routing (context.route) and Service Worker blocking (serviceWorkers: "block") can only be verified by executing the Playwright suite.',
  });
  evidence.push({
    policy: 'singleUseRefreshSessionIsolation',
    status: 'not-verified',
    detail:
      'Declared in spec.json, but per-worker login isolation and refresh token rotation behavior can only be verified by executing the Playwright suite.',
  });

  return { errors, warnings, evidence };
}

export function checkSpec(spec, { rootDir = null, verifyFiles = false, staleSkills = [] } = {}) {
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
    if (!tier.origin) {
      errors.push(`tiers.${tierName}: origin is required`);
    } else {
      const originCheck = validateTierOrigin(tierName, tier.origin);
      if (!originCheck.ok) {
        errors.push(originCheck.error);
      }
    }
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

  for (const stale of staleSkills) {
    if (stale.action === 'conflict') {
      warnings.push(
        `stale skill conflict at "${stale.relPath}": ${stale.reason}`
      );
    } else {
      warnings.push(
        `stale generated skill "${stale.relPath}" is no longer in spec.json (run "playwright-harness build --prune" to remove)`
      );
    }
  }

  let evidence = [
    {
      policy: 'contractDeclaration',
      status: errors.length === 0 ? 'declared' : 'not-verified',
      detail:
        'Declaration-only check validates .playwright-harness/spec.json structure and internal consistency. Pass --verify-files to audit repository files and run Playwright to enforce runtime browser boundaries.',
    },
  ];

  if (verifyFiles && rootDir) {
    const repoCheck = checkRepositoryEvidence(spec, rootDir);
    errors.push(...repoCheck.errors);
    warnings.push(...repoCheck.warnings);
    evidence = repoCheck.evidence;
  }

  return { ok: errors.length === 0, errors, warnings, evidence, verifyFiles: Boolean(verifyFiles) };
}
