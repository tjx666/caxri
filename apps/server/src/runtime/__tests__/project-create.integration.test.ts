import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { createRuntime } from '../bootstrap';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('project.create', () => {
    it('creates a Project when the selected root identity is unchanged', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-create-selected-'));
        temporaryDirectories.push(temporaryDirectory);
        const directory = await realpath(temporaryDirectory);
        const selectedRoot = join(directory, 'selected');
        await mkdir(selectedRoot);
        const selectedIdentity = await lstat(selectedRoot, { bigint: true });
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
        });

        try {
            await expect(
                runtime.handlers['project.create']({
                    rootPath: selectedRoot,
                    expectedRootIdentity: {
                        path: selectedRoot,
                        device: selectedIdentity.dev.toString(),
                        inode: selectedIdentity.ino.toString(),
                    },
                }),
            ).resolves.toMatchObject({ rootPath: selectedRoot });
        } finally {
            await runtime.close();
        }
    });

    it('rejects a selected root replaced before durable Project creation', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-create-identity-'));
        temporaryDirectories.push(temporaryDirectory);
        const directory = await realpath(temporaryDirectory);
        const selectedRoot = join(directory, 'selected');
        await mkdir(selectedRoot);
        const selectedIdentity = await lstat(selectedRoot, { bigint: true });
        await rename(selectedRoot, join(directory, 'selected-original'));
        await mkdir(selectedRoot);
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
        });

        try {
            const parameters: Parameters<(typeof runtime.handlers)['project.create']>[0] = {
                rootPath: selectedRoot,
                expectedRootIdentity: {
                    path: selectedRoot,
                    device: selectedIdentity.dev.toString(),
                    inode: selectedIdentity.ino.toString(),
                },
            };

            await expect(runtime.handlers['project.create'](parameters)).rejects.toMatchObject({
                code: 'PATH_DENIED',
            });
            expect(runtime.handlers['project.list']({})).toEqual({
                view: 'desktop',
                projects: [],
            });
        } finally {
            await runtime.close();
        }
    });
});
