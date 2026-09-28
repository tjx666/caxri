import { markdownProcessorConfig, typescriptConfig } from '@yutengjing/eslint-config-typescript';
import { defineConfig, globalIgnores } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

import {
    browserUnsafeImports,
    transitionalCycleAllowances,
} from './scripts/architecture-boundaries';
import caxri from './scripts/eslint-rules/index';

const typescriptFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const javaScriptAndTypeScriptFiles = [
    '**/*.js',
    '**/*.jsx',
    '**/*.mjs',
    '**/*.cjs',
    ...typescriptFiles,
];
const rendererUnsafePackageImports = browserUnsafeImports.flatMap((specifier) =>
    specifier === 'electron' ? [] : [specifier, `${specifier}/*`],
);
/**
 * Directories whose production/tooling code may run child processes at all (the Renderer is out of scope: it already
 * bans importing `child_process` outright via the Renderer `no-restricted-imports` config below).
 */
const shellExecutionScopedDirectories = [
    'apps/cli/src/**',
    'apps/desktop/src/main/**',
    'apps/desktop/src/preload/**',
    'apps/desktop/src/shared/**',
    'apps/server/src/**',
    'extensions/**',
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
        'release.noindex',
        'node_modules',
        /**
         * Expo prebuild output is native generated code. Local Android and iOS builds recreate these gitignored roots;
         * repository lint must inspect the config plugins that produce them, not Gradle, CocoaPods, or Xcode output.
         */
        'apps/mobile/android/**',
        'apps/mobile/ios/**',
        /**
         * Generated Go and Acceptance evidence can contain temporary TypeScript outside tsconfig.
         */
        '.records/**',
        'test-results',
        /**
         * Local tool caches, including Sonda bundle-analysis reports (`CAXRI_BUNDLE_ANALYZE=1`), whose generated
         * HTML/JSON payloads must never be linted.
         */
        '.cache/**',
        /**
         * Shallow clones of third-party repos for competitive research; never lint someone else's project config.
         */
        'competitors/**',
        /**
         * `@yutengjing/eslint-config-basic` scopes a `no-console`/`no-process-exit` override to `**\/scripts/**\/*.*`,
         * which (as an unrestricted `files` pattern) broadens the overall file-discovery superset to every extension
         * under a `scripts/` directory. Because the shared preset's TypeScript `languageOptions` block has no `files`
         * filter of its own, ESLint would try to parse native helpers with the TypeScript parser and crash. Shell and
         * Swift sources have their own compilers and were never meant to be JS/TS-linted; binary font assets, such as
         * the mobile Terminal fonts under `apps/mobile/scripts/terminal-fonts/`, fail with "Parsing error: Invalid
         * character"; SVG assets, such as the mobile file-icon overrides under
         * `apps/mobile/scripts/file-icon-overrides/`, fail with "Parsing error: '>' expected".
         */
        '**/*.{sh,svg,swift,ttf,otf,woff,woff2}',
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
         * Vendored Oxlint plugin source follows its upstream style and is exercised by the Oxlint contract test instead
         * of being recursively linted by itself or by ESLint.
         */
        'tools/oxlint/anti-slop/**',
        /**
         * Negative fixture for the refactor Acceptance validator: the mismatched closing fence is intentional so the
         * test can prove that trailing fence info cannot expose a hidden plan. ESLint otherwise parses the deliberately
         * malformed fixture as a virtual TypeScript module before the validator test can consume it as plain text.
         */
        '.agents/skills/file-issue/scripts/__fixtures__/refactor-acceptance/fence-trailing-info-bypass.txt',
        /**
         * `.claude/skills` is a compatibility symlink to `.agents/skills` (see AGENTS.md); linting both paths would
         * just duplicate every finding under the canonical `.agents/skills` tree.
         */
        '.claude/**',
        /**
         * The design-prototype runtime manifest resolves its `@/` imports through esbuild `--alias` flags in
         * `build-runtime.ts`, not tsconfig paths. This mirrors the type-aware lint exclusion in `.oxlintrc.json`.
         */
        '.agents/skills/design-prototype/assets/entry.mjs',
        /**
         * Gitignored design-prototype runtime artifacts: the bundled/vendored minified `.js` files that
         * `build-runtime.ts` writes and caches beside the tracked `entry.mjs` source.
         */
        '.agents/skills/design-prototype/assets/*.js',
        /**
         * The design-prototype HTML template's inline scripts are deliberate browser-global shims plus a `text/babel`
         * TSX block ESLint cannot parse; `scripts/verify-prototype.ts` validates the template end-to-end in a real
         * browser instead.
         */
        '.agents/skills/design-prototype/references/template.html',
    ]),
    /**
     * `typescriptConfig` covers the shared basic + import-x + TypeScript recommended rules (syntactic only). Type-aware
     * linting is deliberately NOT composed here: every rule that needs type information runs through `oxlint
     * --type-aware` (`.oxlintrc.json`, backed by tsgolint) instead, so ESLint never pays the `projectService`
     * type-checking cost. `markdownProcessorConfig` turns fenced JS/TS code blocks in `*.md` files into virtual files
     * the rest of this config lints; it deliberately replaces the default export's document-level `markdownRulesConfig`
     * (Markdown semantics belong to markdownlint — see `.markdownlint-cli2.jsonc` — not ESLint) per
     * https://github.com/tjx666/caxri/issues/177.
     */
    typescriptConfig,
    markdownProcessorConfig,
    reactHooks.configs.flat['recommended-latest'],
    {
        files: typescriptFiles,
        rules: {
            /**
             * Syntactic rules the repository previously received through `typeCheckedConfig` (`recommendedTypeChecked`
             * is a superset of `recommended`); re-enabled explicitly now that the type-aware layer moved to oxlint.
             */
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-namespace': 'error',
            '@typescript-eslint/no-unused-vars': 'error',
            '@typescript-eslint/triple-slash-reference': 'error',
        },
    },
    {
        files: javaScriptAndTypeScriptFiles,
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
                     * `__tests__` is a directory-role convention documented in source-layout. `SKILL.md` and
                     * `README.md` are required entrypoint names — the skill loader and npm respectively — that fenced
                     * snippets inherit as their physical filename.
                     */
                    ignore: [/^__tests__$/, /^SKILL\.md$/, /^README\.md$/],
                },
            ],
            /**
             * Prettier never inserts blank lines between class members. Require a blank line on either side of a
             * method; consecutive fields may stay packed, and TypeScript overload signatures stay adjacent.
             */
            '@stylistic/lines-between-class-members': [
                'error',
                {
                    enforce: [
                        { blankLine: 'always', prev: 'method', next: '*' },
                        { blankLine: 'always', prev: '*', next: 'method' },
                    ],
                },
                { exceptAfterOverload: true },
            ],
        },
    },
    {
        files: javaScriptAndTypeScriptFiles,
        plugins: {
            caxri,
        },
        rules: {
            'caxri/architecture-boundaries': 'error',
        },
    },
    {
        files: [
            'apps/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
            'packages/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
            'scripts/fixtures/eslint/architecture/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
        ],
        plugins: {
            'import-x': importX,
        },
        rules: {
            /**
             * Target workspaces must stay acyclic from the first source movement onward.
             */
            'import-x/no-cycle': ['error', { ignoreExternal: true }],
        },
    },
    ...(transitionalCycleAllowances.length > 0
        ? [
              {
                  files: transitionalCycleAllowances.flatMap(({ files }) => [...files]),
                  rules: {
                      'import-x/no-cycle': 'off' as const,
                  },
              },
          ]
        : []),
    {
        files: typescriptFiles,
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },
    {
        files: javaScriptAndTypeScriptFiles,
        rules: {
            /**
             * These unicorn rules consult type information when parserServices are available and fall back to
             * aggressive syntax-only heuristics when they are not. ESLint deliberately runs without typed linting (the
             * type-aware layer lives in oxlint — see .oxlintrc.json), and in untyped mode each of these produced
             * confirmed false positives on this repository (a non-Array `.push()` receiver, a string `.slice()` treated
             * as an ArrayBuffer view, an intentional boolean-to-boolean `!==` comparison).
             */
            'unicorn/no-chained-comparison': 'off',
            'unicorn/no-computed-property-existence-check': 'off',
            'unicorn/no-return-array-push': 'off',
            'unicorn/no-unsafe-buffer-conversion': 'off',
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
        files: ['apps/desktop/src/renderer/src/components/ui/dialog.tsx'],
        rules: {
            /**
             * Shadcn compound components intentionally share one module.
             */
            'react-refresh/only-export-components': 'off',
        },
    },
    {
        files: ['apps/desktop/src/renderer/**/*.tsx'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'ExportDefaultDeclaration',
                    message: 'Use a named export for React components and modules.',
                },
                /**
                 * Main's `setWindowOpenHandler` denies every `window.open`/`target="_blank"` navigation (see
                 * `apps/desktop/src/main/index.ts`), so a raw `target="_blank"` anchor never actually opens anything.
                 * Route external navigation through `openExternalUrl`
                 * (`apps/desktop/src/renderer/src/lib/external-link.ts`), which calls `external.open`.
                 */
                {
                    selector: 'JSXAttribute[name.name="target"][value.value="_blank"]',
                    message:
                        'target="_blank" anchors never navigate (Main denies window.open); use openExternalUrl from apps/desktop/src/renderer/src/lib/external-link.ts instead.',
                },
            ],
        },
    },
    {
        files: ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx'],
        rules: {
            /**
             * The renderer must never reach Node.js, Electron, PTY, Git, or filesystem APIs directly; it may only use
             * the typed `window.caxri` bridge exposed by preload. See AGENTS.md product invariants and the
             * project-architecture skill.
             */
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@caxri/system', '@caxri/system/*'],
                            message:
                                '@caxri/system is not browser-safe; the Renderer must use a typed protocol or Desktop bridge.',
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
                            group: rendererUnsafePackageImports,
                            message:
                                'The renderer must never import platform-only packages directly; use the typed window.caxri bridge.',
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ['apps/desktop/src/renderer/__tests__/*.test.ts'],
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
            /**
             * The shared preset runs `check-line-alignment` in `never` mode with an empty `wrapIndent`, so a tag
             * description that wraps must continue flush with the `*`. `prettier-plugin-jsdoc` re-wraps that same
             * description with a two-space hanging indent, and `lint-staged` runs Prettier after `eslint --fix`, so the
             * committed file carried a warning that only CI's `--max-warnings=0` reported. Declaring Prettier's hanging
             * indent as the expected `wrapIndent` makes both tools converge on one layout.
             */
            'jsdoc/check-line-alignment': ['warn', 'never', { wrapIndent: '  ' }],
        },
    },
    {
        files: [
            'apps/cli/src/**',
            'apps/desktop/src/main/**',
            'apps/desktop/src/preload/**',
            'apps/desktop/src/shared/**',
            'apps/server/src/**',
            'extensions/**',
            'packages/system/src/**',
        ],
        rules: {
            /**
             * The `@/*` alias is declared only in the Renderer TypeScript project. CLI, Desktop platform/shared,
             * Server, extensions, and system code must use public package imports or relative imports so they keep
             * resolving under their process module loaders. This also bans `child_process`'s shell-string
             * `exec`/`execSync` (arbitrary command strings) everywhere they are imported from; structured argv
             * `spawn`/`execFile` (see project-architecture) stays allowed.
             */
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@/*'],
                            message:
                                '@/* exists only for the Renderer; use a public package or relative import here.',
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
    /**
     * The `n/no-sync` ban moved to oxlint (`node/no-sync` in .oxlintrc.json): eslint-plugin-n v18 requires typed
     * linting for it, and ESLint here is deliberately syntactic-only. A deliberately synchronous production boundary
     * still needs a justifying comment (`// oxlint-disable-next-line node/no-sync -- <reason>`).
     */
    {
        files: [
            'apps/desktop/src/**/*.tsx',
            'src/**/*.tsx',
            'scripts/fixtures/eslint/*-fixture.tsx',
        ],
        ignores: [
            '**/main.tsx',
            '**/process-explorer-main.tsx',
            '**/agent-commander-main.tsx',
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
        files: [
            'apps/desktop/src/**/use-*.ts',
            'src/**/use-*.ts',
            'scripts/fixtures/eslint/use-*-fixture.ts',
        ],
        ignores: ['**/*.test.ts', '**/__tests__/**'],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/filename-export-mapping': 'error',
        },
    },
    /**
     * Feature-directory scale contract (`.agents/skills/source-layout/SKILL.md` section 3): tests, feature-local hooks,
     * and utils stay flat below three files of the kind and earn `__tests__/` / `hooks/` / `utils/` at three.
     */
    {
        files: [
            'apps/desktop/src/renderer/src/features/**/*.{ts,tsx}',
            'scripts/fixtures/eslint/feature-structure/**/*.{ts,tsx}',
        ],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/feature-directory-structure': 'error',
        },
    },
    /**
     * Server-state contract (`.agents/skills/react/SKILL.md` section 4): a read that resolves into component state is
     * lost on every remount. It started at the View Container runtime, where views are keyed by Session and a
     * contributed view inherits whatever the shared tree and controlled-view implementations do, then grew through the
     * dialogs (#797) and the remaining feature directories (#899) until every Renderer feature was covered. The scope
     * is now `features/**` rather than a directory list: a new feature is inside the contract from its first commit,
     * which is the only version of this rule that cannot be outgrown again.
     */
    {
        files: [
            'apps/desktop/src/renderer/src/features/**/*.{ts,tsx}',
            'scripts/fixtures/eslint/view-container-reads/**/*.{ts,tsx}',
        ],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/server-reads-through-query': 'error',
        },
    },
    /**
     * DESIGN.md principle 5 claimed unregistering Tailwind's palette made a literal color utility fail the build. It
     * does not: Tailwind simply emits no rule, so `bg-white` stays on the element and styles nothing. Three such class
     * names had already survived into the bundle, one of them the quiet zone around the pairing QR code. This rule is
     * the check the comment described.
     */
    {
        files: [
            'apps/desktop/src/renderer/src/**/*.{ts,tsx}',
            'scripts/fixtures/eslint/color-utilities/**/*.ts',
        ],
        plugins: {
            caxri,
        },
        rules: {
            'caxri/registered-color-utilities': 'error',
        },
    },
);
