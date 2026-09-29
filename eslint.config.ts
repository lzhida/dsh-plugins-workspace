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
      // 提交的客户端打包产物（esbuild 生成，见 packages/*/scripts/build-client.ts）
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
);
