/**
 * guided-goal client bundle — 手写零构建 CJS-in-factory。
 *
 * Settings → 引导式目标 配置面板:两条命令的独立启停。
 * - 行式布局与控件复用 dsh 原生设置页的 CSS modules 全局类
 *   (oY77xG_row/rowText/title/desc/selector,同版本内稳定;
 *   dsh 升级若 hash 变化,面板退化为无样式,不影响功能)。
 * - 读写走 ctx.settingsScope(bind settings.namespace,host 持久化);
 * - 面板文案走 ctx.locale(浏览器语言自适应);命令文案语言跟随
 *   dsh 全局语言设置(host 侧 resolveLanguage 读取 locale namespace)。
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
            nav: '引导式目标',
            enabledTitle: '引导式目标命令',
            enabledDesc: '/guided-goal:直接输入走访谈创建,quick 子命令快速创建',
            on: '已启用',
            off: '已关闭',
            loading: '正在载入配置…',
            unavailable: '配置存储不可用',
            readonly: '只读连接,无法修改',
          },
          en: {
            nav: 'Guided Goal',
            enabledTitle: 'Guided goal command',
            enabledDesc:
              '/guided-goal: plain input runs the interview; the quick subcommand creates without one',
            on: 'Enabled',
            off: 'Disabled',
            loading: 'Loading settings…',
            unavailable: 'Settings storage unavailable',
            readonly: 'Read-only connection; settings cannot be changed',
          },
        });
      }, 'guided-goal: dictionaries');
      var t = ctx.locale.bind('guided-goal');

      var scope = ctx.settingsScope.bind({ namespace: 'guided-goal' });

      // 原生设置行的行式结构:row > rowText(title+desc) + 右侧 selector 按钮。
      // 类名为 dsh 原生设置页的 CSS modules 全局类(同版本内稳定)。
      function Row(props) {
        var title = props.title;
        var desc = props.desc;
        var on = props.on;
        var disabled = props.disabled;
        var onToggle = props.onToggle;
        var stateText = on ? t('on') : t('off');
        return h(
          'div',
          {
            className: 'oY77xG_row',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            },
          },
          h(
            'div',
            { className: 'oY77xG_rowText' },
            h('div', { className: 'oY77xG_title' }, title),
            h('div', { className: 'oY77xG_desc' }, desc),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'oY77xG_selector',
              disabled: disabled,
              onClick: onToggle,
              style: { opacity: disabled ? 0.5 : 1 },
            },
            stateText,
          ),
        );
      }

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
          return h(
            'div',
            { className: 'oY77xG_row' },
            h('div', { className: 'oY77xG_desc' }, notice),
          );
        }

        var value = snap.value;
        var disabled = !snap.writable;
        var readonlyTip = disabled ? t('readonly') : null;

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h(Row, {
            title: t('enabledTitle'),
            desc: t('enabledDesc'),
            on: value.enabled !== false,
            disabled: disabled,
            onToggle: function () {
              scope.set('enabled', value.enabled === false);
            },
          }),
          readonlyTip
            ? h('div', { className: 'oY77xG_desc' }, readonlyTip)
            : null,
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
