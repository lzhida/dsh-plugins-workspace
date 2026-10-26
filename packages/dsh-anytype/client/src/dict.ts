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
 * zh/en 键集一致性由 src/client-bundle.test.ts 断言（缺译 / 漏译防回归）。
 *
 * @module dsh-anytype/client/dict
 */

/** 文案字典类型：两语言同键集。 */
export type Dict = Record<'zh' | 'en', Record<string, string>>;

export const DICT: Dict = {
  zh: {
    title: 'Anytype 配置',
    intro:
      '本卡片配置 Anytype 连接与持久记忆两个插件行。连接类字段只填一次，记忆插件行复用同一把钥匙。改动保存后即时生效（工具组开关需重载插件）。',
    sectionConnection: 'Anytype 连接',
    sectionMemory: '持久记忆',
    enabled: '启用',
    enabledDesc: '关闭后不注册任何工具（指引 section 保留）；改动需重载插件',
    baseUrl: 'API 地址',
    baseUrlDesc: 'Anytype 本地 API 地址（桌面端默认端口 31009）',
    apiKey: 'API 密钥',
    apiKeyDesc: 'Anytype 应用设置 → API Keys → 创建',
    apiKeyPlaceholder: '输入新的密钥（留空表示不改动）',
    apiKeySet: '已配置',
    apiKeyUnset: '未配置',
    apiKeyClear: '清除密钥',
    apiKeyNote: '密钥为只写字段：保存后不再回显，留空即保持原值',
    apiVersion: 'Anytype-Version',
    apiVersionDesc: 'Anytype-Version 请求头取值',
    requestTimeoutMs: '请求超时（毫秒）',
    requestTimeoutMsDesc: '单请求超时上限',
    maxResponseChars: '结果截断上限（字符）',
    maxResponseCharsDesc: '工具结果超过该字符数即截断（保护模型上下文）',
    disabledGroups: '停用的工具组',
    disabledGroupsDesc: '勾选后该组工具不再注册；改动需重载插件',
    memoryEnabled: '启用记忆工具',
    memoryEnabledDesc: '关闭后不注册任何 memory_* 工具（指引 section 保留）',
    spaceName: '记忆空间名',
    spaceNameDesc: '作为记忆工作环境的 Anytype 空间名（memory_setup 按需创建）',
    spaceId: '记忆空间 id',
    spaceIdDesc:
      '钉住指定空间（短引用如 64xiwe 或完整 id）；留空 = 按空间名解析',
    defaultStatus: '新记忆默认状态',
    defaultStatusDesc: 'AI 写入记忆的默认审核态：draft / approved / disputed',
    recallLimit: '召回默认条数',
    recallLimitDesc: 'memory_recall 默认返回条数',
    recallMaxTokens: '召回 token 预算',
    recallMaxTokensDesc: '召回正文的默认 token 预算（元数据免费）',
    embeddingBatchSize: '向量批大小',
    embeddingBatchSizeDesc:
      '每次请求投影 embedding 属性的记忆条数（限速 1rps 的往返预算）',
    memoryDisabledGroups: '停用的记忆工具组',
    memoryDisabledGroupsDesc: '勾选后该组工具不再注册；改动需重载插件',
    save: '保存',
    discard: '放弃修改',
    saving: '保存中…',
    dirty: '有未保存的修改',
    failed: '保存失败，请重试',
    conflict: '配置已在别处被修改，请放弃草稿后重试',
    loading: '正在载入配置…',
    unavailable: '配置存储不可用',
    readonly: '只读连接，无法修改',
    invalidBaseUrl: 'API 地址无效：需以 http:// 或 https:// 开头',
  },
  en: {
    title: 'Anytype configuration',
    intro:
      'This card configures the Anytype connection and the persistent-memory plugin rows. Connection fields are filled in once — the memory row reuses the same key. Changes take effect immediately (tool-group switches need a plugin reload).',
    sectionConnection: 'Anytype connection',
    sectionMemory: 'Persistent memory',
    enabled: 'Enabled',
    enabledDesc:
      'When off, no tools are registered (the guidance section stays); a plugin reload is required',
    baseUrl: 'API URL',
    baseUrlDesc: 'Anytype local API base URL (desktop app default port 31009)',
    apiKey: 'API key',
    apiKeyDesc: 'Anytype App Settings → API Keys → Create new',
    apiKeyPlaceholder: 'Enter a new key (leave blank to keep the current one)',
    apiKeySet: 'Configured',
    apiKeyUnset: 'Not configured',
    apiKeyClear: 'Clear key',
    apiKeyNote:
      'The key is write-only: it is never shown again — leave it blank to keep the current value',
    apiVersion: 'Anytype-Version',
    apiVersionDesc: 'Anytype-Version request header value',
    requestTimeoutMs: 'Request timeout (ms)',
    requestTimeoutMsDesc: 'Per-request timeout upper bound',
    maxResponseChars: 'Result budget (chars)',
    maxResponseCharsDesc:
      'Tool results beyond this many characters are truncated (protects model context)',
    disabledGroups: 'Disabled tool groups',
    disabledGroupsDesc:
      'Checked groups are no longer registered; a plugin reload is required',
    memoryEnabled: 'Memory tools enabled',
    memoryEnabledDesc:
      'When off, no memory_* tools are registered (the guidance section stays)',
    spaceName: 'Memory space name',
    spaceNameDesc:
      'Name of the Anytype space used as the memory workspace (created on demand by memory_setup)',
    spaceId: 'Memory space id',
    spaceIdDesc:
      'Pin a specific space (short reference like 64xiwe or a full id); empty = resolve by spaceName',
    defaultStatus: 'Default memory status',
    defaultStatusDesc:
      'Status for memories written by the agent: draft / approved / disputed',
    recallLimit: 'Default recall limit',
    recallLimitDesc: 'Default number of memories returned by memory_recall',
    recallMaxTokens: 'Recall token budget',
    recallMaxTokensDesc:
      'Default token budget for recalled memory bodies (metadata is free)',
    embeddingBatchSize: 'Embedding batch size',
    embeddingBatchSizeDesc:
      'How many memories project the embedding property per request (1rps rate limit budget)',
    memoryDisabledGroups: 'Disabled memory tool groups',
    memoryDisabledGroupsDesc:
      'Checked groups are no longer registered; a plugin reload is required',
    save: 'Save',
    discard: 'Discard',
    saving: 'Saving…',
    dirty: 'Unsaved changes',
    failed: 'Save failed, please retry',
    conflict: 'Settings changed elsewhere; discard the draft and retry',
    loading: 'Loading settings…',
    unavailable: 'Settings storage unavailable',
    readonly: 'Read-only connection; settings cannot be changed',
    invalidBaseUrl: 'Invalid API URL: it must start with http:// or https://',
  },
};
