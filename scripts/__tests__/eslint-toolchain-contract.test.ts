import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

async function lint(path: string) {
    // These fixtures are deliberately excluded from the repository's own lint gate via
    // `globalIgnores` (see eslint.config.ts); `ignore: false` bypasses that here so the test can
    // still observe them being linted.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result;
}

/**
 * `ESLint#calculateConfigForFile` is typed as `Promise<any>` (there is no narrower public type),
 * so this local shape is asserted explicitly rather than relying on the untyped return value.
 */
interface EffectiveConfig {
    rules?: Record<string, [number, ...unknown[]] | undefined>;
}

async function effectiveConfigFor(path: string): Promise<EffectiveConfig> {
    const eslint = new ESLint({ cwd: root });
    return (await eslint.calculateConfigForFile(resolve(root, path))) as EffectiveConfig;
}

describe('shared ESLint preset toolchain contract', () => {
    it('fires type-aware rules only available through the typed-linting layer', async () => {
        const result = await lint('scripts/fixtures/eslint/type-aware-violation.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('@typescript-eslint/no-floating-promises');
        expect(ruleIds).toContain('@typescript-eslint/no-unsafe-assignment');
    });

    it('flags a non-kebab-case filename via unicorn/filename-case', async () => {
        const result = await lint('scripts/fixtures/eslint/NotKebabCaseFixture.ts');
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('unicorn/filename-case');
    });

    it('keeps Caxri-specific boundary rules active on a representative renderer file', async () => {
        const config = await effectiveConfigFor('src/renderer/src/app.tsx');

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
        expect(config.rules?.['@typescript-eslint/no-floating-promises']?.[0]).toBe(2);
        expect(config.rules?.['unicorn/filename-case']?.[0]).toBe(2);
        expect(config.rules?.['import-x/order']).toBeDefined();
    });

    it('bans default exports on .tsx files under src/', async () => {
        const config = await effectiveConfigFor('src/renderer/src/app.tsx');
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
        await expect(eslint.isPathIgnored(resolve(root, 'release/caxri.dmg'))).resolves.toBe(true);
    });
});
