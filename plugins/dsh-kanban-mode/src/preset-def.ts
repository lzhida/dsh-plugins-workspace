/**
 * 「看板模式」预设定义。
 *
 * 形态：逐行复刻 DSH 官方 standard 预设（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`，
 * 本机版本 0.2.2-rc.5）的 `config.plugins` 行集，末尾追加一行看板上下文入口。
 *
 * 复刻口径（跟版策略见 docs/standard-preset-replica.md）：
 *   - 行 id、行名、行内 config 逐行照抄官方 standard；persona 的 prefix 换成看板
 *     定位文案并保留 `{{model}}` 占位符；
 *   - planning / compaction / delegation 三个 `cordis:group` 的 group / isolate /
 *     config 结构原样保留——isolate 是「预设子树的 service 不能发布到 root realm」
 *     这条硬约束的唯一解法（否则整份预设以
 *     `Preset services require isolate realms: ...` 失败）；
 *   - 声明式 YAML 的 `!!js <expr>` 在编程式注册里用 `{ __jsExpr: '<expr>' }` 表达，
 *     语义一致（loader 的 Entry._resolveDisabled 与 internal/config 插值都认这个节点）；
 *   - delegation 组内**追加**两行官方 `dsh-tool-subagent` 实例（provider:
 *     codex / claude-code），这是本预设对官方 standard 的扩展而非复刻偏差：
 *     只挂工具行、绝不挂 provider 行——提供方插件装在宿主 profile 层（用户自行
 *     安装），未安装时这两行按官方「提供方存在才注册、离开即释放」的语义静默
 *     不挂载、不算失败，预设其余部分零影响（启用步骤与限制见 docs/official-subagent.md）。
 *
 * 硬红线：行集内**绝不出现**指向 dsh-taskboard 的行。宿主根层已经注册了
 * `taskboard_*` 工具，预设里再挂同一个插件会在该作用域再注册一套同名工具，
 * 遮蔽根层工具，并额外实例化第二套 SchedulerService → 定时卡被重复执行。
 *
 * @module dsh-kanban-mode/preset-def
 */

/** 预设 id（注册表唯一键；重复注册会抛 `Duplicate agent preset: <id>`）。 */
export const KANBAN_PRESET_ID = 'kanban-mode';

/** 预设显示名。 */
export const KANBAN_PRESET_NAME = '看板模式';

/** 预设排序（官方 standard = 1，本预设排在其后）。 */
export const KANBAN_PRESET_ORDER = 2;

/** 看板上下文入口行的插件名——必须是**包名**（相对路径在 preset 内会 never started）。 */
export const BOARD_CONTEXT_ENTRY_NAME = '@zhidal/dsh-kanban-mode/board-context';

/** 看板上下文入口行在行集里的行 id。 */
export const BOARD_CONTEXT_ROW_ID = 'kanban-board-context';

/** 预设描述（会出现在 Web 新建会话的预设选择器里）。 */
export const KANBAN_PRESET_DESCRIPTION =
  '看板模式：以 DSH 任务看板为唯一台账的工作方式——先查板、先读后动、先认领；复杂需求先拆卡并经用户确认再落卡；有真实依赖用 blockedBy 落门禁，被前置阻塞就停下等；自验后提交执行报告与评论并置为待验收，完成永远由用户确认。';

/** 预设行（与宿主 loader 的行选项同形，字段宽松以便承载 group / isolate）。 */
export interface PresetPluginRow {
  /** 行 id（官方 standard 每行都有；用于同 id + config 覆盖）。 */
  id?: string;
  /** 行插件名（包名或宿主内置插件名）。 */
  name: string;
  /** 行配置（任意深度都支持 `{ __jsExpr }` 节点）。 */
  config?: unknown;
  /** 行禁用状态（`true` / `{ __jsExpr }`）。 */
  disabled?: unknown;
  /** 是否是承载子树的 group 行。 */
  group?: boolean;
  /** group 行的服务隔离域。 */
  isolate?: Record<string, boolean>;
}

/** 预设定义（宿主 `ctx.agentPresets.register()` 的入参形状）。 */
export interface PresetDefinition {
  id: string;
  name: string;
  description: string;
  order: number;
  plugins: PresetPluginRow[];
}

/**
 * 声明式 YAML `!!js <expr>` 的编程式形态。
 *
 * 宿主 loader（`@deepseek-ai/cordis-plugin-loader`）用 `__jsExpr` 节点承载
 * `!!js` 表达式：`Entry._resolveDisabled` 求值 disabled 节点，插件挂载时的
 * `internal/config` 钩子对 config 做递归插值（任意深度）。
 * @param expression - 在 loader 上下文里求值的 JS 表达式（`ctx` 作用域，含 baseUrl）。
 * @returns `__jsExpr` 节点。
 */
function jsExpr(expression: string): { __jsExpr: string } {
  return { __jsExpr: expression };
}

/**
 * 官方 standard 预设的 plan-mode 段落文案（逐字复刻，含换行）。
 *
 * 这段文案属于官方预设的一部分：它规定了计划阶段「只读不写」「exit_plan_mode
 * 必须是最后一次工具调用」等纪律，改写它等于改写 standard 的语义。
 */
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;

/**
 * 看板定位的人设前缀。
 *
 * 与官方 standard 的 `persona.prefix` 同形，只换定位文案；`{{model}}` 占位符保留
 * （宿主在提示装配时插值模型名）。
 */
