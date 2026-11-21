/**
 * 面板 API 错误分类与超时常量契约。
 *
 * classifyPanelError 是「发起失败三类可读提示」的分流器（系列 4/6）：
 * 504/超时文案 → upstream-timeout；502/连接文案 → upstream-unavailable；
 * 其余原样展示。TIMEOUTS 与宿主路由 UPSTREAM_TIMEOUTS 的「+5s 余量」
 * 关系在此互锚，防止单侧改动后前端先于后端超时。
 *
 * @module dsh-open-design/api-errors
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyPanelError, PanelRequestError, TIMEOUTS } from './api.ts';

/**
 * 从宿主半区源码提取 UPSTREAM_TIMEOUTS（文本互锚：client 测试不跨根
 * import 服务端模块——vitest 会重写该层相对路径——直接按 cwd 定位文件
 * 解析常量表；本仓 vitest 约定从仓库根跑）。
 */
function readHostTimeouts(): Record<string, number> {
  const candidates = [
    resolve(process.cwd(), 'plugins/dsh-open-design/src/status-routes.ts'),
    resolve(process.cwd(), 'src/status-routes.ts'),
  ];
  const hostPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
  const text = readFileSync(hostPath, 'utf8');
  const start = text.indexOf('UPSTREAM_TIMEOUTS = {');
  const end = text.indexOf('} as const', start);
  const section = text.slice(start, end);
  const out: Record<string, number> = {};
  for (const match of section.matchAll(/(\w+):\s*([\d_]+),/g)) {
    out[match[1]] = Number(match[2].replaceAll('_', ''));
  }
  return out;
}

describe('dsh-open-design', () => {
  it('504 与超时类文案归类为 upstream-timeout', () => {
    expect(
      classifyPanelError(
        new PanelRequestError('上游 start_run 超时（45000ms）', 504),
      ),
    ).toBe('upstream-timeout');
    expect(classifyPanelError(new Error('signal timed out'))).toBe(
      'upstream-timeout',
    );
  });

  it('502 与连接类文案归类为 upstream-unavailable', () => {
    expect(classifyPanelError(new PanelRequestError('上游调用失败', 502))).toBe(
      'upstream-unavailable',
    );
    expect(
      classifyPanelError(new Error('MCP 连接不可用：请确认已安装 Open Design')),
    ).toBe('upstream-unavailable');
  });

  it('其它错误保持 unknown（原样展示）', () => {
    expect(
      classifyPanelError(new PanelRequestError('prompt 不能为空', 400)),
    ).toBe('unknown');
    expect(classifyPanelError(new Error('Unexpected token < in JSON'))).toBe(
      'unknown',
    );
  });

  it('客户端超时一律大于宿主路由上游超时（后端先回 504）', () => {
    const host = readHostTimeouts();
    expect(Object.keys(host)).toEqual(
      expect.arrayContaining([
        'projects',
        'focus',
        'skills',
        'agents',
        'plugins',
        'run',
        'startRun',
        'cancelRun',
      ]),
    );
    expect(TIMEOUTS.projects).toBeGreaterThan(host.projects);
    expect(TIMEOUTS.focus).toBeGreaterThan(host.focus);
    expect(TIMEOUTS.skills).toBeGreaterThan(host.skills);
    expect(TIMEOUTS.agents).toBeGreaterThan(host.agents);
    expect(TIMEOUTS.plugins).toBeGreaterThan(host.plugins);
    expect(TIMEOUTS.run).toBeGreaterThan(host.run);
    expect(TIMEOUTS.startRun).toBeGreaterThan(host.startRun);
    expect(TIMEOUTS.cancelRun).toBeGreaterThan(host.cancelRun);
  });
});
