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

### @lzhida/dsh-obsidian

Wraps the [Obsidian built-in CLI](https://obsidian.md/help/cli) (`obsidian <command> [key=value ...]`) as `obsidian_*` agent tools so models and humans can operate an Obsidian vault directly from a dsh session. The full command taxonomy (35+ sub-commands covering `file:move` / `delete` / `property:set` / `plugin:enable` / `command` / `reload` / …) lives in [`src/commands.ts`](./packages/dsh-obsidian/src/commands.ts) as a single source of truth; the system-prompt section renders the same list and the safety contract — the README deliberately does not duplicate the table to avoid drift.

**Highlights**

- **9 `obsidian_*` tools**: `obsidian_read` / `create` / `append` / `search` / `daily` / `daily_append` / `properties` / `vault` + the generic `obsidian_run` that covers the remaining 35+ sub-commands (the model must know the exact sub-command name; the description enforces "must come from the commands.ts inventory" to keep the model from inventing CLI flags);
- **Four-tier danger model**: `read` / `write` / `destructive` / `execute`, tagged per command in `commands.ts`; the protocol section spells out which tier needs explicit user confirmation and which needs the host permission gate;
- **Error normalisation**: every failure becomes a `[CODE] message` text (`OBSIDIAN_CLI_NOT_FOUND` / `OBSIDIAN_INVALID_INPUT` / `OBSIDIAN_SPAWN_FAILED` / `OBSIDIAN_TIMEOUT` / `OBSIDIAN_NONZERO_EXIT` / `OBSIDIAN_PROTOCOL_ERROR`) so the model can match by code; the Obsidian-specific `Error:` stdout prefix is detected and surfaced as `OBSIDIAN_PROTOCOL_ERROR`;
- **stdio truncation**: stdout 20k / stderr 4k; overflows gain a `[truncated to N chars]` marker;
- **No bundled binary**: the `obsidian` command is provided by the Obsidian app and must be on `PATH`; the first call surfaces `OBSIDIAN_CLI_NOT_FOUND` with a clear recovery hint when missing;
- **system-prompt section**: `tool:obsidian` at order 2960 (sits next to `tool:taskboard` 2950, ordered after by name); injects the 35+ command table and the safety contract at load time;
- **Zero configuration**: install and use; defaults to the active vault; multi-vault callers pass `vault=<name>` per call.

**Prerequisite**: Obsidian installed locally (≥ 1.4, which ships the CLI). If `obsidian --version` fails, fix the PATH first.

### @lzhida/dsh-taskboard

Task board plugin (an architectural/teaching re-implementation of [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard#readme)): the core contract for **human creates card → agent claims and executes → human accepts**. Ten `taskboard_*` agent tools plus code-level protocol gates (agent can never move to `done`, a held task cannot be stolen, cross-project actions are forbidden, checklist check must carry an evidence note), ifVersion optimistic concurrency, DoD checklist (≤30 items), structured execution report, and a system-prompt section spelling out the claim discipline and the done-gate. Ledger persisted to `~/.dsh/dsh-taskboard.json` via atomic write.

**Highlights**

- **10 `taskboard_*` tools**: `taskboard_list` / `get` / `comments` / `create` / `update` / `move` / `comment_add` / `delete` / `checklist` / `execution_report` — available in any session, scoped by the `workspaceId` project boundary;
- **Code-level protocol gates**: four failure paths are rejected by code, not by prompt convention — `DONE_FORBIDDEN` / `TASK_HELD` / `CROSS_PROJECT_FORBIDDEN` / `CHECKLIST_NOTE_REQUIRED`;
- **ifVersion optimistic concurrency**: `update` / `move` / `checklist` / `trash` all require matching `ifVersion`; stale versions raise `VERSION_CONFLICT`;
- **DoD checklist**: acceptance criteria set at creation (≤30 items, each ≤200 chars); agent check must include an evidence note (command / file / test); the user can check independently on the detail panel; even with every item checked, the task is not auto-`done`;
- **Structured execution report**: `taskboard_execution_report` submits (summary / changed files / checks / artifacts / risk), rendered column-wise in the in-review detail panel;
- **Five-column flow + soft delete**: `backlog` / `todo` / `in_progress` / `in_review` / `done` plus `canceled` / `archived` / `trashed`; the state-machine whitelist forbids illegal transitions;
- **system-prompt section**: `tool:taskboard` at order 2950 spells out the claim discipline, the done-gate, and retry rules — the model learns the contract before its first call;
- **Zero configuration**: install and use; no token / API key needed; data stays local.

**Deliberately out of scope** (an architectural re-implementation, not a 1:1 port): the Web kanban UI, cron scheduler, worktree-isolated execution, external-session autosync, multi-repo mirror, task templates, image attachments. See the [package README](./packages/dsh-taskboard/README.md).

### @lzhida/dsh-test-runner

Repackages the e2e orchestration logic of `.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts` into five `test_runner_*` agent tools, callable from any dsh session (instead of a developer running the shell script by hand). Boots real dsh Web UI under an isolated `~/.dsh/profiles/<name>` profile and runs three assertions (plugin load log, port reachable, tokened URL page); it never touches the current `default` profile or any running dsh instance.

**Five-step method**

| Step | Tool                          | Purpose                                                                                                                   |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | `test_runner_review_profiles` | Audit `~/.dsh/profiles/`, mark test-purpose profiles; if `createIfMissing=true`, bootstrap from the official web template |
| 2    | `test_runner_install`         | Install the plugin under test into the test profile (auto-maintains cordis.patch.yml for local executors)                 |
| 3    | `test_runner_boot`            | Spawn `dsh web` in the background, return `sessionId` and tokened URL; `ctx.effect` on unload force-kills the child       |
| 4    | `test_runner_run_assertions`  | Poll the three assertions — **callable repeatedly until ready**                                                           |
| 5    | `test_runner_cleanup`         | Explicit kill + uninstall the tested plugin; restore the profile to a clean state                                         |

**Highlights**

- **Three invocation paths**: developer shell (`npx tsx .../test-e2e.ts`) / background job + browser takeover / dsh-agent in-session five-step — pick the one that fits the context;
- **Composable / concurrent**: every tool is independently callable; the agent decides the cadence and may retry on partial failure;
- **Profile isolation + auto cleanup**: `test_runner_cleanup` explicitly kills the process and uninstalls the plugin; `ctx.effect` on unload is the safety net;
- **Local executor compatibility**: automatically appends the "disable permission presets" block to the profile's `cordis.patch.yml` when needed (matches `test-e2e.ts` behaviour);
- **system-prompt section**: `tool:test-runner` at order 2850; the model sees the five-step protocol before its first call;
- **Hard-coded DoD**: load-log contract `[<name>]`, default port 3865, profile isolation, explicit cleanup — all baked into the tool descriptions.

## Installation

Prerequisites: Node ≥ 22, pnpm 11, dsh installed.

```sh
# The guided goal command (independent, no executor dependency)
pnpm dsh plugin --profile default add link:packages/dsh-guided-goal

# Obsidian operations (independent — 9 obsidian_* tools + a generic entry, wraps Obsidian's built-in CLI)
pnpm dsh plugin --profile default add link:packages/dsh-obsidian

# The task board plugin (independent — 10 taskboard_* tools + code-level protocol gates)
pnpm dsh plugin --profile default add link:packages/dsh-taskboard

# The plugin e2e test agent tool (independent — five test_runner_* tools)
pnpm dsh plugin --profile default add link:packages/dsh-test-runner
```

After installation, confirm the target plugins are enabled under dsh Web UI Settings → Plugins: use `/guided-goal` from the chat input for guided-goal; the task-board agent uses the `taskboard_*` tool set collaboratively from any session; the test-runner agent uses the `test_runner_*` tool set to drive plugin e2e in any isolated profile.

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
