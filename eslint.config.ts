import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores(['dist', 'logs', 'out', 'release', 'node_modules', 'test-results']),
    eslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    reactHooks.configs.flat.recommended,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            'react-refresh': reactRefresh,
        },
        rules: {
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
        },
    },
    {
        files: ['src/renderer/src/components/ui/dialog.tsx'],
        rules: {
            /** shadcn compound components intentionally share one module. */
            'react-refresh/only-export-components': 'off',
        },
    },
);
