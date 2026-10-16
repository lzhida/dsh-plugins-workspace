/**
 * dsh-llm-fallback client bundle — 手写零构建 CJS-in-factory。
 *
 * 设置 → 插件 → dsh-llm-fallback 的配置卡片:
 * - 启用开关;
 * - **模型勾选**:候选池来自 `ctx.remote.session.modelCatalog()`(宿主已配置
 *   provider 的模型目录,按 provider 分组),勾选即加入回退队列;列表限高
 *   滚动(280px 内部滚动,不再撑长设置页外层滚动条),并提供搜索框
 *   (provider 分组名 / 模型 id / 显示名,大小写不敏感子串过滤,无命中给空态);
 * - **排序**:已选队列可上移/下移/移除,顺序即回退优先级(纯回退候选,
 *   不含会话指定的模型——它失败后从队列第 1 项开始切);
 * - **最大回退次数**(maxRetries,0 = 链长;只限切换候选次数);
 * - **每候选重试次数**(retriesBeforeSwitch,0 = 跟随官方重试预算;
 *   0.5.0 起取代旧 fallbackWhen 回退时机下拉);
 * - **失败候选冷却跳过**(cooldownEnabled 开关 + cooldownMs 窗口时长,毫秒):
 *   失败模型短窗内不再作为后续请求起点,窗口期满自动恢复优先级;
 * - **时段计划**(0.6.0):scheduleEnabled 开关 + 规则编辑(阻塞目标从同一
 *   模型目录勾选,支持 provider/* 通配手改;窗口 HH:mm 起止 + 星期 chips,
 *   起点可大于终点表示跨夜,相等为全天)——高峰窗口内被阻塞目标的请求
 *   由宿主侧插件自动改写为链上首个可用候选,全部被阻塞时降级放行;
 *
 * 为什么需要客户端包:宿主 `@deepseek-ai/dsh-settings` 的 `describe()` 只投影
 * `.volatile()` 字段给"自带页面的客户端",而 dsh 0.2.0-rc.2 **没有**通用的
 * schema→页面自动生成客户端(`autoGenerate` 在已发布客户端中无实现),因此
 * 配置 UI 必须由插件自带 client 注册进 Plugins 页的 `plugins.bundle.config` 插槽。
 *
 * 读写走 `ctx.configForms.get(entryId)`(namespace = profile 条目 id),
 * 与一方插件 dsh-client-ui-settings-subagent 同路径:
 *   scope.getSnapshot() -> { status, value, writable, revision }
 *   scope.mutate([{op:'set', path, value}], revision)
 *
 * 样式用内联样式,不依赖 dsh 的 CSS modules 哈希类名(版本升级不失效);
 * 颜色全部引用 dsh web 主题 token `--dsw-alias-*`(明/暗双模式各有定义,
 * 由客户端 Theme inspect 提供方列出),暗色模式下不再出现文字与背景混色。
 *
 * 国际化(0.3.3):文案字典 DICT(zh/en)经 `ctx.locale.register(DICT_NS, DICT)`
 * 注册进 dsh 的 locale 服务——当前语言即 dsh 的语言配置(Host 偏好存于设置
 * namespace `locale` 字段 `preference`,缺省回退浏览器语言,再回退 `en`,
 * 与 dsh-client-locale 内置语言目录 LOCALE_IDS `['zh','en']` 对齐),`t` 在
 * 每次渲染时按激活语言解析;卡片另订阅 locale 快照(LocaleFace 的
 * getSnapshot/subscribe 契约),用户在 设置 → 通用 → 语言 切换语言时本卡
 * 立即重渲染。locale 服务缺失(组合未含 dsh-client-locale)时回退英文字典,
 * 配置卡降级可用、apply 不抛错。服务端 Config schema 的字段描述另经
 * schemastery i18n 映射(`{ '': 英文默认, zh, en }`,见 src/config.ts 的
 * desc())随 settings.describe 下发,由前端按同一语言配置解析。
 */
