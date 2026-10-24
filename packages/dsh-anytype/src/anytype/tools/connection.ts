/**
 * 连接诊断组：anytype_whoami + anytype_status。
 *
 * - `GET /v2/auth/whoami` —— 密钥身份/权限/空间授权概览，Anytype 工具链的
 *   诊断第一站：401（key 失效）、403（scope 不足）、连接失败等配置问题的
 *   最短验证路径；
 * - `anytype_status` —— 桌面端后端（31009）实时探测：配置/可达/鉴权态。
 *   连接失败时的标准诊断入口。
 */

import {
  outputSpec,
  runRequest,
  toToolValue,
  type ToolDeps,
} from '../../core/index.ts';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 构建连接诊断组工具。 */
export function buildConnectionTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'anytype_whoami',
      description:
        'Show the current Anytype API key details: key name, scope, grant (permission, spaces access) and API version. Call this first to verify the Anytype connection and key validity.',
      parameters: {},
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return runRequest(deps, exec, 'GET', '/v2/auth/whoami');
      },
    }),
    defineTool({
      name: 'anytype_status',
      description:
        'Diagnose the Anytype desktop backend (port 31009): configuration, reachability and authentication of the local API. Use this FIRST when any anytype_* tool fails with a connection error — it distinguishes "app not running" from "key invalid".',
      parameters: {},
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const cfg = deps.config();
        const probe = await deps.client.probeDesktop(exec.signal);
        const data = {
          url: cfg.baseUrl,
          configured: probe.configured,
          reachable: probe.reachable,
          authenticated: probe.authenticated,
          error: probe.error ?? null,
          note: 'desktop is detection-only — start the Anytype desktop app yourself',
        };
        return toToolValue({ status: 200, data }, cfg.maxResponseChars);
      },
    }),
  ];
}
