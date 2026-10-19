/**
 * 连接诊断组：anytype_whoami。
 *
 * `GET /v2/auth/whoami` —— 密钥身份/权限/空间授权概览，Anytype 工具链的
 * 诊断第一站：401（key 失效）、403（scope 不足）、连接失败等配置问题的
 * 最短验证路径。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { outputSpec, runRequest, type ToolDeps } from './shared.ts';

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
  ];
}
