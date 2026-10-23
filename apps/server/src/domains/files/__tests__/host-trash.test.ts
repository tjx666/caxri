import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hostTrashDirectory, moveToHostTrash } from '../host-trash';

describe('moveToHostTrash on a freedesktop.org host', () => {
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
            platform: 'linux',
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

        await moveToHostTrash(first, { directory: trash, platform: 'linux' });
        const target = await moveToHostTrash(second, { directory: trash, platform: 'linux' });

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

        expect(await moveToHostTrash(source, { directory: trash, platform: 'linux' })).toBe(
            join(trash, 'files', 'a.2.md'),
        );
        expect(await readFile(join(trash, 'files', 'a.md'), 'utf8')).toBe('orphan');
    });

    it('moves a whole folder', async () => {
        const folder = join(root, 'project', 'my notes');
        await writeFile(join(folder, 'b.md'), 'b');

        const target = await moveToHostTrash(folder, { directory: trash, platform: 'linux' });

        expect(await readFile(join(target, 'b.md'), 'utf8')).toBe('b');
        await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('releases the reserved name when the entry cannot be moved', async () => {
        await expect(
            moveToHostTrash(join(root, 'project', 'missing.md'), {
                directory: trash,
                platform: 'linux',
            }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(trash, 'info'))).toEqual([]);
    });

    it('follows XDG_DATA_HOME and ignores a relative one, as the specification requires', () => {
        expect(hostTrashDirectory({ XDG_DATA_HOME: '/data' }, 'linux')).toBe('/data/Trash');
        expect(hostTrashDirectory({ XDG_DATA_HOME: 'relative' }, 'linux')).toMatch(
            /\/\.local\/share\/Trash$/u,
        );
    });
});

describe('moveToHostTrash on macOS', () => {
    let root: string;
    let trash: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-host-trash-'));
        trash = join(root, '.Trash');
        await mkdir(join(root, 'project', 'notes'), { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { force: true, recursive: true });
    });

    it('uses ~/.Trash and ignores XDG_DATA_HOME', () => {
        expect(hostTrashDirectory({ XDG_DATA_HOME: '/data' }, 'darwin')).toBe(
            join(homedir(), '.Trash'),
        );
    });

    it('moves files and folders into ~/.Trash without overwriting a same-named entry', async () => {
        await writeFile(join(root, 'project', 'a.md'), 'one');
        await writeFile(join(root, 'project', 'notes', 'a.md'), 'two');
        await mkdir(trash);
        await writeFile(join(trash, 'a.md'), 'already there');

        const first = await moveToHostTrash(join(root, 'project', 'a.md'), {
            directory: trash,
            platform: 'darwin',
        });
        const second = await moveToHostTrash(join(root, 'project', 'notes', 'a.md'), {
            directory: trash,
            platform: 'darwin',
        });
        const folder = await moveToHostTrash(join(root, 'project', 'notes'), {
            directory: trash,
            platform: 'darwin',
        });

        expect(first).toBe(join(trash, 'a 2.md'));
        expect(second).toBe(join(trash, 'a 3.md'));
        expect(folder).toBe(join(trash, 'notes'));
        expect(await readFile(join(trash, 'a.md'), 'utf8')).toBe('already there');
        expect(await readFile(first, 'utf8')).toBe('one');
        expect(await readFile(second, 'utf8')).toBe('two');
        expect(await readdir(join(root, 'project'))).toEqual([]);
    });

    it('never replaces an empty folder of the same name, and moves a link itself', async () => {
        await mkdir(join(trash, 'notes'), { recursive: true });
        await symlink('notes', join(root, 'project', 'link'));

        const folder = await moveToHostTrash(join(root, 'project', 'notes'), {
            directory: trash,
            platform: 'darwin',
        });
        const link = await moveToHostTrash(join(root, 'project', 'link'), {
            directory: trash,
            platform: 'darwin',
        });

        expect(folder).toBe(join(trash, 'notes 2'));
        expect(await readdir(join(trash, 'notes'))).toEqual([]);
        expect(link).toBe(join(trash, 'link'));
        expect((await stat(join(root, 'project'))).isDirectory()).toBe(true);
        expect(await readdir(join(root, 'project'))).toEqual([]);
    });

    it('reserves no name when the entry is missing', async () => {
        await mkdir(trash);
        await expect(
            moveToHostTrash(join(root, 'project', 'missing.md'), {
                directory: trash,
                platform: 'darwin',
            }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(trash)).toEqual([]);
    });
});
