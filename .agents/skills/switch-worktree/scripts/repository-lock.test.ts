import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { pathExists, repositoryContext, withRepositoryLock } from './repository';

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
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
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('repository lock publication', () => {
    it('publishes complete owner metadata atomically', async () => {
        const context = await repositoryContext(await createRepository());
        const lockPath = join(context.stateDir, 'operation.lock');
        const readyToPublish = Promise.withResolvers<void>();
        const allowPublish = Promise.withResolvers<void>();
        const taskEntered = Promise.withResolvers<void>();
        const allowTaskExit = Promise.withResolvers<void>();

        const operation = withRepositoryLock(
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
        expect(await pathExists(lockPath)).toBe(false);

        allowPublish.resolve();
        await taskEntered.promise;
        await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toContain(
            `"pid": ${process.pid}`,
        );
        allowTaskExit.resolve();
        await expect(operation).resolves.toBeUndefined();
        expect(await pathExists(lockPath)).toBe(false);
    });
});
