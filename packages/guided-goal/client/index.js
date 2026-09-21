/**
 * guided-goal client bundle — 手写零构建 CJS-in-factory。
 *
 * Settings → Guided Goal 配置面板:Enable 开关 + 命令文案语言选择。
 * 读写走 ctx.settingsScope(bind settings.namespace,host 持久化);
 * 面板文案走 ctx.locale(浏览器语言自适应)。
 * react 与 @deepseek-ai/* client 服务由宿主模块表解析(dsh.client.inject)。
 */
globalThis.__ModuleLoader__.load({
  // id 必须与 package.json 包名一致,否则 boot graph arrive() 抛
  // "loaded without registering"。
  id: '@dsh-plugins/guided-goal',
  factory: (require) => {
    var module = { exports: {} };
    var h = require('react').createElement;
    var useState = require('react').useState;
    var useEffect = require('react').useEffect;

    var name = 'guided-goal';
    var inject = ['slots', 'locale', 'settingsScope'];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register('guided-goal', {
          zh: {
            nav: '目标引导 Goal',
            enable: '启用命令',
            language: '命令文案语言',
            langAuto: '跟随浏览器(双语)',
            langZh: '中文',
            langEn: 'English',
            loading: '正在载入配置…',
            unavailable: '配置存储不可用',
            readonly: '只读连接,无法修改',
          },
          en: {
            nav: 'Guided Goal',
            enable: 'Enable commands',
            language: 'Command text language',
            langAuto: 'Follow browser (bilingual)',
            langZh: '中文',
            langEn: 'English',
            loading: 'Loading settings…',
            unavailable: 'Settings storage unavailable',
            readonly: 'Read-only connection; settings cannot be changed',
          },
        });
      }, 'guided-goal: dictionaries');
      var t = ctx.locale.bind('guided-goal');

      var scope = ctx.settingsScope.bind({ namespace: 'guided-goal' });

      function Form() {
        var snapState = useState(scope.getSnapshot());
        var snap = snapState[0];
        var setSnap = snapState[1];

        useEffect(
          function () {
            return scope.subscribe(function () {
              setSnap(scope.getSnapshot());
            });
          },
          [scope],
        );

        if (snap.status !== 'ready' || !snap.value) {
          var notice =
            snap.status === 'unavailable' ? t('unavailable') : t('loading');
          return h('div', { style: { fontSize: 13, opacity: 0.7 } }, notice);
        }

        var value = snap.value;
        var disabled = !snap.writable;

        return h(
          'div',
          null,
          h(
            'label',
            {
              key: 'enable',
              style: {
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                marginBottom: 12,
              },
            },
            h('input', {
              type: 'checkbox',
              checked: value.enabled !== false,
              disabled: disabled,
              onChange: function (event) {
                scope.set('enabled', event.target.checked);
              },
            }),
            h(
              'span',
              { style: { fontSize: 13, fontWeight: 600 } },
              t('enable'),
            ),
          ),
          h(
            'label',
            {
              key: 'language',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                marginBottom: 12,
              },
            },
            h(
              'span',
              { style: { fontSize: 12, fontWeight: 600, opacity: 0.8 } },
              t('language'),
            ),
            h(
              'select',
              {
                style: {
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--dsh-border, #ccc)',
                  font: 'inherit',
                },
                value: value.language || 'auto',
                disabled: disabled,
                onChange: function (event) {
                  scope.set('language', event.target.value);
                },
              },
              h('option', { value: 'auto' }, t('langAuto')),
              h('option', { value: 'zh' }, t('langZh')),
              h('option', { value: 'en' }, t('langEn')),
            ),
            h(
              'span',
              { style: { fontSize: 11, opacity: 0.6 } },
              'guided-goal / quick-goal',
            ),
          ),
        );
      }

      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'guided-goal',
              order: 42,
              label: function () {
                return t('nav');
              },
              locale: 'guided-goal',
              inject: function () {
                return { t: t };
              },
            },
            function () {
              return h(Form);
            },
          );
        });
      }, 'guided-goal: settings section');
    }

    var exports = {};
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    module.exports = exports;
    return module.exports;
  },
});
