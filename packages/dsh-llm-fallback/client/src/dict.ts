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
      '0 = 按队列长度(切完所有候选才报错);只限切换次数,同候选重试由下方次数控制',
    retriesBeforeSwitch: '每候选重试次数',
    retriesHint:
      '0 = 跟随官方重试预算(provider 重试策略,默认 5);N = 以插件配置为准,当前候选重试 N 次后才切换(超出官方预算的部分由插件代执行)',
    cooldownEnabled: '失败候选冷却跳过',
    cooldownEnabledHint:
      '候选重试预算耗尽切换后,短时间内后续请求不再从它开始,直接用下一个可用候选;窗口期满自动恢复优先级并重新验证',
    cooldownMs: '冷却窗口时长(毫秒)',
    cooldownMsHint:
      '失败模型保持跳过的时长,窗口过后重新验证并恢复其优先级;0 = 立即过期(等效禁用)',
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
      '0 = queue length (try every candidate before failing); bounds candidate switches, not same-candidate retries',
    retriesBeforeSwitch: 'Retries before switch',
    retriesHint:
      '0 = follow the official retry budget (provider retry policy, default 5); N = authoritative — retry the current candidate N times before switching (the plugin performs retries beyond the official budget itself)',
    cooldownEnabled: 'Cooldown skip for failed models',
    cooldownEnabledHint:
      'After a candidate exhausts its retry budget and the chain switches away, subsequent requests skip it for a short window and start from the next healthy candidate; it is re-verified when the window expires',
    cooldownMs: 'Cooldown window (ms)',
    cooldownMsHint:
      'How long a failed model stays skipped before being re-verified and restored to its priority position; 0 = expire immediately (disabled)',
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
