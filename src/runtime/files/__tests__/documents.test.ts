import {
    chmod,
    link,
    mkdtemp,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { DocumentService } from '../documents';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe('DocumentService', () => {
    it('keeps the previous file intact when writing the replacement fails', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'caxri-document-save-')));
        temporaryDirectories.push(root);
        const path = join(root, 'document.txt');
        await writeFile(path, 'previous complete content', 'utf8');
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            new StructuredLogger(join(root, 'logs')),
            () => 1_024,
            { replaceFile: () => Promise.reject(new Error('injected failure')) },
        );

        await expect(service.write('session-1', path, 'replacement')).rejects.toThrow(
            'injected failure',
        );

        expect(await readFile(path, 'utf8')).toBe('previous complete content');
        expect(await readdir(root)).toEqual(['document.txt', 'logs']);
    });

    it('atomically replaces the complete file while preserving its permission bits', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'caxri-document-save-')));
        temporaryDirectories.push(root);
        const path = join(root, 'document.txt');
        await writeFile(path, 'previous', 'utf8');
        await chmod(path, 0o640);
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            new StructuredLogger(join(root, 'logs')),
            () => 1_024,
        );

        const saved = await service.write('session-1', path, 'complete replacement');

        expect(saved.content).toBe('complete replacement');
        expect((await stat(path)).mode & 0o777).toBe(0o640);
        expect(await readdir(root)).toEqual(['document.txt', 'logs']);
    });

    it.each(['different inode', 'hard link', 'symlink'] as const)(
        'rejects a %s swapped in before the final target validation',
        async (replacementKind) => {
            const root = await realpath(await mkdtemp(join(tmpdir(), 'caxri-document-save-')));
            temporaryDirectories.push(root);
            const path = join(root, 'document.txt');
            const originalPath = join(root, 'document.original.txt');
            const outsidePath = join(root, 'outside.txt');
            await writeFile(path, 'previous', 'utf8');
            await writeFile(outsidePath, 'foreign', 'utf8');
            const service = new DocumentService(
                () => Promise.resolve({ path, root }),
                new StructuredLogger(join(root, 'logs')),
                () => 1_024,
                {
                    beforeReplaceValidation: async () => {
                        await rename(path, originalPath);
                        if (replacementKind === 'different inode')
                            await writeFile(path, 'foreign', 'utf8');
                        else if (replacementKind === 'hard link') await link(outsidePath, path);
                        else await symlink(outsidePath, path);
                    },
                },
            );

            await expect(service.write('session-1', path, 'replacement')).rejects.toThrow(
                'File changed during save',
            );

            expect(await readFile(originalPath, 'utf8')).toBe('previous');
            expect(await readFile(outsidePath, 'utf8')).toBe('foreign');
            expect((await readdir(root)).some((entry) => entry.endsWith('.caxri-tmp'))).toBe(false);
        },
    );

    it('does not write replacement bytes through a swapped parent symlink', async () => {
        const testRoot = await realpath(await mkdtemp(join(tmpdir(), 'caxri-document-save-')));
        temporaryDirectories.push(testRoot);
        const root = join(testRoot, 'project');
        const parent = join(root, 'nested');
        const originalParent = join(root, 'nested.original');
        const outside = join(testRoot, 'outside');
        const path = join(parent, 'document.txt');
        await mkdir(parent, { recursive: true });
        await mkdir(outside);
        await writeFile(path, 'previous', 'utf8');
        let openCount = 0;
        let outsideContentDuringWrite: string | undefined;
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            new StructuredLogger(join(testRoot, 'logs')),
            () => 1_024,
            {
                openFile: async (...args) => {
                    openCount += 1;
                    if (openCount === 2) {
                        await rename(parent, originalParent);
                        await symlink(outside, parent, 'dir');
                    }
                    return open(...args);
                },
                beforeReplaceValidation: async () => {
                    const [outsideEntry] = await readdir(outside);
                    if (outsideEntry)
                        outsideContentDuringWrite = await readFile(
                            join(outside, outsideEntry),
                            'utf8',
                        );
                },
            },
        );

        await expect(service.write('session-1', path, 'editor-secret')).rejects.toThrow(
            'Temporary file changed during save',
        );

        expect(outsideContentDuringWrite).toBeUndefined();
        expect(await readFile(join(originalParent, 'document.txt'), 'utf8')).toBe('previous');
        expect(await readdir(outside)).toEqual([]);
    });

    it('does not remove an outside file through a swapped temporary parent', async () => {
        const testRoot = await realpath(await mkdtemp(join(tmpdir(), 'caxri-document-save-')));
        temporaryDirectories.push(testRoot);
        const root = join(testRoot, 'project');
        const parent = join(root, 'nested');
        const originalParent = join(root, 'nested.original');
        const outside = join(testRoot, 'outside');
        const path = join(parent, 'document.txt');
        let outsideTemporaryPath = '';
        await mkdir(parent, { recursive: true });
        await mkdir(outside);
        await writeFile(path, 'previous', 'utf8');
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            new StructuredLogger(join(testRoot, 'logs')),
            () => 1_024,
            {
                beforeReplaceValidation: async () => {
                    const temporaryName = (await readdir(parent)).find((entry) =>
                        entry.endsWith('.caxri-tmp'),
                    );
                    if (!temporaryName) throw new Error('Expected a temporary replacement file');
                    await rename(parent, originalParent);
                    await symlink(outside, parent, 'dir');
                    outsideTemporaryPath = join(outside, temporaryName);
                    await writeFile(outsideTemporaryPath, 'outside-file', 'utf8');
                },
            },
        );

        await expect(service.write('session-1', path, 'replacement')).rejects.toThrow();

        expect(await readFile(outsideTemporaryPath, 'utf8')).toBe('outside-file');
        expect(await readFile(join(originalParent, 'document.txt'), 'utf8')).toBe('previous');
    });
});
