# playwright-harness-kit

Record, explain, check and generate workflow skills for a **Playwright & multimodal browser verification contract**: execution tiers (`ui-contract` vs. `integrated`), stable scenario IDs (`M-AUTH-01`, `M-UX-01`), single-use refresh token session policies, artifact hygiene, and hybrid ARIA + DOM geometry + VLM visual rubrics.

Companion to [MUMRO Academy Lesson 15](https://academy.mumro.io/lessons/playwright-browser-automation-and-verification/). You write `.playwright-harness/spec.json`. The kit validates the verification contract, optionally audits repository test files and scripts (`--verify-files`), and generates managed `SKILL.md` files for coding and QA agents.

Requires Node.js 20+. Zero runtime dependencies in the CLI.

---

## Responsibility boundary: Declarative Contract vs. Runtime Browser Proof

`playwright-harness-kit` separates three distinct layers of verification:

1. **Declaration-only contract check (`playwright-harness check --strict`)**:
   - Validates that `.playwright-harness/spec.json` is internally consistent:
     - `ui-contract` tiers use `networkPolicy: "deny-unhandled"` and a structurally parsed (`new URL()`) bare origin whose hostname is either a reserved RFC 2606 `*.invalid` domain or an explicit loopback host (`localhost`, `127.0.0.1`, `[::1]`). Lookalike hosts (`https://localhost.attacker.example`, `https://production.example/path/localhost`), embedded credentials, and paths/queries are rejected as errors.
     - Rejects `allowSharedStorageState: true` when `singleUseRefreshRotation: true`.
     - Requires `locatorStrategy: "role-and-label-first"`, `forbidLiveMutations: true`, and `playwright/.auth/` in `artifactHygiene.gitIgnore`.
     - Requires `viewports`, `programmaticInvariants`, and `multimodalRubric` whenever `visualCheck.required: true`.
     - Warns if stale generated `SKILL.md` files remain on disk after a skill or `copySkillsTo` target was removed from `spec.json`.
   - **What it does NOT prove**: Static JSON validation does not inspect your test code or enforce network isolation at runtime.

2. **Repository evidence check (`playwright-harness check --strict --verify-files`)**:
   - Audits the repository on disk against the contract:
     - Verifies that every `scenarios[].spec` file exists on disk and contains its canonical scenario ID (`M-AUTH-01`, `M-UX-01`).
     - Verifies that `npm run <script>` commands in `tiers[*].command` exist in the target `package.json`.
     - Verifies that every path in `artifactHygiene.gitIgnore` is listed in `.gitignore`.
   - Reports explicit evidence states (`declared`, `observed`, `not-verified`) and always reports runtime browser policies (`uiContractNetworkIsolation`, `singleUseRefreshSessionIsolation`) as `not-verified` until the Playwright suite is executed.

3. **Runtime Playwright execution (`npx playwright test`)**:
   - Actual browser network isolation (`context.route('**/*', ...)`, `context.routeWebSocket()`, and `serviceWorkers: 'block'`), DOM/ARIA behavior, and CSS geometry (`scrollWidth <= innerWidth`, `boundingBox()`) are proven only by running the Playwright test suite.
   - Note that browser-level request interception (`context.route`) isolates the frontend under test; it never proves backend RBAC or server-side egress restriction, and a generated `SKILL.md` file is agent guidance rather than a credential sandbox.

---

## Commands & Exit Codes

```bash
npx github:RolePlayingTech/playwright-harness-kit explain [dir] [--strict] [--verify-files] [--json]
npx github:RolePlayingTech/playwright-harness-kit check [dir] [--strict] [--verify-files] [--json]
npx github:RolePlayingTech/playwright-harness-kit build [dir] [--dry-run] [--prune] [--force] [--json]
npx github:RolePlayingTech/playwright-harness-kit prune [dir] [--dry-run] [--force] [--json]
```

### Exit code policy
- `0` — Contract check passed (and 0 warnings when `--strict` is set), or `build` / `prune` / `--dry-run` completed with 0 conflicts.
- `1` — Contract validation error, missing file/script under `--verify-files`, warning under `--strict`, build/prune conflict on a hand-edited file without `--force`, or invalid CLI usage.

---

## 5-Minute Walkthrough: Runnable Offline Playwright Lab (`examples/offline-ui`)

This repository ships two examples with separate scenario catalogs so IDs never collide:
- **`examples/offline-ui/`** (`DEMO-AUTH-01`, `DEMO-UX-01`) — A self-contained, runnable offline Playwright mini-project with a local static UI (`app/index.html`), a fail-closed `ui-contract` fixture (`e2e/fixtures.ts` with `serviceWorkers: 'block'` and HTTP + WebSocket default-deny routing), synthetic-data screenshot + 4-point visual rubric attachment (`testInfo.attach`), and an intentional broken vs. fixed UI toggle. Requires no external services and no LLM API keys.
- **`examples/mumro-web/`** (`M-AUTH-01`, `M-UX-01`) — Reference `.playwright-harness/spec.json` contract from the MUMRO production workspace (`ui-contract` + `integrated` tiers).

### Step 1: Validate the contract and repository files

```bash
node bin/playwright-harness.mjs check examples/offline-ui --strict --verify-files
```

Expected output:

```text
PASS: Playwright verification spec and repository files verified (strict mode, 0 warnings).

Evidence summary:
  [observed    ] scenarioSpecFiles: All declared scenario .spec files exist on disk and reference their canonical scenario IDs.
  [observed    ] tierCommands: All declared tier npm scripts exist in their target package.json files.
  [observed    ] gitIgnoreHygiene: All declared artifactHygiene.gitIgnore paths are present in .gitignore.
  [not-verified] uiContractNetworkIsolation: Declared in spec.json, but default-deny browser routing (context.route) and Service Worker blocking (serviceWorkers: "block") can only be verified by executing the Playwright suite.
  [not-verified] singleUseRefreshSessionIsolation: Declared in spec.json, but per-worker login isolation and refresh token rotation behavior can only be verified by executing the Playwright suite.
```

### Step 2: Preview and build managed `SKILL.md` files (with `--prune`)

```bash
node bin/playwright-harness.mjs build examples/offline-ui --dry-run
node bin/playwright-harness.mjs build examples/offline-ui --prune
```

Each generated `SKILL.md` embeds a verifiable `<!-- playwright-harness-kit:managed sha256=... -->` marker and records managed paths in `.playwright-harness/.managed-manifest.json` (`targetRoots` + `managedFiles`). If a skill or `copySkillsTo` target is later removed from `spec.json`, `check` warns about the stale skill and `build --prune` (or `prune`) removes intact managed files while refusing to delete hand-edited skills without `--force`, and structurally rejecting any untrusted or unmanaged path even when `--force` is passed.

### Step 3: Run the Playwright suite against the broken UI (`--broken`)

Install Playwright in `examples/offline-ui` and run the suite in broken mode:

```bash
cd examples/offline-ui
npm install
npx playwright install chromium
npm run test:e2e:broken
# Or run the structured broken-mode verifier used in CI:
npm run test:e2e:broken:verify
```

In `broken` mode (`?mode=broken`):
1. **`DEMO-AUTH-01` fails**: Submitting the password recovery form when `POST /api/auth/password/forgot` returns HTTP `503` wipes the user's typed email address (`Expected: "qa-reset@example.invalid", Received: ""`) and schedules an unapproved background retry.
2. **`DEMO-UX-01` fails**: Even though `expect(page.getByRole('dialog')).toBeVisible()` passes in the ARIA tree, the drawer has a rigid `min-width: 540px` rule on a `390×844` mobile screen. The test first captures and attaches `demo-ux-01-mobile-390x844-broken.png` + the 4-point visual rubric (`testInfo.attach`), and then the programmatic geometry invariant catches the horizontal overflow (`Document scrollWidth (540px) must not exceed mobile innerWidth (390px)`).
3. **Default-deny HTTP + WebSocket guard passes**: Unmocked `fetch('https://analytics.example.com/ping')` and `new WebSocket('wss://realtime.example.com/socket')` attempts are blocked and recorded.

### Step 4: Run the Playwright suite against the repaired UI (`test:e2e:contract`)

```bash
npm run test:e2e:contract
```

In `fixed` mode (default):
- **`DEMO-AUTH-01` passes**: `role="alert"` is visible, the typed email `"qa-reset@example.invalid"` is preserved, and `forgotPasswordCalls === 1`.
- **`DEMO-UX-01` passes**: Captures and attaches `demo-ux-01-mobile-390x844-fixed.png` + the 4-point visual review rubric (truncation, occlusion, alignment, contrast), and asserts `documentElement.scrollWidth <= window.innerWidth` (`390 <= 390`) and `Close drawer` button `boundingBox()` inside `390px`. Note that screenshot inspection (human or VLM) is non-deterministic and complements—never replaces—deterministic DOM geometry assertions.
- **Negative HTTP & WebSocket boundary check passes**: Both `fetch('https://analytics.example.com/ping')` and `new WebSocket('wss://realtime.example.com/socket')` are aborted/closed and recorded by the default-deny `ui-contract` fixture.

---

## License

MIT. Built for [MUMRO Academy](https://academy.mumro.io) by [RolePlayingTech](https://roleplayingtech.com).
