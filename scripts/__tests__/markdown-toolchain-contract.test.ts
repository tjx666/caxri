import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { parse as parseJsonc } from 'jsonc-parser';
import { lint } from 'markdownlint/promise';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

interface MarkdownlintCli2Config {
    config?: Record<string, unknown>;
}

/**
 * Reuses the repository's own semantic rule set (`.markdownlint-cli2.jsonc`'s `config` block)
 * instead of hard-coding a second copy, so this contract stays in sync with the real gate.
 */
async function markdownlintRuleConfig(): Promise<Record<string, unknown>> {
    const raw = await readFile(resolve(root, '.markdownlint-cli2.jsonc'), 'utf8');
    const parsed = parseJsonc(raw) as MarkdownlintCli2Config;
    return parsed.config ?? {};
}

describe('markdown semantics vs. fenced-code toolchain contract', () => {
    it('flags a Markdown semantic violation with markdownlint', async () => {
        // `.markdownlint-cli2.jsonc` ignores `scripts/fixtures/markdown/**` so the real gate stays
        // green; lint the fixture directly here to prove the rule still fires.
        const config = await markdownlintRuleConfig();
        const results = await lint({
            config,
            files: ['scripts/fixtures/markdown/semantic-violation.md'],
        });
        const violations = results['scripts/fixtures/markdown/semantic-violation.md'] ?? [];
        const ruleNames = violations.flatMap((violation) => violation.ruleNames);

        expect(ruleNames).toContain('MD001');
        expect(ruleNames).toContain('heading-increment');
    });

    it('does not flag the fenced-code fixture with markdownlint (Markdown semantics are clean)', async () => {
        const config = await markdownlintRuleConfig();
        const results = await lint({
            config,
            files: ['scripts/fixtures/markdown/fenced-code-violation.md'],
        });

        expect(results['scripts/fixtures/markdown/fenced-code-violation.md']).toEqual([]);
    });

    it("flags a fenced TypeScript block's violation through ESLint's markdown processor", async () => {
        // `eslint.config.ts` ignores `scripts/fixtures/markdown/**` so the real gate stays green;
        // `ignore: false` bypasses that here so the test can still observe it being linted, mirroring
        // `scripts/__tests__/eslint-toolchain-contract.test.ts`.
        const eslint = new ESLint({ cwd: root, ignore: false });
        const [result] = await eslint.lintFiles([
            'scripts/fixtures/markdown/fenced-code-violation.md',
        ]);
        const ruleIds = result.messages.map((message) => message.ruleId);

        expect(ruleIds).toContain('no-debugger');
    });

    it('does not flag the Markdown-semantic fixture through ESLint (no fenced code to process)', async () => {
        const eslint = new ESLint({ cwd: root, ignore: false });
        const [result] = await eslint.lintFiles([
            'scripts/fixtures/markdown/semantic-violation.md',
        ]);

        expect(result.messages).toEqual([]);
    });
});
