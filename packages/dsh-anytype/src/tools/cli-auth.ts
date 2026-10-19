/**
 * CLI 账户工具组：anytype_cli_login / anytype_cli_create。
 *
 * 操作对象是本机 anytype-cli 实例的 **bot 账户**（独立数据面）：
 * - 全部参数读自插件配置（cliAccountKey/cliAccountName/cliNetworkConfig/
 *   cliListenAddress），账户 key 经 stdin 传入——不进命令行、不进会话轨迹；
 * - create 会在本机生成数据目录并将凭证存入系统 keyring（属真实状态变更，
 *   账户名即辨识标记）；login 不删除任何数据；
 * - 刻意不提供 logout / apikey revoke 等破坏性工具（用户主权动作）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { AnytypeToolValue, JsonValue } from '../client.ts';
import { toToolValue } from '../client.ts';
import type { CliLauncher } from '../launcher.ts';
import { outputSpec, type ToolDeps } from './shared.ts';

/** 把机读 result 的账户字段收敛为无损 JSON（来源 JSON.parse，断言安全）。 */
function asJsonValue(
  value: Record<string, unknown> | null | undefined,
): JsonValue {
  return (value ?? null) as JsonValue;
}

/**
 * login/create 是 RPC 变更操作，需要活着的本地节点承接——
 * 不可达就先 serve 拉起（detached，独立存活）。失败时返回可操作错误值。
 */
async function ensureNode(
  launcher: CliLauncher,
  maxResponseChars: number,
): Promise<AnytypeToolValue | undefined> {
  const node = await launcher.serveStart();
  if (node === 'started' || node === 'already-running') return undefined;
  const message =
    node === 'bin-not-found'
      ? 'anytype-cli binary not found (cliPath). Install it: https://github.com/anyproto/anytype-cli'
      : 'Could not bring up the local anytype node (`anytype serve`) before this operation. Check `anytype service status` output.';
  return toToolValue(
    {
      status: 400,
      data: {
        ok: false,
        state: `node-${node}`,
        account: null,
        error_message: message,
      },
      backend: 'cli',
    },
    maxResponseChars,
  );
}

/** 构建CLI 账户工具组。 */
export function buildCliAuthTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_cli_login',
      description:
        'Log in to the local anytype-cli bot account using the account key configured in the plugin setting cliAccountKey (fed via stdin). Auto-starts the local node (`anytype serve`) if it is not running. Use when anytype_status reports cli authenticated=false — e.g. on a fresh CLI instance after `anytype auth create`, or after switching data paths. Non-destructive.',
      parameters: {},
      output: outputSpec(),
      async execute() {
        const cfg = deps.config();
        const nodeError = await ensureNode(deps.launcher, cfg.maxResponseChars);
        if (nodeError !== undefined) return nodeError;
        const result = await deps.launcher.login();
        return toToolValue(
          {
            status: result.ok ? 200 : 400,
            data: {
              ok: result.ok,
              state: result.state,
              account: asJsonValue(result.account),
              error_code: result.errorCode ?? null,
              error_message: result.errorMessage ?? null,
            },
            backend: 'cli',
          },
          cfg.maxResponseChars,
        );
      },
    }),
    defineTool({
      name: 'anytype_cli_create',
      description:
        'Create a new anytype-cli bot account with the name configured in the plugin setting cliAccountName (required). Auto-starts the local node (`anytype serve`) if it is not running. REAL side effect on this machine: generates the account, creates its local data directory and stores credentials in the system keyring. The account is separate from the desktop app; join spaces via invite links afterwards. Non-destructive (creates only).',
      parameters: {},
      output: outputSpec(),
      async execute() {
        const cfg = deps.config();
        const nodeError = await ensureNode(deps.launcher, cfg.maxResponseChars);
        if (nodeError !== undefined) return nodeError;
        const result = await deps.launcher.create();
        return toToolValue(
          {
            status: result.ok ? 200 : 400,
            data: {
              ok: result.ok,
              state: result.state,
              account: asJsonValue(result.account),
              error_code: result.errorCode ?? null,
              error_message: result.errorMessage ?? null,
            },
            backend: 'cli',
          },
          cfg.maxResponseChars,
        );
      },
    }),
  ];
}
