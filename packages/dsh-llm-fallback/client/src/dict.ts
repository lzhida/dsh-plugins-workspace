/**
 * 配置卡文案字典（zh / en）。
 *
 * 经 plugin.apply 注册进宿主 locale 服务（命名空间 DICT_NS）：当前语言即
 * dsh 的语言配置（Host 偏好存于设置 namespace `locale` 字段 `preference`，
 * 缺省回退浏览器语言，再回退 `en`，与 dsh-client-locale 内置语言目录
 * LOCALE_IDS `['zh','en']` 对齐）。locale 服务缺失（组合未含
 * dsh-client-locale）时 plugin.apply 回退本表 en 字典的静态 t，配置卡
 * 降级可用、apply 不抛错。
 *
 * zh/en 键集一致性由 client-bundle.test.ts 断言（缺译 / 漏译防回归）。
 *
 * @module dsh-llm-fallback/client/dict
 */

/** 文案字典类型：两语言同键集。 */
export type Dict = Record<'zh' | 'en', Record<string, string>>;

export const DICT: Dict = {
  zh: {
    title: '模型回退',
    intro:
      '会话指定的模型失败时,自动按队列顺序切换到下一个模型(对话不中断)。本队列是纯回退候选,不含会话指定的模型。',
    enabled: '启用',
    enabledDesc: '关闭后不再拦截模型失败',
    queue: '回退队列(可上移/下移调整顺序)',
    queueEmpty: '尚未选择模型;请在下方勾选可用模型。',
    fallbackN: '回退',
    moveUp: '上移',
    moveDown: '下移',
    remove: '移除',
    stale: '已失效',
    staleHint:
      '该模型已不在宿主模型目录中(被删除或模型 id 变更),请求会失败;请移除或在下方目录重新勾选',
    clearStale: '清除失效项',
    clearStaleHint: '把所有已不在目录中的候选从队列移除(保存后生效)',
    queueEffort: '推理力度覆盖',
    queueEffortHint:
      '切换到该候选时随 select 写入的推理力度(adapter 自有力度 id,如 medium);留空沿用会话当前力度。候选不支持该 id 时请求报错并照常切下一候选',
    queueEffortPlaceholder: '力度(留空沿用)',
    queueMaxTokens: '输出上限覆盖',
    queueMaxTokensHint:
      '路由到该候选的请求单次输出上限(正整数 token);留空透传会话原值。超限会在请求期失败,是否切换取决于失败码是否在白名单',
    queueMaxTokensPlaceholder: '上限(留空透传)',
    catalog: '可用模型',
    catalogLoading: '正在加载模型目录…',
    catalogError: '模型目录加载失败',
    catalogRetry: '重试',
    catalogEmpty: '宿主尚未配置任何 provider 模型。',
    catalogHint: '勾选加入队列(追加到末尾)',
    catalogSearch: '搜索模型(provider / 模型 id / 名称)…',
    searchAria: '搜索模型',
    catalogNoMatch: '没有匹配的模型',
    maxRetries: '最多切换候选数',
    maxRetriesHint:
      '0 = 按队列长度(切完所有候选才报错);只限切换次数,同候选重试固定跟随官方重试预算(provider 重试策略,默认 5)',
    cooldownEnabled: '失败候选冷却跳过',
    cooldownEnabledHint:
      '候选重试预算耗尽切换后,短时间内后续请求不再从它开始,直接用下一个可用候选;窗口期满自动恢复优先级并重新验证',
    cooldownMs: '冷却窗口时长(毫秒)',
    cooldownMsHint:
      '失败模型保持跳过的时长,窗口过后重新验证并恢复其优先级;0 = 立即过期(等效禁用)',
    cooldownBreaker: '连续失败熔断递增',
    cooldownBreakerHint:
      '同一候选反复失败时冷却窗口按指数增长(首次失败仍是普通冷却窗口,单次偶发失败零变化);冷却到期后进入稳定观察期,优先级低于其他可用候选,没有其他可用候选时仍会半开试探;期间再失败则继续翻倍,安静度过即视为恢复',
    cooldownBreakerCapMs: '熔断窗口上限(毫秒)',
    cooldownBreakerCapMsHint:
      '熔断递增窗口的封顶(不会低于普通冷却窗口),与配额派生及 retry-after 时长上限相互独立',
    cooldownStabilizationMs: '稳定观察期时长(毫秒)',
    cooldownStabilizationMsHint:
      '冷却到期后该候选仍可作为半开试探,但优先级低于其他可用候选;观察期内再失败则窗口继续翻倍,安静度过即视为恢复并清零失败计数;0 = 冷却到期后不再观察(会话指定模型在冷却窗内直接重试仍可能递增)',
    timeWindowEnabled: '时间窗切换/错峰优先',
    timeWindowEnabledHint:
      '配置的窗口内,按规则把候选预填进失败冷却表(到期 = 窗口结束),请求自动改写切走;窗口结束由惰性过期自动恢复优先级,无需定时器',
    timeWindowRules: '时间窗规则(provider 匹配 + 时段窗口)',
    timeWindowRulesHint:
      'block = 窗口内冷却命中的 provider(高峰避让);prefer = 冷却未命中的 provider(错峰自动优先 DeepSeek)。窗口按宿主机本地时区判定:HH:mm 半开区间,起点>终点 = 跨夜,相等 = 全天',
    twMatchLabel: 'provider 匹配',
    twMatchPlaceholder: 'deepseek-account / deepseek-* / *',
    twActionBlock: '高峰避让',
    twActionPrefer: '错峰优先',
    twWindowStart: '窗口起点',
    twWindowEnd: '窗口终点',
    twAddRule: '添加规则',
    twAddWindow: '添加窗口',
    twRemoveRule: '删除规则',
    twRemoveWindow: '删除窗口',
    twPreset: '填入官方模板',
    twPresetHint:
      '官方错峰默认:高峰 08:30–00:30 避让 deepseek-*;错峰 00:30–08:30(官方半价)优先 deepseek-*',
    twEmpty: '暂无规则;可填入官方模板或手动添加',
    twInvalid:
      '时间窗规则无效:provider 匹配不能为空,且每条规则至少要有一个合法的 HH:mm 窗口',
    save: '保存',
    discard: '放弃修改',
    saving: '保存中…',
    saved: '已保存',
    failed: '保存失败,请重试',
    conflict: '配置已在别处被修改,请放弃草稿后重试',
    loading: '正在载入配置…',
    unavailable: '配置存储不可用',
    readonly: '只读连接,无法修改',
    dirty: '有未保存的修改',
  },
  en: {
    title: 'Model fallback',
    intro:
      'When the model selected in the session fails, the next model in the queue is tried automatically (the conversation is not interrupted). This queue holds pure fallback candidates — the session-selected primary is not configured here.',
    enabled: 'Enabled',
    enabledDesc: 'When off, model failures are no longer intercepted',
    queue: 'Fallback queue (move up/down to reorder)',
    queueEmpty: 'No model selected yet — check models below.',
    fallbackN: 'Fallback',
    moveUp: 'Move up',
    moveDown: 'Move down',
    remove: 'Remove',
    stale: 'Unavailable',
    staleHint:
      'This model is no longer in the host catalog (removed, or its model id changed) and requests to it will fail — remove it or re-pick from the catalog below',
    clearStale: 'Remove unavailable',
    clearStaleHint:
      'Remove every candidate that is no longer in the catalog from the queue (takes effect on save)',
    queueEffort: 'Reasoning effort override',
    queueEffortHint:
      'Reasoning effort written alongside model.select when the chain switches to this candidate (adapter-owned effort id, e.g. medium); leave empty to keep the session effort. An unsupported id fails the request (UNSUPPORTED_REASONING_EFFORT) and the chain moves on',
    queueEffortPlaceholder: 'effort (empty = keep)',
    queueMaxTokens: 'Output cap override',
    queueMaxTokensHint:
      'Per-request output cap (positive integer tokens) for requests routed to this candidate; leave empty to pass the session value through. Over-limit requests fail at request time — whether the chain moves on depends on the failure code whitelist',
    queueMaxTokensPlaceholder: 'cap (empty = pass through)',
    catalog: 'Available models',
    catalogLoading: 'Loading model catalog…',
    catalogError: 'Model catalog failed to load',
    catalogRetry: 'Retry',
    catalogEmpty: 'No provider model is configured on this host yet.',
    catalogHint: 'Check to append to the queue',
    catalogSearch: 'Search models (provider / id / name)…',
    searchAria: 'Search models',
    catalogNoMatch: 'No matching models',
    maxRetries: 'Max switches',
    maxRetriesHint:
      '0 = queue length (try every candidate before failing); bounds candidate switches, not same-candidate retries — the retry budget always follows the official one (provider retry policy, default 5)',
    cooldownEnabled: 'Cooldown skip for failed models',
    cooldownEnabledHint:
      'After a candidate exhausts its retry budget and the chain switches away, subsequent requests skip it for a short window and start from the next healthy candidate; it is re-verified when the window expires',
    cooldownMs: 'Cooldown window (ms)',
    cooldownMsHint:
      'How long a failed model stays skipped before being re-verified and restored to its priority position; 0 = expire immediately (disabled)',
    cooldownBreaker: 'Circuit-breaker escalation',
    cooldownBreakerHint:
      'When the same candidate keeps failing, its cooldown window grows exponentially. The first failure still uses the plain window, so one-off failures change nothing. After the window expires, the candidate enters a lower-priority stabilization period; it remains a half-open probe when no other candidate is available.',
    cooldownBreakerCapMs: 'Breaker window cap (ms)',
    cooldownBreakerCapMsHint:
      'Upper bound applied to the escalated window (never below the plain cooldown window); independent from the cap that governs quota-derived durations',
    cooldownStabilizationMs: 'Stabilization period (ms)',
    cooldownStabilizationMsHint:
      'After the cooldown expires, the candidate remains a half-open probe but is lower priority than other available candidates; another failure during observation doubles the window again, while a quiet period means recovery and resets the counter; 0 = no post-cooldown observation (a direct retry of the session model during its cooldown may still escalate)',
    timeWindowEnabled: 'Time-window switching / off-peak priority',
    timeWindowEnabledHint:
      'During configured windows, candidates matching the rules are prefilled into the failure-cooldown table (expiry = window end) so requests switch away transparently; when a window ends the existing lazy expiry restores priority — no timers',
    timeWindowRules: 'Time-window rules (provider match + windows)',
    timeWindowRulesHint:
      'block = cool matched providers during the window (peak avoidance); prefer = cool NON-matched providers (off-peak: prefer DeepSeek automatically). Windows follow the host local timezone: "HH:mm" half-open; start > end wraps midnight; start == end = all day',
    twMatchLabel: 'Provider match',
    twMatchPlaceholder: 'deepseek-account / deepseek-* / *',
    twActionBlock: 'Peak avoidance',
    twActionPrefer: 'Off-peak priority',
    twWindowStart: 'Window start',
    twWindowEnd: 'Window end',
    twAddRule: 'Add rule',
    twAddWindow: 'Add window',
    twRemoveRule: 'Remove rule',
    twRemoveWindow: 'Remove window',
    twPreset: 'Use official preset',
    twPresetHint:
      'Official off-peak defaults: avoid deepseek-* during peak 08:30–00:30; prefer deepseek-* during off-peak 00:30–08:30 (official half-price window)',
    twEmpty: 'No rules yet — use the official preset or add one manually',
    twInvalid:
      'Invalid time-window rule: provider match must not be empty, and every rule needs at least one valid "HH:mm" window',
    save: 'Save',
    discard: 'Discard',
    saving: 'Saving…',
    saved: 'Saved',
    failed: 'Save failed, please retry',
    conflict: 'Settings changed elsewhere; discard the draft and retry',
    loading: 'Loading settings…',
    unavailable: 'Settings storage unavailable',
    readonly: 'Read-only connection; settings cannot be changed',
    dirty: 'Unsaved changes',
  },
};
