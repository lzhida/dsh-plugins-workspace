/* eslint-disable */
globalThis.__ModuleLoader__.load({
  id: '@dsh-plugins/guided-goal',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ('use strict');
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name2 in all)
        __defProp(target, name2, { get: all[name2], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if ((from && typeof from === 'object') || typeof from === 'function') {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, {
              get: () => from[key],
              enumerable:
                !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
            });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (
      (target = mod != null ? __create(__getProtoOf(mod)) : {}),
      __copyProps(
        // If the importer is in node compatibility mode or this is not an ESM
        // file that has been converted to a CommonJS file using a Babel-
        // compatible transform (i.e. "__esModule" has not been set), then set
        // "default" to the CommonJS "module.exports" for node compatibility.
        isNodeMode || !mod || !mod.__esModule
          ? __defProp(target, 'default', { value: mod, enumerable: true })
          : target,
        mod,
      )
    );
    var __toCommonJS = (mod) =>
      __copyProps(__defProp({}, '__esModule', { value: true }), mod);

    // client/src/index.tsx
    var index_exports = {};
    __export(index_exports, {
      apply: () => apply,
      inject: () => inject,
      name: () => name,
    });
    module.exports = __toCommonJS(index_exports);
    var React = __toESM(require('react'), 1);
    var { createElement: createElement2, useEffect, useState } = React;
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
        label: '\u76EE\u6807 Objective',
        placeholder: '\u8981\u5B8C\u6210\u4EC0\u4E48,\u4E00\u53E5\u8BDD',
        multiline: true,
      },
      {
        key: 'successCriteria',
        label: '\u6210\u529F\u6807\u51C6 Success criteria',
        placeholder:
          '\u53EF\u5224\u5B9A\u7684\u5B8C\u6210\u4FE1\u53F7(\u6D4B\u8BD5\u901A\u8FC7 / \u547D\u4EE4\u9000\u51FA\u7801 0 / \u6587\u4EF6\u5B58\u5728\u2026)',
        multiline: true,
      },
      {
        key: 'verification',
        label: '\u9A8C\u8BC1\u65B9\u5F0F Verification',
        placeholder:
          '\u9A8C\u8BC1\u6240\u7528\u7684\u786E\u5207\u547D\u4EE4\u6216\u52A8\u4F5C',
      },
      {
        key: 'boundaries',
        label: '\u8303\u56F4\u8FB9\u754C Boundaries',
        placeholder:
          '\u5141\u8BB8\u89E6\u78B0 / \u660E\u786E\u7981\u6B62\u89E6\u78B0\u7684\u8DEF\u5F84',
      },
      {
        key: 'stopConditions',
        label: '\u505C\u6B62\u6761\u4EF6 Stop conditions',
        placeholder: '\u4F55\u65F6\u505C\u4E0B\u5E76\u4EA4\u8FD8\u4EBA\u5DE5',
      },
      {
        key: 'maxGoalRounds',
        label: '\u8F6E\u6B21\u4E0A\u9650 maxGoalRounds(\u53EF\u9009)',
        placeholder: '\u7559\u7A7A\u4F7F\u7528\u9ED8\u8BA4 256',
      },
    ];
    function fetchSessions(setSessions, setStatus) {
      fetch('/api/guided-goal/sessions')
        .then((r) => r.json())
        .then((data) => {
          setSessions(data?.sessions ?? []);
        })
        .catch((e) => {
          setStatus('\u8F7D\u5165\u4F1A\u8BDD\u5931\u8D25: ' + e.message);
        });
    }
    function Form() {
      const [sessions, setSessions] = useState([]);
      const [status, setStatus] = useState(
        '\u6B63\u5728\u8F7D\u5165\u4F1A\u8BDD\u2026',
      );
      useEffect(function onLoad() {
        fetchSessions(setSessions, setStatus);
      }, []);
      function submit(event) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const fields = {};
        let missing = null;
        FIELDS.forEach((f) => {
          const value = String(data.get(f.key) ?? '').trim();
          if (
            (f.key === 'objective' || f.key === 'successCriteria') &&
            !value
          ) {
            missing = f.label;
          }
          fields[f.key] = value;
        });
        const sessionId = String(data.get('sessionId') ?? '');
        if (missing) {
          setStatus('\u5FC5\u586B\u672A\u586B: ' + missing);
          return;
        }
        if (!sessionId) {
          setStatus(
            '\u65E0\u53EF\u9009\u4F1A\u8BDD,\u5148\u5728\u4F1A\u8BDD\u9875\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD',
          );
          return;
        }
        fetch('/api/guided-goal/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dsh-guided-goal': '1',
          },
          body: JSON.stringify({ sessionId, fields }),
        })
          .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
          .then((res) => {
            setStatus(
              res.ok
                ? (res.body.message ??
                    '\u5DF2\u63D0\u4EA4\u521B\u5EFA\u8BF7\u6C42')
                : '\u5931\u8D25: ' +
                    (res.body.error ?? JSON.stringify(res.body)),
            );
          })
          .catch((e) => {
            setStatus('\u8BF7\u6C42\u5931\u8D25: ' + e.message);
          });
      }
      return /* @__PURE__ */ React.createElement(
        'form',
        {
          onSubmit: submit,
          style: { display: 'flex', flexDirection: 'column' },
        },
        FIELDS.map((f) =>
          /* @__PURE__ */ React.createElement(
            'label',
            { key: f.key, style: FIELD },
            /* @__PURE__ */ React.createElement(
              'span',
              { style: LABEL },
              f.label,
            ),
            f.multiline
              ? /* @__PURE__ */ React.createElement('textarea', {
                  name: f.key,
                  style: { ...CONTROL, minHeight: 64, resize: 'vertical' },
                  placeholder: f.placeholder,
                })
              : /* @__PURE__ */ React.createElement('input', {
                  name: f.key,
                  style: CONTROL,
                  placeholder: f.placeholder,
                }),
          ),
        ),
        /* @__PURE__ */ React.createElement(
          'label',
          { style: FIELD },
          /* @__PURE__ */ React.createElement(
            'span',
            { style: LABEL },
            '\u76EE\u6807\u4F1A\u8BDD',
          ),
          /* @__PURE__ */ React.createElement(
            'select',
            { name: 'sessionId', style: CONTROL },
            sessions.map((s) =>
              /* @__PURE__ */ React.createElement(
                'option',
                { key: s.id, value: s.id },
                s.title || s.id,
              ),
            ),
          ),
          /* @__PURE__ */ React.createElement(
            'span',
            { style: HINT },
            '\u5217\u51FA\u5F53\u524D\u6D3B\u8DC3\u4F1A\u8BDD;\u63D0\u4EA4\u540E\u5411\u8BE5\u4F1A\u8BDD\u6CE8\u5165\u521B\u5EFA\u6307\u4EE4',
          ),
        ),
        /* @__PURE__ */ React.createElement(
          'button',
          { type: 'submit', style: BUTTON },
          '\u521B\u5EFA Goal',
        ),
        /* @__PURE__ */ React.createElement('div', { style: STATUS }, status),
        /* @__PURE__ */ React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              fetchSessions(setSessions, setStatus);
            },
            style: {
              ...BUTTON,
              background: 'transparent',
              fontWeight: 400,
              fontSize: 11,
            },
          },
          '\u5237\u65B0\u4F1A\u8BDD\u5217\u8868',
        ),
      );
    }
    function apply(ctx) {
      ctx.effect(function registerDictionaries() {
        return ctx.locale.register('guided-goal', {
          zh: { nav: '\u76EE\u6807\u5F15\u5BFC Goal' },
          en: { nav: 'Guided Goal' },
        });
      }, 'guided-goal: dictionaries');
      const t = ctx.locale.bind('guided-goal');
      ctx.effect(function injectSettingsSection() {
        return ctx.slots.inject('settings.section', function registerSection() {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'guided-goal',
              order: 42,
              label: () => t('nav'),
              locale: 'guided-goal',
              inject: () => ({ t }),
            },
            () => createElement2(Form),
          );
        });
      }, 'guided-goal: settings section');
    }
    return module.exports;
  },
});
