import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SPEC_DIR = '.playwright-harness';
export const SPEC_FILE = 'spec.json';
export const NETWORK_POLICIES = ['deny-unhandled', 'local-stack-only', 'staging-allowlist'];
export const LOCATOR_STRATEGIES = ['role-and-label-first'];
export const TRACE_MODES = ['on-first-retry', 'retain-on-failure', 'off', 'on'];

export const ROOT_KEYS = [
  '$schema',
  'name',
  'purpose',
  'tiers',
  'authSessionPolicy',
  'artifactHygiene',
  'scenarios',
  'skills',
  'copySkillsTo',
];

export const TIER_KEYS = ['command', 'origin', 'networkPolicy', 'purpose'];
export const AUTH_POLICY_KEYS = ['singleUseRefreshRotation', 'allowSharedStorageState', 'rationale'];
export const HYGIENE_KEYS = ['traceMode', 'gitIgnore', 'forbidLiveMutations'];
export const SCENARIO_KEYS = ['id', 'title', 'tier', 'spec', 'locatorStrategy', 'visualCheck'];
export const VISUAL_CHECK_KEYS = ['required', 'viewports', 'programmaticInvariants', 'multimodalRubric'];
export const VIEWPORT_KEYS = ['width', 'height'];
export const SKILL_KEYS = ['name', 'description', 'covers'];
export const EXTENSION_KEY_RE = /^x-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function isExtensionKey(key) {
  return EXTENSION_KEY_RE.test(String(key));
}

const KNOWN_KEY_SUGGESTIONS = {
  root: {
    project: 'did you mean "name"?',
    summary: 'did you mean "purpose"?',
    description: 'did you mean "purpose"?',
    version: 'root "version" is not supported; use "x-*" for custom metadata',
    authPolicy: 'did you mean "authSessionPolicy"?',
    sessionPolicy: 'did you mean "authSessionPolicy"?',
    hygiene: 'did you mean "artifactHygiene"?',
    copySkillTo: 'did you mean "copySkillsTo"?',
  },
  tier: {
    url: 'did you mean "origin"?',
    baseURL: 'did you mean "origin"?',
    network: 'did you mean "networkPolicy"?',
    description: 'did you mean "purpose"?',
  },
  authPolicy: {
    sharedStorageState: 'did you mean "allowSharedStorageState"?',
    singleUseRefresh: 'did you mean "singleUseRefreshRotation"?',
    reason: 'did you mean "rationale"?',
  },
  hygiene: {
    trace: 'did you mean "traceMode"?',
    gitignore: 'did you mean "gitIgnore"?',
    forbidLiveSocialMutations: 'did you mean "forbidLiveMutations"?',
  },
  scenario: {
    scenarioId: 'did you mean "id"?',
    name: 'did you mean "title"?',
    file: 'did you mean "spec"?',
    specFile: 'did you mean "spec"?',
    locators: 'did you mean "locatorStrategy"?',
    vision: 'did you mean "visualCheck"?',
  },
  visualCheck: {
    invariants: 'did you mean "programmaticInvariants"?',
    rubric: 'did you mean "multimodalRubric"?',
    vlmRubric: 'did you mean "multimodalRubric"?',
  },
  skill: {
    uses: 'did you mean "covers"?',
    scenarios: 'did you mean "covers"?',
    steps: '"steps" is not supported; generated SKILL.md workflow steps are synthesized from "covers" and each referenced scenario',
  },
};

function editDistance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const dp = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let j = 1; j <= t.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= s.length; i++) {
      const temp = dp[i];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[s.length];
}

function suggestForUnknownKey(key, allowedKeys, context) {
  const table = KNOWN_KEY_SUGGESTIONS[context] || {};
  if (Object.hasOwn(table, key)) {
    return table[key];
  }
  let bestKey = null;
  let bestDist = Infinity;
  for (const candidate of allowedKeys) {
    if (candidate === '$schema') continue;
    const dist = editDistance(key, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = candidate;
    }
  }
  if (bestKey && bestDist <= 3) {
    return `did you mean "${bestKey}"?`;
  }
  return `allowed keys: ${allowedKeys.filter((k) => k !== '$schema').join(', ')}, or "x-*" extensions`;
}

export function specPath(dir) {
  return join(dir, SPEC_DIR, SPEC_FILE);
}

export function loadSpec(dir) {
  const raw = JSON.parse(readFileSync(specPath(dir), 'utf8'));
  return normalizeSpec(raw);
}

