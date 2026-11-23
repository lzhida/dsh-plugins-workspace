import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.agents/**',
      // 提交的客户端打包产物（esbuild 生成，见 plugins/*/scripts/build-client.ts）
      '**/web/app.js',
      '**/client/index.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/web/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // vendored 上游源码（Apache-2.0，逐字保留，见 plugins/dsh-taskboard/docs/local-changes.md）：
    // 关闭推荐规则集，只保留解析检查——任何改写都会让 vendored 副本与上游产生无谓 diff，
    // 破坏「按上游版本重新 vendoring 时可逐字比对」的可维护性。
    // src/local/** 是本仓自有代码，仍受全量规则约束。
    files: ['plugins/dsh-taskboard/src/**'],
    ignores: ['plugins/dsh-taskboard/src/local/**'],
    rules: Object.fromEntries(
      [
        ...Object.keys(js.configs.recommended.rules ?? {}),
        ...tseslint.configs.recommended.flatMap((config) =>
          Object.keys(config.rules ?? {}),
        ),
      ].map((rule) => [rule, 'off']),
    ),
  },
);