const KANBAN_PERSONA_PREFIX = `You are a coding agent powered by the {{model}} model, working in 看板模式 (kanban mode): DSH 任务看板（taskboard_* 工具）是唯一台账。开工先查板、先读后动、先认领；复杂需求先拆成多卡，拆分表经用户确认后再落卡；一张卡只做一个可独立验收的功能点；有真实先后依赖时用 blockedBy 落机器门禁，被前置阻塞的卡必须停下等待前置完成；实现后自验、提交执行报告与评论、置为待验收——任务永不自行置完成，完成由用户确认。全部交流与代码注释用中文。`;

/**
 * 官方 standard 预设的行集（逐行复刻）。
 *
 * 每次调用返回全新对象，避免调用方改行时污染共享常量。
 * @returns standard 行集的副本（23 行）。
 */
export function standardPluginRows(): PresetPluginRow[] {
  return [
    // 人设：看板模式的定位（保留 {{model}} 占位符）。
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: KANBAN_PERSONA_PREFIX },
    },
    // 工作区指令与时间上下文。
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    // shell（平台开关照抄官方 standard）。
    {
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      disabled: jsExpr("process.platform === 'win32'"),
    },
    {
      id: 'tool-pwsh',
      name: '@deepseek-ai/dsh-tool-pwsh',
      disabled: jsExpr("process.platform !== 'win32'"),
    },
    // 文件读写与检索。
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: {
        // Set false to drop the apply_patch tool beside edit.
        applyPatch: false,
      },
    },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    // 后台作业与定时任务。
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    // skill 链：文件系统 skill 目录（官方 standard 的 customSkillDirs 指向
    // dsh-agent-preset 自带的 skills 目录）。
    {
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: {
        customSkillDirs: [
          jsExpr(
            "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')",
          ),
        ],
      },
    },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    // 目标管理。
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    // 计划模式组（服务隔离域：planMode 不得发布到 root realm）。
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: { section: PLAN_MODE_SECTION },
        },
      ],
    },
    // 上下文压缩组（服务隔离域：compaction / toolResultPruner）。
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        {
          id: 'compaction-basic',
          name: '@deepseek-ai/dsh-compaction-basic',
        },
        {
          id: 'command-compact',
          name: '@deepseek-ai/dsh-command-compact',
        },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: {
            thresholdChars: 8192,
            headChars: 4096,
            tailChars: 1024,
          },
        },
      ],
    },
    // 委派组（服务隔离域：workflowEngine）。
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        {
          id: 'tool-subagent-control',
          name: '@deepseek-ai/dsh-tool-subagent-control',
          config: { interrupt: false },
        },
        {
          id: 'tool-subagent',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelection: true,
            modelDiscovery: true,
          },
        },
        {
          id: 'tool-subagent-fork',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork' },
        },
        // 官方进程外提供方（可选增强）：codex / claude-code。提供方插件由用户
        // 装在宿主 profile 层（绝不在此挂 provider 行——与宿主重复注册会抛
        // DUPLICATE_PROVIDER；未安装时挂 provider 行则整份预设加载失败）。
        // 本行集只挂工具行，吃官方语义兜底：提供方不存在 → 工具不注册、
        // 不算挂载失败（tool-subagent 0.2.2-rc.5 src/index.ts:189-193）；提供方
        // 存在 → 工具自动出现。maxDepth 必须显式 'provider-managed'：进程外
        // 提供方没有 depthLimit 能力，数值上限（含 Host 默认 1）会让挂载失败；
        // 不设 disabled（官方配方里的 disabled:true 是「复制 preset 后人工删除
        // 才暴露」的保守默认，与本预设「装了即自动可用」的目标相反）；不设
        // modelSelection / modelDiscovery / agentOptions（进程外提供方缺这些
        // 能力，配了同样挂载失败）。官方 README 配方中的 enableRunInBackground
        // 键在 0.2.2-rc.5 的 Config schema 里不存在（全包零命中），故省略。
        // 启用步骤与限制清单见 docs/official-subagent.md。
        {
          id: 'tool-subagent-codex',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'codex',
            toolName: 'subagent_codex',
            maxDepth: 'provider-managed',
          },
        },
        {
          id: 'tool-subagent-claude-code',
          name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'claude-code',
            toolName: 'subagent_claude_code',
            maxDepth: 'provider-managed',
          },
        },
        {
          id: 'workflow-ptc',
          name: '@deepseek-ai/dsh-workflow-ptc',
          config: { provider: 'spawn' },
        },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      ],
    },
    // 交互与任务跟踪。
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    },
    // 联网检索与交付。
    {
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
    // 插件管理（官方 standard 在没有 profileContext 时禁用；官方插件市场始终禁用）。
    {
      id: 'tool-plugin-manager',
      name: '@deepseek-ai/dsh-plugin-manager/tools',
      disabled: jsExpr("!ctx.get('profileContext')"),
    },
    {
      id: 'tool-plugin-market',
      name: '@deepseek-ai/dsh-plugin-market/tools',
      disabled: true,
    },
  ];
}

/**
 * 构造「看板模式」预设定义。
 *
 * 行集 = 官方 standard 行集（逐行复刻）+ 末尾一行看板上下文入口。
 * @returns 可直接交给 `ctx.agentPresets.register()` 的预设定义。
 */
export function buildKanbanPresetConfig(): PresetDefinition {
  return {
    id: KANBAN_PRESET_ID,
    name: KANBAN_PRESET_NAME,
    description: KANBAN_PRESET_DESCRIPTION,
    order: KANBAN_PRESET_ORDER,
    plugins: [
      ...standardPluginRows(),
      {
        id: BOARD_CONTEXT_ROW_ID,
        name: BOARD_CONTEXT_ENTRY_NAME,
      },
    ],
  };
}