export function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('spec must be a JSON object');
  }
  const invalidFields = [];
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.includes(key) && !isExtensionKey(key)) {
      const hint = suggestForUnknownKey(key, ROOT_KEYS, 'root');
      invalidFields.push(`unknown field "${key}" (${hint})`);
    }
  }

  const tiers = {};
  if (!raw.tiers || typeof raw.tiers !== 'object' || Array.isArray(raw.tiers)) {
    invalidFields.push('spec.tiers must be a JSON object mapping tier names to tier definitions');
  } else {
    for (const [tierName, tierVal] of Object.entries(raw.tiers)) {
      if (isExtensionKey(tierName)) continue;
      tiers[tierName] = normalizeTier(tierName, tierVal, invalidFields);
    }
  }

  const authSessionPolicy = normalizeAuthPolicy(raw.authSessionPolicy, invalidFields);
  const artifactHygiene = normalizeHygiene(raw.artifactHygiene, invalidFields);

  if (raw.scenarios !== undefined && !Array.isArray(raw.scenarios)) {
    invalidFields.push('spec.scenarios must be an array of scenario objects');
  }
  if (raw.skills !== undefined && !Array.isArray(raw.skills)) {
    invalidFields.push('spec.skills must be an array of skill objects');
  }
  if (raw.copySkillsTo !== undefined && !Array.isArray(raw.copySkillsTo)) {
    invalidFields.push('spec.copySkillsTo must be an array of relative directory paths');
  }

  return {
    name: String(raw.name || '').trim(),
    purpose: String(raw.purpose || '').trim(),
    tiers,
    authSessionPolicy,
    artifactHygiene,
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map((s, idx) => normalizeScenario(s, idx)) : [],
    skills: Array.isArray(raw.skills) ? raw.skills.map((sk, idx) => normalizeSkill(sk, idx)) : [],
    copySkillsTo: Array.isArray(raw.copySkillsTo) ? raw.copySkillsTo.map((d) => String(d).trim()) : [],
    invalidFields,
  };
}

function normalizeTier(name, raw, invalidFields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidFields.push(`tiers.${name} must be a JSON object`);
    return { name, command: '', origin: '', networkPolicy: '', purpose: '' };
  }
  for (const key of Object.keys(raw)) {
    if (!TIER_KEYS.includes(key) && !isExtensionKey(key)) {
      const hint = suggestForUnknownKey(key, TIER_KEYS, 'tier');
      invalidFields.push(`unknown field "tiers.${name}.${key}" (${hint})`);
    }
  }
  return {
    name,
    command: String(raw.command || '').trim(),
    origin: String(raw.origin || '').trim(),
    networkPolicy: String(raw.networkPolicy || '').trim(),
    purpose: String(raw.purpose || '').trim(),
  };
}

function normalizeAuthPolicy(raw, invalidFields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidFields.push('spec.authSessionPolicy is required and must be a JSON object');
    return { singleUseRefreshRotation: undefined, allowSharedStorageState: undefined, rationale: '' };
  }
  for (const key of Object.keys(raw)) {
    if (!AUTH_POLICY_KEYS.includes(key) && !isExtensionKey(key)) {
      const hint = suggestForUnknownKey(key, AUTH_POLICY_KEYS, 'authPolicy');
      invalidFields.push(`unknown field "authSessionPolicy.${key}" (${hint})`);
    }
  }
  if (typeof raw.singleUseRefreshRotation !== 'boolean') {
    invalidFields.push('authSessionPolicy.singleUseRefreshRotation must be a boolean');
  }
  if (typeof raw.allowSharedStorageState !== 'boolean') {
    invalidFields.push('authSessionPolicy.allowSharedStorageState must be a boolean');
  }
  return {
    singleUseRefreshRotation: typeof raw.singleUseRefreshRotation === 'boolean' ? raw.singleUseRefreshRotation : false,
    allowSharedStorageState: typeof raw.allowSharedStorageState === 'boolean' ? raw.allowSharedStorageState : false,
    rationale: String(raw.rationale || '').trim(),
  };
}

function normalizeHygiene(raw, invalidFields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidFields.push('spec.artifactHygiene is required and must be a JSON object');
    return { traceMode: '', gitIgnore: [], forbidLiveMutations: undefined };
  }
  for (const key of Object.keys(raw)) {
    if (!HYGIENE_KEYS.includes(key) && !isExtensionKey(key)) {
      const hint = suggestForUnknownKey(key, HYGIENE_KEYS, 'hygiene');
      invalidFields.push(`unknown field "artifactHygiene.${key}" (${hint})`);
    }
  }
  if (!Array.isArray(raw.gitIgnore)) {
    invalidFields.push('artifactHygiene.gitIgnore must be an array of ignored paths');
  }
  if (typeof raw.forbidLiveMutations !== 'boolean') {
    invalidFields.push('artifactHygiene.forbidLiveMutations must be a boolean');
  }
  return {
    traceMode: String(raw.traceMode || '').trim(),
    gitIgnore: Array.isArray(raw.gitIgnore) ? raw.gitIgnore.map((g) => String(g).trim()).filter(Boolean) : [],
    forbidLiveMutations: typeof raw.forbidLiveMutations === 'boolean' ? raw.forbidLiveMutations : undefined,
  };
}

