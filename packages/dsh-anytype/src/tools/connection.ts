/**
 * 连接诊断组：anytype_whoami + anytype_status。
 *
 * - `GET /v2/auth/whoami` —— 密钥身份/权限/空间授权概览，Anytype 工具链的
 *   诊断第一站：401（key 失效）、403（scope 不足）、连接失败等配置问题的
 *   最短验证路径；
 * - `anytype_status` —— 双后端（桌面端 31009 / anytype-cli 31012）实时探测：
 *   可达性、鉴权态、CLI 安装与服务状态、当前生效后端。后端连不上时的
 *   标准诊断入口。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { toToolValue } from '../client.ts';
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
    defineTool({
      name: 'anytype_status',
      description:
        'Diagnose both Anytype backends: desktop app (port 31009) and anytype-cli (port 31012, separate bot-account data plane). Reports reachability, authentication, CLI install/service state, and which backend is currently effective. Use this FIRST when any anytype_* tool fails with a connection error.',
      parameters: {},
      output: outputSpec(),
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const cfg = deps.config();
        const probes = await deps.client.probeAll(exec.signal);
        const cliStatus = await deps.launcher.cliServiceStatus();
        const data = {
          backend_mode: cfg.backendMode,
          effective_backend: probes.effective,
          desktop: {
            url: probes.desktop.url,
            configured: probes.desktop.configured,
            reachable: probes.desktop.reachable,
            authenticated: probes.desktop.authenticated,
            error: probes.desktop.error ?? null,
            note: 'desktop is detection-only — start the Anytype desktop app yourself',
          },
          cli: {
            url: probes.cli.url,
            configured: probes.cli.configured,
            reachable: probes.cli.reachable,
            authenticated: probes.cli.authenticated,
            auto_start: cfg.cli.autoStart,
            bin_found: cliStatus.binFound,
            service_state: cliStatus.state,
            service_detail: cliStatus.detail,
            error: probes.cli.error ?? null,
          },
        };
        const backend = probes.effective === 'cli' ? 'cli' : 'desktop';
        return toToolValue(
          { status: 200, data, backend },
          cfg.maxResponseChars,
        );
      },
    }),
  ];
}
