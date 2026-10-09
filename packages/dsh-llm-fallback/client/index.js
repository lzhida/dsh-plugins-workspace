/**
 * dsh-llm-fallback client bundle — 手写零构建 CJS-in-factory。
 *
 * 设置 → 插件 → dsh-llm-fallback 的配置卡片:
 * - 启用开关;
 * - **模型勾选**:候选池来自 `ctx.remote.session.modelCatalog()`(宿主已配置
 *   provider 的模型目录,按 provider 分组),勾选即加入回退队列;
 * - **排序**:已选队列可上移/下移/移除,顺序即回退优先级(首项=主模型);
 * - **最大回退次数**(maxRetries,0 = 链长);
 * - 回退时机(fallbackWhen)。
 *
 * 为什么需要客户端包:宿主 `@deepseek-ai/dsh-settings` 的 `describe()` 只投影
 * `.volatile()` 字段给"自带页面的客户端",而 dsh 0.2.0-rc.2 **没有**通用的
 * schema→页面自动生成客户端(`autoGenerate` 在已发布客户端中无实现),因此
 * 配置 UI 必须由插件自带 client 注册进 Plugins 页的 `plugins.item` 插槽。
 *
 * 读写走 `ctx.configForms.get(entryId)`(namespace = profile 条目 id),
 * 与一方插件 dsh-client-ui-settings-subagent 同路径:
 *   scope.getSnapshot() -> { status, value, writable, revision }
 *   scope.mutate([{op:'set', path, value}], revision)
 *
 * 样式用内联样式,不依赖 dsh 的 CSS modules 哈希类名(版本升级不失效)。
 */
