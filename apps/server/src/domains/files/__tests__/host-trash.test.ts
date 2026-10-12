import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hostTrashDirectory, moveToHostTrash } from '../host-trash';

describe('moveToHostTrash', () => {
    let root: string;
    let trash: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-host-trash-'));
        trash = join(root, 'data', 'Trash');
        await mkdir(join(root, 'project', 'my notes'), { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it('moves the entry into files/ and records where it came from in info/', async () => {
        const source = join(root, 'project', 'my notes', 'a.md');
        await writeFile(source, 'draft');

        const target = await moveToHostTrash(source, {
            directory: trash,
            now: new Date(2026, 9, 13, 8, 5, 9),
        });

        expect(target).toBe(join(trash, 'files', 'a.md'));
        expect(await readFile(target, 'utf8')).toBe('draft');
        await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(trash, 'info', 'a.md.trashinfo'), 'utf8')).toBe(
            `[Trash Info]\nPath=${join(root, 'project', 'my%20notes', 'a.md')}\nDeletionDate=2026-10-13T08:05:09\n`,
        );
        expect((await stat(join(trash, 'files'))).mode & 0o777).toBe(0o700);
    });

    it('gives a second entry with the same name its own slot instead of overwriting the first', async () => {
        const first = join(root, 'project', 'a.md');
        const second = join(root, 'project', 'my notes', 'a.md');
        await writeFile(first, 'one');
        await writeFile(second, 'two');

        await moveToHostTrash(first, { directory: trash });
        const target = await moveToHostTrash(second, { directory: trash });

        expect(target).toBe(join(trash, 'files', 'a.2.md'));
        expect(
            (await readdir(join(trash, 'files'))).toSorted((left, right) =>
                left.localeCompare(right),
            ),
        ).toEqual(['a.2.md', 'a.md']);
        expect(await readFile(join(trash, 'files', 'a.md'), 'utf8')).toBe('one');
        expect(await readFile(join(trash, 'info', 'a.2.md.trashinfo'), 'utf8')).toContain(
            `Path=${join(root, 'project', 'my%20notes', 'a.md')}`,
        );
    });

    it('never overwrites an orphaned Trash entry that has no .trashinfo', async () => {
        await mkdir(join(trash, 'files'), { recursive: true });
        await writeFile(join(trash, 'files', 'a.md'), 'orphan');
        const source = join(root, 'project', 'a.md');
        await writeFile(source, 'new');

        expect(await moveToHostTrash(source, { directory: trash })).toBe(
            join(trash, 'files', 'a.2.md'),
        );
        expect(await readFile(join(trash, 'files', 'a.md'), 'utf8')).toBe('orphan');
    });

    it('moves a whole folder', async () => {
        const folder = join(root, 'project', 'my notes');
        await writeFile(join(folder, 'b.md'), 'b');

        const target = await moveToHostTrash(folder, { directory: trash });

        expect(await readFile(join(target, 'b.md'), 'utf8')).toBe('b');
        await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('releases the reserved name when the entry cannot be moved', async () => {
        await expect(
            moveToHostTrash(join(root, 'project', 'missing.md'), { directory: trash }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(trash, 'info'))).toEqual([]);
    });

    it('follows XDG_DATA_HOME and ignores a relative one, as the specification requires', () => {
        expect(hostTrashDirectory({ XDG_DATA_HOME: '/data' })).toBe('/data/Trash');
        expect(hostTrashDirectory({ XDG_DATA_HOME: 'relative' })).toMatch(
            /\/\.local\/share\/Trash$/u,
        );
    });
});
