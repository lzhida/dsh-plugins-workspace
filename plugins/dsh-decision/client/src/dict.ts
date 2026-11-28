/**
 * decision-tools 双语字典（决策工具系列 6/11）。
 *
 * key 约定：分区前缀（field./tool./verify./section./action./hint./
 * common.）；en 为基准（缺失 key 回落 key 本身），zh 为中文文案。
 *
 * @module dsh-decision/client/dict
 */

/** 字典条目（en 基准 / zh 中文）。 */
export type DictEntry = { en: string; zh: string };

const EN: Record<string, string> = {};
const ZH: Record<string, string> = {};

function define(key: string, en: string, zh: string): void {
  EN[key] = en;
  ZH[key] = zh;
}

/* ---- 页面骨架 ---- */
define('page.title', 'Decision Tools', '决策工具');
define(
  'page.description',
  'Configure the decision model endpoint, tool switches, budget and fallback parameters. This panel is the primary editor; the host-generated config card edits the same values.',
  '配置决策模型接口、工具开关、预算与兜底参数。本面板为主编辑入口；宿主出厂配置卡编辑的是同一份配置。',
);
define('common.save', 'Save', '保存');
define('common.saving', 'Saving…', '保存中…');
define('common.saved', 'Saved', '已保存');
define('common.unsaved', 'Unsaved changes', '有未保存修改');
define(
  'common.conflict',
  'Settings changed elsewhere; please review and retry.',
  '配置在别处被修改，请刷新后重试。',
);
define('common.error', 'Save failed', '保存失败');
define(
  'common.readonly',
  'Settings are read-only in this view.',
  '当前视图配置只读。',
);

/* ---- 分区标题 ---- */
define('section.model', 'Decision model endpoint', '决策模型接口');
define('section.tools', 'Tool switches', '工具开关');
define('section.budget', 'Budget', '预算');
define('section.fallback', 'LLM fallback (judge)', '大模型兜底（裁判）');
define('section.ledger', 'Ledger & gate', '账本与闸门');

/* ---- 模型接口字段 ---- */
define('field.baseUrl', 'Base URL', '接口地址');
define(
  'field.baseUrl.hint',
  'e.g. http://127.0.0.1:3425',
  '例如 http://127.0.0.1:3425',
);
define('field.apiKey', 'API key', 'API key');
define(
  'field.apiKey.hint',
  'Stored in the host profile config; never logged.',
  '存放于宿主 profile 配置；绝不写入日志。',
);
define('field.model', 'Model', '模型');
define('field.model.hint', 'e.g. ollama-r5/kev-4b', '例如 ollama-r5/kev-4b');
define('field.timeoutMs', 'Timeout (ms)', '超时（毫秒）');
define('field.timeoutMs.hint', '1000 – 300000', '1000 – 300000');

/* ---- 验证按钮与状态 ---- */
define('verify.button', 'Verify endpoint', '验证接口');
define('verify.verifying', 'Verifying…', '验证中…');
define('verify.ok', 'Endpoint verified', '接口验证通过');
define('verify.ok.latency', 'Latency', '延迟');
define('verify.fail', 'Verify failed', '验证失败');
define(
  'verify.route-missing',
  'Verify route unavailable (host route not registered). Reload after the plugin loads.',
  '验证路由不可用（宿主路由未注册）。插件加载后请重试。',
);
define('verify.last-verified', 'Last verified at', '最近验证时间');
define('verify.last-error', 'Last verify error', '最近验证错误');

/* ---- 工具开关 ---- */
define('tool.decide', 'decide — typed judgement', 'decide — 结构化判定');
define('tool.gate', 'gate — pre-action guard', 'gate — 危险动作闸门');
define('tool.rerank', 'rerank — candidate ranking', 'rerank — 方案选型');
define('tool.batch', 'batch — bulk classification', 'batch — 批量判定');
define('tool.locate', 'locate — visual grounding', 'locate — 视觉定位');
define('tool.usage', 'usage — ledger statistics', 'usage — 用量账本');
define('tool.history', 'history — decision history', 'history — 决策历史');
define('tool.recheck', 'recheck — drift recheck', 'recheck — 复检漂移');
define(
  'tool.calibrate',
  'calibrate — calibration audit',
  'calibrate — 校准审计',
);
define('tool.arbiter', 'arbiter — explicit judge', 'arbiter — 显式裁判');
define(
  'hint.tools',
  'Disabled tools reject calls with tool-disabled. History / usage / calibrate work locally without the model.',
  '关闭的工具以 tool-disabled 拒绝调用。history / usage / calibrate 纯本地，无需模型。',
);

