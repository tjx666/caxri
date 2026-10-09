import { link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    clearExternalDocumentsForTesting,
    externalDocumentDirectory,
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
