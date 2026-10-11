import { Buffer } from 'node:buffer';
import {
    link,
    mkdir,
    mkdtemp,
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

import { afterEach, describe, expect, it } from 'vitest';

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
            /multiple filesystem links/,
        );
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
