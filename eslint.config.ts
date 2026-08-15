import {
    markdownProcessorConfig,
    typeCheckedConfig,
    typescriptConfig,
} from '@yutengjing/eslint-config-typescript';
import { defineConfig, globalIgnores } from 'eslint/config';
import n from 'eslint-plugin-n';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

import caxri from './scripts/eslint-rules/index';

const typescriptFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const javaScriptAndTypeScriptFiles = [
    '**/*.js',
    '**/*.jsx',
    '**/*.mjs',
    '**/*.cjs',
    ...typescriptFiles,
];
/**
 * Directories whose production/tooling code may run child processes at all (the Renderer is out of scope: it already
 * bans importing `child_process` outright via the Renderer `no-restricted-imports` config below).
 */
const shellExecutionScopedDirectories = [
    'src/main/**',
    'src/host/**',
    'src/preload/**',
    'src/runtime/**',
    'src/shared/**',
    'scripts/**',
    '.agents/**',
    'e2e/**',
    'packages/*/src/**',
];

export default defineConfig(
    globalIgnores([
        '**/dist/**',
        'logs',
        'out',
        'release',
        'node_modules',
        /**
         * Generated Go and Acceptance evidence can contain temporary TypeScript outside tsconfig.
         */
        '.records/**',
        'test-results',
        /**
         * Shallow clones of third-party repos for competitive research; never lint someone else's project config.
         */
        'competitors/**',
        /**
         * `@yutengjing/eslint-config-basic` scopes a `no-console`/`no-process-exit` override to `**\/scripts/**\/*.*`,
         * which (as an unrestricted `files` pattern) broadens the overall file-discovery superset to any extension
         * under a `scripts/` directory. Because the shared preset's TypeScript `languageOptions` block has no `files`
         * filter of its own, that superset makes ESLint try to parse this shell script with the TypeScript parser and
         * crash. Shell scripts were never meant to be JS/TS-linted; there is exactly one in the repository.
         */
        '**/*.sh',
        /**
         * Negative fixtures for `scripts/__tests__/eslint-toolchain-contract.test.ts`: they exist solely to trip
         * specific rules and would otherwise fail this repository's own `--max-warnings=0` gate. The contract test
         * lints them directly with `ignore: false`.
         */
        'scripts/fixtures/eslint/**',
        /**
         * Negative fixtures for `scripts/__tests__/markdown-toolchain-contract.test.ts`: the fenced TypeScript block is
         * deliberately invalid so the contract test can prove ESLint's markdown processor catches it. The contract test
         * lints this file directly with `ignore: false`.
         */
        'scripts/fixtures/markdown/**',
        /**
         * `.claude/skills` is a compatibility symlink to `.agents/skills` (see AGENTS.md); linting both paths would
         * just duplicate every finding under the canonical `.agents/skills` tree.
         */
        '.claude/**',
    ]),
    /**
     * `typescriptConfig` covers the shared basic + import-x + TypeScript recommended rules; `typeCheckedConfig` layers
     * `recommendedTypeChecked` with `projectService: true` and disables type-aware rules on the processor's virtual
     * `**\/*.md/**` children (they cannot be resolved by `projectService`). `markdownProcessorConfig` turns fenced
     * JS/TS code blocks in `*.md` files into virtual files the rest of this config lints; it deliberately replaces the
     * default export's document-level `markdownRulesConfig` (Markdown semantics belong to markdownlint — see
     * `.markdownlint-cli2.jsonc` — not ESLint) per https://github.com/tjx666/caxri/issues/177.
     */
    typescriptConfig,
    typeCheckedConfig,
    markdownProcessorConfig,
    reactHooks.configs.flat['recommended-latest'],
    {
        files: typescriptFiles,
        languageOptions: {
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        plugins: {
            'react-refresh': reactRefresh,
        },
        rules: {
            'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }],
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
        },
    },
    {
        files: javaScriptAndTypeScriptFiles,
        rules: {
            'unicorn/filename-case': [
                'error',
                {
                    case: 'kebabCase',
                    /**
                     * `__tests__` is a directory-role convention documented in AGENTS.md, not a naming violation.
                     */
                    ignore: [/^__tests__$/],
                },
            ],
        },
    },
    {
        files: typescriptFiles,
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },
    {
        /**
         * Scoped separately from `consistent-type-imports` above: this rule requires type information, and
         * `markdownProcessorConfig`'s virtual `**\/*.md/**` code-block children also match `typescriptFiles` (they end
         * in `.ts`/`.tsx`). Without this `ignores`, this override would re-enable a type-aware rule that
         * `typeCheckedConfig`'s `markdownProcessorTypeCheckedConfig` deliberately turns off for those virtual files
         * (they cannot be resolved by `projectService`), because later config entries win.
         */
        files: typescriptFiles,
        ignores: ['**/*.md/**'],
        rules: {
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
        },
    },
    {
        files: ['**/package.json'],
        rules: {
            /**
             * Eslint-plugin-node-dependencies@2.2.0 crashes with `TypeError: aVer.compare is not a function` while
             * merging this repository's `engines.node` ranges across dependencies (upstream bug in its semver-range
             * normalization, not a real violation). Re-enable once the upstream plugin ships a fix.
             */
            'node-dependencies/compat-engines': 'off',
        },
    },
    {
        files: ['src/renderer/src/components/ui/dialog.tsx'],
        rules: {
            /**
             * Shadcn compound components intentionally share one module.
             */
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
             * The renderer must never reach Node.js, Electron, PTY, Git, or filesystem APIs directly; it may only use
             * the typed `window.caxri` bridge exposed by preload. See AGENTS.md "Architecture boundaries".
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
            /**
             * Repository-level Renderer contracts inspect source from Vitest's Node environment.
             */
            'no-restricted-imports': 'off',
        },
    },
    {
        files: javaScriptAndTypeScriptFiles,
        rules: {
            /**
             * `eslint-config-prettier` (already composed into the shared preset) only disables core and `@stylistic`
             * rules that conflict with Prettier's own formatting; it does not cover `eslint-plugin-jsdoc`. Prettier
             * reformats `/** ... *\/` block comments (including the `{/** ... *\/}` form used for JSX-embedded doc
             * comments) in a way `jsdoc/check-alignment` disagrees with, so the two fight indefinitely on every `bun
             * run format` pass. Prettier owns formatting; this rule is the one Prettier-formatting-conflict category
             * the shared-preset migration allows disabling.
             */
            'jsdoc/check-alignment': 'off',
        },
    },
    {
        files: ['src/host/**', 'src/main/**', 'src/preload/**', 'src/runtime/**', 'src/shared/**'],
        rules: {
            /**
             * `@shared/*` and `@/*` aliases are declared only in `tsconfig.web.json` (the Renderer TypeScript project,
             * per AGENTS.md "Architecture guardrails"); Main, Preload, Runtime, Host, and shared Node code must use
             * relative imports so they keep resolving under the Node/Electron module loader. This also bans
             * `child_process`'s shell-string `exec`/`execSync` (arbitrary command strings) everywhere they are imported
             * from; structured argv `spawn`/`execFile` (see AGENTS.md "Forbidden") stays allowed.
             */
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@shared', '@shared/*', '@/*'],
                            message:
                                '@shared/* and @/* aliases exist only for the Renderer (tsconfig.web.json); use a relative import here.',
                        },
                    ],
                    paths: [
                        {
                            name: 'child_process',
                            importNames: ['exec', 'execSync'],
                            message:
                                'child_process exec/execSync run an arbitrary shell string; use structured argv spawn/execFile instead.',
                        },
                        {
                            name: 'node:child_process',
                            importNames: ['exec', 'execSync'],
                            message:
                                'child_process exec/execSync run an arbitrary shell string; use structured argv spawn/execFile instead.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['scripts/**', '.agents/**', 'e2e/**', 'packages/*/src/**'],
        rules: {
            /**
             * Same shell-string ban as the Main/Preload/Runtime/Host/shared config above, scoped separately so this
             * object's `no-restricted-imports` entry (a distinct, non-overlapping `files` set) does not need to repeat
             * the alias-ban patterns that only make sense for Desktop source under `src/`.
             */
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'child_process',
                            importNames: ['exec', 'execSync'],
                            message:
                                'child_process exec/execSync run an arbitrary shell string; use structured argv spawn/execFile instead.',
                        },
                        {
                            name: 'node:child_process',
                            importNames: ['exec', 'execSync'],
                            message:
                                'child_process exec/execSync run an arbitrary shell string; use structured argv spawn/execFile instead.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: shellExecutionScopedDirectories,
        ignores: ['**/*.tsx'],
        rules: {
            /**
             * Bans the `spawn`/`execFile` `shell: true` option, which turns a structured argv call back into
             * shell-string execution. Scoped to non-`.tsx` files so this object's `no-restricted-syntax` entry never
             * collides with the separate `src/**\/*.tsx` default-export-ban config object above (flat config replaces,
             * rather than merges, a later matching object's same-named rule).
             */
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        ':matches(CallExpression[callee.name=/^(?:spawn|execFile)$/], CallExpression[callee.property.name=/^(?:spawn|execFile)$/]) > ObjectExpression > Property[key.name="shell"][value.value=true]',
                    message:
                        'spawn/execFile with shell: true runs an arbitrary shell string; pass argv as an array without shell: true instead.',
                },
            ],
        },
    },
    {
        files: [
            'src/main/**/*.ts',
            'src/runtime/**/*.ts',
            'src/shared/node/**/*.ts',
            'packages/cli/src/**/*.ts',
            'scripts/**/*.ts',
            '.agents/**/scripts/**/*.ts',
        ],
        ignores: ['**/*.test.ts', '**/__tests__/**'],
        plugins: {
            n,
        },
        rules: {
            /**
             * AGENTS.md "Code conventions": prefer asynchronous Node.js APIs over `*Sync` variants in Main, Runtime,
             * and tooling code; test code is exempt. A deliberately synchronous production boundary needs a comment
             * justifying it (`// eslint-disable-next-line n/no-sync -- <reason>`).
             */
            'n/no-sync': 'error',
        },
    },
    {
        files: ['src/**/*.tsx', 'scripts/fixtures/eslint/*-fixture.tsx'],
        ignores: [
            '**/main.tsx',
            '**/process-explorer-main.tsx',
            '**/index.tsx',
            '**/*.test.tsx',
            '**/*.stories.tsx',
        ],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/filename-export-mapping': 'error',
        },
    },
    {
        files: ['src/**/use-*.ts', 'scripts/fixtures/eslint/use-*-fixture.ts'],
        ignores: ['**/*.test.ts', '**/__tests__/**'],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/filename-export-mapping': 'error',
        },
    },
);