function normalizeScenario(raw, index = 0) {
  const invalidFields = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    invalidFields.push(`scenarios[${index}] must be a JSON object`);
    return {
      id: '',
      title: '',
      tier: '',
      spec: '',
      locatorStrategy: '',
      visualCheck: { required: false, viewports: [], programmaticInvariants: [], multimodalRubric: [] },
      invalidFields,
    };
  }
  for (const key of Object.keys(raw)) {
    if (!SCENARIO_KEYS.includes(key) && !isExtensionKey(key)) {
      const hint = suggestForUnknownKey(key, SCENARIO_KEYS, 'scenario');
      invalidFields.push(`unknown field "scenarios[${index}].${key}" (${hint})`);
    }
  }

  const vcRaw = raw.visualCheck;
  let visualCheck = { required: undefined, viewports: [], programmaticInvariants: [], multimodalRubric: [] };
  if (!vcRaw || typeof vcRaw !== 'object' || Array.isArray(vcRaw)) {
    invalidFields.push(`scenarios[${index}].visualCheck is required and must be a JSON object`);
  } else {
    for (const key of Object.keys(vcRaw)) {
      if (!VISUAL_CHECK_KEYS.includes(key) && !isExtensionKey(key)) {
        const hint = suggestForUnknownKey(key, VISUAL_CHECK_KEYS, 'visualCheck');
        invalidFields.push(`unknown field "scenarios[${index}].visualCheck.${key}" (${hint})`);
      }
    }
    if (typeof vcRaw.required !== 'boolean') {
      invalidFields.push(`scenarios[${index}].visualCheck.required must be a boolean`);
    }
    const viewports = [];
    if (vcRaw.viewports !== undefined) {
      if (!Array.isArray(vcRaw.viewports)) {
        invalidFields.push(`scenarios[${index}].visualCheck.viewports must be an array of { width, height } objects`);
      } else {
        vcRaw.viewports.forEach((vp, vIdx) => {
          if (!vp || typeof vp !== 'object' || Array.isArray(vp)) {
            invalidFields.push(`scenarios[${index}].visualCheck.viewports[${vIdx}] must be an object`);
            return;
          }
          for (const vKey of Object.keys(vp)) {
            if (!VIEWPORT_KEYS.includes(vKey) && !isExtensionKey(vKey)) {
              invalidFields.push(`unknown field "scenarios[${index}].visualCheck.viewports[${vIdx}].${vKey}"`);
            }
          }
          if (!Number.isInteger(vp.width) || vp.width <= 0 || !Number.isInteger(vp.height) || vp.height <= 0) {
            invalidFields.push(`scenarios[${index}].visualCheck.viewports[${vIdx}] requires positive integer width and height`);
          } else {
            viewports.push({ width: vp.width, height: vp.height });
          }
        });
      }
    }
    visualCheck = {
      required: typeof vcRaw.required === 'boolean' ? vcRaw.required : false,
      viewports,
      programmaticInvariants: Array.isArray(vcRaw.programmaticInvariants)
        ? vcRaw.programmaticInvariants.map((item) => String(item).trim()).filter(Boolean)
        : [],
      multimodalRubric: Array.isArray(vcRaw.multimodalRubric)
        ? vcRaw.multimodalRubric.map((item) => String(item).trim()).filter(Boolean)
        : [],
    };
  }

  return {
    id: String(raw.id || '').trim(),
    title: String(raw.title || '').trim(),
    tier: String(raw.tier || '').trim(),
    spec: String(raw.spec || '').trim(),
    locatorStrategy: String(raw.locatorStrategy || '').trim(),
    visualCheck,
    invalidFields,
  };
}

function normalizeSkill(skill, index = 0) {
  const invalidFields = [];
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    invalidFields.push(`skills[${index}] must be a JSON object`);
  } else {
    for (const key of Object.keys(skill)) {
      if (!SKILL_KEYS.includes(key) && !isExtensionKey(key)) {
        const hint = suggestForUnknownKey(key, SKILL_KEYS, 'skill');
        invalidFields.push(`unknown field "skills[${index}].${key}" (${hint})`);
      }
    }
    if (skill.covers !== undefined && !Array.isArray(skill.covers)) {
      invalidFields.push(`skills[${index}].covers must be an array of scenario IDs`);
    }
  }
  return {
    name: String(skill?.name || '').trim(),
    description: String(skill?.description || '').replace(/\r\n?/g, '\n').trim(),
    covers: Array.isArray(skill?.covers) ? skill.covers.map((c) => String(c).trim()) : [],
    invalidFields,
  };
}
