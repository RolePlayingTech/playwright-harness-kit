# playwright-harness-kit

Record, explain, check and generate workflow skills for a **Playwright & multimodal browser verification contract**: execution tiers (`ui-contract` vs. `integrated`), stable scenario IDs (`M-AUTH-01`, `M-UX-01`), single-use refresh token session policies, artifact hygiene, and hybrid ARIA + DOM geometry + VLM visual rubrics.

Companion to [MUMRO Academy Lesson 15](https://academy.mumro.io/lessons/playwright-browser-automation-and-verification/). You write `.playwright-harness/spec.json`. The kit validates the verification contract in CI and generates managed `SKILL.md` files for coding and QA agents.

Requires Node.js 20+. Zero runtime dependencies.

## Why

When coding and QA agents verify web applications in a real browser, four failure modes happen repeatedly:

- **Pixel-coordinate clicking**: the agent takes a screenshot on every step and guesses `mouse.click(x, y)`, breaking across viewports and burning token budgets instead of using the ARIA accessibility tree (`@playwright/mcp` `browser_snapshot` and `getByRole`).
- **Hallucinated visual pass/fail**: a multimodal model inspects a screenshot without deterministic DOM geometry assertions (`scrollWidth <= innerWidth`, `boundingBox`) or an explicit rubric.
- **Session-family revocation in parallel workers**: sharing a single `storageState` file across concurrent Playwright workers when the backend uses single-use refresh token rotation (`401` cascade).
- **Unmocked network calls or leaked auth traces**: contract tests hitting external endpoints, or `.auth/` / trace archives being committed to Git.

`playwright-harness-kit` makes your browser verification rules checkable in CI:

- **Two-tier network discipline**: `ui-contract` tiers must set `networkPolicy: "deny-unhandled"` and use a reserved `.invalid` or localhost origin.
- **Auth token rotation guard**: rejects `allowSharedStorageState: true` when `singleUseRefreshRotation: true`.
- **Semantic locator policy**: enforces `locatorStrategy: "role-and-label-first"` and rejects brittle coordinate or CSS-chain strategies.
- **Hybrid visual check contract**: when `visualCheck.required: true`, requires explicit `viewports`, deterministic DOM `programmaticInvariants`, and a `multimodalRubric` for VLM inspection.
- **Artifact & trace hygiene**: requires `forbidLiveMutations: true` and `playwright/.auth/` in `gitIgnore`, and warns when `traceMode: "on"` stores traces on passing runs.
- **Safe, conflict-aware `SKILL.md` generation**: generates managed skills with SHA-256 ownership markers (`<!-- playwright-harness-kit:managed sha256=... -->`), unified `--dry-run` diffs, and conflict protection.

## Commands

```bash
npx github:RolePlayingTech/playwright-harness-kit explain [dir] [--strict] [--json]
npx github:RolePlayingTech/playwright-harness-kit check [dir] [--strict] [--json]
npx github:RolePlayingTech/playwright-harness-kit build [dir] --dry-run [--json]
npx github:RolePlayingTech/playwright-harness-kit build [dir] [--force] [--json]
```

From this repository:

```bash
npm test
npm run explain
npm run check
npm run build:dry-run
```

## License

MIT. Built for [MUMRO Academy](https://academy.mumro.io) by [RolePlayingTech](https://roleplayingtech.com).
