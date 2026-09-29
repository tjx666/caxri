import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MOBILE_CHANGES_MAX_PATCH_BYTES } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const directories: string[] = [];
const services: GitService[] = [];
const databases: CaxriDatabase[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    await Promise.all(services.map((service) => service.close()));
    services.length = 0;
    for (const database of databases) database.close();
    databases.length = 0;
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function fixture({ shouldCommit = true } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-changes-'));
    directories.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Fixture User'], { cwd: root });
    await writeFile(join(root, 'tracked.txt'), 'old\n');
    await writeFile(join(root, 'dense.txt'), 'old\n');
    await writeFile(join(root, 'rename.txt'), 'renamed\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    if (shouldCommit) await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const support = await mkdtemp(join(tmpdir(), 'caxri-mobile-changes-support-'));
    directories.push(support);
    const database = new CaxriDatabase(join(support, 'test.db'));
    databases.push(database);
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const logger = new StructuredLogger(join(support, 'logs'));
    loggers.push(logger);
    const git = new GitService(new ProjectRootResolver(database), logger);
    services.push(git);
    return { git, root, session };
}

describe('mobile changes Git projection', () => {
    it('uses the final working tree after staging in an unborn repository', async () => {
        const { git, root, session } = await fixture({ shouldCommit: false });
        await writeFile(join(root, 'tracked.txt'), 'after staging\nsecond line\n');
        const list = await git.mobileChangesList(session.id, true);
        const file = list.files.find((entry) => entry.path === 'tracked.txt');
        expect(file).toMatchObject({ status: 'A', additions: 2, deletions: 0 });
        const diff = await git.mobileChangesDiff(session.id, file!.repositoryId, file!.path);
        expect(diff.status).toBe('available');
        if (diff.status === 'available') {
            expect(diff.patch).toContain('+after staging');
            expect(diff.patch).toContain('+second line');
            expect(diff.patch).not.toContain('+old');
        }
    });

    it('does not consume the Desktop numeric refresh sequence', async () => {
        const { git, root, session } = await fixture();
        const nonce = Date.now();
        await git.summary(session.id, nonce, 'renderer');
        await writeFile(join(root, 'tracked.txt'), 'after mobile refresh\n');
        await git.mobileChangesList(session.id, true);
        const afterMobile = await git.summary(session.id, 0, 'renderer');
        await writeFile(join(root, 'tracked.txt'), 'after desktop refresh\n');
        const next = await git.summary(session.id, nonce + 1, 'renderer');
        expect(next.repositories[0].generation).toBeGreaterThan(
            afterMobile.repositories[0].generation,
        );
        expect(next.repositories[0].files.map((file) => file.path)).toContain('tracked.txt');
    });

    it('returns authorized relative paths, counts, and bounded unified patches for tracked and untracked files', async () => {
        const { git, root, session } = await fixture();
        await writeFile(join(root, 'tracked.txt'), 'new\n');
        await writeFile(join(root, 'dense.txt'), 'line\n'.repeat(1_001));
        await rename(join(root, 'rename.txt'), join(root, 'moved.txt'));
        await execFileAsync('git', ['add', '-A', '--', 'rename.txt', 'moved.txt'], { cwd: root });
        await writeFile(join(root, 'added.txt'), 'first\nsecond\n');
        await writeFile(join(root, 'binary.bin'), new Uint8Array([1, 0, 2]));
        await writeFile(join(root, 'large.txt'), 'x'.repeat(MOBILE_CHANGES_MAX_PATCH_BYTES));
        await writeFile(join(root, 'many-lines.txt'), 'line\n'.repeat(1_001));
        await writeFile(join(root, 'bounded-lines.txt'), 'line\n'.repeat(995));
        await writeFile(join(root, 'escaped.txt'), '\\'.repeat(30 * 1024));

        const list = await git.mobileChangesList(session.id, true);
        expect(list.isRepository).toBe(true);
        expect(list.files.map((file) => file.path)).toEqual(
            expect.arrayContaining([
                'tracked.txt',
                'moved.txt',
                'added.txt',
                'binary.bin',
                'large.txt',
            ]),
        );
        expect(list.files.every((file) => !file.path.startsWith(root))).toBe(true);
        const repoId = list.files[0].repositoryId;
        expect(list.files.find((file) => file.path === 'added.txt')).toMatchObject({
            status: 'A',
            additions: 2,
            deletions: 0,
        });
        expect(list.files.find((file) => file.path === 'added.txt')?.repositoryName).toBeTruthy();
        // Git has no line count for a binary file, so the row carries none instead of `+0 −0`.
        expect(list.files.find((file) => file.path === 'binary.bin')).not.toHaveProperty(
            'additions',
        );
        expect(list.files.find((file) => file.path === 'moved.txt')).toMatchObject({
            status: 'R',
            originalPath: 'rename.txt',
        });
        const tracked = await git.mobileChangesDiff(session.id, repoId, 'tracked.txt');
        expect(tracked.status).toBe('available');
        if (tracked.status === 'available') expect(tracked.patch).toContain('@@');
        const added = await git.mobileChangesDiff(session.id, repoId, 'added.txt');
        expect(added.status).toBe('available');
        if (added.status === 'available') expect(added.patch).toContain('+first');
        await expect(git.mobileChangesDiff(session.id, repoId, 'binary.bin')).resolves.toEqual({
            status: 'binary',
        });
        await expect(git.mobileChangesDiff(session.id, repoId, 'large.txt')).resolves.toEqual({
            status: 'oversized',
        });
        await expect(git.mobileChangesDiff(session.id, repoId, 'many-lines.txt')).resolves.toEqual({
            status: 'oversized',
        });
        await expect(git.mobileChangesDiff(session.id, repoId, 'dense.txt')).resolves.toEqual({
            status: 'oversized',
        });
        await expect(
            git.mobileChangesDiff(session.id, repoId, 'bounded-lines.txt'),
        ).resolves.toMatchObject({ status: 'available' });
        await expect(git.mobileChangesDiff(session.id, repoId, 'escaped.txt')).resolves.toEqual({
            status: 'oversized',
        });
        await expect(git.mobileChangesDiff(session.id, repoId, '../tracked.txt')).resolves.toEqual({
            status: 'stale',
        });
        await expect(
            git.mobileChangesDiff(session.id, 'unapproved-repo', 'tracked.txt'),
        ).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });
});
