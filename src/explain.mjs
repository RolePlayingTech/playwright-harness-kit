export function explainData(spec, check) {
  const coveredSet = new Set();
  for (const skill of spec.skills) {
    for (const id of skill.covers) coveredSet.add(id);
  }
  const uncoveredScenarios = spec.scenarios.filter((s) => !coveredSet.has(s.id)).map((s) => s.id);
  return {
    ok: check.ok,
    name: spec.name,
    purpose: spec.purpose,
    tiers: spec.tiers,
    authSessionPolicy: spec.authSessionPolicy,
    artifactHygiene: spec.artifactHygiene,
    scenarios: spec.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      tier: s.tier,
      spec: s.spec,
      locatorStrategy: s.locatorStrategy,
      visualCheck: s.visualCheck,
      coveredBySkills: spec.skills.filter((sk) => sk.covers.includes(s.id)).map((sk) => sk.name),
    })),
    skills: spec.skills.map((sk) => ({
      name: sk.name,
      description: sk.description,
      covers: sk.covers,
    })),
    uncoveredScenarios,
    errors: check.errors,
    warnings: check.warnings,
  };
}

export function formatExplain(spec, check) {
  const data = explainData(spec, check);
  const auth = spec.authSessionPolicy;
  const hygiene = spec.artifactHygiene;
  const lines = [
    `Playwright verification contract: ${spec.name}`,
    spec.purpose,
    `Auth session policy: singleUseRefreshRotation=${auth.singleUseRefreshRotation}, allowSharedStorageState=${auth.allowSharedStorageState}`,
    `Artifact hygiene: traceMode=${hygiene.traceMode}, forbidLiveMutations=${hygiene.forbidLiveMutations}, gitIgnore=[${hygiene.gitIgnore.join(', ')}]`,
    '',
    'Tier            Network Policy     Origin                            Command',
    '--------------  -----------------  --------------------------------  --------------------------------------------',
  ];
  for (const [tierName, tier] of Object.entries(spec.tiers)) {
    lines.push(
      [
        tierName.padEnd(14),
        tier.networkPolicy.padEnd(17),
        tier.origin.padEnd(32),
        tier.command,
      ].join('  ')
    );
  }

  lines.push(
    '',
    'Scenario     Tier            Locators              Visual (Geometry + VLM)   Spec',
    '-----------  --------------  --------------------  ------------------------  ----------------------------------------'
  );
  for (const s of spec.scenarios) {
    const vpSummary = s.visualCheck?.required
      ? `yes (${s.visualCheck.viewports.map((v) => `${v.width}x${v.height}`).join(', ')})`
      : 'no (DOM/ARIA only)';
    lines.push(
      [
        s.id.padEnd(11),
        s.tier.padEnd(14),
        s.locatorStrategy.padEnd(20),
        vpSummary.padEnd(24),
        s.spec,
      ].join('  ')
    );
  }

  lines.push('', 'Skills');
  if (spec.skills.length) {
    for (const skill of spec.skills) {
      lines.push(`  ${skill.name}: ${skill.description}`);
      lines.push(`    covers: ${skill.covers.join(', ') || '(none)'}`);
    }
  } else {
    lines.push('  (none declared)');
  }

  lines.push('', 'Uncovered scenarios');
  if (data.uncoveredScenarios.length) {
    lines.push(`  ${data.uncoveredScenarios.join(', ')}`);
  } else {
    lines.push('  (none — all scenarios are referenced by at least one skill)');
  }

  if (check.errors.length) {
    lines.push('', 'Errors');
    for (const error of check.errors) lines.push(`  - ${error}`);
  }
  if (check.warnings.length) {
    lines.push('', 'Warnings');
    for (const warning of check.warnings) lines.push(`  - ${warning}`);
  }
  if (!check.errors.length && !check.warnings.length) {
    lines.push('', 'Check: Playwright verification contract is internally consistent.');
  }
  return lines.join('\n');
}
