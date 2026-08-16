import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

/**
 * `scripts/fixtures/eslint/**` is excluded from the repository's own lint gate via `globalIgnores` (see
 * `eslint.config.ts`); `ignore: false` bypasses that here so this test can still lint the fixtures directly, matching
 * `scripts/__tests__/eslint-toolchain-contract.test.ts`'s pattern for exercising the custom
 * `caxri/filename-export-mapping` rule end-to-end through the real flat config rather than an isolated `RuleTester`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result;
}

function ruleIds(result: Awaited<ReturnType<typeof lint>>) {
    return result.messages.map((message) => message.ruleId);
}

describe('caxri/filename-export-mapping', () => {
    it('stays silent for a PascalCase component export matching its kebab-case filename', async () => {
        const result = await lint('scripts/fixtures/eslint/good-mapped-component-fixture.tsx');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('stays silent for a camelCase arrow-function export bound via export const', async () => {
        const result = await lint('scripts/fixtures/eslint/arrow-component-fixture.tsx');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('stays silent for a use-*.ts hook exporting the camelCase mapping of its filename', async () => {
        const result = await lint('scripts/fixtures/eslint/use-good-mapped-hook-fixture.ts');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('stays silent for a class-based component matching its filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/class-component-fixture.tsx');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('stays silent for a re-exported binding that references a matching local declaration', async () => {
        const result = await lint('scripts/fixtures/eslint/re-export-component-fixture.tsx');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('flags a component export whose name does not match its filename mapping at all', async () => {
        const result = await lint('scripts/fixtures/eslint/bad-mapped-component-fixture.tsx');
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain("must export 'BadMappedComponentFixture'");
        expect(message?.message).toContain('found: WrongExportName');
    });

    it('flags a component export with the right identifier but the wrong casing', async () => {
        const result = await lint('scripts/fixtures/eslint/wrong-casing-component-fixture.tsx');
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain("must export 'WrongCasingComponentFixture'");
        expect(message?.message).toContain('found: wrongCasingComponentFixture');
    });

    it('flags a component file with no function-like or class export', async () => {
        const result = await lint('scripts/fixtures/eslint/no-function-export-fixture.tsx');
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain('found: (no function export)');
    });

    it('flags a use-*.ts hook export that does not match the camelCase mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/use-bad-mapped-hook-fixture.ts');
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain("must export 'useBadMappedHookFixture'");
        expect(message?.message).toContain('(the camelCase mapping');
    });

    it('flags a use-*.ts hook export using PascalCase instead of the camelCase mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/use-wrong-casing-hook-fixture.ts');
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain("must export 'useWrongCasingHookFixture'");
        expect(message?.message).toContain('found: UseWrongCasingHookFixture');
    });

    it('stays silent for a compound-component file when one export matches the filename mapping', async () => {
        const result = await lint('scripts/fixtures/eslint/compound-component-fixture.tsx');
        expect(ruleIds(result)).not.toContain('caxri/filename-export-mapping');
    });

    it('flags a compound-component file when none of its exports match the filename mapping', async () => {
        const result = await lint(
            'scripts/fixtures/eslint/compound-component-mismatch-fixture.tsx',
        );
        expect(ruleIds(result)).toContain('caxri/filename-export-mapping');
        const message = result.messages.find(
            (entry) => entry.ruleId === 'caxri/filename-export-mapping',
        );
        expect(message?.message).toContain("must export 'CompoundComponentMismatchFixture'");
        expect(message?.message).toContain('found: CompoundMismatch, CompoundMismatchContent');
    });
});