/* ---- 预算 ---- */
define('field.budgetEnabled', 'Enable hard budget', '启用硬预算');
define(
  'field.budgetEnabled.hint',
  'Check the daily window before every model call.',
  '每次模型调用前先查日窗口配额。',
);
define('field.budgetMaxCallsPerDay', 'Max calls / day', '每日调用上限');
define('field.budgetMaxTokensPerDay', 'Max tokens / day', '每日 token 上限');
define(
  'field.budgetMaxCostUsdPerDay',
  'Max cost (USD) / day',
  '每日成本上限（美元）',
);
define('field.budgetResetHourUtc', 'Reset hour (UTC)', '重置时刻（UTC）');
define(
  'field.budgetResetHourUtc.hint',
  '0 – 23; daily window boundary.',
  '0 – 23；日窗口切分点。',
);
define(
  'field.costInputPer1kTokens',
  'Cost per 1k input tokens (USD)',
  '每千输入 token 成本（美元）',
);
define(
  'field.costOutputPer1kTokens',
  'Cost per 1k output tokens (USD)',
  '每千输出 token 成本（美元）',
);
define(
  'hint.cost',
  'Rates default to 0 — cost is then an estimate with cost 0.',
  '费率默认 0——此时成本按 0 估算。',
);

/* ---- 兜底 ---- */
define('field.fallbackEnabled', 'Enable LLM fallback', '启用大模型兜底');
define(
  'field.fallbackEnabled.hint',
  'Cascade: unconfigured / failed / low-confidence calls fall back to the judge model.',
  '级联回退：未配置 / 调用失败 / 低置信时交给裁判模型。',
);
define('field.fallbackProvider', 'Judge provider', '裁判 provider');
define(
  'field.fallbackProvider.hint',
  'Empty = use the session current model.',
  '留空 = 使用会话当前模型。',
);
define('field.fallbackModel', 'Judge model', '裁判模型');
define(
  'field.fallbackModel.hint',
  'Empty = use the session current model.',
  '留空 = 使用会话当前模型。',
);
define('field.fallbackMinConfidence', 'Min confidence', '置信度门控');
define(
  'field.fallbackMinConfidence.hint',
  'Below this (or low agreement) triggers the judge.',
  '低于该值（或共识不足）触发裁判。',
);
define('field.fallbackMode', 'Fallback mode', '兜底模式');
define(
  'field.fallbackMode.hint',
  'auto-fallback / explicit-arbiter / both.',
  'auto-fallback / explicit-arbiter / both。',
);
define('field.fallbackTimeoutMs', 'Judge timeout (ms)', '裁判超时（毫秒）');
define(
  'field.fallbackMaxCallsPerDay',
  'Judge max calls / day',
  '裁判每日调用上限',
);
define(
  'hint.fallback',
  'Judge calls share the budget and carry their own daily cap. (Judge logic lands in card 7/11; this section stores parameters.)',
  '裁判调用共享预算并有独立日上限。（裁判逻辑由 7/11 落地；本区仅负责参数存取。）',
);

/* ---- 账本与闸门 ---- */
define('field.ledgerEnabled', 'Enable ledger (file)', '启用账本（落盘）');
define(
  'field.ledgerEnabled.hint',
  'Persisted at <DSH_HOME>/plugins/dsh-decision/ledger.jsonl. Toggle requires reload.',
  '落盘于 <DSH_HOME>/plugins/dsh-decision/ledger.jsonl。开关需重启生效。',
);
define('field.ledgerMaxEntries', 'Ledger max entries', '账本容量上限');
define('field.gateAllowThreshold', 'Gate allow threshold', 'gate 放行阈值');
define(
  'field.gateAllowThreshold.hint',
  'allow P(yes) >= threshold; grey zone escalates.',
  'allow P(yes) ≥ 阈值；灰区一律 escalate。',
);

/** 双语字典（en 基准 + zh 覆盖）。 */
export const DICT = {
  en: EN,
  zh: ZH,
};

/** 静态回退取词（locale 服务缺失时用）。 */
export function staticT(key: string): string {
  return EN[key] ?? key;
}
