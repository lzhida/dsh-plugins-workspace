/**
 * README 一致性防回归测试。
 *
 * README 随包发布(package.json `files` 白名单),承载安装命令、默认配置值
 * 与失败码白名单等用户可直接执行 / 依赖的事实。本测试把这些事实与代码互相
 * 锚定:改实现忘改文档(或文档误删关键信息)时在此处变红,防止文档与行为漂移。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RETRYABLE_CODES } from './config.ts';

const readme = readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);

describe('dsh-llm-fallback README', () => {
  it('不存在旧包名 @lzhida/dsh-llm-fallback 残留', () => {
    expect(readme.includes('@lzhida/dsh-llm-fallback')).toBe(false);
  });

  it('保留开源 README 必备章节(特性 / 安装 / 配置 / 许可证)', () => {
    for (const section of ['## 特性', '## 安装', '## 配置', '## 许可证']) {
      expect(readme).toContain(section);
    }
  });

  it('npm 安装命令与包名一致', () => {
    expect(readme).toContain('dsh plugin add @zhidal/dsh-llm-fallback');
  });

  it('包含 e2e 契约装载日志行 `[dsh-llm-fallback] plugin loaded`', () => {
    expect(readme).toContain('[dsh-llm-fallback] plugin loaded');
  });

  it('失败码白名单覆盖 DEFAULT_RETRYABLE_CODES 全部默认码', () => {
    for (const code of DEFAULT_RETRYABLE_CODES) {
      expect(readme).toContain(code);
    }
  });

  it('默认配置值与代码一致(maxRetries 0=链长 / 退避 500-30000ms / afterRetry)', () => {
    expect(readme).toContain("'afterRetry'");
    expect(readme).toContain('`0`（= 链长');
    expect(readme).toContain('`500`');
    expect(readme).toContain('`30000`');
  });

  it('已按开源 README 结构收敛:不再包含版本历史 / 适配版本内部表', () => {
    expect(readme).not.toContain('## 版本历史');
    expect(readme).not.toContain('## 适配版本');
    expect(readme).not.toContain('宿主上游问题');
  });
});
