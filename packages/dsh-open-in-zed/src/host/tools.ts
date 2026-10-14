/**
 * The `open_in_zed` agent tool: opens a REGISTERED workspace directory in
 * the Zed editor from an agent session. Returns structured results instead
 * of throwing, so the agent always receives an actionable message (unknown
 * id → the registry roster; missing binary → the install hint).
 *
 * @module dsh-open-in-zed/host/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-tools';
import { openInZed, ZED_ERROR_CODES, ZedError } from './zed.ts';
import {
  resolveOpenTarget,
  RouteError,
  type WorkspaceRegistryFace,
} from './routes.ts';

/** Tool result: a successful launch. */
export type OpenInZedOk = {
  opened: true;
  path: string;
  command: string[];
  workspace: { id: string; title: string };
};

/** Tool result: a classified failure with guidance. */
export type OpenInZedFail = {
  opened: false;
  code: string;
  message: string;
  /** Registry roster on target-resolution failures, so the agent can retry. */
  workspaces?: Array<{ id: string; title: string; path: string }>;
};

/** Either tool result shape. */
export type OpenInZedResult = OpenInZedOk | OpenInZedFail;

/** Tool dependencies (all injectable for tests). */
export interface OpenInZedToolOptions {
  registry: WorkspaceRegistryFace;
  /** Spawn runner override (tests); omitted → the real exec layer. */
  runner?: Parameters<typeof openInZed>[2];
  /** Explicit bin override (tests); production resolves from env. */
  bin?: string;
}

/**
 * Build the `open_in_zed` tool.
 * @param options - registry face plus optional test overrides.
 * @returns the defined tool ready for `ctx.tools.register`.
 */
export function createOpenInZedTool(options: OpenInZedToolOptions) {
  const JSON_OUT = { type: 'json' } as const;
  return defineTool({
    name: 'open_in_zed',
    description:
      'Open a registered DSH workspace directory in the Zed editor on the host machine. ' +
      'Address the workspace by id (preferred) or by its exact registered path; arbitrary ' +
      'paths are refused. Fails with guidance when Zed is not installed.',
    parameters: {
      workspaceId: {
        type: 'string',
        description:
          'Target workspace id (registry id). Omit when `path` is given.',
      },
      path: {
        type: 'string',
        description:
          'Absolute path that must own a registered workspace. Ignored when `workspaceId` is given.',
      },
      newWindow: {
        type: 'boolean',
        description:
          'Open a fresh Zed window instead of reusing the last one (default false).',
      },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as OpenInZedResult;
        if (result.opened) {
          return [
            {
              type: 'text',
              text: `已用 Zed 打开 ${result.workspace.title}（${result.path}）`,
            },
          ];
        }
        const roster =
          result.workspaces !== undefined && result.workspaces.length > 0
            ? ` 可用工作区: ${result.workspaces
                .map((w) => `${w.title}(${w.id})`)
                .slice(0, 10)
                .join(', ')}`
            : '';
        return [
          {
            type: 'text',
            text: `打开失败 [${result.code}]: ${result.message}${roster}`,
          },
        ];
      },
    },
    async execute(args: {
      workspaceId?: string;
      path?: string;
      newWindow?: boolean;
    }): Promise<OpenInZedResult> {
      try {
        const { workspace } = await resolveOpenTarget(
          {
            workspaceId: args.workspaceId,
            path: args.path,
            newWindow: args.newWindow,
          },
          options.registry,
        );
        const launch = await openInZed(
          workspace.path,
          {
            ...(options.bin !== undefined ? { bin: options.bin } : {}),
            ...(args.newWindow === true ? { newWindow: true } : {}),
          },
          options.runner,
        );
        return {
          opened: true,
          path: launch.path,
          command: [...launch.command],
          workspace: { id: workspace.id, title: workspace.title },
        };
      } catch (error) {
        if (error instanceof RouteError) {
          const withRoster =
            error.code === 'not_found' || error.code === 'forbidden'
              ? { workspaces: options.registry.list() }
              : {};
          return {
            opened: false,
            code: error.code,
            message: error.message,
            ...withRoster,
          };
        }
        if (error instanceof ZedError) {
          if (
            error.code === ZED_ERROR_CODES.notFound &&
            options.registry.list().length > 0
          ) {
            return {
              opened: false,
              code: error.code,
              message: error.message,
              workspaces: options.registry.list(),
            };
          }
          return { opened: false, code: error.code, message: error.message };
        }
        return {
          opened: false,
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
