import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { formatSource } from '../format-source';

const root = resolve(import.meta.dirname, '../..');

async function lint(path: string) {
    // These fixtures are deliberately excluded from the repository's own lint gate via
    // `globalIgnores` (see eslint.config.ts); `ignore: false` bypasses that here so the test can
    // still observe them being linted.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result;
}

async function lintAll(paths: string[]) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    return eslint.lintFiles(paths);
}

async function lintSource(path: string, source: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintText(source, { filePath: resolve(root, path) });
    return result;
}

/**
 * `ESLint#calculateConfigForFile` is typed as `Promise<any>` (there is no narrower public type), so this local shape is
 * asserted explicitly rather than relying on the untyped return value.
 */
interface EffectiveConfig {
    rules?: Record<string, [number, ...unknown[]] | undefined>;
}

async function effectiveConfigFor(path: string): Promise<EffectiveConfig> {
    const eslint = new ESLint({ cwd: root });
    return (await eslint.calculateConfigForFile(resolve(root, path))) as EffectiveConfig;
}

describe('shared ESLint preset toolchain contract', () => {
    it('rejects application imports of bundled extension implementation', async () => {
        const paths = [
            'apps/desktop/src/main/extension-import.ts',
            'apps/desktop/src/renderer/src/extension-import.ts',
            'apps/server/src/core/extension-import.ts',
            'apps/cli/src/extension-import.ts',
        ];
        const results = await Promise.all(
            paths.map((path) => {
                const specifier = relative(dirname(path), 'extensions/status/src/extension.ts');
                return lintSource(path, `import '${specifier}';`);
            }),
        );
        for (const result of results)
            expect(result.messages.map(({ messageId }) => messageId)).toContain(
                'extensionImplementationImport',
            );
    });

    it('preserves extension public API and build artifact composition imports', async () => {
        const results = await Promise.all([
            lintSource('apps/server/src/core/extension-contract.ts', "import 'caxri';"),
            lintSource(
                'scripts/extension-build.ts',
                "import '../extensions/status/src/extension';",
            ),
        ]);
        for (const result of results)
            expect(result.messages.map(({ messageId }) => messageId)).not.toContain(
                'extensionImplementationImport',
            );
    });

    it('keeps ESLint syntactic-only: type-aware rules stay with oxlint, not ESLint', async () => {
        // Type-aware linting moved to `oxlint --type-aware` (see .oxlintrc.json and
        // scripts/__tests__/oxlint-toolchain-contract.test.ts). ESLint must neither fire nor even
        // configure these rules, or it would silently re-pay the projectService type-check cost.
        const result = await lint('scripts/fixtures/eslint/type-aware-violation.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).not.toContain('@typescript-eslint/no-floating-promises');
        expect(ruleIds).not.toContain('@typescript-eslint/no-unsafe-assignment');

        const config = await effectiveConfigFor('apps/desktop/src/main/index.ts');
        expect(config.rules?.['@typescript-eslint/no-floating-promises']).toBeUndefined();
        expect(config.rules?.['@typescript-eslint/no-misused-promises']).toBeUndefined();
    });

    it('flags a non-kebab-case filename via unicorn/filename-case', async () => {
        const result = await lint('scripts/fixtures/eslint/NotKebabCaseFixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('unicorn/filename-case');
    });

    it('converges with the formatter on a wrapped JSDoc tag description', async () => {
        // `lint-staged` runs `bun fmt` again after `eslint --fix`, and `caxri/jsdoc-format` wraps a
        // multi-line `@returns` description with a hanging indent; `jsdoc/check-line-alignment` must
        // accept that layout, or a locally green commit reaches CI carrying a `--max-warnings=0`
        // failure.
        const path = 'scripts/fixtures/eslint/wrapped-jsdoc-tag.ts';
        const filePath = resolve(root, path);
        const source = [
            '/**',
            ' * @returns A cancel function to call when the editor unmounts, so a diff the user navigated away from cannot report',
            ' * a recovery for a surface that no longer exists.',
            ' */',
            'export function probe(): () => void {',
            '    return () => {};',
            '}',
            '',
        ].join('\n');
        const fixer = new ESLint({ cwd: root, fix: true, ignore: false });
        const [fixed] = await fixer.lintText(source, { filePath });
        const formatted = await formatSource(fixed.output ?? source, filePath);

        const [relinted] = await new ESLint({ cwd: root, ignore: false }).lintText(formatted, {
            filePath,
        });
        expect(relinted.messages.map(({ ruleId }) => ruleId)).not.toContain(
            'jsdoc/check-line-alignment',
        );
        expect(relinted.messages.map(({ ruleId }) => ruleId)).not.toContain('caxri/jsdoc-format');
        expect(formatted).toContain(
            ' * @returns A cancel function to call when the editor unmounts, so a diff the user navigated away from cannot report a\n *   recovery',
        );
        // Both tools must agree on one layout: another formatter pass changes nothing.
        await expect(formatSource(formatted, filePath)).resolves.toBe(formatted);
    });

    it('keeps Caxri-specific boundary rules active on a representative renderer file', async () => {
        const config = await effectiveConfigFor('apps/desktop/src/renderer/src/app.tsx');

        // Caxri-specific overrides layered on top of the shared preset.
        expect(config.rules?.['max-lines']?.[1]).toMatchObject({ max: 800 });
        expect(config.rules?.['no-restricted-imports']?.[0]).toBe(2);
        expect(config.rules?.['no-restricted-syntax']?.[0]).toBe(2);
        expect(
            (config.rules?.['no-restricted-syntax']?.[1] as { selector?: string }).selector,
        ).toBe('ExportDefaultDeclaration');

        // `eslint-plugin-react-hooks` v7 `recommended-latest` (including the React Compiler-backed
        // checks the repo relies on via `babel-plugin-react-compiler`) and `eslint-plugin-react-refresh`
        // are not part of the shared preset; they must remain wired exactly as before the migration.
        expect(config.rules?.['react-hooks/rules-of-hooks']?.[0]).toBe(2);
        // Compiler-backed checks introduced in `eslint-plugin-react-hooks` v7's `recommended-latest`.
        expect(config.rules?.['react-hooks/purity']?.[0]).toBe(2);
        expect(config.rules?.['react-hooks/set-state-in-render']?.[0]).toBe(2);
        expect(config.rules?.['react-refresh/only-export-components']?.[0]).toBe(1);

        // Shared-preset coverage the migration adopted must also be present on the same file.
        // (Type-aware rules such as no-floating-promises deliberately absent: they run via oxlint.)
        expect(config.rules?.['unicorn/filename-case']?.[0]).toBe(2);
        expect(config.rules?.['import-x/order']).toBeDefined();
    });

    it('bans default exports on Desktop .tsx files', async () => {
        const config = await effectiveConfigFor('apps/desktop/src/renderer/src/app.tsx');
        const noRestrictedSyntax = config.rules?.['no-restricted-syntax'] as [
            number,
            { selector?: string; message?: string },
        ];

        expect(noRestrictedSyntax[0]).toBe(2);
        expect(noRestrictedSyntax[1].selector).toBe('ExportDefaultDeclaration');
    });

    it('keeps generated workspace and packaging output outside source linting', async () => {
        const eslint = new ESLint({ cwd: root });

        await expect(eslint.isPathIgnored(resolve(root, 'out/main/index.js'))).resolves.toBe(true);
        await expect(
            eslint.isPathIgnored(resolve(root, 'release.noindex/caxri.dmg')),
        ).resolves.toBe(true);
    });

    it('keeps native script helpers outside TypeScript source linting', async () => {
        const eslint = new ESLint({ cwd: root });

        await expect(
            eslint.isPathIgnored(resolve(root, 'scripts/mobile-acceptance-privacy.swift')),
        ).resolves.toBe(true);
    });

    it('keeps binary font assets under a scripts directory outside source linting', async () => {
        const eslint = new ESLint({ cwd: root });

        await expect(
            eslint.isPathIgnored(
                resolve(root, 'apps/mobile/scripts/terminal-fonts/JetBrainsMono-Regular.woff2'),
            ),
        ).resolves.toBe(true);
    });

    it('does not apply source line limits to generated migration metadata', async () => {
        const config = await effectiveConfigFor(
            'apps/server/src/domains/db/migrations/meta/0016_snapshot.json',
        );

        expect(config.rules?.['max-lines']).toBeUndefined();
    });

    it('bans the Renderer alias outside the Renderer', async () => {
        const config = await effectiveConfigFor('apps/server/src/domains/index.ts');
        const noRestrictedImports = config.rules?.['no-restricted-imports'] as [
            number,
            { patterns?: Array<{ group?: string[] }> },
        ];

        expect(noRestrictedImports[0]).toBe(2);
        expect(noRestrictedImports[1].patterns?.[0]?.group).toEqual(['@/*']);
    });

    it('bans child_process exec/execSync everywhere they are imported from', async () => {
        const result = await lint('scripts/fixtures/eslint/child-process-exec-fixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('no-restricted-imports');
    });

    it('covers every executable application and extension source root with shell-string guards', async () => {
        const roots = [
            'apps/cli/src/shell-guard.ts',
            'apps/desktop/src/shared/shell-guard.ts',
            'extensions/fixture/src/shell-guard.ts',
        ];
        for (const path of roots) {
            // eslint-disable-next-line no-await-in-loop -- each synthetic path verifies a distinct flat-config scope
            const result = await lintSource(
                path,
                "import { exec, spawn } from 'node:child_process'; exec('unsafe'); spawn('tool', [], { shell: true });",
            );
            const ruleIds = result.messages.map((message) => message.ruleId);
            expect(ruleIds, path).toContain('no-restricted-imports');
            expect(ruleIds, path).toContain('no-restricted-syntax');
        }
    });

    it('bans spawn/execFile with shell: true', async () => {
        const result = await lint('scripts/fixtures/eslint/spawn-shell-true-fixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('no-restricted-syntax');
    });

    it('rejects application-to-application source imports', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/architecture/apps/desktop/src/renderer/src/bad-app-import.ts',
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('enforces Server process and Domain layers from the first import', async () => {
        const results = await lintAll([
            'scripts/fixtures/eslint/architecture/apps/server/src/domains/bad-terminal-host-import.ts',
            'scripts/fixtures/eslint/architecture/apps/server/src/domains/cross-layer.test.ts',
            'scripts/fixtures/eslint/architecture/apps/server/src/terminal-host/bad-domain-import.ts',
            'scripts/fixtures/eslint/architecture/apps/server/src/extension-host/bad-core-import.ts',
            'scripts/fixtures/eslint/architecture/apps/server/src/observability/bad-core-import.ts',
        ]);

        expect(results).toHaveLength(5);
        for (const result of results)
            expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
                'caxri/architecture-boundaries',
            );
    });

    it('rejects package-private source imports from consumers', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/architecture/apps/desktop/src/renderer/src/bad-package-private-import.ts',
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('enforces the reviewed package dependency direction', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/architecture/apps/desktop/src/renderer/src/bad-package-dependency.ts',
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('rejects CommonJS require calls that cross an application boundary', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/architecture/apps/desktop/src/renderer/src/bad-require-import.ts',
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('rejects platform imports from browser-safe packages', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/architecture/packages/protocol/src/bad-browser-import.ts',
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('leaves Promise.withResolvers to tests in the ES2022 Mobile runtime', async () => {
        const source = `
let release = (): void => {};
const released = new Promise<void>((resolve) => {
    release = resolve;
});
export { release, released };
`;
        const [runtime, test] = await Promise.all([
            lintSource('apps/mobile/src/release-latch.ts', source),
            lintSource('apps/mobile/src/__tests__/release-latch.test.ts', source),
        ]);
        expect(runtime.messages.map(({ ruleId }) => ruleId)).not.toContain(
            'unicorn/prefer-promise-with-resolvers',
        );
        expect(test.messages.map(({ ruleId }) => ruleId)).toContain(
            'unicorn/prefer-promise-with-resolvers',
        );
    });

    it('rejects platform imports across both mobile runtime roots', async () => {
        const cases = [
            ['apps/mobile/src/node-prefixed-import.ts', 'node:fs'],
            ['apps/mobile/app/node-bare-import.ts', 'fs'],
            ['apps/mobile/src/electron-import.ts', 'electron'],
            ['apps/mobile/app/node-pty-import.ts', 'node-pty'],
            ['apps/mobile/src/sqlite-import.ts', 'better-sqlite3'],
            ['apps/mobile/app/watcher-import.ts', '@parcel/watcher'],
            ['apps/mobile/src/web-socket-package-import.ts', 'ws'],
        ] as const;
        const results = await Promise.all(
            cases.map(([path, specifier]) => lintSource(path, `import '${specifier}';`)),
        );

        for (const [index, result] of results.entries())
            expect(
                result.messages.map(({ ruleId }) => ruleId),
                cases[index]?.[0],
            ).toContain('caxri/architecture-boundaries');
    });

    it('allows static contract tests to inspect browser source with Node APIs', async () => {
        const results = await Promise.all([
            lintSource(
                'apps/desktop/src/renderer/__tests__/source-contract.test.ts',
                "import { readFile } from 'node:fs/promises'; void readFile;",
            ),
            lintSource(
                'apps/mobile/src/__tests__/source-contract.test.ts',
                "import { readFile } from 'node:fs/promises'; void readFile;",
            ),
        ]);

        for (const result of results)
            expect(result.messages.map(({ ruleId }) => ruleId)).not.toContain(
                'caxri/architecture-boundaries',
            );
    });

    it('ignores Expo native build output during repository lint', async () => {
        const eslint = new ESLint({ cwd: root });
        const androidOutput = resolve(root, 'apps/mobile/android/build/generated.js');
        const iosOutput = resolve(root, 'apps/mobile/ios/Pods/generated.js');
        const ignored = await Promise.all([
            eslint.isPathIgnored(androidOutput),
            eslint.isPathIgnored(iosOutput),
        ]);

        expect(ignored).toEqual([true, true]);
    });

    it('keeps every shared browser-unsafe dependency out of Renderer source', async () => {
        const results = await Promise.all(
            ['ws', '@parcel/watcher'].map((specifier) =>
                lintSource(
                    `apps/desktop/src/renderer/src/${specifier.replace('/', '-')}-import.ts`,
                    `import '${specifier}';`,
                ),
            ),
        );

        for (const result of results)
            expect(result.messages.map(({ ruleId }) => ruleId)).toContain('no-restricted-imports');
    });

    it('keeps the platform-only Client supervisor out of browser code', async () => {
        const result = await lintSource(
            'scripts/fixtures/eslint/architecture/apps/desktop/src/renderer/src/platform-client-import.ts',
            "import '@caxri/client/supervise';",
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('reserves node:net in Server Core and the Client supervisor for the Mobile gateway', async () => {
        const [rejected, bare, supervisor, gateway, preview, test] = await Promise.all([
            lintSource('apps/server/src/core/control-socket.ts', "import 'node:net';"),
            lintSource('apps/server/src/core/control-socket.ts', "import 'net';"),
            lintSource('packages/client/src/supervise/control-socket.ts', "import 'node:net';"),
            lintSource('apps/server/src/core/mobile/gateway/gateway.ts', "import 'node:net';"),
            lintSource('apps/server/src/core/mobile/preview/proxy.ts', "import 'node:net';"),
            lintSource(
                'apps/server/src/core/__tests__/control-socket.test.ts',
                "import 'node:net';",
            ),
        ]);
        const boundaryIds = (result: ESLint.LintResult) =>
            result.messages.map(({ ruleId }) => ruleId);

        for (const result of [rejected, bare, supervisor])
            expect(boundaryIds(result)).toContain('caxri/architecture-boundaries');
        for (const result of [gateway, preview, test])
            expect(boundaryIds(result)).not.toContain('caxri/architecture-boundaries');
    });

    it('keeps test-only package seams out of production source', async () => {
        const result = await lintSource(
            'scripts/fixtures/eslint/architecture/apps/server/src/test-only-import.ts',
            "import '@caxri/agent-skills/testing';",
        );

        expect(result.messages.map(({ ruleId }) => ruleId)).toContain(
            'caxri/architecture-boundaries',
        );
    });

    it('rejects cycles in target applications and packages', async () => {
        const results = await lintAll([
            'scripts/fixtures/eslint/architecture/packages/client/src/cycle-a.ts',
            'scripts/fixtures/eslint/architecture/packages/client/src/cycle-b.ts',
        ]);

        expect(results.flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId))).toContain(
            'import-x/no-cycle',
        );
    });

    it('leaves the async-Node-API ban to oxlint (n/no-sync requires typed linting)', async () => {
        // See scripts/__tests__/oxlint-toolchain-contract.test.ts for the node/no-sync coverage.
        const config = await effectiveConfigFor('apps/server/src/domains/index.ts');

        expect(config.rules?.['n/no-sync']).toBeUndefined();
    });

    it('flags a component export that does not match its filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/bad-mapped-component-fixture.tsx');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('caxri/filename-export-mapping');
    });

    it('stays silent when a component export matches its filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/good-mapped-component-fixture.tsx');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).not.toContain('caxri/filename-export-mapping');
    });

    it('flags a use-*.ts hook export that does not match its filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/use-bad-mapped-hook-fixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('caxri/filename-export-mapping');
    });

    it('stays silent when a use-*.ts hook export matches its filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/use-good-mapped-hook-fixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).not.toContain('caxri/filename-export-mapping');
    });

    it('requires a blank line between class methods', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/class-members-packed-methods-fixture.ts',
        );
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('@stylistic/lines-between-class-members');
    });

    it('keeps packed fields and overload signatures without requiring a blank line', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/class-members-spaced-methods-fixture.ts',
        );
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).not.toContain('@stylistic/lines-between-class-members');
    });

    it('keeps class-member blank lines active on a representative source file', async () => {
        const config = await effectiveConfigFor('apps/server/src/core/control-server.ts');

        expect(config.rules?.['@stylistic/lines-between-class-members']?.[0]).toBe(2);
    });

    it('registers every ESLint fixture as a Knip entry', async () => {
        // Fixtures are only reached as string paths, so Knip reports them as unused files unless they are listed in
        // package.json `knip.workspaces["."].entry`. Missing that listing failed CI on the class-member spacing change.
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
            knip: { workspaces: { '.': { entry: string[] } } };
        };
        const knipEntries = manifest.knip.workspaces['.'].entry.filter((entry) =>
            entry.startsWith('scripts/fixtures/eslint/'),
        );
        const fixtureRoot = join(root, 'scripts/fixtures/eslint');
        const unregistered = (await readdir(fixtureRoot, { recursive: true, withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) =>
                relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
            )
            .filter((file) => knipEntries.every((entry) => !matchesGlob(file, entry)))
            .toSorted((left, right) => left.localeCompare(right));

        expect(unregistered).toEqual([]);
    });

    it('keeps generated design prototype assets out of Knip file analysis', async () => {
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
            knip: {
                workspaces: {
                    '.': { entry: string[]; ignoreFiles: string[] };
                };
            };
        };
        const rootWorkspace = manifest.knip.workspaces['.'];

        expect(rootWorkspace.entry).toContain('.agents/skills/design-prototype/assets/entry.mjs');
        expect(rootWorkspace.ignoreFiles).toContain('.agents/skills/design-prototype/assets/*.js');
    });
});
