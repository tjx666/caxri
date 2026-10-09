import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readExternalFileSnapshot } from '../external-file-snapshot';

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-external-snapshot-'));
    created.push(directory);
    return directory;
}

afterEach(async () => {
    const pending = [...created];
    created.length = 0;
    await Promise.all(pending.map((path) => rm(path, { force: true, recursive: true })));
});

describe('readExternalFileSnapshot', () => {
    /**
     * `/tmp` is a symbolic link to `/private/tmp` on macOS, so an Agent that prints a perfectly ordinary `/tmp/...`
     * path produced a Terminal link Caxri refused as "Browse location is not a directory", a file that plainly existed
     * reported as missing. Only the ancestors may be resolved; the file itself stays lexical.
     */
    it('opens a file whose containing directory is reached through a symlinked ancestor', async () => {
        const real = await temporaryDirectory();
        const linkParent = await temporaryDirectory();
        const link = join(linkParent, 'linked');
        await symlink(real, link);
        await writeFile(join(real, 'note.txt'), 'external content', 'utf8');

        const document = await readExternalFileSnapshot(join(link, 'note.txt'));

        expect(document.content).toBe('external content');
        expect(document.name).toBe('note.txt');
    });

    it('still refuses a symbolic link standing in for the file itself', async () => {
        const directory = await temporaryDirectory();
        await writeFile(join(directory, 'target.txt'), 'external content', 'utf8');
        await symlink(join(directory, 'target.txt'), join(directory, 'alias.txt'));

        await expect(readExternalFileSnapshot(join(directory, 'alias.txt'))).rejects.toThrow(
            /Symbolic links cannot be opened/,
        );
    });

    it('requires an absolute path', async () => {
        await expect(readExternalFileSnapshot('relative/note.txt')).rejects.toThrow(
            /must be absolute/,
        );
    });
});
