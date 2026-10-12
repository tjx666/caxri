import type * as FileSystemPromises from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectFolderBrowser } from '../folder-browse';

/**
 * Paths whose `stat` never settles, standing in for an unreachable automount or network share.
 */
const hangingPaths = new Set<string>();

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FileSystemPromises>();
    return {
        ...actual,
        stat: (path: string) =>
            [...hangingPaths].some((hanging) => path.startsWith(hanging))
                ? new Promise(() => {})
                : actual.stat(path),
    };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
    hangingPaths.clear();
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-folder-browse-'));
    const root = await realpath(temporary);
    temporaryDirectories.push(root);
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'repo', 'src'));
    await mkdir(join(root, 'empty'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'file.txt'), 'x');
    return root;
}

describe('project.browseFolders', () => {
    it('lists visible subfolders of the home directory by default with Git and child hints', async () => {
        const home = await fixture();
        const browse = createProjectFolderBrowser({ homeDirectory: () => Promise.resolve(home) })[
            'project.browseFolders'
        ];
        const result = await browse({});
        expect(result).toMatchObject({ path: home, home, truncated: false });
        expect(result.entries).toEqual([
            {
                name: 'empty',
                path: join(home, 'empty'),
                isGitRepository: false,
                hasChildren: false,
            },
            { name: 'repo', path: join(home, 'repo'), isGitRepository: true, hasChildren: true },
        ]);
    });

    it('browses absolute folders outside home and reports the parent', async () => {
        const home = await fixture();
        const browse = createProjectFolderBrowser({ homeDirectory: () => Promise.resolve('/') })[
            'project.browseFolders'
        ];
        const result = await browse({ path: join(home, 'repo') });
        expect(result.parent).toBe(home);
        expect(result.entries.map((entry) => entry.name)).toEqual(['src']);
    });

    it('rejects relative paths, files, and missing folders with classified errors', async () => {
        const home = await fixture();
        const browse = createProjectFolderBrowser({ homeDirectory: () => Promise.resolve(home) })[
            'project.browseFolders'
        ];
        await expect(browse({ path: 'repo' })).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(browse({ path: join(home, 'file.txt') })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
        await expect(browse({ path: join(home, 'missing') })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('reports the filesystem root as having no parent', async () => {
        const browse = createProjectFolderBrowser({ homeDirectory: () => Promise.resolve('/') })[
            'project.browseFolders'
        ];
        expect((await browse({ path: '/' })).parent).toBeNull();
    });

    it('still lists a folder whose probe hangs, as expandable and without the Git badge', async () => {
        const home = await fixture();
        hangingPaths.add(join(home, 'repo'));
        const browse = createProjectFolderBrowser({
            homeDirectory: () => Promise.resolve(home),
            entryProbeTimeoutMs: 50,
        })['project.browseFolders'];
        expect((await browse({})).entries).toEqual([
            {
                name: 'empty',
                path: join(home, 'empty'),
                isGitRepository: false,
                hasChildren: false,
            },
            { name: 'repo', path: join(home, 'repo'), isGitRepository: false, hasChildren: true },
        ]);
    });
});
