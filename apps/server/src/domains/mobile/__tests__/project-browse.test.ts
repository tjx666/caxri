import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { createMobileProjectAddHandler, createMobileProjectBrowseHandler } from '../project-browse';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A sandbox home directory with a normal Project candidate, a Git repository, a dotfolder that must stay hidden, and a
 * symlink that escapes the sandbox entirely, plus a real directory outside the sandbox for a `..` escape attempt.
 */
async function createSandbox(): Promise<{ home: string; outsideSecret: string }> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-project-browse-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'home'), { recursive: true });
    const home = await realpath(join(root, 'home'));
    const outside = join(root, 'outside');
    await mkdir(join(home, 'project-a'), { recursive: true });
    await mkdir(join(home, 'project-b', '.git'), { recursive: true });
    await mkdir(join(home, 'project-a', 'child'), { recursive: true });
    await mkdir(join(home, '.hidden'), { recursive: true });
    const outsideSecret = join(outside, 'secret');
    await mkdir(outsideSecret, { recursive: true });
    await symlink(join('..', 'outside', 'secret'), join(home, 'escape-link'));
    return { home, outsideSecret };
}

describe('createMobileProjectBrowseHandler', () => {
    it('lists visible directories, hides dotfolders, and marks Git repositories and children', async () => {
        const { home } = await createSandbox();
        const browse = createMobileProjectBrowseHandler({
            homeDirectory: () => Promise.resolve(home),
        });
        const result = await browse({ path: undefined });
        expect(result.truncated).toBe(false);
        expect(
            result.entries
                .map((entry) => entry.name)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['escape-link', 'project-a', 'project-b']);
        expect(result.entries.find((entry) => entry.name === 'project-a')).toMatchObject({
            relativePath: 'project-a',
            isGitRepository: false,
            hasChildren: true,
        });
        expect(result.entries.find((entry) => entry.name === 'project-b')).toMatchObject({
            isGitRepository: true,
            hasChildren: false,
        });
    });

    it('rejects a `..` traversal that resolves outside the home directory', async () => {
        const { home } = await createSandbox();
        const browse = createMobileProjectBrowseHandler({
            homeDirectory: () => Promise.resolve(home),
        });
        await expect(browse({ path: '../outside' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects a symlink whose target resolves outside the home directory', async () => {
        const { home } = await createSandbox();
        const browse = createMobileProjectBrowseHandler({
            homeDirectory: () => Promise.resolve(home),
        });
        await expect(browse({ path: 'escape-link' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects a path that does not exist', async () => {
        const { home } = await createSandbox();
        const browse = createMobileProjectBrowseHandler({
            homeDirectory: () => Promise.resolve(home),
        });
        await expect(browse({ path: 'does-not-exist' })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });
});

describe('createMobileProjectAddHandler', () => {
    it('adds a Project after resolving the canonical root inside home', async () => {
        const { home } = await createSandbox();
        const createProject = vi.fn().mockReturnValue({ id: 'project-1', displayTitle: 'Demo' });
        const emit = vi.fn();
        const database = { createProject } as unknown as CaxriDatabase;
        const add = createMobileProjectAddHandler({
            database,
            emit,
            homeDirectory: () => Promise.resolve(home),
        });
        const result = await add({ path: 'project-a' });
        expect(result).toEqual({ project: { id: 'project-1', displayTitle: 'Demo' } });
        expect(createProject).toHaveBeenCalledWith(join(home, 'project-a'));
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.create' },
        });
    });

    it('rejects a `..` traversal without ever creating a Project', async () => {
        const { home } = await createSandbox();
        const createProject = vi.fn();
        const database = { createProject } as unknown as CaxriDatabase;
        const add = createMobileProjectAddHandler({
            database,
            emit: vi.fn(),
            homeDirectory: () => Promise.resolve(home),
        });
        await expect(add({ path: '../outside/secret' })).rejects.toMatchObject({
            code: 'FORBIDDEN',
        });
        expect(createProject).not.toHaveBeenCalled();
    });

    it('rejects a symlink escape without ever creating a Project', async () => {
        const { home } = await createSandbox();
        const createProject = vi.fn();
        const database = { createProject } as unknown as CaxriDatabase;
        const add = createMobileProjectAddHandler({
            database,
            emit: vi.fn(),
            homeDirectory: () => Promise.resolve(home),
        });
        await expect(add({ path: 'escape-link' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(createProject).not.toHaveBeenCalled();
    });
});
