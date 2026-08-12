import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default defineConfig(
    globalIgnores([
        'dist',
        'logs',
        'out',
        'release',
        'node_modules',
        /** Generated Go and Acceptance evidence can contain temporary TypeScript outside tsconfig. */
        '.records/**',
        'test-results',
        /** Shallow clones of third-party repos for competitive research; never lint someone else's project config. */
        'competitors/**',
    ]),
    eslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    reactHooks.configs.flat['recommended-latest'],
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
            'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }],
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
    {
        files: ['src/**/*.tsx'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'ExportDefaultDeclaration',
                    message: 'Use a named export for React components and modules.',
                },
            ],
        },
    },
    {
        files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
        rules: {
            /**
             * The renderer must never reach Node.js, Electron, PTY, Git, or filesystem APIs directly;
             * it may only use the typed `window.caxri` bridge exposed by preload. See AGENTS.md
             * "Architecture boundaries".
             */
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/shared/node/**', '@shared/node*', '@shared/node/**'],
                            message:
                                'src/shared/node is Node-only (main/runtime); the renderer must never import it.',
                        },
                        {
                            group: ['electron', 'electron/*'],
                            message:
                                'The renderer must never import Electron APIs directly; use the typed window.caxri bridge.',
                        },
                        {
                            group: ['node:*'],
                            message:
                                'The renderer must never import Node.js builtins directly; use the typed window.caxri bridge.',
                        },
                        {
                            group: ['fs', 'path', 'child_process', 'os'],
                            message:
                                'The renderer must never import Node.js builtins directly; use the typed window.caxri bridge.',
                        },
                        {
                            group: ['node-pty', 'better-sqlite3'],
                            message:
                                'The renderer must never import native modules directly; use the typed window.caxri bridge.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['src/renderer/__tests__/*.test.ts'],
        rules: {
            /** Repository-level Renderer contracts inspect source from Vitest's Node environment. */
            'no-restricted-imports': 'off',
        },
    },
);
