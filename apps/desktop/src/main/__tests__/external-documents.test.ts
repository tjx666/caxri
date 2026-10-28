import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import {
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    openLinkedExternalDocument,
    readExternalDocument,
    readExternalDocumentAsset,
} from '../external-document-reads';
import {
    clearExternalDocumentsForTesting,
    externalDocumentDirectory,
    externalDocumentDiskState,
    externalDocumentPath,
    writeExternalDocument,
} from '../external-documents';
import { readExternalFileSnapshot } from '../external-file-snapshot';

const created: string[] = [];

async function externalFile(name = 'guide.md', content = '# Guide\n') {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-external-document-'));
    created.push(directory);
    const path = join(directory, name);
    await writeFile(path, content, 'utf8');
    const document = await readExternalFileSnapshot(path);
    return { directory: document.displayPath.slice(0, -name.length - 1), document };
}

afterEach(async () => {
    clearExternalDocumentsForTesting();
    const pending = [...created];
    created.length = 0;
    await Promise.all(pending.map((path) => rm(path, { force: true, recursive: true })));
});

describe('external documents', () => {
    it('writes an opened document back in place', async () => {
        const { document } = await externalFile();
        const before = await stat(document.displayPath);

        const result = await writeExternalDocument(document.id, '# Edited\n');

        expect(await readFile(document.displayPath, 'utf8')).toBe('# Edited\n');
        expect(result).toMatchObject({ content: '# Edited\n', size: 9 });
        expect((await stat(document.displayPath)).ino).toBe(before.ino);
    });

    it('resolves the file and its folder for desktop actions', async () => {
        const { directory, document } = await externalFile();

        expect(await externalDocumentPath(document.id)).toBe(document.displayPath);
        expect(await externalDocumentDirectory(document.id)).toBe(directory);
    });

    it('keeps one ID for a file opened again', async () => {
        const { document } = await externalFile();

        expect((await readExternalFileSnapshot(document.displayPath)).id).toBe(document.id);
    });

    it('refuses an ID Main never issued', async () => {
        await expect(writeExternalDocument('unknown-document', 'x')).rejects.toThrow(
            /no longer available/,
        );
        await expect(externalDocumentPath('unknown-document')).rejects.toThrow(
            /no longer available/,
        );
    });

    /**
     * Editors that save by writing a temporary file and renaming it over the original replace the inode at the path.
     * The path the user opened stays the document's identity, so a later save must still land there.
     */
    it('keeps saving after another app replaced the file through a rename', async () => {
        const { directory, document } = await externalFile();
        await writeFile(join(directory, 'guide.md.tmp'), 'from another editor', 'utf8');
        await rename(join(directory, 'guide.md.tmp'), document.displayPath);

        await writeExternalDocument(document.id, 'from Caxri');

        expect(await readFile(document.displayPath, 'utf8')).toBe('from Caxri');
    });

    it('refuses to follow a symbolic link swapped in for the file', async () => {
        const { directory, document } = await externalFile();
        const target = join(directory, 'elsewhere.md');
        await writeFile(target, 'untouched', 'utf8');
        await rm(document.displayPath);
        await symlink(target, document.displayPath);

        await expect(writeExternalDocument(document.id, 'redirected')).rejects.toThrow(
            /Symbolic links cannot be opened/,
        );
        expect(await readFile(target, 'utf8')).toBe('untouched');
    });

    it('refuses a file that gained a second hard link', async () => {
        const { directory, document } = await externalFile();
        await link(document.displayPath, join(directory, 'alias.md'));

        await expect(writeExternalDocument(document.id, 'shared')).rejects.toThrow(
            /hard-linked elsewhere, so Caxri can't save it safely\. Use Open with Default App\./,
        );
    });

    it('states the save size limit in human units', async () => {
        const { document } = await externalFile();

        await expect(
            writeExternalDocument(document.id, 'a'.repeat(MAX_CONFIGURABLE_FILE_BYTES + 1)),
        ).rejects.toThrow("File is larger than 16 MB and can't be saved here.");
    });
});

