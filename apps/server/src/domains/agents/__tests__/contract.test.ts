import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalPath, processStateToAgentActivity, projectDirectories } from '../contract';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('canonicalPath', () => {
    it('resolves a symlinked path to the same realpath as its target', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-canonical-'));
        temporaryDirectories.push(directory);
        const target = join(directory, 'target');
        await mkdir(target);
        const link = join(directory, 'link');
        await symlink(target, link);

        const canonicalTarget = await canonicalPath(target);

        await expect(canonicalPath(link)).resolves.toBe(canonicalTarget);
        await expect(canonicalPath(link)).resolves.not.toBe(link);
    });

    it('falls back to a normalized absolute path when the target does not exist', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-canonical-missing-'));
        temporaryDirectories.push(directory);
        const missing = join(directory, 'nested', '..', 'does-not-exist');

        await expect(canonicalPath(missing)).resolves.toBe(resolve(missing));
    });
});

describe('processStateToAgentActivity', () => {
    it.each([
        ['starting', 'unknown'],
        ['running', 'unknown'],
        ['stopped', 'completed'],
        ['dead', 'failed'],
        ['failed', 'failed'],
        [undefined, 'unknown'],
    ] as const)('maps process state %s to activity %s', (state, activity) => {
        expect(processStateToAgentActivity(state)).toBe(activity);
    });
});

describe('projectDirectories', () => {
    it('stays inside the Project and bounds deeply nested discovery roots', () => {
        expect(projectDirectories({ projectRoot: '/project', cwd: '/outside/worktree' })).toEqual([
            '/project',
        ]);

        const deepCwd = join('/project', ...Array.from({ length: 100 }, (_, index) => `d${index}`));
        const directories = projectDirectories({ projectRoot: '/project', cwd: deepCwd });
        expect(directories).toHaveLength(30);
        expect(directories[0]).toBe('/project');
        expect(directories.at(-1)).toBe(deepCwd);
    });
});
