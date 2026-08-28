import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { execFileAsync } from '../exec';

const root = resolve(import.meta.dirname, '../..');

const activeAntiSlopRuleNames = [
    'anti-slop/no-conditional-empty-object-spread',
    'anti-slop/no-object-parameters',
    'anti-slop/no-reflect-apply',
    'anti-slop/no-unknown-type-aliases',
    'anti-slop/no-widen-then-assert',
] as const;

const deferredAntiSlopRuleNames = [
    'anti-slop/no-chained-type-assertions',
    'anti-slop/no-known-value-widening',
    'anti-slop/no-module-mocking',
    'anti-slop/no-reflect-get',
    'anti-slop/no-runtime-typeof',
    'anti-slop/no-shape-in-symbol-names',
    'anti-slop/no-unknown-parameters',
    'anti-slop/no-unknown-returns',
    'anti-slop/no-unsafe-dictionary-type',
    'anti-slop/require-safety-comment-for-type-assertion',
] as const;

/**
 * Full-line `//` comments are the only comment form used in .oxlintrc.json.
 */
function parseJsonc(contents: string): Record<string, unknown> {
    return JSON.parse(
        contents
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('//'))
            .join('\n'),
    ) as Record<string, unknown>;
}

interface OxlintRun {
    exitCode: number;
    stdout: string;
}

/**
 * Runs the repository oxlint binary with the repository config minus `ignorePatterns`, so the deliberately-violating
 * fixtures under scripts/fixtures/eslint/ (ignored by the real lint gate) can still be linted here. `--no-ignore`
 * cannot do this: it only bypasses ignore files and CLI ignore flags, not config `ignorePatterns`.
 */
async function lintTypeAware(configPath: string, file: string): Promise<OxlintRun> {
    try {
        const { stdout } = await execFileAsync(
            join(root, 'node_modules', '.bin', 'oxlint'),
            ['-c', configPath, '--type-aware', file],
            { cwd: root, encoding: 'utf8' },
        );
        return { exitCode: 0, stdout };
    } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string };
        return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? '' };
    }
}

describe('oxlint type-aware toolchain contract', () => {
    /**
     * Must live at the repository root, not in a tmpdir: oxlint resolves `overrides[].files` globs relative to the
     * config file's directory, so a config elsewhere would never match `scripts/**` and the node/no-sync assertions
     * would silently pass on nothing.
     */
    const fixtureConfigPath = join(root, `.oxlintrc.contract-${process.pid}.json`);

    beforeAll(async () => {
        const config = parseJsonc(await readFile(join(root, '.oxlintrc.json'), 'utf8'));
        delete config.ignorePatterns;
        delete config.$schema;
        await writeFile(fixtureConfigPath, JSON.stringify(config));
    });

    afterAll(async () => {
        await rm(fixtureConfigPath, { force: true });
    });

    it('fires type-aware rules on the typed-linting fixture', async () => {
        const result = await lintTypeAware(
            fixtureConfigPath,
            'scripts/fixtures/eslint/type-aware-violation.ts',
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain('typescript(no-floating-promises)');
    });

    it('requires async system APIs outside tests in Desktop, Server, shared system, CLI, and tooling', async () => {
        const violation = await lintTypeAware(
            fixtureConfigPath,
            'scripts/fixtures/eslint/no-sync-fixture.ts',
        );
        expect(violation.exitCode).not.toBe(0);
        expect(violation.stdout).toContain('node(no-sync)');

        // Test code is exempt: the tests override turns the rule back off.
        const config = parseJsonc(await readFile(join(root, '.oxlintrc.json'), 'utf8'));
        const overrides = config.overrides as Array<{
            files: string[];
            rules: Record<string, unknown>;
        }>;
        const noSyncOverride = overrides.find((override) => override.rules['node/no-sync']);
        expect(noSyncOverride?.files).toContain('apps/desktop/src/main/**/*.ts');
        expect(noSyncOverride?.files).toContain('apps/server/src/**/*.ts');
        expect(noSyncOverride?.files).toContain('packages/system/src/**/*.ts');
        const testExemption = overrides.find(
            (override) => override.rules['node/no-sync'] === 'off',
        );
        expect(testExemption?.files).toContain('**/*.test.ts');
        expect(testExemption?.files).toContain('**/__tests__/**');
    });

    it('loads the vendored anti-slop plugin and rejects low-evidence patterns', async () => {
        const result = await lintTypeAware(
            fixtureConfigPath,
            'scripts/fixtures/eslint/anti-slop-violation.ts',
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain('anti-slop(no-conditional-empty-object-spread)');
        expect(result.stdout).toContain('anti-slop(no-object-parameters)');
        expect(result.stdout).toContain('anti-slop(no-reflect-apply)');
        expect(result.stdout).toContain('anti-slop(no-unknown-type-aliases)');
        expect(result.stdout).toContain('anti-slop(no-widen-then-assert)');
    });

    it('owns only curated type-aware and anti-slop rules, leaving other syntactic linting to ESLint', async () => {
        const config = parseJsonc(await readFile(join(root, '.oxlintrc.json'), 'utf8'));

        const rules = Object.keys(config.rules as Record<string, unknown>);
        expect(rules.length).toBeGreaterThan(0);
        const antiSlopRules = rules
            .filter((rule) => rule.startsWith('anti-slop/'))
            .toSorted((left, right) => left.localeCompare(right));
        expect(antiSlopRules).toEqual(
            [...activeAntiSlopRuleNames, ...deferredAntiSlopRuleNames].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        );
        const configuredRules = config.rules as Record<string, unknown>;
        expect(activeAntiSlopRuleNames.map((rule) => configuredRules[rule])).toEqual(
            activeAntiSlopRuleNames.map(() => 'error'),
        );
        expect(deferredAntiSlopRuleNames.map((rule) => configuredRules[rule])).toEqual(
            deferredAntiSlopRuleNames.map(() => 'off'),
        );
        expect(
            rules
                .filter((rule) => !rule.startsWith('anti-slop/'))
                .every((rule) => rule.startsWith('typescript/')),
        ).toBe(true);

        expect(config.jsPlugins).toContainEqual({
            name: 'anti-slop',
            specifier: './tools/oxlint/anti-slop/index.ts',
        });
        expect(config.ignorePatterns).toContain('tools/oxlint/anti-slop/**');

        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
            knip: { workspaces: { '.': { ignore: string[] } } };
        };
        expect(manifest.knip.workspaces['.'].ignore).toContain('tools/oxlint/anti-slop/**');

        // The default rule categories must stay off, or oxlint would add uncurated syntactic
        // territory beyond the explicitly reviewed anti-slop policy.
        expect(config.categories).toMatchObject({ correctness: 'off', suspicious: 'off' });

        // Anchor rules that must never silently drop out of the type-aware gate.
        const ruleNames = new Set(rules);
        expect(ruleNames.has('typescript/no-floating-promises')).toBe(true);
        expect(ruleNames.has('typescript/no-misused-promises')).toBe(true);
        expect(ruleNames.has('typescript/switch-exhaustiveness-check')).toBe(true);
    });
});