describe('external document changes on disk', () => {
    it('stays quiet for its own save and reports another app writing the file', async () => {
        const { document } = await externalFile();
        expect(await externalDocumentDiskState(document.id)).toBe('unchanged');

        await writeExternalDocument(document.id, '# Saved by Caxri\n');
        expect(await externalDocumentDiskState(document.id)).toBe('unchanged');

        await writeFile(document.displayPath, '# Changed elsewhere, longer\n', 'utf8');
        expect(await externalDocumentDiskState(document.id)).toBe('changed');
        expect(await readExternalDocument(document.id)).toMatchObject({
            content: '# Changed elsewhere, longer\n',
        });
        expect(await externalDocumentDiskState(document.id)).toBe('unchanged');
    });

    it('notices a same-size rewrite through its modification time', async () => {
        const { document } = await externalFile('guide.md', 'aaaa');
        await writeFile(document.displayPath, 'bbbb', 'utf8');
        await utimes(document.displayPath, new Date(), new Date(Date.now() + 5000));

        expect(await externalDocumentDiskState(document.id)).toBe('changed');
    });

    it('reads a file that another editor replaced through a rename', async () => {
        const { directory, document } = await externalFile();
        await writeFile(join(directory, 'guide.md.tmp'), 'renamed over', 'utf8');
        await rename(join(directory, 'guide.md.tmp'), document.displayPath);

        expect(await externalDocumentDiskState(document.id)).toBe('changed');
        expect((await readExternalDocument(document.id)).content).toBe('renamed over');
    });

    it('treats a deleted file as unchanged', async () => {
        const { document } = await externalFile();
        await rm(document.displayPath);

        expect(await externalDocumentDiskState(document.id)).toBe('unchanged');
    });

    /**
     * The watcher reacts to Caxri's own save, and a read landing between the truncate and the last write would hand the
     * Renderer a half-written file to replace its buffer with. The save is held right after it truncated the file, so
     * the read provably lands inside that window.
     */
    it('refuses a read while its own save is writing, then reads the saved content', async () => {
        const { directory, document } = await externalFile('guide.md', '# Before the save\n');
        const scratch = await open(join(directory, 'scratch.md'), 'w');
        const fileHandle = Object.getPrototypeOf(scratch) as FileHandle;
        await scratch.close();
        const heldBeforeWrite = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const writeSpy = vi.spyOn(fileHandle, 'write');
        writeSpy.mockImplementation(async function (this: FileHandle, ...parameters: unknown[]) {
            heldBeforeWrite.resolve();
            await release.promise;
            // Only the first write is held: restoring hands it and the rest of the save to the real method.
            writeSpy.mockRestore();
            return this.write(...(parameters as Parameters<FileHandle['write']>));
        });
        onTestFinished(() => {
            release.resolve();
            writeSpy.mockRestore();
        });

        const saving = writeExternalDocument(document.id, '# After the save\n');
        await heldBeforeWrite.promise;
        expect(await readFile(document.displayPath, 'utf8')).toBe('');
        await expect(readExternalDocument(document.id)).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'Document is being saved',
        });

        release.resolve();
        await saving;
        expect(await readExternalDocument(document.id)).toMatchObject({
            content: '# After the save\n',
        });
    });
});

const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

