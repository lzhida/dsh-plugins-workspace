/**
 * guided-goal client bundle — handwritten, zero-build CJS-in-factory form.
 *
 * Served by dsh's client-modules subsystem at /plugins/guided-goal/client.js
 * via the `dsh.client` declaration and `exports["./client"]` in package.json.
 * The bundle MUST exist on disk as final JS (a missing file answers 404);
 * being handwritten satisfies that contract without any build step.
 *
 * Registers a "settings.section" slot rendering the guided-goal wizard form.
 * react and @deepseek-ai/* client services resolve from the host module table
 * (declared via dsh.client.inject). Browser globals are reached through
 * globalThis so the file stays lint-clean under node globals.
 */
globalThis.__ModuleLoader__.load({
  // id 必须与 package.json 包名一致:boot graph row 与 __ModuleLoader__ 注册
  // 以包名为键对齐,不一致时 arrive() 抛 "loaded without registering"。
  id: '@dsh-plugins/guided-goal',
  factory: (require) => {
    var module = { exports: {} };
    var h = require('react').createElement;
    var useState = require('react').useState;
    var useEffect = require('react').useEffect;

    var name = 'guided-goal';
    var inject = ['slots', 'locale'];

    var FIELD = {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      marginBottom: 12,
    };
    var LABEL = { fontSize: 12, fontWeight: 600, opacity: 0.8 };
    var CONTROL = {
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsh-border, #ccc)',
      font: 'inherit',
    };
    var HINT = { fontSize: 11, opacity: 0.6 };
    var STATUS = {
      marginTop: 8,
      fontSize: 12,
      whiteSpace: 'pre-wrap',
      minHeight: 16,
    };
    var BUTTON = {
      alignSelf: 'flex-start',
      padding: '6px 14px',
      borderRadius: 6,
      border: 'none',
      cursor: 'pointer',
      font: 'inherit',
      fontWeight: 600,
    };

    var FIELDS = [
      {
        key: 'objective',
        label: '目标 Objective',
        placeholder: '要完成什么,一句话',
        multiline: true,
      },
      {
        key: 'successCriteria',
        label: '成功标准 Success criteria',
        placeholder: '可判定的完成信号(测试通过 / 命令退出码 0 / 文件存在…)',
        multiline: true,
      },
      {
        key: 'verification',
        label: '验证方式 Verification',
        placeholder: '验证所用的确切命令或动作',
      },
      {
        key: 'boundaries',
        label: '范围边界 Boundaries',
        placeholder: '允许触碰 / 明确禁止触碰的路径',
      },
      {
        key: 'stopConditions',
        label: '停止条件 Stop conditions',
        placeholder: '何时停下并交还人工',
      },
      {
        key: 'maxGoalRounds',
        label: '轮次上限 maxGoalRounds(可选)',
        placeholder: '留空使用默认 256',
      },
    ];

    function fetchSessions(setSessions, setStatus) {
      fetch('/api/guided-goal/sessions')
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          setSessions((data && data.sessions) || []);
        })
        .catch(function (e) {
          setStatus('载入会话失败: ' + e.message);
        });
    }

    function Form() {
      var sessionsState = useState([]);
      var sessions = sessionsState[0];
      var setSessions = sessionsState[1];
      var statusState = useState('正在载入会话…');
      var status = statusState[0];
      var setStatus = statusState[1];

      useEffect(function () {
        fetchSessions(setSessions, setStatus);
      }, []);

      function submit(event) {
        event.preventDefault();
        var data = new FormData(event.currentTarget);
        var fields = {};
        var missing = null;
        FIELDS.forEach(function (f) {
          var value = String(data.get(f.key) || '').trim();
          if (f.key === 'objective' || f.key === 'successCriteria') {
            if (!value) missing = f.label;
          }
          fields[f.key] = value;
        });
        var sessionId = String(data.get('sessionId') || '');
        if (missing) {
          setStatus('必填未填: ' + missing);
          return;
        }
        if (!sessionId) {
          setStatus('无可选会话,先在会话页打开一个会话');
          return;
        }

        fetch('/api/guided-goal/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dsh-guided-goal': '1',
          },
          body: JSON.stringify({ sessionId: sessionId, fields: fields }),
        })
          .then(function (r) {
            return r.json().then(function (b) {
              return { ok: r.ok, body: b };
            });
          })
          .then(function (res) {
            setStatus(
              res.ok
                ? res.body.message || '已提交创建请求'
                : '失败: ' +
                    (res.body && res.body.error ? res.body.error : res.body),
            );
          })
          .catch(function (e) {
            setStatus('请求失败: ' + e.message);
          });
      }

      return h(
        'form',
        {
          onSubmit: submit,
          style: { display: 'flex', flexDirection: 'column' },
        },
        FIELDS.map(function (f) {
          return h(
            'label',
            { key: f.key, style: FIELD },
            h('span', { style: LABEL }, f.label),
            f.multiline
              ? h('textarea', {
                  name: f.key,
                  style: Object.assign({}, CONTROL, {
                    minHeight: 64,
                    resize: 'vertical',
                  }),
                  placeholder: f.placeholder,
                })
              : h('input', {
                  name: f.key,
                  style: CONTROL,
                  placeholder: f.placeholder,
                }),
          );
        }),
        h(
          'label',
          { style: FIELD },
          h('span', { style: LABEL }, '目标会话'),
          h(
            'select',
            { name: 'sessionId', style: CONTROL },
            sessions.map(function (s) {
              return h('option', { key: s.id, value: s.id }, s.title || s.id);
            }),
          ),
          h(
            'span',
            { style: HINT },
            '列出当前活跃会话;提交后向该会话注入创建指令',
          ),
        ),
        h('button', { type: 'submit', style: BUTTON }, '创建 Goal'),
        h('div', { style: STATUS }, status),
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              fetchSessions(setSessions, setStatus);
            },
            style: Object.assign({}, BUTTON, {
              background: 'transparent',
              fontWeight: 400,
              fontSize: 11,
            }),
          },
          '刷新会话列表',
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register('guided-goal', {
          zh: { nav: '目标引导 Goal' },
          en: { nav: 'Guided Goal' },
        });
      }, 'guided-goal: dictionaries');
      var t = ctx.locale.bind('guided-goal');

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
