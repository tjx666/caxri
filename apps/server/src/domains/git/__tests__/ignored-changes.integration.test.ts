import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitCommandOptions } from '../command';
import { IgnoredChangeFilter } from '../ignored-changes';

const directories: string[] = [];

afterEach(async () => {
    const created = [...directories];
    directories.length = 0;
    await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), 'caxri-ignored-changes-'));
    const root = await realpath(created);
    directories.push(root);
    const git = (...arguments_: string[]) => execFileSync('git', arguments_, { cwd: root });
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, '.gitignore'), 'dist/\nkept/\n*.log\n');
    await mkdir(join(root, 'kept'));
    await writeFile(join(root, 'kept', 'keep.txt'), 'tracked inside an ignored directory\n');
    git('add', '.gitignore');
    git('add', '-f', 'kept/keep.txt');
    return root;
}

function filterFor(root: string) {
    const run = vi.fn((cwd: string, arguments_: string[], options?: GitCommandOptions) =>
        Promise.resolve(
            execFileSync('git', arguments_, {
                cwd,
                encoding: 'utf8',
                input: options?.input,
                maxBuffer: options?.maxBufferBytes,
            }),
        ),
    );
    const tracker = {
        groupChangesByRoot: (_sessionId: string, paths: readonly string[]) =>
            new Map([[root, paths.map((path) => join(root, path))]]),
    };
    const filter = new IgnoredChangeFilter(tracker, run);
    const relevantRoots = (paths: string[], flags: { overflow?: boolean } = {}) =>
        filter.relevantRoots({
            sessionId: 'session-1',
            changes: paths.map((path) => ({ path })),
            ...flags,
        });
    return { filter, relevantRoots, run };
}

describe('IgnoredChangeFilter', () => {
    it('drops a build writing ignored files, and remembers the ignored directory', async () => {
        const root = await repo();
        const { relevantRoots, run } = filterFor(root);

        await expect(
            relevantRoots(['dist/main.js', 'dist/assets/app.css', 'debug.log']),
        ).resolves.toEqual([]);
        const spawned = run.mock.calls.length;
        await expect(relevantRoots(['dist/assets/other.css'])).resolves.toEqual([]);
        expect(run.mock.calls.length).toBe(spawned);
    });

    it('keeps a change Git can see', async () => {
        const root = await repo();
        const { relevantRoots } = filterFor(root);

        await expect(relevantRoots(['dist/main.js', 'src/app.ts'])).resolves.toEqual([root]);
    });

    it('keeps a tracked file inside an ignored directory, and never remembers that directory', async () => {
        const root = await repo();
        const { relevantRoots } = filterFor(root);

        await expect(relevantRoots(['kept/other.txt'])).resolves.toEqual([]);
        await expect(relevantRoots(['kept/keep.txt'])).resolves.toEqual([root]);
    });

    it('keeps every root of an overflowed batch and forgets what it remembered there', async () => {
        const root = await repo();
        const { relevantRoots, run } = filterFor(root);

        await relevantRoots(['dist/main.js']);
        await expect(relevantRoots(['dist/main.js'], { overflow: true })).resolves.toEqual([root]);
        const spawned = run.mock.calls.length;
        await relevantRoots(['dist/main.js']);
        expect(run.mock.calls.length).toBeGreaterThan(spawned);
    });
});