globalThis.__ModuleLoader__.load({
  // id 必须与 package.json 包名一致,否则 boot graph arrive() 抛
  // "loaded without registering"。
  id: '@lzhida/dsh-llm-fallback',
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
          '主模型失败时按队列顺序自动切换到下一个模型(对话不中断)。队列首项 = 主模型。',
        enabled: '启用',
        enabledDesc: '关闭后不再拦截模型失败',
        queue: '回退队列(可上移/下移调整顺序)',
        queueEmpty: '尚未选择模型;请在下方勾选可用模型。',
        primary: '主模型',
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
        maxRetries: '最大回退次数',
        maxRetriesHint: '0 = 按队列长度(跑完全部候选才报错)',
        fallbackWhen: '回退时机',
        afterRetry: '官方重试耗尽后(afterRetry)',
        immediately: '一次失败立即切换(immediately)',
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
          'When the primary model fails, the next model in the queue is tried automatically (the conversation is not interrupted). The first entry is the primary model.',
        enabled: 'Enabled',
        enabledDesc: 'When off, model failures are no longer intercepted',
        queue: 'Fallback queue (move up/down to reorder)',
        queueEmpty: 'No model selected yet — check models below.',
        primary: 'Primary',
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
        maxRetries: 'Max fallbacks',
        maxRetriesHint: '0 = queue length (try every candidate before failing)',
        fallbackWhen: 'Fallback timing',
        afterRetry: 'After official retry budget (afterRetry)',
        immediately: 'Switch on first failure (immediately)',
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

    // ── 内联样式(不依赖哈希类名)──────────────────────────────────
    var S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '4px 0',
      },
      section: { display: 'flex', flexDirection: 'column', gap: 8 },
      label: { fontWeight: 600, fontSize: 13 },
      hint: { fontSize: 12, opacity: 0.65 },
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
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 6,
      },
      badge: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.35)',
        opacity: 0.9,
        whiteSpace: 'nowrap',
      },
      btn: {
        cursor: 'pointer',
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
      },
      primaryBtn: {
        cursor: 'pointer',
        padding: '5px 14px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'rgba(96,140,255,0.9)',
        color: '#fff',
        fontSize: 13,
      },
      group: { display: 'flex', flexDirection: 'column', gap: 4 },
      groupTitle: { fontSize: 12, opacity: 0.7, marginTop: 4 },
      check: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        cursor: 'pointer',
      },
      input: {
        width: 90,
        padding: '3px 6px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
      },
      notice: { fontSize: 13, opacity: 0.75 },
    };

    function apply(ctx) {
      var t = ctx.locale.bind(DICT_NS);
      ctx.effect(function () {
        return ctx.locale.register(DICT_NS, DICT);
      }, 'llm-fallback: dictionaries');

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
        var draftWhenState = useState(null);
        var draftWhen = draftWhenState[0];
        var setDraftWhen = draftWhenState[1];
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

        var value = (snap.value || {});
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
        var when =
          draftWhen === null ? value.fallbackWhen || 'afterRetry' : draftWhen;
        var dirty =
          enabled !== (value.enabled !== false) ||
          !sameQueue(queue, currentQueue) ||
          retries !== Number(value.maxRetries || 0) ||
          when !== (value.fallbackWhen || 'afterRetry');

        function beginDraft() {
          if (draftQueue === null) {
            setDraftEnabled(value.enabled !== false);
            setDraftQueue(currentQueue.map(function (r) { return { provider: r.provider, model: r.model }; }));
            setDraftRetries(Number(value.maxRetries || 0));
            setDraftWhen(value.fallbackWhen || 'afterRetry');
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

        function discard() {
          setDraftEnabled(null);
          setDraftQueue(null);
          setDraftRetries(null);
          setDraftWhen(null);
          setDraftRev(null);
          setError(null);
        }

        function save() {
          if (busy || !writable) return;
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
                { op: 'set', path: ['fallbackWhen'], value: when },
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
            h('span', { style: S.badge }, index === 0 ? t('primary') : t('fallbackN') + ' ' + index),
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

        // 模型目录(勾选)
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
          catalogBody = h(
            'div',
            { style: S.section },
            cat.groups.map(function (group) {
              return h(
                'div',
                { key: group.id, style: S.group },
                h('div', { style: S.groupTitle }, group.id),
                (group.models || []).map(function (m) {
                  var key = group.id + '/' + m.id;
                  return h(
                    'label',
                    { key: key, style: S.check },
                    h('input', {
                      type: 'checkbox',
                      checked: selected[key] === true,
                      disabled: !writable || busy,
                      onChange: function () { toggleModel(group.id, m.id); },
                    }),
                    h('span', null, m.name || m.id),
                    h('span', { style: S.hint }, m.id),
                  );
                }),
              );
            }),
          );
        }
        children.push(
          h(
            'div',
            { key: 'catalog', style: S.section },
            h('div', { style: S.label }, t('catalog')),
            h('div', { style: S.hint }, t('catalogHint')),
            catalogBody,
          ),
        );

        // 最大回退次数
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

        // 回退时机
        children.push(
          h(
            'div',
            { key: 'when', style: S.row },
            h('div', { style: S.label }, t('fallbackWhen')),
            h(
              'select',
              {
                style: S.input,
                value: when,
                disabled: !writable || busy,
                onChange: function (event) {
                  beginDraft();
                  setDraftWhen(event.target.value);
                },
              },
              h('option', { value: 'afterRetry' }, t('afterRetry')),
              h('option', { value: 'immediately' }, t('immediately')),
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
      // plugin-manager 的 PackageDetail 页(设置 → 插件 → @lzhida/dsh-llm-fallback)
      // 内部 "the configuration the bundle registered for itself" 的官方渲染位:
      //   renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
      // 且仅当 ledger 里存在 key === pkg.name 的注册时才显示该 data-plugin-config 区块。
      // (曾试过 plugins.item——那是 ItemCard 独立配置页的插槽,与官方
      //   settings-subagent/shell/web-search 一样会渲染成独立区块,不符合
      //   "嵌在本插件页内"的诉求,已改用 bundle.config。)
      var PKG_NAME = '@lzhida/dsh-llm-fallback';
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
    module.exports = exports;
    return module.exports;
  },
});
