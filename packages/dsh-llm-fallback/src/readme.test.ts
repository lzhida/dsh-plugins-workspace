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

  it('默认配置值与代码一致(retriesBeforeSwitch 0=跟随预算 / maxRetries 0=链长 / 退避 500-30000ms)', () => {
    expect(readme).toContain('`retriesBeforeSwitch`');
    expect(readme).toContain('`maxRetries`');
    expect(readme).toContain('`0`（= 链长');
    expect(readme).toContain('`500`');
    expect(readme).toContain('`30000`');
  });

  it('配置表不再包含旧回退时机配置 fallbackWhen(0.5.0 起改为每候选重试次数)', () => {
    // 0.5.0 移除 fallbackWhen(afterRetry/immediately 两档),配置面统一为
    // 数值化 retriesBeforeSwitch。配置表/配置值层面若再出现旧字段即为文档
    // 漂移(升级说明语境的"旧字段被忽略"提示除外)。
    expect(readme).not.toContain('| `fallbackWhen`');
    expect(readme).not.toContain("'afterRetry'");
  });

  it('每候选重试次数小节锚定核心语义(自动档跟随官方预算 / 自定义档以插件为准 / 代执行)', () => {
    expect(readme).toContain('## 每候选重试次数（retriesBeforeSwitch）');
    // 自定义档以插件配置为准,不再被 provider 预算封顶
    expect(readme).toContain('以插件为准');
    expect(readme).not.toContain('min(N, retryPolicy.maxRetries)');
    expect(readme).toContain('代执行');
    expect(readme).toContain('dsh-llm-retry');
  });

  it('轨迹可见性小节锚定官方事件通道(llm/retry / retry-started / policyKey)', () => {
    expect(readme).toContain('## 轨迹可见性');
    expect(readme).toContain('`llm/retry`');
    expect(readme).toContain('`llm/retry-started`');
    expect(readme).toContain('llm-fallback'); // policyKey
    // 文档必须说明这是官方已知事件类型,而非插件自创(ignorable 兼容机制)
    expect(readme).toContain('官方已知事件类型');
    // 轨迹编号契约:按 provider 建链、retry 链内连续(format v4 读侧校验),
    // 旧的"每 step 一个 retryId + 切换序号"编号会写出非法序列导致会话无法恢复
    expect(readme).toContain('按**失败 provider** 建链');
    expect(readme).toContain('从 1 起严格连续');
  });

  it('perTurn 已实装:配置表与行为段写明单次切换档,已知限制不再声称未实装', () => {
    // 0.5.x 曾是半成品字段(schema 声明、解析存在、状态机未读);实装后
    // 文档若再出现"预留/未实装"即为文档漂移。
    expect(readme).not.toContain('`perTurn` 尚未实装');
    expect(readme).not.toContain('尚未参与回退判定');
    expect(readme).toContain('至多切换一次');
  });

  it('step 状态表已知限制已更新:写明新 turn 清理与上界,不再声称无界', () => {
    expect(readme).not.toContain('严格意义上无上界');
    expect(readme).toContain('新 turn');
  });

  it('已按开源 README 结构收敛:不再包含版本历史 / 适配版本内部表', () => {
    expect(readme).not.toContain('## 版本历史');
    expect(readme).not.toContain('## 适配版本');
    expect(readme).not.toContain('宿主上游问题');
  });
});
