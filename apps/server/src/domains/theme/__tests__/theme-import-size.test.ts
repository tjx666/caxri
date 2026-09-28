import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme, MAX_THEME_IMPORT_FILE_BYTES } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('included theme import size', () => {
    it('rejects a merged UTF-8 document over the import limit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-merged-limit-'));
        temporaryDirectories.push(directory);
        const parentPath = join(directory, 'parent.json');
        const childPath = join(directory, 'child.json');
        await writeFile(
            parentPath,
            JSON.stringify({
                colors: { 'editor.background': '#123456' },
                parentPadding: '界'.repeat(210_000),
            }),
        );
        await writeFile(
            childPath,
            JSON.stringify({ include: './parent.json', childPadding: 'a'.repeat(450_000) }),
        );

        await expect(importTheme(childPath, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: `Theme exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte limit after merging its included parent`,
        } satisfies Partial<CaxriError>);
    });

    it('accepts an included theme below the merged import limit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-merged-valid-'));
        temporaryDirectories.push(directory);
        const parentPath = join(directory, 'parent.json');
        const childPath = join(directory, 'child.json');
        await writeFile(
            parentPath,
            JSON.stringify({
                colors: { 'editor.background': '#123456' },
                parentPadding: 'a'.repeat(100_000),
            }),
        );
        await writeFile(
            childPath,
            JSON.stringify({ include: './parent.json', childPadding: 'b'.repeat(600_000) }),
        );

        await expect(importTheme(childPath, draculaTheme)).resolves.toMatchObject({
            source: 'vscode',
            editor: { background: '#123456' },
        });
    });
});
