import { describe, expect, it } from 'vitest';

import {
  BOARD_CONTEXT_ENTRY_NAME,
  BOARD_CONTEXT_ROW_ID,
  buildKanbanPresetConfig,
  KANBAN_PRESET_DESCRIPTION,
  KANBAN_PRESET_ID,
  KANBAN_PRESET_NAME,
  KANBAN_PRESET_ORDER,
  standardPluginRows,
  type PresetPluginRow,
} from './preset-def.ts';

/**
 * 官方 standard 预设的行 id 顺序（DSH 0.2.2-rc.5，
 * `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）。
 * 这份列表是「跟版探针」：上游增删行时本单测会失败，提示同步复刻。
 */
const STANDARD_ROW_IDS = [
  'persona',
  'agent-instructions',
  'time-context',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'tool-schedule',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'planning',
  'compaction',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
  'tool-office',
  'tool-plugin-manager',
  'tool-plugin-market',
];

/** 在行集里按行 id 取行。 */
function rowById(rows: PresetPluginRow[], id: string): PresetPluginRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`预设行集缺少 id=${id} 的行`);
  }
  return row;
}

describe('dsh-kanban-mode 预设定义', () => {
  it('预设的 id、名称、顺序与描述符合约定', () => {
    const preset = buildKanbanPresetConfig();
    expect(preset.id).toBe('kanban-mode');
    expect(preset.name).toBe('看板模式');
    expect(preset.order).toBe(2);
    expect(preset.order).toBeGreaterThan(1);
    expect(preset.description).toBe(KANBAN_PRESET_DESCRIPTION);
    expect(preset.description.length).toBeGreaterThan(0);
    expect(KANBAN_PRESET_ID).toBe('kanban-mode');
    expect(KANBAN_PRESET_NAME).toBe('看板模式');
    expect(KANBAN_PRESET_ORDER).toBe(2);
  });

  it('行集是 standard 复刻 23 行加末尾看板上下文行', () => {
    const rows = buildKanbanPresetConfig().plugins;
    expect(rows).toHaveLength(STANDARD_ROW_IDS.length + 1);
    expect(rows.map((row) => row.id)).toEqual([
      ...STANDARD_ROW_IDS,
      BOARD_CONTEXT_ROW_ID,
    ]);
    const last = rows[rows.length - 1]!;
    expect(last.name).toBe(BOARD_CONTEXT_ENTRY_NAME);
    expect(last.name).toBe('@zhidal/dsh-kanban-mode/board-context');
  });

  it('行集内不得出现指向 dsh-taskboard 的行', () => {
    const rows = buildKanbanPresetConfig().plugins;
    const offenders = rows.filter(
      (row) => /taskboard/i.test(row.id ?? '') || /taskboard/i.test(row.name),
    );
    expect(offenders).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain('@zhidal/dsh-taskboard');
    expect(JSON.stringify(rows)).not.toContain("'dsh-taskboard'");
  });

  it('delegation 组内行序锁定官方可选子代理两行的位置', () => {
    const rows = buildKanbanPresetConfig().plugins;
    const delegation = rowById(rows, 'delegation');
    expect(Array.isArray(delegation.config)).toBe(true);
    const inner = delegation.config as PresetPluginRow[];
    // 官方 standard 复刻 5 行 + 追加 2 行官方可选工具行（codex / claude-code，
    // 插在 fork 之后、workflow 两行之前，让同族委派实例彼此相邻）。
    expect(inner.map((row) => row.id)).toEqual([
      'tool-subagent-control',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-codex',
      'tool-subagent-claude-code',
      'workflow-ptc',
      'tool-workflow',
    ]);
  });

  it('官方可选子代理工具行形状正确且 toolName 互异', () => {
    const rows = buildKanbanPresetConfig().plugins;
    const delegation = rowById(rows, 'delegation');
    const inner = delegation.config as PresetPluginRow[];
    const codex = rowById(inner, 'tool-subagent-codex');
    const claudeCode = rowById(inner, 'tool-subagent-claude-code');
    // 同一个官方工具插件的两份实例：config 只声明 provider / toolName /
    // maxDepth，名字与官方 provider 注册名（'codex' / 'claude-code'）一致。
    expect(codex).toEqual({
      id: 'tool-subagent-codex',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: {
        provider: 'codex',
        toolName: 'subagent_codex',
        maxDepth: 'provider-managed',
      },
    });
    expect(claudeCode).toEqual({
      id: 'tool-subagent-claude-code',
      name: '@deepseek-ai/dsh-tool-subagent',
      config: {
        provider: 'claude-code',
        toolName: 'subagent_claude_code',
        maxDepth: 'provider-managed',
      },
    });
    // 不设 disabled：官方语义已保证提供方缺失时工具不挂载；显式 disabled
    // 反而会让「装了也不出现」，与本预设「装了即自动可用」的目标相反。
    expect(codex).not.toHaveProperty('disabled');
    expect(claudeCode).not.toHaveProperty('disabled');
    // maxDepth 必须显式 'provider-managed'：进程外提供方没有 depthLimit
    // 能力，数值上限（含 Host 默认 1）会让挂载失败（官方报错原文即建议该值）。
    expect((codex.config as { maxDepth: string }).maxDepth).toBe(
      'provider-managed',
    );
    expect((claudeCode.config as { maxDepth: string }).maxDepth).toBe(
      'provider-managed',
    );
    // 不设 modelSelection / modelDiscovery / agentOptions：进程外提供方缺
    // 这些能力，配了同样挂载失败。
    for (const row of [codex, claudeCode]) {
      const config = row.config as Record<string, unknown>;
      expect(config).not.toHaveProperty('modelSelection');
      expect(config).not.toHaveProperty('modelDiscovery');
      expect(config).not.toHaveProperty('agentOptions');
    }
    // 官方语义：每个委派实例的 toolName 必须不同——组内四个互异。
    const toolNames = inner
      .map((row) => (row.config as { toolName?: string } | undefined)?.toolName)
      .filter((name): name is string => typeof name === 'string');
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'subagent',
        'subagent_fork',
        'subagent_codex',
        'subagent_claude_code',
      ]),
    );
  });

  it('未安装官方提供方时预设组合零影响', () => {
    const rows = buildKanbanPresetConfig().plugins;
    // 全部行（含组内子行）。
    const allRows = rows.flatMap((row) =>
      Array.isArray(row.config)
        ? [row, ...(row.config as PresetPluginRow[])]
        : [row],
    );
    // 结构面①：绝不挂 provider 行。provider 行归宿主 profile 层——预设里
    // 再挂会与宿主重复注册（DUPLICATE_PROVIDER）；未安装时挂 provider 行
    // 则整份预设加载失败。「零影响」正是建立在「预设里根本没有 provider 行」。
    const providerNames = allRows
      .map((row) => row.name)
      .filter((name) => name.startsWith('@deepseek-ai/dsh-subagent-'));
    expect(providerNames).toEqual([]);
    // 结构面②③④已由形状测试锁定（无 disabled、maxDepth 为
    // 'provider-managed'、无进程外提供方不支持的能力键）。
    // 数据面：预设行集是纯数据——不携带凭证、不探测环境，构建结果与
    // 「装没装官方 provider」完全无关；未安装时这两行只是两个不会挂载的
    // 定义，其余行的形状与顺序分毫不变。
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
  });

  it('planning、compaction、delegation 三个组保留 isolate 结构', () => {
    const rows = buildKanbanPresetConfig().plugins;
    const planning = rowById(rows, 'planning');
    expect(planning.name).toBe('cordis:group');
    expect(planning.group).toBe(true);
    expect(planning.isolate).toEqual({ planMode: true });
    expect(Array.isArray(planning.config)).toBe(true);

    const compaction = rowById(rows, 'compaction');
    expect(compaction.group).toBe(true);
    expect(compaction.isolate).toEqual({
      compaction: true,
      toolResultPruner: true,
    });

    const delegation = rowById(rows, 'delegation');
    expect(delegation.group).toBe(true);
    expect(delegation.isolate).toEqual({ workflowEngine: true });
  });

  it('standard 里的平台开关用 __jsExpr 表达', () => {
    const rows = standardPluginRows();
    expect(rowById(rows, 'tool-bash').disabled).toEqual({
      __jsExpr: "process.platform === 'win32'",
    });
    expect(rowById(rows, 'tool-pwsh').disabled).toEqual({
      __jsExpr: "process.platform !== 'win32'",
    });
    expect(rowById(rows, 'tool-plugin-manager').disabled).toEqual({
      __jsExpr: "!ctx.get('profileContext')",
    });
    expect(rowById(rows, 'tool-plugin-market').disabled).toBe(true);
    // 第 4 处：skill-filesystem 的 customSkillDirs 指向官方 dsh-agent-preset
    // 自带 skills 目录（jsExpr 内含 baseUrl 相对解析，见 docs/standard-preset-replica.md）。
    const skillDirs = rowById(rows, 'skill-filesystem').config as {
      customSkillDirs: unknown;
    };
    expect(skillDirs.customSkillDirs).toHaveLength(1);
    const [skillDir] = skillDirs.customSkillDirs as [{ __jsExpr: string }];
    expect(skillDir.__jsExpr).toContain(
      "'@deepseek-ai/dsh-agent-preset/package.json'",
    );
    expect(skillDir.__jsExpr).toContain("'skills'");
  });

  it('人设前缀保留 {{model}} 占位符', () => {
    const rows = standardPluginRows();
    const persona = rowById(rows, 'persona');
    const config = persona.config as { prefix: string };
    expect(config.prefix).toContain('{{model}}');
    expect(config.prefix).toContain('看板模式');
  });

  it('每次取到的行集互不影响', () => {
    const first = standardPluginRows();
    first[0]!.id = 'mutated';
    expect(standardPluginRows()[0]!.id).toBe('persona');
  });
});
