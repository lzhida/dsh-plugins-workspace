# dsh-plugins-workspace

English | [简体中文](./README.md)

A plugin repository for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) — a TypeScript + cordis plugin monorepo. It currently hosts a single plugin: [@zhidal/dsh-llm-fallback](./packages/dsh-llm-fallback/README.md) (build-based distribution, entry is the esbuild-bundled dist, published on [npm](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback)).

> **Pure AI development**: all code in this repository is written entirely by AI coding agents.

## Plugins

### @zhidal/dsh-llm-fallback

The model-fallback plugin for dsh: it intercepts global LLM calls and, when the session-selected model (the de-facto primary) fails, automatically switches to the next `provider/model` in the fallback queue **without interrupting the conversation**. Supports per-candidate retries (`retriesBeforeSwitch`), cooldown skipping of failed candidates, and a visual settings card; routing decisions use only stable host failure codes. See [packages/dsh-llm-fallback/README.md](./packages/dsh-llm-fallback/README.md) for features, internals, configuration, and troubleshooting.

## Installation

Prerequisites: Node ≥ 22, pnpm 11, dsh installed.

```sh
dsh plugin add @zhidal/dsh-llm-fallback                       # npm install (recommended)
dsh plugin add link:<absolute repo path>/packages/dsh-llm-fallback  # in-repo development (link: must be absolute)
```

For the full install options (npm / link / git / tarball), `allowBuilds` approval, and install verification, see [packages/dsh-llm-fallback/README.md](./packages/dsh-llm-fallback/README.md).

> **Note when adding a TS-source-entry plugin**: a TS source entry (`main: "src/index.ts"`) only supports a local `link:` install **with an absolute path** — a relative `link:` path is resolved by pnpm against the profile directory and always fails; git/npm/tarball entity installs are rejected by Node with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Entity installs require a dist entry (esbuild bundle) like dsh-llm-fallback.

## Development

```sh
pnpm install        # install deps and run lefthook install automatically; also triggers llm-fallback's prepare to build dist
pnpm lint           # ESLint (flat config, TS)
pnpm format         # Prettier write (format:check validates only)
pnpm typecheck      # per-package tsc --noEmit
pnpm test           # Vitest across all src/**/*.test.ts
```

- **Build-based distribution**: `@zhidal/dsh-llm-fallback`'s `main` points at the esbuild-bundled `dist/index.js` (rebuild alone with `pnpm --filter @zhidal/dsh-llm-fallback build`) — the only viable entry scheme while the host Node refuses type-stripping for `.ts` files under node_modules;
- **E2E**: no dedicated script — follow the manual CLI flow in [.agents/skills/dsh-plugin-dev/SKILL.md](./.agents/skills/dsh-plugin-dev/SKILL.md) §5: boot a real dsh instance under a dedicated profile (default `test`, auto-bootstrapped from the official web template when missing); the plugin list is isolated per profile while `DSH_HOME` stays the global `~/.dsh` (model credentials are shared); assert the `[dsh-llm-fallback] plugin loaded` log, port reachability, and tokened URL page health; `plugin remove` afterwards;
- **Adding a plugin**: create `packages/<name>/` modeled on `packages/dsh-llm-fallback/package.json`; `pnpm-workspace.yaml` picks it up automatically; keep `@deepseek-ai/cordis` in `devDependencies` with `import type` only (the framework is provided by the host at runtime);
- **Versioning & release**: Changesets (`pnpm changeset` → `changeset:version`) plus the `{shortName}-v{X.Y.Z}` git tag that triggers the npm release pipeline — see [.changeset/README.md](./.changeset/README.md) and [scripts/release/README.md](./scripts/release/README.md);
- **Commits**: Chinese Conventional Commits; develop on `feat/*` / `fix/*` branches merged into `dev`, then into `main` after verification.
- **CI**: a GitHub Actions pipeline ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on push / PR targeting `main` and `dev`, executing the same `format:check → lint → typecheck → test` gate chain as local development on Ubuntu with Node 22 / 24; [tests/ci-workflow.test.ts](tests/ci-workflow.test.ts) is a regression test for the pipeline itself, guarding the scripts it invokes, the gate order, and pinned action versions. E2E and npm publishing are out of CI scope (the former needs a real dsh instance and credentials, the latter publish authorization).

## License

MIT
