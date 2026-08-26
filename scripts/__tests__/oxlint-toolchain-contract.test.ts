import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { execFileAsync } from '../exec';

const root = resolve(import.meta.dirname, '../..');

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

    it('requires async Node APIs (node/no-sync) outside tests in Main/Runtime/shared-node/CLI/tooling', async () => {
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
        expect(noSyncOverride?.files).toContain('src/runtime/**/*.ts');
        const testExemption = overrides.find(
            (override) => override.rules['node/no-sync'] === 'off',
        );
        expect(testExemption?.files).toContain('**/*.test.ts');
        expect(testExemption?.files).toContain('**/__tests__/**');
    });

    it('owns only type-aware typescript rules, leaving syntactic linting to ESLint', async () => {
        const config = parseJsonc(await readFile(join(root, '.oxlintrc.json'), 'utf8'));

        const rules = Object.keys(config.rules as Record<string, unknown>);
        expect(rules.length).toBeGreaterThan(0);
        for (const rule of rules) {
            expect(rule).toMatch(/^typescript\//);
        }

        // The default rule categories must stay off, or oxlint would re-lint syntactic territory
        // that ESLint owns (and vice versa the whole point of the split collapses).
        expect(config.categories).toMatchObject({ correctness: 'off', suspicious: 'off' });

        // Anchor rules that must never silently drop out of the type-aware gate.
        const ruleNames = new Set(rules);
        expect(ruleNames.has('typescript/no-floating-promises')).toBe(true);
        expect(ruleNames.has('typescript/no-misused-promises')).toBe(true);
        expect(ruleNames.has('typescript/switch-exhaustiveness-check')).toBe(true);
    });
});
