import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { isPathPresent, repoContext, withRepoLock } from './repo';

const temporaryDirectories: string[] = [];

async function createRepo(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-repository-lock-'));
    temporaryDirectories.push(temporary);
    const root = join(temporary, 'caxri');
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

describe('repository lock publication', () => {
    it('reclaims an ownerless lock left past its grace period', async () => {
        const context = await repoContext(await createRepo());
        const lockPath = join(context.stateDir, 'operation.lock');
        await mkdir(lockPath, { recursive: true });
        const abandonedAt = new Date(Date.now() - 60_000);
        await utimes(lockPath, abandonedAt, abandonedAt);

        await expect(withRepoLock(context, () => Promise.resolve('entered'))).resolves.toBe(
            'entered',
        );
        expect(await isPathPresent(lockPath)).toBe(false);
    });

    it('publishes complete owner metadata atomically', async () => {
        const context = await repoContext(await createRepo());
        const lockPath = join(context.stateDir, 'operation.lock');
        const readyToPublish = Promise.withResolvers<void>();
        const allowPublish = Promise.withResolvers<void>();
        const taskEntered = Promise.withResolvers<void>();
        const allowTaskExit = Promise.withResolvers<void>();

        const operation = withRepoLock(
            context,
            async () => {
                taskEntered.resolve();
                await allowTaskExit.promise;
            },
            {
                beforeLockPublish: async () => {
                    readyToPublish.resolve();
                    await allowPublish.promise;
                },
            },
        );
        await readyToPublish.promise;
        expect(await isPathPresent(lockPath)).toBe(false);

        allowPublish.resolve();
        await taskEntered.promise;
        await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toContain(
            `"pid": ${process.pid}`,
        );
        allowTaskExit.resolve();
        await expect(operation).resolves.toBeUndefined();
        expect(await isPathPresent(lockPath)).toBe(false);
    });

    it('reclaims an interrupted stale-lock cleanup owner', async () => {
        const context = await repoContext(await createRepo());
        const lockPath = join(context.stateDir, 'operation.lock');
        const cleanupPath = join(context.stateDir, 'operation-lock-cleanup');
        await mkdir(lockPath, { recursive: true });
        await writeFile(
            join(lockPath, 'owner.json'),
            JSON.stringify({
                identity: 'dead-lock-owner',
                pid: process.pid,
                startedAt: new Date().toISOString(),
            }),
            'utf8',
        );
        await mkdir(cleanupPath);
        await writeFile(
            join(cleanupPath, 'owner.json'),
            JSON.stringify({
                identity: 'dead-cleanup-owner',
                pid: process.pid,
                startedAt: new Date().toISOString(),
            }),
            'utf8',
        );

        await expect(withRepoLock(context, () => Promise.resolve('recovered'))).resolves.toBe(
            'recovered',
        );
        expect(await isPathPresent(lockPath)).toBe(false);
        expect(await isPathPresent(cleanupPath)).toBe(false);
    });

    it('lets two contenders converge after reclaiming one stale repository lock', async () => {
        const context = await repoContext(await createRepo());
        const lockPath = join(context.stateDir, 'operation.lock');
        const cleanupPath = join(context.stateDir, 'operation-lock-cleanup');
        await mkdir(lockPath, { recursive: true });
        await writeFile(
            join(lockPath, 'owner.json'),
            JSON.stringify({
                identity: 'stale-process-identity',
                pid: process.pid,
                startedAt: new Date().toISOString(),
            }),
            'utf8',
        );

        let activeTasks = 0;
        let maximumActiveTasks = 0;
        const runContender = (name: string): Promise<string> =>
            withRepoLock(context, async () => {
                activeTasks += 1;
                maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                activeTasks -= 1;
                return name;
            });

        await expect(Promise.all([runContender('first'), runContender('second')])).resolves.toEqual(
            expect.arrayContaining(['first', 'second']),
        );
        expect(maximumActiveTasks).toBe(1);
        expect(await isPathPresent(lockPath)).toBe(false);
        expect(await isPathPresent(cleanupPath)).toBe(false);
    }, 15_000);

    it('replaces the ownerless cleanup marker from an interrupted older worker', async () => {
        const context = await repoContext(await createRepo());
        const cleanupPath = join(context.stateDir, 'operation-lock-cleanup');
        await mkdir(cleanupPath, { recursive: true });

        await expect(withRepoLock(context, () => Promise.resolve('recovered'))).resolves.toBe(
            'recovered',
        );
        expect(await isPathPresent(cleanupPath)).toBe(false);
    });

    it('lets independent resource namespaces hold locks concurrently', async () => {
        const context = await repoContext(await createRepo());
        const releaseFirst = Promise.withResolvers<void>();
        const firstEntered = Promise.withResolvers<void>();
        const first = withRepoLock(
            context,
            async () => {
                firstEntered.resolve();
                await releaseFirst.promise;
            },
            { namespace: 'e2e-worker-0' },
        );
        await firstEntered.promise;

        await expect(
            withRepoLock(context, () => Promise.resolve('second'), {
                namespace: 'e2e-worker-1',
            }),
        ).resolves.toBe('second');
        releaseFirst.resolve();
        await expect(first).resolves.toBeUndefined();
    });
});
