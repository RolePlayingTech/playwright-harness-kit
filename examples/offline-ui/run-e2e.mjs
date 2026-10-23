import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const broken = process.argv.includes('--broken');
const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--broken');
const cli = resolve(here, 'node_modules/@playwright/test/cli.js');

const res = spawnSync(process.execPath, [cli, 'test', ...extraArgs], {
  cwd: here,
  stdio: 'inherit',
  env: {
    ...process.env,
    UI_BUG_MODE: broken ? 'broken' : 'fixed',
  },
});

process.exit(res.status ?? 1);
