/**
 * Host loader entry for dsh-open-in-zed.
 *
 * Wiring: the `open_in_zed` agent tool, and the /dsh-open-in-zed JSON
 * routes (open / status / workspaces) when a webServer is served. Both
 * halves resolve targets through the workspace registry only — an
 * arbitrary filesystem path is never handed to the zed CLI.
 *
 * Export shape follows the dsh-tool-todo lesson: a function plugin —
 * `name` / `inject` / `apply`, NO default export.
 *
 * @module dsh-open-in-zed
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only module imports: they load the cordis Context augmentations
// (ctx.tools / ctx.webServer / ctx.workspaceRegistry) and vanish at
// compile time — the plugin keeps ZERO runtime @deepseek-ai imports.
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  registryFace,
  registerOpenInZedRoutes,
  type WorkspaceRegistryFace,
} from './host/routes.ts';
import { createOpenInZedTool } from './host/tools.ts';

/** Cordis plugin name. */
export const name = 'dsh-open-in-zed';

/** Required host services (tool registry + HTTP carrier + workspace registry). */
export const inject = ['tools', 'webServer', 'workspaceRegistry'];

/**
 * Mount the host half.
 * @param ctx - the plugin context (tools + webServer + workspaceRegistry injected).
 */
export function apply(ctx: Context): void {
  // 本仓库 e2e 契约（.agents/skills/dsh-plugin-dev §5.2）：apply 时打印
  // `[<name>] ` 前缀的结构化装载日志，供加载级断言匹配。
  console.log(`[${name}] plugin loaded`);

  // The registry comes and goes with the workspace service; the tool schema
  // mounts synchronously and resolves the live face on each call.
  let activeRegistry: WorkspaceRegistryFace | undefined;
  const requireRegistry = (): WorkspaceRegistryFace => {
    if (activeRegistry === undefined) {
      throw new Error(
        'workspace registry is not ready; retry after host startup completes',
      );
    }
    return activeRegistry;
  };

  ctx.effect(
    () =>
      ctx.tools.register(
        createOpenInZedTool({
          get registry(): WorkspaceRegistryFace {
            return requireRegistry();
          },
        }),
      ),
    'dsh-open-in-zed: tool',
  );

  ctx.inject(['workspaceRegistry'], (wsCtx: Context) => {
    const registry = registryFace(wsCtx.workspaceRegistry as WorkspaceRegistry);
    activeRegistry = registry;
    // Top-level `inject` already gates on webServer, so it is ready here.
    const disposeRoutes = registerOpenInZedRoutes(wsCtx, { registry });
    return () => {
      if (activeRegistry === registry) activeRegistry = undefined;
      disposeRoutes();
    };
  });
}
