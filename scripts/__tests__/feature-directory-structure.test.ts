import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ESLint, Linter } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

import featureDirectoryStructure from '../eslint-rules/feature-directory-structure';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/feature-directory-structure';
const fixtures = 'scripts/fixtures/eslint/feature-structure';

/**
 * `scripts/fixtures/eslint/**` is excluded from the repository's own lint gate via `globalIgnores` (see
 * `eslint.config.ts`); `ignore: false` bypasses that here so this test can lint the fixture directories through the
 * real flat config, matching `scripts/__tests__/filename-export-mapping.test.ts`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result;
}

function ruleMessages(result: Awaited<ReturnType<typeof lint>>) {
    return result.messages.filter((message) => message.ruleId === ruleId);
}

const cleanupDirectories: string[] = [];

afterEach(() => {
    for (const directory of cleanupDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
    cleanupDirectories.length = 0;
});

describe('caxri/feature-directory-structure', () => {
    it('flags every colocated test file once the directory reaches three of them', async () => {
        const result = await lint(`${fixtures}/consolidate-tests/alpha.test.ts`);
        const messages = ruleMessages(result);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('move them into __tests__/');
    });

    it('stays silent for the non-test module in an over-threshold directory', async () => {
        const result = await lint(`${fixtures}/consolidate-tests/alpha.ts`);
        expect(ruleMessages(result)).toHaveLength(0);
    });

    it('flags a colocated test file left behind next to an existing __tests__/', async () => {
        const result = await lint(`${fixtures}/coexist-tests/beta.test.ts`);
        const messages = ruleMessages(result);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('__tests__/ already exists');
    });

    it('stays silent for a test file already inside __tests__/', async () => {
        const result = await lint(`${fixtures}/coexist-tests/__tests__/alpha.test.ts`);
        expect(ruleMessages(result)).toHaveLength(0);
    });

    it('flags flat use-* hooks once the directory reaches three of them', async () => {
        const result = await lint(`${fixtures}/consolidate-hooks/use-alpha.ts`);
        const messages = ruleMessages(result);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('move them into hooks/');
    });

    it('flags a flat hook left behind next to an existing hooks/', async () => {
        const result = await lint(`${fixtures}/coexist-hooks/use-beta.ts`);
        const messages = ruleMessages(result);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('hooks/ already exists');
    });

    it('stays silent for a hook already inside hooks/', async () => {
        const result = await lint(`${fixtures}/coexist-hooks/hooks/use-alpha.ts`);
        expect(ruleMessages(result)).toHaveLength(0);
    });

    it('flags utils.ts coexisting with a utils/ directory', async () => {
        const result = await lint(`${fixtures}/coexist-utils/utils.ts`);
        const messages = ruleMessages(result);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('must not coexist');
    });

    it('stays silent for a below-threshold flat directory', async () => {
        const results = await Promise.all([
            lint(`${fixtures}/good-flat/alpha.test.ts`),
            lint(`${fixtures}/good-flat/beta.test.ts`),
            lint(`${fixtures}/good-flat/use-alpha.ts`),
            lint(`${fixtures}/good-flat/utils.ts`),
        ]);
        for (const result of results) {
            expect(ruleMessages(result)).toHaveLength(0);
        }
    });

    it('observes directory changes within one long-lived lint process (stale-cache regression)', () => {
        // Reproduces the language-server scenario: the same rule module lints the same directory twice in one
        // process, with the directory crossing the threshold in between. The mtime-keyed cache must notice.
        const directory = mkdtempSync(join(tmpdir(), 'feature-structure-'));
        cleanupDirectories.push(directory);
        // Flat-config Linter only matches files under its cwd, and `.ts` needs an explicit `files` glob.
        const linter = new Linter({ cwd: directory });
        const config: Linter.Config = {
            files: ['**/*.ts'],
            plugins: {
                caxri: { rules: { 'feature-directory-structure': featureDirectoryStructure } },
            },
            rules: { 'caxri/feature-directory-structure': 'error' },
        };
        const lintOne = () =>
            linter
                .verify('export {};\n', config, join(directory, 'alpha.test.ts'))
                .filter((message) => message.ruleId === 'caxri/feature-directory-structure');

        writeFileSync(join(directory, 'alpha.test.ts'), 'export {};\n');
        writeFileSync(join(directory, 'beta.test.ts'), 'export {};\n');
        expect(lintOne()).toHaveLength(0);

        writeFileSync(join(directory, 'gamma.test.ts'), 'export {};\n');
        // Guard against same-millisecond mtime granularity so the cache key provably differs.
        const later = new Date(Date.now() + 10);
        utimesSync(directory, later, later);
        const messages = lintOne();
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toContain('move them into __tests__/');
    });

    it('stays silent for a fully folded directory', async () => {
        const results = await Promise.all([
            lint(`${fixtures}/good-folded/__tests__/alpha.test.ts`),
            lint(`${fixtures}/good-folded/hooks/use-alpha.ts`),
            lint(`${fixtures}/good-folded/utils/format.ts`),
        ]);
        for (const result of results) {
            expect(ruleMessages(result)).toHaveLength(0);
        }
    });
});
