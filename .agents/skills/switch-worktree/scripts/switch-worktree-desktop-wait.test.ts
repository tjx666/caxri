import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireDesktopLease, releaseDesktopLease } from './desktop-lease';
import { runCapture } from './process';
import { repoContext, withRepoLock } from './repo';
import { runCli } from './switch-worktree';

const temporaryDirectories: string[] = [];

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-desktop-wait-'));
    temporaryDirectories.push(temporary);
    const root = join(temporary, 'repository');
    await mkdir(root);
    await runCapture('git', ['init', '-b', 'main'], root);
    await runCapture('git', ['config', 'user.email', 'caxri@example.invalid'], root);
    await runCapture('git', ['config', 'user.name', 'Caxri Test'], root);
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await runCapture('git', ['add', 'README.md'], root);
    await runCapture('git', ['commit', '-m', 'initial'], root);
    return root;
}

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('switch-worktree desktop --wait', () => {
    it('rejects a wait outside whole seconds from 1 to 1800', async () => {
        await expect(
            runCli(['desktop', '--label', 'Benchmark', '--wait', '0', '--', 'true']),
        ).rejects.toThrow('--wait requires whole seconds');
        await expect(
            runCli(['desktop', '--label', 'Benchmark', '--wait', '1.5', '--', 'true']),
        ).rejects.toThrow('--wait requires whole seconds');
    });

    it('runs its command once a busy lease is released', async () => {
        const root = await createRepo();
        const first = await acquireDesktopLease(root, 'Acceptance');
        const previousCwd = process.cwd();
        try {
            process.chdir(root);
            const waiting = runCli([
                'desktop',
                '--label',
                'Benchmark',
                '--wait',
                '10',
                '--',
                'true',
            ]);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await releaseDesktopLease(first);
            await expect(waiting).resolves.toBeUndefined();
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('waits out a repository operation that holds the lock past its default 10s', async () => {
        const root = await createRepo();
        const context = await repoContext(root);
        const held = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const holding = withRepoLock(context, () => {
            held.resolve();
            return released.promise;
        });
        await held.promise;
        const waiting = acquireDesktopLease(root, 'Android Acceptance', process.pid, {
            waitMs: 30_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 10_500));
        released.resolve();
        await holding;
        const lease = await waiting;
        await releaseDesktopLease(lease);
    }, 30_000);
});
