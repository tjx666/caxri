import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    compositionChangedDirectories,
    lintDirectorySiblings,
    untouchedDirectorySiblings,
} from '../directory-siblings';

const roots: string[] = [];

const fixture = async (files: string[]): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'directory-siblings-'));
    roots.push(root);
    await Promise.all(
        files.map(async (file) => {
            await mkdir(join(root, file, '..'), { recursive: true });
            await writeFile(join(root, file), '');
        }),
    );
    return root;
};

afterEach(async () => {
    const created = [...roots];
    roots.length = 0;
    await Promise.all(created.map((root) => rm(root, { recursive: true, force: true })));
});

describe('compositionChangedDirectories', () => {
    it('adds the grandparent only when the parent is a classification folder', () => {
        expect(
            compositionChangedDirectories([
                'features/settings/hooks/use-focus.ts',
                'features/chat/message.tsx',
            ]),
        ).toEqual(['features/chat', 'features/settings', 'features/settings/hooks']);
    });
});

describe('untouchedDirectorySiblings', () => {
    it('lists untouched TypeScript files directly inside each directory', async () => {
        const root = await fixture([
            'settings/hooks/use-focus.ts',
            'settings/use-page.ts',
            'settings/view.tsx',
            'settings/notes.md',
            'settings/nested/deep.ts',
        ]);

        await expect(
            untouchedDirectorySiblings(root, ['settings', 'missing'], ['settings/view.tsx']),
        ).resolves.toEqual(['settings/use-page.ts']);
    });
});

describe('lintDirectorySiblings', () => {
    it('lints the siblings beside a newly added hooks folder without the ESLint cache', async () => {
        const root = await fixture(['settings/hooks/use-focus.ts', 'settings/use-page.ts']);
        const run = vi.fn(async () => {});
        const capture = vi.fn(() => Promise.resolve(''));

        const count = await lintDirectorySiblings({
            base: 'base',
            files: ['settings/hooks/use-focus.ts'],
            removedFiles: [],
            root,
            capture,
            run,
        });

        expect(count).toBe(1);
        expect(run).toHaveBeenCalledWith(root, 'eslint', [
            '--no-warn-ignored',
            '--max-warnings=0',
            'settings/use-page.ts',
        ]);
    });

    it('skips directories whose file set did not change', async () => {
        const root = await fixture(['settings/hooks/use-focus.ts', 'settings/use-page.ts']);
        const run = vi.fn(async () => {});

        const count = await lintDirectorySiblings({
            base: 'base',
            files: ['settings/hooks/use-focus.ts'],
            removedFiles: [],
            root,
            capture: () => Promise.resolve('settings/hooks/use-focus.ts\0'),
            run,
        });

        expect(count).toBe(0);
        expect(run).not.toHaveBeenCalled();
    });
});
