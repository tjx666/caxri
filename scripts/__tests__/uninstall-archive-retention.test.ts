import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { completedArchiveCandidates } from '../uninstall-archive-retention';
import type { CaxriUninstallOptions } from '../uninstall-caxri';
import { uninstallCaxri } from '../uninstall-caxri';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
    home: string;
    options: CaxriUninstallOptions;
    profile: string;
}> {
    const home = await mkdtemp(join(tmpdir(), 'caxri-archive-retention-'));
    temporaryDirectories.push(home);
    const profile = join(home, 'Library', 'Application Support', 'Caxri');
    await mkdir(join(profile, 'host'), { recursive: true });
    await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
    return {
        home,
        options: {
            apply: true,
            archiveRootPath: join(home, 'code', 'caxri-uninstall-archives'),
            homeDirectory: home,
            includeDevProfiles: false,
            profilePath: profile,
            removeApplications: false,
            removeGlobalCli: false,
        },
        profile,
    };
}

async function createCompletedArchive(root: string, name: string): Promise<string> {
    const archive = join(root, name);
    await mkdir(archive, { recursive: true });
    await writeFile(
        join(archive, 'manifest.json'),
        `${JSON.stringify({
            archiveDirectory: archive,
            createdAt: '2025-01-01T00:00:00.000Z',
            schemaVersion: 1,
            targets: [
                {
                    archivedPath: join(archive, '01-Caxri'),
                    originalPath: '/Users/example/Library/Application Support/Caxri',
                    status: 'archived',
                },
            ],
        })}\n`,
        'utf8',
    );
    return archive;
}

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { force: true, recursive: true })));
});

describe('Caxri uninstall archive retention', () => {
    it('reports older completed archives without deleting them in a dry run', async () => {
        const { options, profile } = await fixture();
        const olderArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-01T00-00-00-000Z-DRY123',
        );

        const result = await uninstallCaxri(
            { ...options, apply: false },
            { inspectPathOwner: () => Promise.resolve(undefined) },
        );

        expect(result.archivePruneCandidates).toEqual([olderArchive]);
        expect(result.prunedArchives).toEqual([]);
        expect((await lstat(olderArchive)).isDirectory()).toBe(true);
        expect((await lstat(profile)).isDirectory()).toBe(true);
    });

    it('keeps only the new non-empty archive while retaining unsafe or newer siblings', async () => {
        const { home, options } = await fixture();
        const olderArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-01T00-00-00-000Z-ABC123',
        );
        const newerArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2099-01-01T00-00-00-000Z-ABC123',
        );
        const manualArchive = join(options.archiveRootPath, 'manual-backup');
        await mkdir(manualArchive);
        const symlinkTarget = join(home, 'archive-symlink-target');
        const symlinkArchive = join(
            options.archiveRootPath,
            'uninstall-2025-01-02T00-00-00-000Z-ABC123',
        );
        await mkdir(symlinkTarget);
        await symlink(symlinkTarget, symlinkArchive);

        const result = await uninstallCaxri(options, {
            inspectPathOwner: () => Promise.resolve(undefined),
        });

        expect(result).toMatchObject({
            archivePruneCandidates: [olderArchive],
            archivePruneFailures: [],
            prunedArchives: [olderArchive],
        });
        await expect(lstat(olderArchive)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lstat(newerArchive)).isDirectory()).toBe(true);
        expect((await lstat(manualArchive)).isDirectory()).toBe(true);
        expect((await lstat(symlinkArchive)).isSymbolicLink()).toBe(true);
        expect((await lstat(result.archiveDirectory!)).isDirectory()).toBe(true);
    });

    it('keeps older archives after a target move failure', async () => {
        const { options, profile } = await fixture();
        const olderArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-01T00-00-00-000Z-DEF456',
        );

        const result = await uninstallCaxri(options, {
            inspectPathOwner: () => Promise.resolve(undefined),
            moveToArchive: () =>
                Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
        });

        expect(result.failedTargets).toEqual([{ message: 'permission denied', path: profile }]);
        expect(result.prunedArchives).toEqual([]);
        expect((await lstat(olderArchive)).isDirectory()).toBe(true);
    });

    it('keeps older archives when every planned source disappears before moving', async () => {
        const { options } = await fixture();
        const olderArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-01T00-00-00-000Z-GHI789',
        );

        const result = await uninstallCaxri(options, {
            inspectPathOwner: () => Promise.resolve(undefined),
            moveToArchive: () =>
                Promise.reject(Object.assign(new Error('already absent'), { code: 'ENOENT' })),
        });

        expect(result.failedTargets).toEqual([]);
        expect(result.movedTargets).toEqual([]);
        expect(result.prunedArchives).toEqual([]);
        expect((await lstat(olderArchive)).isDirectory()).toBe(true);
    });

    it('does not order same-millisecond archives by their random suffix', async () => {
        const { options } = await fixture();
        const olderArchive = await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-01T00-00-00-999Z-OLD123',
        );
        await createCompletedArchive(
            options.archiveRootPath,
            'uninstall-2025-01-02T00-00-00-000Z-AAA111',
        );

        const candidates = await completedArchiveCandidates(
            options.archiveRootPath,
            'uninstall-2025-01-02T00-00-00-000Z-ZZZ999',
        );

        expect(candidates).toEqual([olderArchive]);
    });
});
