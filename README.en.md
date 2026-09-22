# dsh-plugins-workspace

English | [简体中文](./README.md)

A collection of plugins for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness) — a TypeScript + cordis plugin monorepo. Plugins are loaded directly as TypeScript source by the dsh loader, with no build step.

> **Pure AI development**: all code in this repository is written entirely by AI coding agents.

## Plugins

### @lzhida/dsh-guided-goal

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

### @lzhida/dsh-tool-nushell

A standalone `nushell` tool: invoked explicitly by the model, commands run via `nu --no-config-file -c <command>` and return structured results (exit code, stdout, stderr). Commands are dispatched through the `ctx.shell` capability seam to the currently mounted nushell executor; installed with a companion executor, it replaces the official bash/pwsh shell family.

**Highlights**

- **Clean evaluation**: `--no-config-file` disables user config for reproducible behavior;
- **Foreground/background execution**: `run_in_background` returns a job id immediately, collected via the generic `ctx.jobs` (`job_output`/`job_kill`); timeout (default 30s, max 600s, SIGTERM on expiry) and cancellation are forwarded;
- **Structured output**: canonical oneOf (background handle | foreground result), per-stream truncation with the full output spilled to disk and reported as `spillPath`; `outputFormat` supports `text`/`json`/`nuon`;
- **Sandbox aware**: paired with `@lzhida/dsh-nushell-sandbox`, the tool publishes `sandbox_permissions` + `justification` escalation arguments — a sandbox-denied command may be retried once with a wider mode, with a stated reason and user approval;
- **Parallel-safe**: process-level isolation, may run concurrently with other tool calls;
- **Lifecycle cleanup**: surviving child processes are killed on plugin unload; `nu` is resolved via PATH — errors when missing, never bundled.

**Tool arguments**: `command` (required), `description` (required), `workdir`, `timeoutMs`, `run_in_background`, `outputFormat`, `stdin`; sandbox combinations additionally publish `sandbox_permissions`/`justification`. See the [package README](./packages/dsh-tool-nushell/README.md) for full semantics.

**Prerequisite**: Nushell installed locally (`nu` on PATH).

### @lzhida/dsh-nushell-local

Local Nushell shell executor: injects the `ctx.shell` capability seam so nushell joins the official shell family as a first-class shell (the counterpart of the official `dsh-pwsh-local` for PowerShell). Delegates managed spawning to `ctx.subprocess` — bounded output, spill files, and timeout grace live in the executor; clean `nu`-dialect evaluation, configurable `nuPath`, and automatic diagnostic annotations when stderr hits known wrapper-layer signatures. See the [package README](./packages/dsh-nushell-local/README.md).

### @lzhida/dsh-nushell-sandbox

Sandboxed Nushell shell executor: a `ctx.shell` provider mutually exclusive with `dsh-nushell-local` (the counterpart of the official bash/pwsh local ↔ sandbox executor pair). Every command's argv is wrapped process-level via `ctx.sandbox.confine` and spawned under restriction; policy denials and runner failures are classified by dialect into `ShellSandboxInfo` fact fields; fail-closed — when no runner is available it errors out instead of silently falling back to unrestricted execution. See the [package README](./packages/dsh-nushell-sandbox/README.md).

## Installation

Prerequisites: Node ≥ 22, pnpm 11, dsh installed, and Nushell installed locally (`nu` on PATH).

```sh
# Pick one executor (ctx.shell is a single-implementation seam; the two are mutually exclusive;
# installing either disables the official bash/pwsh shell family and tool-bash/tool-pwsh)
pnpm dsh plugin --profile default add link:packages/dsh-nushell-local
pnpm dsh plugin --profile default add link:packages/dsh-nushell-sandbox

# The nushell tool layer (consumes the ctx.shell injected by the executor above)
pnpm dsh plugin --profile default add link:packages/dsh-tool-nushell

# The guided goal command (independent, no executor dependency)
pnpm dsh plugin --profile default add link:packages/dsh-guided-goal
```

After installation, confirm the target plugins are enabled under dsh Web UI Settings → Plugins: use `/guided-goal` from the chat input for guided-goal; the `nushell` tool is invoked by the model on demand.

## Development

```sh
pnpm install        # install deps and run lefthook install automatically
pnpm lint           # ESLint (flat config, TS)
pnpm format         # Prettier write (format:check validates only)
pnpm typecheck      # per-package tsc --noEmit
pnpm test           # Vitest across all src/**/*.test.ts
```

- **Pure TypeScript**: plugins have no build step; `package.json` `main` points straight at `src/index.ts` and is loaded by the host dsh loader;
- **E2E**: the runner boots a real dsh instance with a dedicated profile (default `e2e`, auto-bootstrapped from the official web template when missing) — the plugin list is isolated per profile while `DSH_HOME` stays the global `~/.dsh` (model credentials are shared); asserts the plugin load log, web port reachability, and auth-chain health; tune with `E2E_PORT` / `E2E_TIMEOUT_MS` / `E2E_DSH_PROFILE` / `E2E_KEEP_MS` (runner at `.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts`, run via `npx tsx`);
- **Adding a plugin**: create `packages/<name>/` modeled on `packages/dsh-guided-goal/package.json`; `pnpm-workspace.yaml` picks it up automatically;
- **Commits**: Chinese Conventional Commits; develop on `feat/*` / `fix/*` branches merged into `dev`, then into `main` after verification.

## License

MIT