globalThis.__ModuleLoader__.load({
  // id 必须与 package.json 包名一致,否则 boot graph arrive() 抛
  // "loaded without registering"。
  id: '@zhidal/dsh-llm-fallback',
  factory: (require) => {
    var module = { exports: {} };
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;

    var name = 'llm-fallback';
    /** locale 字典命名空间。 */
    var DICT_NS = 'llm-fallback';
    /** 设置 namespace = profile 条目 id(由 cordis.patch.yml 的 id 决定)。 */
    var ENTRY_NS = 'dsh-llm-fallback';

    var inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms'];

    var DICT = {
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
        scheduleEnabled: '时段计划',
        scheduleEnabledHint:
          '开启后按下方规则在指定时段自动避开被阻塞的 provider/model(改写为回退队列可用候选,对话不中断;按宿主机本地时区判定)',
        scheduleHint:
          '规则 = 阻塞目标 + 时段窗口;窗口内命中目标的请求自动改写为链上第一个可用候选,全部候选被阻塞时降级放行(绝不中断对话)',
        scheduleAddRule: '添加规则',
        scheduleRemoveRule: '删除规则',
        scheduleRuleN: '规则',
        scheduleTargets: '阻塞目标',
        scheduleTargetsEmpty: '尚未选择目标;点击「编辑目标」从模型目录勾选。',
        scheduleTargetsHint: '勾选加入阻塞目标(与回退队列同一模型目录)',
        scheduleEditTargets: '编辑目标',
        scheduleDoneTargets: '完成选择',
        scheduleWindows: '时段窗口',
        scheduleAddWindow: '添加窗口',
        scheduleStart: '开始',
        scheduleEnd: '结束',
        scheduleInvalid:
          '窗口时间格式应为 HH:mm;起点>终点 = 跨夜,相等 = 全天',
        scheduleOvernight: '跨夜',
        d1: '一',
        d2: '二',
        d3: '三',
        d4: '四',
        d5: '五',
        d6: '六',
        d7: '日',
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
        scheduleEnabled: 'Time-window schedule',
        scheduleEnabledHint:
          'When on, blocked providers/models are avoided automatically during the windows below — requests are rewritten to an available fallback candidate without interrupting the conversation (host local timezone)',
        scheduleHint:
          'A rule pairs blocked targets with time windows; during a window, matching requests are rewritten to the first available candidate, and when every candidate is blocked they pass through unchanged (the conversation is never interrupted)',
        scheduleAddRule: 'Add rule',
        scheduleRemoveRule: 'Remove rule',
        scheduleRuleN: 'Rule',
        scheduleTargets: 'Blocked targets',
        scheduleTargetsEmpty:
          'No targets yet — click "Edit targets" to pick from the model catalog.',
        scheduleTargetsHint:
          'Check to add blocked targets (same catalog as the fallback queue)',
        scheduleEditTargets: 'Edit targets',
        scheduleDoneTargets: 'Done',
        scheduleWindows: 'Time windows',
        scheduleAddWindow: 'Add window',
        scheduleStart: 'Start',
        scheduleEnd: 'End',
        scheduleInvalid:
          'Window time must be HH:mm; start > end wraps midnight, start == end means all day',
        scheduleOvernight: 'overnight',
        d1: 'Mon',
        d2: 'Tue',
        d3: 'Wed',
        d4: 'Thu',
        d5: 'Fri',
        d6: 'Sat',
        d7: 'Sun',
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

    /** 单条队列项的稳定 key。 */
    function routeKey(route) {
      return route.provider + '/' + route.model;
    }

    /** 队列是否一致(顺序敏感)。 */
    function sameQueue(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) {
        if (a[i].provider !== b[i].provider || a[i].model !== b[i].model) {
          return false;
        }
      }
      return true;
    }

    /** 窗口时间格式(HH:mm,00:00-23:59)。 */
    var TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

    /** 深拷贝规则数组(draft 不可变更新的基线;days 缺失归一为空数组)。 */
    function cloneRules(rules) {
      return (rules || []).map(function (rule) {
        return {
          targets: (rule.targets || []).slice(),
          windows: (rule.windows || []).map(function (w) {
            return {
              start: String(
                w.start === undefined || w.start === null ? '' : w.start,
              ),
              end: String(w.end === undefined || w.end === null ? '' : w.end),
              days: (w.days || []).slice(),
            };
          }),
        };
      });
    }

    /** 深拷贝单条规则。 */
    function cloneRule(rule) {
      return cloneRules([rule])[0];
    }

    /** 规则列表是否结构一致(顺序敏感;days 空数组与缺失等同)。 */
    function sameRules(a, b) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) {
        var ra = a[i];
        var rb = b[i];
        if (ra.targets.length !== rb.targets.length) return false;
        for (var t = 0; t < ra.targets.length; t += 1) {
          if (ra.targets[t] !== rb.targets[t]) return false;
        }
        if (ra.windows.length !== rb.windows.length) return false;
        for (var w = 0; w < ra.windows.length; w += 1) {
          if (ra.windows[w].start !== rb.windows[w].start) return false;
          if (ra.windows[w].end !== rb.windows[w].end) return false;
          var da = ra.windows[w].days || [];
          var db = rb.windows[w].days || [];
          if (da.length !== db.length) return false;
          for (var d = 0; d < da.length; d += 1) {
            if (da[d] !== db[d]) return false;
          }
        }
      }
      return true;
    }

    /**
     * 规则是否可保存:至少一个目标与一条窗口,且窗口时间均为合法 HH:mm。
     * 宿主侧 resolveScheduleRules 对占位规则(targets/windows 双空)宽容跳过、
     * 半配置/非法规则整体拒绝——client 侧保存闸保持同一判定,避免把会导致
     * 宿主拒收配置的值写出去。
     */
    function ruleValid(rule) {
      if (!rule || rule.targets.length === 0 || rule.windows.length === 0) {
        return false;
      }
      for (var i = 0; i < rule.windows.length; i += 1) {
        var w = rule.windows[i];
        if (!TIME_RE.test(String(w.start || ''))) return false;
        if (!TIME_RE.test(String(w.end || ''))) return false;
      }
      return true;
    }

    /** 保存前丢弃新建未填的占位规则(targets 与 windows 双空)。 */
    function stripPlaceholderRules(rules) {
      return rules.filter(function (rule) {
        return rule.targets.length > 0 || rule.windows.length > 0;
      });
    }

    /**
     * 搜索过滤谓词:provider 分组名 / 模型 id / 显示名,大小写不敏感子串匹配。
     * 空搜索词(或纯空白)视为不过滤,返回 true。
     */
    function modelMatches(group, model, query) {
      var q = String(query || '')
        .trim()
        .toLowerCase();
      if (!q) return true;
      return (
        String(group.id || '')
          .toLowerCase()
          .indexOf(q) !== -1 ||
        String(model.id || '')
          .toLowerCase()
          .indexOf(q) !== -1 ||
        String(model.name || '')
          .toLowerCase()
          .indexOf(q) !== -1
      );
    }

    /** 目录分组 × 搜索词 → 仍有命中的分组(组内模型已过滤;全部无命中返回 [])。 */
    function filteredCatalogGroups(groups, query) {
      return (groups || [])
        .map(function (group) {
          return {
            id: group.id,
            models: (group.models || []).filter(function (m) {
              return modelMatches(group, m, query);
            }),
          };
        })
        .filter(function (group) {
          return group.models.length > 0;
        });
    }

    // ── 内联样式(不依赖哈希类名)──────────────────────────────────
    // 颜色一律走 dsh web 主题 token `--dsw-alias-*`(明/暗双模式各有定义,
    // 由客户端 Theme inspect 提供方列出):文本用 label-primary/secondary,
    // 边框用 border-l1/l2,抬升表面用 bg-layer-1,强调色用 brand-primary。
    // 不再硬编码半透明灰阶(旧边框/徽标的配色)——那是暗色模式下文字与
    // 背景混色的根因;token 缺失时按 CSS var 规则退回继承色/初始值,不会
    // 渲染崩溃。
    var T = {
      text: 'var(--dsw-alias-label-primary)',
      textSecondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    var S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '4px 0',
        // 卡片根节点显式设置文本色:不依赖宿主容器的继承链,暗色模式
        // 下也不会退回 UA 默认的近黑前景。
        color: T.text,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      label: { fontWeight: 600, fontSize: 13, color: T.text },
      hint: { fontSize: 12, color: T.textSecondary },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      },
      queueRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        border: '1px solid ' + T.border,
        borderRadius: 6,
      },
      badge: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid ' + T.border,
        color: T.textSecondary,
        whiteSpace: 'nowrap',
      },
      btn: {
        cursor: 'pointer',
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid ' + T.borderStrong,
        background: 'transparent',
        color: T.text,
        fontSize: 12,
      },
      primaryBtn: {
        cursor: 'pointer',
        padding: '5px 14px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: T.brand,
        color: '#fff',
        fontSize: 13,
      },
      group: { display: 'flex', flexDirection: 'column', gap: 4 },
      groupTitle: { fontSize: 12, color: T.textSecondary, marginTop: 4 },
      // accent-color 会被勾选框继承,明暗模式下勾选态都用品牌色渲染。
      check: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        cursor: 'pointer',
        accentColor: T.brand,
      },
      input: {
        width: 90,
        padding: '3px 6px',
        borderRadius: 6,
        border: '1px solid ' + T.borderStrong,
        background: T.surface,
        color: T.text,
      },
      searchInput: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid ' + T.borderStrong,
        background: T.surface,
        color: T.text,
        fontSize: 13,
      },
      // 可用模型列表容器:限高 + 内部滚动,模型再多也不撑长外层滚动条。
      catalogScroll: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        maxHeight: 280,
        overflowY: 'auto',
        padding: 8,
        border: '1px solid ' + T.border,
        borderRadius: 8,
        background: T.surface,
      },
      noMatch: { fontSize: 12, color: T.textSecondary, padding: '8px 2px' },
      notice: { fontSize: 13, color: T.textSecondary },
      // 时段计划:规则盒(纵向容器)与星期 chips(选中 = 品牌底色)。
      ruleBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 8,
        border: '1px solid ' + T.border,
        borderRadius: 6,
      },
      chip: {
        cursor: 'pointer',
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid ' + T.borderStrong,
        background: 'transparent',
        color: T.textSecondary,
        fontSize: 11,
      },
      chipOn: {
        cursor: 'pointer',
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid transparent',
        background: T.brand,
        color: '#fff',
        fontSize: 11,
      },
    };

    function apply(ctx) {
      // dsh 语言配置入口:ctx.locale 是宿主 locale 服务的 LocaleFace
      // (bind/register/getSnapshot/subscribe)。缺失时(组合未含
      // dsh-client-locale)回退英文字典的静态 t,配置卡降级可用。
      var locale = ctx.locale;
      var t;
      if (
        locale &&
        typeof locale.bind === 'function' &&
        typeof locale.register === 'function'
      ) {
        // bind 返回的 t 在每次调用时按当前激活语言解析(bind 按 ns 缓存,
        // 与 LocaleRuntime 同一实例),配合下方快照订阅实现语言切换即时生效。
        t = locale.bind(DICT_NS);
        ctx.effect(function () {
          return locale.register(DICT_NS, DICT);
        }, 'llm-fallback: dictionaries');
      } else {
        t = function (key) {
          var entry = DICT.en[key];
          return entry === undefined ? String(key) : entry;
        };
      }

      // namespace = profile 条目 id;dsh-settings 按条目 id 索引 descriptor。
      var scope = ctx.configForms.get(ENTRY_NS);

      function Card(props) {
        // `plugins.item` 有两个渲染位(见 dsh-client-ui-plugin-manager):
        //   { view: 'summary' } → 列表行/详情头的一句话说明
        //   { view: 'page', form } → 插件详情页的「配置」区块(完整表单)
        if (props && props.view === 'summary') {
          return h('span', null, t('intro'));
        }

        var snapState = useState(scope.getSnapshot());
        var snap = snapState[0];
        var setSnap = snapState[1];

        // 草稿(用户未保存的编辑)
        var draftEnabledState = useState(null);
        var draftEnabled = draftEnabledState[0];
        var setDraftEnabled = draftEnabledState[1];
        var draftQueueState = useState(null);
        var draftQueue = draftQueueState[0];
        var setDraftQueue = draftQueueState[1];
        var draftRetriesState = useState(null);
        var draftRetries = draftRetriesState[0];
        var setDraftRetries = draftRetriesState[1];
        var draftRetriesBeforeState = useState(null);
        var draftRetriesBefore = draftRetriesBeforeState[0];
        var setDraftRetriesBefore = draftRetriesBeforeState[1];
        var draftCooldownEnabledState = useState(null);
        var draftCooldownEnabled = draftCooldownEnabledState[0];
        var setDraftCooldownEnabled = draftCooldownEnabledState[1];
        var draftCooldownMsState = useState(null);
        var draftCooldownMs = draftCooldownMsState[0];
        var setDraftCooldownMs = draftCooldownMsState[1];
        var draftScheduleEnabledState = useState(null);
        var draftScheduleEnabled = draftScheduleEnabledState[0];
        var setDraftScheduleEnabled = draftScheduleEnabledState[1];
        var draftScheduleRulesState = useState(null);
        var draftScheduleRules = draftScheduleRulesState[0];
        var setDraftScheduleRules = draftScheduleRulesState[1];
        var draftRevState = useState(null);
        var draftRev = draftRevState[0];
        var setDraftRev = draftRevState[1];

        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        var errorState = useState(null);
        var error = errorState[0];
        var setError = errorState[1];

        // 模型目录
        var catState = useState({ status: 'idle', groups: [] });
        var cat = catState[0];
        var setCat = catState[1];

        // 模型搜索词(纯视图过滤:不影响草稿、队列与保存逻辑)
        var searchState = useState('');
        var search = searchState[0];
        var setSearch = searchState[1];

        // 规则目标编辑态:当前展开目录 picker 的规则下标(-1 = 全部收起;
        // 同一时间只展开一个,控制 DOM 规模),以及规则 picker 独立的搜索词
        // (不与回退队列的搜索互相干扰)。
        var openRuleState = useState(-1);
        var openRule = openRuleState[0];
        var setOpenRule = openRuleState[1];
        var ruleSearchState = useState('');
        var ruleSearch = ruleSearchState[0];
        var setRuleSearch = ruleSearchState[1];

        // 语言联动:订阅 locale 快照(LocaleFace getSnapshot/subscribe 契约),
        // revision 变化(切换语言 / 字典注册)时 bump 本地计数强制重渲染,
        // 让本卡文案立即跟随 设置 → 通用 → 语言 的当前选择。
        // locale 服务缺失时跳过订阅(静态英文回退,无需联动)。
        var localeTickState = useState(0);
        useEffect(
          function () {
            if (
              !locale ||
              typeof locale.subscribe !== 'function' ||
              typeof locale.getSnapshot !== 'function'
            ) {
              return undefined;
            }
            var last = locale.getSnapshot().revision;
            return locale.subscribe(function () {
              var next = locale.getSnapshot().revision;
              if (next === last) return;
              last = next;
              localeTickState[1](function (n) {
                return n + 1;
              });
            });
          },
          [],
        );

        useEffect(function () {
          return scope.subscribe(function () {
            setSnap(scope.getSnapshot());
          });
        }, []);

        function loadCatalog() {
          setCat(function (prev) {
            return { status: 'loading', groups: prev.groups };
          });
          Promise.resolve()
            .then(function () {
              return ctx.remote.session.modelCatalog();
            })
            .then(function (response) {
              if (response && response.ok) {
                setCat({ status: 'ready', groups: response.value.groups || [] });
              } else {
                setCat(function (prev) {
                  return { status: 'error', groups: prev.groups };
                });
              }
            })
            .catch(function () {
              setCat(function (prev) {
                return { status: 'error', groups: prev.groups };
              });
            });
        }

        useEffect(
          function () {
            if (cat.status === 'idle') loadCatalog();
            return undefined;
          },
          [cat.status],
        );

        var value = snap.value || {};
        var currentQueue = useMemo(
          function () {
            return (value.fallbackChains || []).map(function (entry) {
              return { provider: entry.provider, model: entry.model };
            });
          },
          [snap.revision, snap.value],
        );

        if (snap.status !== 'ready') {
          var notice =
            snap.status === 'unavailable' ? t('unavailable') : t('loading');
          return h('div', { style: S.notice }, notice);
        }

        var writable = snap.writable;
        var enabled = draftEnabled === null ? value.enabled !== false : draftEnabled;
        var queue = draftQueue === null ? currentQueue : draftQueue;
        var retries =
          draftRetries === null ? Number(value.maxRetries || 0) : draftRetries;
        var retriesBefore =
          draftRetriesBefore === null
            ? Number(value.retriesBeforeSwitch || 0)
            : draftRetriesBefore;
        // 冷却跳过:enabled 默认 true;窗口默认 300000ms(schema 默认值,
        // 存储里未写过该键时显示默认而非 0,避免误导为"已禁用")。
        var DEFAULT_COOLDOWN_MS = 300000;
        var savedCooldownMs =
          value.cooldownMs === undefined || value.cooldownMs === null
            ? DEFAULT_COOLDOWN_MS
            : Number(value.cooldownMs);
        if (!Number.isFinite(savedCooldownMs) || savedCooldownMs < 0) {
          savedCooldownMs = DEFAULT_COOLDOWN_MS;
        }
        var cooldownEnabled =
          draftCooldownEnabled === null
            ? value.cooldownEnabled !== false
            : draftCooldownEnabled;
        var cooldownMs =
          draftCooldownMs === null ? savedCooldownMs : draftCooldownMs;
        // 时段计划:enabled 默认 false(关闭 = 零行为变化);规则缺省 []。
        var savedScheduleEnabled = value.scheduleEnabled === true;
        var savedScheduleRules = useMemo(
          function () {
            return cloneRules(value.scheduleRules || []);
          },
          [snap.revision, snap.value],
        );
        var scheduleEnabled =
          draftScheduleEnabled === null
            ? savedScheduleEnabled
            : draftScheduleEnabled;
        var scheduleRules =
          draftScheduleRules === null ? savedScheduleRules : draftScheduleRules;
        // 保存闸:非占位规则必须可保存(目标+窗口齐备且时间为合法 HH:mm);
        // 占位规则(双空)允许留在草稿——保存时被剥离。
        var scheduleValid = scheduleRules.every(function (rule) {
          if (rule.targets.length === 0 && rule.windows.length === 0) {
            return true;
          }
          return ruleValid(rule);
        });
        var dirty =
          enabled !== (value.enabled !== false) ||
          !sameQueue(queue, currentQueue) ||
          retries !== Number(value.maxRetries || 0) ||
          retriesBefore !== Number(value.retriesBeforeSwitch || 0) ||
          cooldownEnabled !== (value.cooldownEnabled !== false) ||
          cooldownMs !== savedCooldownMs ||
          scheduleEnabled !== savedScheduleEnabled ||
          !sameRules(scheduleRules, savedScheduleRules);

        function beginDraft() {
          if (draftQueue === null) {
            setDraftEnabled(value.enabled !== false);
            setDraftQueue(currentQueue.map(function (r) { return { provider: r.provider, model: r.model }; }));
            setDraftRetries(Number(value.maxRetries || 0));
            setDraftRetriesBefore(Number(value.retriesBeforeSwitch || 0));
            setDraftCooldownEnabled(value.cooldownEnabled !== false);
            setDraftCooldownMs(savedCooldownMs);
            setDraftScheduleEnabled(value.scheduleEnabled === true);
            setDraftScheduleRules(cloneRules(value.scheduleRules || []));
            setDraftRev(snap.revision);
          }
        }

        function toggleModel(provider, model) {
          if (!writable || busy) return;
          beginDraft();
          var key = provider + '/' + model;
          var base = draftQueue === null ? currentQueue : draftQueue;
          var exists = base.some(function (r) { return routeKey(r) === key; });
          var next = exists
            ? base.filter(function (r) { return routeKey(r) !== key; })
            : base.concat([{ provider: provider, model: model }]);
          setDraftQueue(next);
          setError(null);
        }

        function move(index, delta) {
          if (!writable || busy) return;
          beginDraft();
          var base = (draftQueue === null ? currentQueue : draftQueue).slice();
          var target = index + delta;
          if (target < 0 || target >= base.length) return;
          var tmp = base[index];
          base[index] = base[target];
          base[target] = tmp;
          setDraftQueue(base);
        }

        function removeAt(index) {
          if (!writable || busy) return;
          beginDraft();
          var base = (draftQueue === null ? currentQueue : draftQueue).slice();
          base.splice(index, 1);
          setDraftQueue(base);
        }

        // ── 时段计划规则编辑(全部走不可变更新:先 clone 再 set)──────
        /** 取当前草稿规则数组(未进入草稿时从已保存值克隆)。 */
        function rulesBase() {
          return draftScheduleRules === null
            ? cloneRules(savedScheduleRules)
            : draftScheduleRules;
        }

        function addScheduleRule() {
          if (!writable || busy) return;
          beginDraft();
          var base = rulesBase();
          setDraftScheduleRules(
            base.concat([
              { targets: [], windows: [{ start: '09:00', end: '18:00', days: [] }] },
            ]),
          );
          setOpenRule(base.length); // 展开新规则的目标编辑
        }

        function removeScheduleRule(index) {
          if (!writable || busy) return;
          beginDraft();
          setDraftScheduleRules(
            rulesBase().filter(function (_, i) { return i !== index; }),
          );
          if (openRule === index) setOpenRule(-1);
        }

        /** 对草稿规则做一次不可变变换(fn 收到深拷贝后的数组)。 */
        function editRules(fn) {
          if (!writable || busy) return;
          beginDraft();
          setDraftScheduleRules(fn(rulesBase().map(cloneRule)));
        }

        function toggleRuleTarget(ruleIndex, provider, model) {
          editRules(function (rules) {
            var key = provider + '/' + model;
            var rule = rules[ruleIndex];
            if (!rule) return rules;
            var at = rule.targets.indexOf(key);
            if (at >= 0) rule.targets.splice(at, 1);
            else rule.targets.push(key);
            return rules;
          });
        }

        function addScheduleWindow(ruleIndex) {
          editRules(function (rules) {
            var rule = rules[ruleIndex];
            if (rule) rule.windows.push({ start: '09:00', end: '18:00', days: [] });
            return rules;
          });
        }

        function removeScheduleWindow(ruleIndex, windowIndex) {
          editRules(function (rules) {
            var rule = rules[ruleIndex];
            if (rule) rule.windows.splice(windowIndex, 1);
            return rules;
          });
        }

        function setScheduleWindowTime(ruleIndex, windowIndex, field, text) {
          editRules(function (rules) {
            var w = rules[ruleIndex] && rules[ruleIndex].windows[windowIndex];
            if (w) w[field] = text;
            return rules;
          });
        }

        function toggleScheduleWindowDay(ruleIndex, windowIndex, day) {
          editRules(function (rules) {
            var w = rules[ruleIndex] && rules[ruleIndex].windows[windowIndex];
            if (!w) return rules;
            var at = w.days.indexOf(day);
            if (at >= 0) w.days.splice(at, 1);
            else w.days.push(day);
            return rules;
          });
        }

        function discard() {
          setDraftEnabled(null);
          setDraftQueue(null);
          setDraftRetries(null);
          setDraftRetriesBefore(null);
          setDraftCooldownEnabled(null);
          setDraftCooldownMs(null);
          setDraftScheduleEnabled(null);
          setDraftScheduleRules(null);
          setOpenRule(-1);
          setDraftRev(null);
          setError(null);
        }

        function save() {
          if (busy || !writable || !scheduleValid) return;
          var revision = draftRev === null ? snap.revision : draftRev;
          if (draftRev !== null && snap.revision !== draftRev) {
            setError('conflict');
            return;
          }
          setBusy(true);
          setError(null);
          scope
            .mutate(
              [
                { op: 'set', path: ['enabled'], value: enabled },
                {
                  op: 'set',
                  path: ['fallbackChains'],
                  value: queue.map(function (r) {
                    return { provider: r.provider, model: r.model };
                  }),
                },
                { op: 'set', path: ['maxRetries'], value: retries },
                {
                  op: 'set',
                  path: ['retriesBeforeSwitch'],
                  value: retriesBefore,
                },
                { op: 'set', path: ['cooldownEnabled'], value: cooldownEnabled },
                { op: 'set', path: ['cooldownMs'], value: cooldownMs },
                {
                  op: 'set',
                  path: ['scheduleEnabled'],
                  value: scheduleEnabled,
                },
                {
                  op: 'set',
                  path: ['scheduleRules'],
                  value: stripPlaceholderRules(scheduleRules).map(function (rule) {
                    return {
                      targets: rule.targets.slice(),
                      windows: rule.windows.map(function (w) {
                        return {
                          start: w.start,
                          end: w.end,
                          days: (w.days || []).slice(),
                        };
                      }),
                    };
                  }),
                },
              ],
              revision,
            )
            .then(function () {
              setBusy(false);
              discard();
            })
            .catch(function (err) {
              setBusy(false);
              setError(
                err && err.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'failed',
              );
            });
        }

        // 已勾选集合
        var selected = {};
        queue.forEach(function (r) {
          selected[routeKey(r)] = true;
        });

        var children = [];

        children.push(
          h(
            'div',
            { key: 'intro', style: S.hint },
            t('intro'),
          ),
        );

        // 启用开关
        children.push(
          h(
            'label',
            { key: 'enabled', style: S.check },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: !writable || busy,
              onChange: function () {
                beginDraft();
                setDraftEnabled(!enabled);
              },
            }),
            h('span', { style: S.label }, t('enabled')),
            h('span', { style: S.hint }, t('enabledDesc')),
          ),
        );

        // 回退队列
        var queueRows = queue.map(function (r, index) {
          return h(
            'div',
            { key: routeKey(r), style: S.queueRow },
            h('span', { style: S.badge }, t('fallbackN') + ' ' + (index + 1)),
            h(
              'span',
              { style: { flex: 1, fontSize: 13 } },
              r.provider + ' / ' + r.model,
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: !writable || busy || index === 0,
                title: t('moveUp'),
                onClick: function () { move(index, -1); },
              },
              '↑',
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: !writable || busy || index === queue.length - 1,
                title: t('moveDown'),
                onClick: function () { move(index, 1); },
              },
              '↓',
            ),
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: !writable || busy,
                title: t('remove'),
                onClick: function () { removeAt(index); },
              },
              '✕',
            ),
          );
        });
        children.push(
          h(
            'div',
            { key: 'queue', style: S.section },
            h('div', { style: S.label }, t('queue')),
            queue.length === 0
              ? h('div', { style: S.hint }, t('queueEmpty'))
              : h('div', { style: S.section }, queueRows),
          ),
        );

        // 模型目录(搜索 + 限高滚动 + 勾选)
        // 模型目录渲染(picker 复用体):回退队列与时段规则目标共用同一目录
        // 组件(搜索 + 限高滚动 + 勾选),仅选中集 / 点选回调 / 搜索词 / 提示
        // 文案不同;目录数据(cat)两处共享。
        function catalogElement(selectedMap, onToggle, searchText, setSearchText, hintKey) {
        var catalogBody;
        if (cat.status === 'loading') {
          catalogBody = h('div', { style: S.hint }, t('catalogLoading'));
        } else if (cat.status === 'error') {
          catalogBody = h(
            'div',
            { style: S.section },
            h('div', { style: S.hint }, t('catalogError')),
            h(
              'button',
              { type: 'button', style: S.btn, onClick: loadCatalog },
              t('catalogRetry'),
            ),
          );
        } else if (cat.groups.length === 0) {
          catalogBody = h('div', { style: S.hint }, t('catalogEmpty'));
        } else {
          var visibleGroups = filteredCatalogGroups(cat.groups, searchText);
          catalogBody = h(
            'div',
            { style: S.section },
            h('input', {
              type: 'search',
              style: S.searchInput,
              placeholder: t('catalogSearch'),
              'aria-label': t('searchAria'),
              value: searchText,
              onChange: function (event) {
                setSearchText(event.target.value);
              },
            }),
            visibleGroups.length === 0
              ? h('div', { style: S.noMatch }, t('catalogNoMatch'))
              : h(
                  'div',
                  { style: S.catalogScroll },
                  visibleGroups.map(function (group) {
                    return h(
                      'div',
                      { key: group.id, style: S.group },
                      h('div', { style: S.groupTitle }, group.id),
                      group.models.map(function (m) {
                        var key = group.id + '/' + m.id;
                        return h(
                          'label',
                          { key: key, style: S.check },
                          h('input', {
                            type: 'checkbox',
                            checked: selectedMap[key] === true,
                            disabled: !writable || busy,
                            onChange: function () { onToggle(group.id, m.id); },
                          }),
                          h('span', null, m.name || m.id),
                          h('span', { style: S.hint }, m.id),
                        );
                      }),
                    );
                  }),
                ),
          );
        }
          return h(
            'div',
            { style: S.section },
            h('div', { style: S.label }, t('catalog')),
            h('div', { style: S.hint }, t(hintKey)),
            catalogBody,
          );
        }
        children.push(
          h(
            'div',
            { key: 'catalog', style: S.section },
            catalogElement(selected, toggleModel, search, setSearch, 'catalogHint'),
          ),
        );

        // 每候选重试次数(0 = 跟随官方重试预算)
        children.push(
          h(
            'div',
            { key: 'retriesBeforeSwitch', style: S.row },
            h(
              'div',
              null,
              h('div', { style: S.label }, t('retriesBeforeSwitch')),
              h('div', { style: S.hint }, t('retriesHint')),
            ),
            h('input', {
              type: 'number',
              min: 0,
              style: S.input,
              value: String(retriesBefore),
              disabled: !writable || busy,
              onChange: function (event) {
                beginDraft();
                var parsed = Number(event.target.value);
                setDraftRetriesBefore(
                  Number.isFinite(parsed) && parsed >= 0
                    ? Math.floor(parsed)
                    : 0,
                );
              },
            }),
          ),
        );

        // 最大切换候选数
        children.push(
          h(
            'div',
            { key: 'retries', style: S.row },
            h(
              'div',
              null,
              h('div', { style: S.label }, t('maxRetries')),
              h('div', { style: S.hint }, t('maxRetriesHint')),
            ),
            h('input', {
              type: 'number',
              min: 0,
              style: S.input,
              value: String(retries),
              disabled: !writable || busy,
              onChange: function (event) {
                beginDraft();
                var parsed = Number(event.target.value);
                setDraftRetries(Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0);
              },
            }),
          ),
        );

        // 失败候选冷却跳过(开关 + 窗口时长)
        children.push(
          h(
            'label',
            { key: 'cooldownEnabled', style: S.check },
            h('input', {
              type: 'checkbox',
              checked: cooldownEnabled,
              disabled: !writable || busy,
              onChange: function () {
                beginDraft();
                setDraftCooldownEnabled(!cooldownEnabled);
              },
            }),
            h('span', { style: S.label }, t('cooldownEnabled')),
            h('span', { style: S.hint }, t('cooldownEnabledHint')),
          ),
        );
        children.push(
          h(
            'div',
            { key: 'cooldownMs', style: S.row },
            h(
              'div',
              null,
              h('div', { style: S.label }, t('cooldownMs')),
              h('div', { style: S.hint }, t('cooldownMsHint')),
            ),
            h('input', {
              type: 'number',
              min: 0,
              style: S.input,
              value: String(cooldownMs),
              disabled: !writable || busy,
              onChange: function (event) {
                beginDraft();
                var parsed = Number(event.target.value);
                setDraftCooldownMs(
                  Number.isFinite(parsed) && parsed >= 0
                    ? Math.floor(parsed)
                    : 0,
                );
              },
            }),
          ),
        );

        // ── 时段计划(schedule):开关 + 规则编辑 ──────────────────────
        children.push(
          h(
            'label',
            { key: 'scheduleEnabled', style: S.check },
            h('input', {
              type: 'checkbox',
              checked: scheduleEnabled,
              disabled: !writable || busy,
              onChange: function () {
                beginDraft();
                setDraftScheduleEnabled(!scheduleEnabled);
              },
            }),
            h('span', { style: S.label }, t('scheduleEnabled')),
            h('span', { style: S.hint }, t('scheduleEnabledHint')),
          ),
        );

        var ruleRows = scheduleRules.map(function (rule, ruleIndex) {
          var placeholder =
            rule.targets.length === 0 && rule.windows.length === 0;
          var valid = placeholder || ruleValid(rule);
          var selectedMap = {};
          rule.targets.forEach(function (key) {
            selectedMap[key] = true;
          });
          var ruleChildren = [
            h(
              'div',
              { key: 'head', style: S.row },
              h('span', { style: S.badge }, t('scheduleRuleN') + ' ' + (ruleIndex + 1)),
              h(
                'span',
                { style: { flex: 1, fontSize: 13 } },
                rule.targets.length > 0
                  ? rule.targets.join(', ')
                  : t('scheduleTargetsEmpty'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  disabled: !writable || busy,
                  onClick: function () {
                    setOpenRule(openRule === ruleIndex ? -1 : ruleIndex);
                  },
                },
                openRule === ruleIndex
                  ? t('scheduleDoneTargets')
                  : t('scheduleEditTargets'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  disabled: !writable || busy,
                  title: t('scheduleRemoveRule'),
                  onClick: function () { removeScheduleRule(ruleIndex); },
                },
                '✕',
              ),
            ),
          ];
          if (!valid) {
            ruleChildren.push(
              h('div', { key: 'invalid', style: S.hint }, '⚠ ' + t('scheduleInvalid')),
            );
          }
          if (openRule === ruleIndex) {
            ruleChildren.push(
              h(
                'div',
                { key: 'targets', style: S.section },
                catalogElement(
                  selectedMap,
                  function (provider, model) {
                    toggleRuleTarget(ruleIndex, provider, model);
                  },
                  ruleSearch,
                  setRuleSearch,
                  'scheduleTargetsHint',
                ),
              ),
            );
          }
          ruleChildren.push(
            h(
              'div',
              { key: 'windows', style: S.section },
              h('div', { style: S.label }, t('scheduleWindows')),
              rule.windows.map(function (w, windowIndex) {
                var overnight =
                  w.start.length > 0 && w.end.length > 0 && w.start > w.end;
                return h(
                  'div',
                  { key: 'w' + windowIndex, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', { style: S.hint }, t('scheduleStart')),
                  h('input', {
                    type: 'time',
                    style: S.input,
                    value: w.start,
                    disabled: !writable || busy,
                    onChange: function (event) {
                      setScheduleWindowTime(ruleIndex, windowIndex, 'start', event.target.value);
                    },
                  }),
                  h('span', { style: S.hint }, t('scheduleEnd')),
                  h('input', {
                    type: 'time',
                    style: S.input,
                    value: w.end,
                    disabled: !writable || busy,
                    onChange: function (event) {
                      setScheduleWindowTime(ruleIndex, windowIndex, 'end', event.target.value);
                    },
                  }),
                  overnight ? h('span', { style: S.badge }, t('scheduleOvernight')) : null,
                  [1, 2, 3, 4, 5, 6, 7].map(function (day) {
                    var on = (w.days || []).indexOf(day) >= 0;
                    return h(
                      'button',
                      {
                        key: 'd' + day,
                        type: 'button',
                        style: on ? S.chipOn : S.chip,
                        disabled: !writable || busy,
                        title: t('d' + day),
                        onClick: function () {
                          toggleScheduleWindowDay(ruleIndex, windowIndex, day);
                        },
                      },
                      t('d' + day),
                    );
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.btn,
                      disabled: !writable || busy,
                      title: t('remove'),
                      onClick: function () {
                        removeScheduleWindow(ruleIndex, windowIndex);
                      },
                    },
                    '✕',
                  ),
                );
              }),
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  disabled: !writable || busy,
                  onClick: function () { addScheduleWindow(ruleIndex); },
                },
                t('scheduleAddWindow'),
              ),
            ),
          );
          return h('div', { key: 'rule' + ruleIndex, style: S.ruleBox }, ruleChildren);
        });

        children.push(
          h(
            'div',
            { key: 'scheduleRules', style: S.section },
            ruleRows.length > 0 ? h('div', { style: S.section }, ruleRows) : null,
            h(
              'button',
              {
                type: 'button',
                style: S.btn,
                disabled: !writable || busy,
                onClick: addScheduleRule,
              },
              t('scheduleAddRule'),
            ),
          ),
        );

        // 状态 + 操作
        var statusText = null;
        if (!writable) statusText = t('readonly');
        else if (error === 'conflict') statusText = t('conflict');
        else if (error === 'failed') statusText = t('failed');
        else if (busy) statusText = t('saving');
        else if (dirty) statusText = t('dirty');

        children.push(
          h(
            'div',
            { key: 'actions', style: S.row },
            h('div', { style: S.hint }, statusText),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  style: S.btn,
                  disabled: !dirty || busy,
                  onClick: discard,
                },
                t('discard'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: S.primaryBtn,
                  disabled: !dirty || busy || !writable,
                  onClick: save,
                },
                busy ? t('saving') : t('save'),
              ),
            ),
          ),
        );

        return h('div', { style: S.card }, children);
      }

      // 注册进 `plugins.bundle.config` 插槽(keyed,key = **包名**)——这是
      // plugin-manager 的 PackageDetail 页(设置 → 插件 → @zhidal/dsh-llm-fallback)
      // 内部 "the configuration the bundle registered for itself" 的官方渲染位:
      //   renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
      // 且仅当 ledger 里存在 key === pkg.name 的注册时才显示该 data-plugin-config 区块。
      // (曾试过 plugins.item——那是 ItemCard 独立配置页的插槽,与官方
      //   settings-subagent/shell/web-search 一样会渲染成独立区块,不符合
      //   "嵌在本插件页内"的诉求,已改用 bundle.config。)
      var PKG_NAME = '@zhidal/dsh-llm-fallback';
      ctx.effect(function () {
        return ctx.configForms.whileServed([ENTRY_NS], function () {
          return ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: PKG_NAME,
                locale: DICT_NS,
                inject: function () {
                  return { t: t };
                },
              },
              Card,
            );
          });
        });
      }, 'llm-fallback: package config section');
    }

    var exports = {};
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 纯函数与字典一并导出:client-bundle.test.ts 在 vm 沙箱里执行 factory 后
    // 直接对搜索过滤 / 字典键集 / 语言跟随行为做单元断言(loader 只读
    // name/inject/apply,多余导出对宿主无影响)。
    exports.modelMatches = modelMatches;
    exports.filteredCatalogGroups = filteredCatalogGroups;
    exports.cloneRules = cloneRules;
    exports.sameRules = sameRules;
    exports.ruleValid = ruleValid;
    exports.stripPlaceholderRules = stripPlaceholderRules;
    exports.DICT = DICT;
    module.exports = exports;
    return module.exports;
  },
});
