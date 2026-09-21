# dsh-plugins-workspace

English | [简体中文](./README.md)

A collection of plugins for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness) — a TypeScript + cordis plugin monorepo. Plugins are loaded directly as TypeScript source by the dsh loader, with no build step.

## Plugins

### @dsh-plugins/guided-goal

A guided persistent-goal command. It turns a one-line natural-language intent into a structured goal that the dsh goal domain executes autonomously within the session until completion.

**Highlights**

- **Guided creation** (`/guided-goal`): the model clarifies five fields one by one — success criteria (must be decidable), verification, round cap, boundaries, stop conditions — then composes the objective and calls `create_goal`;
- **Smart interview skip**: when the draft is already sufficiently specific or the user clearly declines to be interviewed, the model may skip clarification and create directly; every inferred field is marked as "Assumption: ...", and the round cap is estimated from workload (small 2–3 / medium 5 / large 8–10 rounds) with the basis explained in the reply;
- **Structured objective**: five fixed sections `## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions`, with the round cap passed as `max_goal_rounds`;
- **Mandatory completion summary**: the goal's stop conditions embed a summary requirement — modified-file list, per-item verification results, and leftover issues;
- **Settings panel**: dsh Settings → Plugins → guided-goal, with an "Enable command" toggle (on by default);
- **Locale aware**: command descriptions and protocol prompts follow dsh's general language setting (Chinese / English / bilingual fallback when unset).

**Usage**

```
/guided-goal              # enter the interview, clarify field by field
/guided-goal <draft goal> # interview with a draft; if the draft is specific enough the model may create directly
```

## Installation

Prerequisites: Node ≥ 22, pnpm 11, and dsh installed.

```sh
# Install into a profile from this repo via link
pnpm dsh plugin --profile default add link:packages/guided-goal
```

After installation, confirm "guided-goal" is enabled under dsh Web UI Settings → Plugins, then use `/guided-goal` from the chat input.

## Development

```sh
pnpm install        # install deps and run lefthook install automatically
pnpm lint           # ESLint (flat config, TS)
pnpm format         # Prettier write (format:check validates only)
pnpm typecheck      # per-package tsc --noEmit
pnpm test           # Vitest across all src/**/*.test.ts
pnpm test:e2e       # real dsh Web UI loading verification (guided-goal by default)
```

- **Pure TypeScript**: plugins have no build step; `package.json` `main` points straight at `src/index.ts` and is loaded by the host dsh loader;
- **E2E**: the runner boots a real dsh instance with an isolated `DSH_HOME` and a dedicated profile, asserting the plugin load log, web port reachability, and auth-chain health; tune with `E2E_PORT` / `E2E_TIMEOUT_MS` / `E2E_KEEP_MS` (see `scripts/test-e2e.ts`);
- **Adding a plugin**: create `packages/<name>/` modeled on `packages/guided-goal/package.json`; `pnpm-workspace.yaml` picks it up automatically;
- **Commits**: Chinese Conventional Commits; develop on `feat/*` / `fix/*` branches merged into `dev`, then into `main` after verification.

## License

MIT
