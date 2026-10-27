import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    staleLocaleCopyWarnings,
    staleLocaleValues,
    staticFragment,
} from './locale-e2e-assertions';

const LOCALE = 'apps/desktop/src/renderer/src/i18n/locales/en/example.ts';

describe('staticFragment', () => {
    it('keeps the longest static segment around placeholders', () => {
        expect(staticFragment('{{window}} limit on track to run out: {{percent}}% left')).toBe(
            'limit on track to run out:',
        );
    });

    it('ignores fragments too short to match reliably', () => {
        expect(staticFragment('Open')).toBeUndefined();
        expect(staticFragment('{{count}} items')).toBeUndefined();
    });
});

describe('staleLocaleValues', () => {
    it('reports edited and removed values but not unchanged or added ones', () => {
        const before =
            "export const x = { 'a': 'Same text here', 'b': 'Old wording', 'c': 'Gone' };";
        const after =
            "export const x = { 'a': 'Same text here', 'b': 'New wording', 'd': 'Added' };";
        expect(staleLocaleValues(before, after)).toEqual(['Old wording', 'Gone']);
    });
});

describe('staleLocaleCopyWarnings', () => {
    async function fixture(): Promise<{ root: string; git: (...a: string[]) => void }> {
        const root = await mkdtemp(join(tmpdir(), 'caxri-locale-e2e-'));
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        git('init', '-b', 'main');
        git('config', 'user.name', 'Check Test');
        git('config', 'user.email', 'check@example.invalid');
        return { root, git };
    }
    async function write(root: string, path: string, contents: string): Promise<void> {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), contents);
    }

    it('warns only for reworded copy that a spec still asserts', async () => {
        const { root, git } = await fixture();
        try {
            await write(
                root,
                LOCALE,
                "export const x = {\n    'a': 'Weekly {{name}} limit on track to run out',\n    'b': 'Unasserted old sentence',\n    'c': 'Removed sentence still asserted',\n    'd': 'Short',\n};\n",
            );
            await write(
                root,
                'e2e/example.e2e.ts',
                "await expect(page.getByText('limit on track to run out')).toBeVisible();\nawait expect(page.getByText('Removed sentence still asserted')).toBeVisible();\nawait page.getByText('Short');\n",
            );
            git('add', '.');
            git('commit', '-m', 'base');
            await write(
                root,
                LOCALE,
                "export const x = {\n    'a': 'Weekly {{name}} limit is projected to run out',\n    'b': 'Unasserted new sentence',\n    'd': 'Brief',\n};\n",
            );
            const warnings = await staleLocaleCopyWarnings(root, [LOCALE], 'HEAD');
            expect(warnings).toEqual([
                { location: 'e2e/example.e2e.ts:1', fragment: 'limit on track to run out' },
                { location: 'e2e/example.e2e.ts:2', fragment: 'Removed sentence still asserted' },
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('stays silent for unchanged locales, non-locale files, and new locale files', async () => {
        const { root, git } = await fixture();
        try {
            await write(root, 'e2e/example.e2e.ts', "page.getByText('Brand new sentence here');\n");
            git('add', '.');
            git('commit', '-m', 'base');
            await write(root, LOCALE, "export const x = { 'a': 'Brand new sentence here' };\n");
            expect(await staleLocaleCopyWarnings(root, [LOCALE], 'HEAD')).toEqual([]);
            expect(await staleLocaleCopyWarnings(root, ['README.md'], 'HEAD')).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