describe('files an external document refers to', () => {
    it('reads an image beside the document or in a folder below it', async () => {
        const { directory, document } = await externalFile();
        await writeFile(join(directory, 'diagram.png'), PIXEL);
        await mkdir(join(directory, 'assets'));
        await writeFile(join(directory, 'assets', 'logo.png'), PIXEL);

        const assets = await Promise.all(
            ['diagram.png', 'assets/logo.png', './assets/../diagram.png'].map((path) =>
                readExternalDocumentAsset(document.id, path),
            ),
        );
        for (const asset of assets) {
            expect(asset).toMatchObject({ mediaType: 'image/png', size: PIXEL.byteLength });
            expect(Buffer.from(asset.base64, 'base64')).toEqual(PIXEL);
        }
    });

    it('refuses an image outside the document folder, through a link, or of another type', async () => {
        const { directory, document } = await externalFile();
        const outside = await mkdtemp(join(tmpdir(), 'caxri-external-outside-'));
        created.push(outside);
        await writeFile(join(outside, 'secret.png'), PIXEL);
        await symlink(outside, join(directory, 'linked'));
        await writeFile(join(directory, 'notes.txt'), 'text');

        await expect(
            readExternalDocumentAsset(document.id, `../${outside.split('/').at(-1)}/secret.png`),
        ).rejects.toThrow(/outside the document folder/);
        await expect(readExternalDocumentAsset(document.id, 'linked/secret.png')).rejects.toThrow(
            /outside the document folder/,
        );
        await expect(readExternalDocumentAsset(document.id, 'notes.txt')).rejects.toThrow(
            /cannot be previewed/,
        );
        await expect(readExternalDocumentAsset(document.id, 'missing.png')).rejects.toThrow(
            /not found/,
        );
    });

    it('registers an external PDF without a text read and serves its bytes under that grant', async () => {
        const bytes = Buffer.from([
            0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff,
        ]);
        const { directory } = await externalFile();
        await writeFile(join(directory, 'manual.pdf'), bytes);

        const document = await readExternalFileSnapshot(join(directory, 'manual.pdf'));
        expect(document).toMatchObject({ name: 'manual.pdf', content: '', size: bytes.byteLength });

        const asset = await readExternalDocumentAsset(document.id, 'manual.pdf');
        expect(asset.mediaType).toBe('application/pdf');
        expect(Buffer.from(asset.base64, 'base64')).toEqual(bytes);
    });

    it('registers an external raster image without a text read and serves its bytes under that grant', async () => {
        // A PNG signature carries a zero byte within its first bytes, which a text read refuses as binary.
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
        const { directory } = await externalFile();
        await writeFile(join(directory, 'logo.png'), bytes);

        const document = await readExternalFileSnapshot(join(directory, 'logo.png'));
        expect(document).toMatchObject({ name: 'logo.png', content: '', size: bytes.byteLength });

        const asset = await readExternalDocumentAsset(document.id, 'logo.png');
        expect(asset.mediaType).toBe('image/png');
        expect(Buffer.from(asset.base64, 'base64')).toEqual(bytes);
    });

    it('still reads an external SVG as text, since its source is editable', async () => {
        const { directory } = await externalFile();
        await writeFile(join(directory, 'icon.svg'), '<svg/>');

        await expect(readExternalFileSnapshot(join(directory, 'icon.svg'))).resolves.toMatchObject({
            content: '<svg/>',
        });
    });

    it('still refuses a PDF outside the grant or through an ID Main never issued', async () => {
        const { directory, document } = await externalFile();
        const outside = await mkdtemp(join(tmpdir(), 'caxri-external-outside-'));
        created.push(outside);
        await writeFile(join(outside, 'secret.pdf'), '%PDF-1.7');

        await expect(
            readExternalDocumentAsset(document.id, `../${outside.split('/').at(-1)}/secret.pdf`),
        ).rejects.toThrow(/outside the document folder/);
        await expect(readExternalDocumentAsset('unissued-id', 'manual.pdf')).rejects.toThrow(
            /no longer available/,
        );
        expect(directory).toBeTruthy();
    });

    it('opens a linked document in the same folder as another external document', async () => {
        const { directory, document } = await externalFile();
        await writeFile(join(directory, 'next.md'), '# Next\n', 'utf8');

        const linked = await openLinkedExternalDocument(document.id, 'next.md');

        expect(linked).toMatchObject({ name: 'next.md', content: '# Next\n' });
        expect(linked.id).not.toBe(document.id);
        await expect(openLinkedExternalDocument(document.id, '../next.md')).rejects.toThrow(
            /outside the document folder/,
        );
    });
});
