/**
 * guided-goal client bundle — 手写零构建 CJS-in-factory。
 *
 * Settings → Guided Goal 配置面板:Enable 开关(命令启停)。
 * 读写走 ctx.settingsScope(bind settings.namespace,host 持久化);
 * 面板文案走 ctx.locale(浏览器语言自适应);命令文案语言跟随
 * dsh 全局语言设置(host 侧 resolveLanguage 读取 locale namespace)。
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
            loading: '正在载入配置…',
            unavailable: '配置存储不可用',
            readonly: '只读连接,无法修改',
          },
          en: {
            nav: 'Guided Goal',
            enable: 'Enable commands',
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
          'label',
          {
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
            h(
              'span',
              {
                style: {
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 400,
                  opacity: 0.6,
                },
              },
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
