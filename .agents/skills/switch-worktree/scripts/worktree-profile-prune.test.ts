import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { getProcessIdentity, runCapture } from './process';
import { isPathPresent, repoContext, writeJsonAtomic } from './repo';
import { createWorktree, removeWorktree } from './worktree';
import { pruneOrphanProfiles } from './worktree-profile-prune';

interface Fixture {
    root: string;
    temporary: string;
}

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createFixture(): Promise<Fixture> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-profile-prune-'));
    temporaryDirectories.push(temporary);
    const remote = join(temporary, 'remote.git');
    const root = join(temporary, 'caxri');
    await mkdir(root);
    await git(temporary, 'init', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await git(root, 'add', 'README.md', '.gitignore');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-u', 'origin', 'main');
    await mkdir(join(root, 'node_modules'));
    return { root, temporary };
}

async function fakeInstall(path: string): Promise<void> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    await mkdir(join(electronDirectory, 'dist'), { recursive: true });
    await writeFile(join(electronDirectory, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    await writeFile(join(electronDirectory, 'path.txt'), 'electron', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'version'), 'v1.0.0\n', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'electron'), 'binary', 'utf8');
}

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('worktree profile pruning', () => {
    it('previews orphan profiles, applies deletion, and keeps unrecognized entries', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/prune-profiles',
            cwd: fixture.root,
            install: fakeInstall,
        });
        const context = await repoContext(fixture.root);
        const orphan = join(context.stateDir, 'profiles', '2d8f8f26-7544-4ce7-b4de-0406f753513c');
        const unrecognized = join(context.stateDir, 'profiles', 'manual-backup');
        await mkdir(orphan, { recursive: true });
        await mkdir(unrecognized, { recursive: true });

        const preview = await pruneOrphanProfiles(fixture.root, false);
        expect(preview).toMatchObject({ applied: false, orphaned: [orphan], removed: [] });
        expect(preview.skipped).toContainEqual({
            path: unrecognized,
            reason: 'unrecognized profile identity',
        });
        expect(await isPathPresent(orphan)).toBe(true);

        const applied = await pruneOrphanProfiles(fixture.root, true);
        expect(applied).toMatchObject({ applied: true, orphaned: [orphan], removed: [orphan] });
        expect(await isPathPresent(orphan)).toBe(false);
        expect(await isPathPresent(unrecognized)).toBe(true);
        expect(await isPathPresent(created.profile!)).toBe(true);
    });

    it('does not prune a profile preserved during worktree removal', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/preserve-before-prune',
            cwd: fixture.root,
            install: fakeInstall,
        });
        await removeWorktree({
            cwd: fixture.root,
            preserveProfile: true,
            target: created.path,
        });

        const result = await pruneOrphanProfiles(fixture.root, true);

        expect(result.removed).toEqual([]);
        expect(result.skipped).toContainEqual({
            path: created.profile,
            reason: 'profile was explicitly preserved',
        });
        expect(await isPathPresent(created.profile!)).toBe(true);
    });

    it('protects profiles referenced by prunable Git worktree admin entries', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/prunable-profile',
            cwd: fixture.root,
            install: fakeInstall,
        });
        await rm(created.path, { recursive: true });

        const result = await pruneOrphanProfiles(fixture.root, true);

        expect(result.orphaned).not.toContain(created.profile);
        expect(await isPathPresent(created.profile!)).toBe(true);
    });

    it('keeps orphan profiles with a live development process', async () => {
        const fixture = await createFixture();
        const context = await repoContext(fixture.root);
        const identity = 'f66afede-c371-4e28-b75d-3d6918941252';
        const profile = join(context.stateDir, 'profiles', identity);
        await mkdir(profile, { recursive: true });
        await writeJsonAtomic(join(context.stateDir, 'processes', `${identity}.json`), {
            cdpPort: 9300,
            identity: await getProcessIdentity(process.pid),
            pid: process.pid,
            startedAt: new Date().toISOString(),
            token: 'orphan-active-process',
            worktreeId: identity,
            worktreePath: join(fixture.temporary, 'removed-worktree'),
        });

        const result = await pruneOrphanProfiles(fixture.root, true);

        expect(result.removed).toEqual([]);
        expect(result.skipped).toContainEqual({
            path: profile,
            reason: `active dev PID ${process.pid}`,
        });
        expect(await isPathPresent(profile)).toBe(true);
    });

    it('keeps orphan profiles with an active Host lock owner', async () => {
        const fixture = await createFixture();
        const context = await repoContext(fixture.root);
        const identity = 'a97fc36d-18f6-4328-ae65-31b64d3a14f4';
        const profile = join(context.stateDir, 'profiles', identity);
        const lock = join(profile, 'host', 'owner.lock');
        await mkdir(join(profile, 'host'), { recursive: true });
        await writeFile(lock, 'lock\n', 'utf8');

        const result = await pruneOrphanProfiles(fixture.root, true, {
            inspectPathOwner: () => Promise.resolve(4242),
        });

        expect(result.removed).toEqual([]);
        expect(result.skipped).toContainEqual({
            path: profile,
            reason: 'active Host PID 4242',
        });
        expect(await isPathPresent(profile)).toBe(true);
    });

    it('prunes an orphan profile after Host releases an empty owner lock', async () => {
        const fixture = await createFixture();
        const context = await repoContext(fixture.root);
        const identity = '22e98175-4644-4a5b-bcc3-596ba0ded9b7';
        const profile = join(context.stateDir, 'profiles', identity);
        await mkdir(join(profile, 'host'), { recursive: true });
        await writeFile(join(profile, 'host', 'owner.lock'), '', 'utf8');

        const result = await pruneOrphanProfiles(fixture.root, true);

        expect(result).toMatchObject({ orphaned: [profile], removed: [profile], skipped: [] });
        expect(await isPathPresent(profile)).toBe(false);
    });
});
