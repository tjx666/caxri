import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
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

import { MAX_PREVIEW_ASSET_BYTES, MAX_PREVIEW_DOCUMENT_BYTES } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentService } from '../documents';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

afterEach(async () => {
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('DocumentService', () => {
    it('rejects a conditional mobile save after an external content change', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-save-'));
        const root = await realpath(directory);
        temporaryDirectories.push(root);
        const path = join(root, 'notes.txt');
        await writeFile(path, 'original');
        const logger = createLogger(join(root, 'logs'));
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            logger,
            () => 1_024,
        );
        const expectedHash = createHash('sha256').update('original').digest('hex');
        await writeFile(path, 'changed externally');
        await expect(
            service.write('session-1', path, 'mobile edit', undefined, expectedHash),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readFile(path, 'utf8')).toBe('changed externally');
        await service.write(
            'session-1',
            path,
            'mobile edit',
            undefined,
            createHash('sha256').update('changed externally').digest('hex'),
        );
        expect(await readFile(path, 'utf8')).toBe('mobile edit');
    });
    it('rejects a link retargeted while its operation waits or its replacement is being written', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-link-race-'));
        const directory = await realpath(temporaryDirectory);
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const first = join(directory, 'first.txt');
        const second = join(directory, 'second.txt');
        const alias = join(root, 'linked.txt');
        await Promise.all([writeFile(first, 'first'), writeFile(second, 'second')]);
        await symlink(first, alias);
        const resolvePath = async () => ({
            root,
            path: await realpath(alias),
            workspacePath: alias,
        });
        const admitted = await resolvePath();
        await rename(alias, join(root, 'old-link'));
        await symlink(second, alias);
        const logger = createLogger(join(directory, 'logs'));
        const service = new DocumentService(resolvePath, logger, () => 1024, {
            beforeReplaceValidation: async () => {
                await rename(alias, join(root, 'second-link'));
                await symlink(first, alias);
            },
        });
        await expect(
            service.write('session', alias, 'queued edit', admitted),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(service.read('session', alias, undefined, admitted)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(service.authorizeOpen('session', alias, admitted)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(service.write('session', alias, 'mid-save edit')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(await readFile(first, 'utf8')).toBe('first');
        expect(await readFile(second, 'utf8')).toBe('second');
        await logger.flush();
    });

    it('keeps the previous file intact when writing the replacement fails', async () => {
        const rootDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-save-'));
        const root = await realpath(rootDirectory);
        temporaryDirectories.push(root);
        const path = join(root, 'document.txt');
        await writeFile(path, 'previous complete content', 'utf8');
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            createLogger(join(root, 'logs')),
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
        const rootDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-save-'));
        const root = await realpath(rootDirectory);
        temporaryDirectories.push(root);
        const path = join(root, 'document.txt');
        await writeFile(path, 'previous', 'utf8');
        await chmod(path, 0o640);
        const service = new DocumentService(
            () => Promise.resolve({ path, root }),
            createLogger(join(root, 'logs')),
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
            const rootDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-save-'));
            const root = await realpath(rootDirectory);
            temporaryDirectories.push(root);
            const path = join(root, 'document.txt');
            const originalPath = join(root, 'document.original.txt');
            const outsidePath = join(root, 'outside.txt');
            await writeFile(path, 'previous', 'utf8');
            await writeFile(outsidePath, 'foreign', 'utf8');
            const service = new DocumentService(
                () => Promise.resolve({ path, root }),
                createLogger(join(root, 'logs')),
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
        const testRootDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-save-'));
        const testRoot = await realpath(testRootDirectory);
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
            createLogger(join(testRoot, 'logs')),
            () => 1_024,
            {
                openFile: async (...arguments_) => {
                    openCount += 1;
                    if (openCount === 2) {
                        await rename(parent, originalParent);
                        await symlink(outside, parent, 'dir');
                    }
                    return open(...arguments_);
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
        const testRootDirectory = await mkdtemp(join(tmpdir(), 'caxri-document-save-'));
        const testRoot = await realpath(testRootDirectory);
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
            createLogger(join(testRoot, 'logs')),
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

    describe('readAsset', () => {
        async function createAssetFixture() {
            const created = await mkdtemp(join(tmpdir(), 'caxri-read-asset-'));
            const testRoot = await realpath(created);
            temporaryDirectories.push(testRoot);
            const root = join(testRoot, 'project');
            await mkdir(root);
            const logger = createLogger(join(testRoot, 'logs'));
            const service = (path: string) =>
                new DocumentService(
                    () => Promise.resolve({ path, root }),
                    logger,
                    () => 1_024,
                );
            return { root, service };
        }

        it('returns the raw bytes and a media type derived from the extension', async () => {
            const { root, service } = await createAssetFixture();
            const path = join(root, 'diagram.png');
            const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
            await writeFile(path, bytes);

            const asset = await service(path).readAsset('session-1', path);

            expect(asset).toEqual({
                path,
                mediaType: 'image/png',
                base64: bytes.toString('base64'),
                size: bytes.byteLength,
            });
        });

        it('refuses a file whose extension is not a previewable image', async () => {
            const { root, service } = await createAssetFixture();
            const path = join(root, 'notes.md');
            await writeFile(path, '# not an image', 'utf8');

            await expect(service(path).readAsset('session-1', path)).rejects.toMatchObject({
                code: 'PATH_DENIED',
            });
        });

        it('refuses an asset larger than the preview limit', async () => {
            const { root, service } = await createAssetFixture();
            const path = join(root, 'huge.png');
            await writeFile(path, Buffer.alloc(MAX_PREVIEW_ASSET_BYTES + 1));

            // The ceiling reads in megabytes, the unit a reader compares against the size Finder shows.
            await expect(service(path).readAsset('session-1', path)).rejects.toMatchObject({
                code: 'CAPACITY',
                message: 'File exceeds the 8.0 MB preview limit',
            });
        });

        it('reads a PDF past the image ceiling and refuses one past the document ceiling', async () => {
            const { root, service } = await createAssetFixture();
            const path = join(root, 'manual.pdf');
            await writeFile(path, Buffer.alloc(MAX_PREVIEW_ASSET_BYTES + 1));

            await expect(service(path).readAsset('session-1', path)).resolves.toMatchObject({
                mediaType: 'application/pdf',
                size: MAX_PREVIEW_ASSET_BYTES + 1,
            });

            await writeFile(path, Buffer.alloc(MAX_PREVIEW_DOCUMENT_BYTES + 1));
            await expect(service(path).readAsset('session-1', path)).rejects.toMatchObject({
                code: 'CAPACITY',
            });
        });
    });
});
