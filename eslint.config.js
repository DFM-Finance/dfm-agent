import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // scripts/ are Node build/CI utilities (not shipped src); they're validated
    // by being executed (smoke-signing.mjs runs in `npm test` + the publish CI),
    // not by lint, and use Node globals the src tsconfig doesn't declare.
    ignores: ['dist/', 'node_modules/', 'scripts/'],
  },
);
