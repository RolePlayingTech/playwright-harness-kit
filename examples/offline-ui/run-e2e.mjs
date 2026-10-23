import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const broken = process.argv.includes('--broken');
const verifyBroken = process.argv.includes('--verify-broken');
const extraArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== '--broken' && arg !== '--verify-broken');
const cli = resolve(here, 'node_modules/@playwright/test/cli.js');

const reportPath = resolve(here, 'test-results/broken-verification-report.json');
if (verifyBroken) {
  mkdirSync(resolve(here, 'test-results'), { recursive: true });
}

const playwrightArgs = verifyBroken
  ? [cli, 'test', '--reporter=list,json', ...extraArgs]
  : [cli, 'test', ...extraArgs];

const res = spawnSync(process.execPath, playwrightArgs, {
  cwd: here,
  stdio: 'inherit',
  env: {
    ...process.env,
    UI_BUG_MODE: broken ? 'broken' : 'fixed',
    ...(verifyBroken ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } : {}),
  },
});

if (!verifyBroken) {
  process.exit(res.status ?? 1);
}

function collectSpecs(suite, out = []) {
  for (const spec of suite.specs || []) {
    out.push(spec);
  }
  for (const child of suite.suites || []) {
    collectSpecs(child, out);
  }
  return out;
}

if (res.status === 0) {
  console.error('FAIL: Expected broken mode to fail DEMO-AUTH-01 and DEMO-UX-01, but Playwright exited with 0.');
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`FAIL: Expected Playwright JSON report at ${reportPath}, but it was not generated.`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const specs = collectSpecs(report);

function findSpec(prefix) {
  return specs.find((s) => s.title.startsWith(prefix));
}

const authSpec = findSpec('DEMO-AUTH-01:');
const uxSpec = findSpec('DEMO-UX-01:');
const guardSpec = findSpec('Default-deny ui-contract guard');

const errors = [];
if (!authSpec) {
  errors.push('Missing DEMO-AUTH-01 spec in Playwright report.');
} else {
  const result = authSpec.tests?.[0]?.results?.[0];
  const msg = result?.error?.message || '';
  if (result?.status !== 'failed' || !msg.includes('Typed email must remain in input after HTTP 503')) {
    errors.push(
      `DEMO-AUTH-01 did not fail with expected email-preservation assertion (status=${result?.status}, message=${JSON.stringify(msg)}).`
    );
  }
}

if (!uxSpec) {
  errors.push('Missing DEMO-UX-01 spec in Playwright report.');
} else {
  const result = uxSpec.tests?.[0]?.results?.[0];
  const msg = result?.error?.message || '';
  const hasScreenshotAttachment = (result?.attachments || []).some(
    (a) => a.name === 'demo-ux-01-mobile-390x844-broken' && a.contentType === 'image/png'
  );
  if (result?.status !== 'failed' || !msg.includes('must not exceed mobile innerWidth (390px)')) {
    errors.push(
      `DEMO-UX-01 did not fail with expected mobile overflow assertion (status=${result?.status}, message=${JSON.stringify(msg)}).`
    );
  }
  if (!hasScreenshotAttachment) {
    errors.push('DEMO-UX-01 did not attach the demo-ux-01-mobile-390x844-broken PNG screenshot.');
  }
}

if (!guardSpec) {
  errors.push('Missing Default-deny ui-contract guard spec in Playwright report.');
} else {
  const result = guardSpec.tests?.[0]?.results?.[0];
  if (result?.status !== 'passed') {
    errors.push(`Default-deny ui-contract guard must pass even in broken mode (status=${result?.status}).`);
  }
}

if (errors.length > 0) {
  console.error('FAIL: Broken-mode verification did not match expected regressions:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}

console.log(
  'PASS: Verified broken-mode regressions (DEMO-AUTH-01 & DEMO-UX-01 failed for expected reasons with screenshot attached; HTTP+WS network guard passed).'
);
process.exit(0);
