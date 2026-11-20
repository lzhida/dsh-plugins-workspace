/**
 * README 一致性防回归测试。
 *
 * README 随包交付（`package.json` `files` 白名单），承载安装命令、默认配置
 * 值、装载日志行、meta 字段名等用户可直接依赖的事实。本测试把这些事实与
 * 代码常量互相锚定：改实现忘改文档（或文档误删关键信息）时在此处变红，
 * 防止文档与行为漂移。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
} from './core/config.ts';
import {
  ASK_USER_QUESTION_TOOL,
  name as askGateName,
} from './entries/ask-gate.ts';
import { DECISION_AUTO_ANSWER_PREFIX } from './services/ask-gate.ts';

const readme = readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);

describe('dsh-decision README', () => {
  it('保留开源 README 必备章节（特性 / 工作原理 / 安装 / 配置 / 许可证）', () => {
    for (const section of [
      '## 特性',
      '## 工作原理',
      '## 安装',
      '## 配置',
      '## 许可证',
    ]) {
      expect(readme).toContain(section);
    }
  });

  it('目录锚点与实际章节一致', () => {
    for (const anchor of [
      '#特性',
      '#工作原理',
      '#安装',
      '#配置',
      '#组合包扩展约定',
      '#轨迹可见性',
      '#已知限制',
      '#故障排查',
      '#开发',
    ]) {
      expect(readme).toContain(anchor);
    }
  });

  it('安装命令与包名一致（link 安装 + 绝对路径提示）', () => {
    expect(readme).toContain(
      'dsh plugin add link:<仓库绝对路径>/plugins/dsh-decision',
    );
    expect(readme).toContain('link: 必须是绝对路径');
    // 本包是私有包 + TS 源码入口，只能 link: 安装——文档必须写清边界。
    expect(readme).toContain('只支持 `link:` 安装');
    expect(readme).toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
  });

  it('包含 e2e 契约装载日志行与工具注册行', () => {
    expect(readme).toContain(`[${askGateName}] plugin loaded`);
    expect(readme).toContain(
      `[${askGateName}] registered 1 tool (${ASK_USER_QUESTION_TOOL})`,
    );
  });

  it('让位样例与包内 patch 一致（出厂 tool-ask-user 停用）', () => {
    expect(readme).toContain('- id: tool-ask-user');
    expect(readme).toContain('disabled: true');
    // 让位按 profile 生效，README 必须写明「每个想启用的 profile 重复该步骤」
    expect(readme).toContain('每个装了本包的 profile 都自动让位');
    expect(readme).toContain('每个想启用的 profile');
  });

  it('配置字段表列出全部五个可编辑字段', () => {
    for (const field of [
      '`enabled`',
      '`decisionProvider`',
      '`decisionModel`',
      '`confidenceThreshold`',
      '`decisionTimeoutMs`',
    ]) {
      expect(readme).toContain(field);
    }
  });

  it('默认配置值与代码一致（阈值 / 超时 / 总开关）', () => {
    expect(readme).toContain(`\`${DEFAULT_CONFIDENCE_THRESHOLD}\``);
    expect(readme).toContain(`\`${DEFAULT_DECISION_TIMEOUT_MS}\``);
    // 总开关默认关闭：README 表格里的默认值必须是 false
    expect(readme).toContain('| `enabled`');
    expect(readme).toMatch(/\|\s*`enabled`\s*\|\s*`boolean`\s*\|\s*`false`/);
    // 阈值与超时的取值范围与 schema 一致
    // 锚点必须能区分「区间下界 0.05」与「步进 0.05」，否则改文案不会让测试变红
    expect(readme).toMatch(/0\.05\s*~\s*1/);
    expect(readme).toContain('120000');
  });

  it('README 列出的宿主错误码与实际透传语义一致', () => {
    for (const code of [
      'ASK_ABORTED',
      'EMPTY_QUESTIONS',
      'CALLER_NOT_LIVE',
      'DELEGATED_CALLER',
      'BAD_INTENT',
      'NO_PROVIDER',
    ]) {
      expect(readme).toContain(code);
    }
  });

  it('门控流程写清判定优先级与 fail-open 方向', () => {
    expect(readme).toContain('## 工作原理');
    // ≥ 阈值自动作答 / < 阈值放行（边界值相等归自动）
    expect(readme).toContain('**≥ 阈值**');
    expect(readme).toContain('**< 阈值**');
    expect(readme).toContain('边界值相等归自动作答');
    // 一切降级都放行——门控不得阻断用户被问到的机会
    expect(readme).toContain('fail-open');
    expect(readme).toContain('放行真实提问');
  });

  it('meta 字段名与代码事实互锚', () => {
    expect(readme).toContain('## 轨迹可见性');
    expect(readme).toContain('presentationMeta');
    expect(readme).toContain('`presentationMeta.confidence`');
    expect(readme).toContain('`presentationMeta.decision`');
    expect(readme).toContain('`presentationMeta.rationale`');
    expect(readme).toContain('`auto-answered`');
    expect(readme).toContain('`passed-through`');
    // 降级信号名与代码六分支一致
    for (const kind of [
      'route-not-configured',
      'model-error',
      'timeout',
      'aborted',
      'llm-unavailable',
      'route-invalid',
    ]) {
      expect(readme).toContain(kind);
    }
    expect(readme).toContain('answers-incomplete: ');
  });

  it('自动作答标注前缀与代码常量一致', () => {
    expect(readme).toContain(DECISION_AUTO_ANSWER_PREFIX);
  });

  it('组合包扩展约定写清新增成员步骤与命名规则', () => {
    expect(readme).toContain('## 组合包扩展约定');
    expect(readme).toContain('<决策点>-gate');
    expect(readme).toContain('src/entries/<决策点>-gate.ts');
    expect(readme).toContain('volatileField()');
    expect(readme).toContain('desc(en, zh)');
    // 让位规则对新增成员同样适用
    expect(readme).toContain('接管别的工具名时要一并让位');
  });

  it('已知限制显著写明三条边界（timed 模式 / 误答风险 / 不受 llm-fallback 保护）', () => {
    expect(readme).toContain('## 已知限制');
    // ① 只覆盖 legacy 模式
    expect(readme).toContain('只覆盖 legacy 模式');
    expect(readme).toContain('timed 模式');
    // ② 误答风险与控制手段
    expect(readme).toContain('决策模型有误答风险');
    expect(readme).toContain('confidenceThreshold');
    expect(readme).toContain('enabled');
    // ③ 决策调用是纯旁路，不受 dsh-llm-fallback 保护
    expect(readme).toContain('不受 `dsh-llm-fallback` 保护');
    expect(readme).toContain('纯旁路');
  });

  it('故障排查覆盖典型症状（不自动作答 / 重复注册 / 解析失败）', () => {
    expect(readme).toContain('## 故障排查');
    // 三条日志出口都要写进文档：自动作答 / 低于阈值（非故障）/ 真正降级
    expect(readme).toContain('decision degraded');
    expect(readme).toContain('decision below threshold');
    expect(readme).toContain('decision auto-answered');
    expect(readme).toContain('重复注册');
    expect(readme).toContain('按 id 覆盖全部问题');
  });

  it('配置存储落点写明 profile 补丁层与热生效边界', () => {
    expect(readme).toContain('~/.dsh/profiles/<profile>/cordis.patch.yml');
    expect(readme).toContain('- id: ask-gate');
    expect(readme).toContain('per-profile');
    expect(readme).toContain('重启宿主后保留');
    expect(readme).toContain('不引入任何自有配置文件或数据目录');
    // HMR 与重启之分（不得笼统写"需重启"）
    expect(readme).toContain('开启 HMR 的 profile');
    expect(readme).toContain('关掉 HMR 的 profile');
  });

  it('开发章节指向契约测试文件（改实现忘改文档会变红）', () => {
    expect(readme).toContain('## 开发');
    expect(readme).toContain('src/manifest.test.ts');
    expect(readme).toContain('src/readme.test.ts');
  });

  it('不残留旧包名 @lzhida/dsh-decision', () => {
    expect(readme.includes('@lzhida/dsh-decision')).toBe(false);
  });
});
