import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    observationProcessManifestDirectory,
    observationProcessManifestPath,
    ObservationProcessManifestPublisher,
    parseObservationProcessManifest,
    readObservationProcessManifest,
} from '../process-manifest';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-observation-manifest-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('observation process manifests', () => {
    it('publishes only the latest bounded lifecycle state to private files', async () => {
        const userDataPath = await temporaryDirectory();
        const directory = observationProcessManifestDirectory(userDataPath);
        const publisher = new ObservationProcessManifestPublisher({
            context: {
                bootId: 'boot-1',
                buildId: 'build-1',
                serverId: 'server-1',
                traceId: '/private/project',
            },
            directory,
            now: () => new Date('2026-08-26T00:00:00.000Z'),
            owner: 'server-core',
            pid: 4242,
            startedAt: 1_000,
        });

        publisher.publish('starting');
        publisher.publish('ready', { context: { requestId: 'request-1' } });
        await publisher.flush();

        const path = observationProcessManifestPath(directory, 'server-core');
        await expect(readObservationProcessManifest(path)).resolves.toEqual({
            context: {
                bootId: 'boot-1',
                buildId: 'build-1',
                processId: 4242,
                requestId: 'request-1',
                serverId: 'server-1',
            },
            owner: 'server-core',
            pid: 4242,
            schemaVersion: 1,
            startedAt: 1_000,
            state: 'ready',
            updatedAt: '2026-08-26T00:00:00.000Z',
        });
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, 'utf8')).not.toContain('/private/project');
        expect(publisher.failureCount()).toBe(0);
    });

    it('rejects unknown fields and content-shaped correlation', () => {
        const base = {
            context: { processId: 42 },
            owner: 'server-core',
            pid: 42,
            schemaVersion: 1,
            startedAt: 1,
            state: 'ready',
            updatedAt: '2026-08-26T00:00:00.000Z',
        };

        expect(parseObservationProcessManifest({ ...base, credential: 'secret' })).toBeUndefined();
        expect(
            parseObservationProcessManifest({
                ...base,
                context: { processId: 42, traceId: '/private/project' },
            }),
        ).toBeUndefined();
    });

    it('rejects non-private files and keeps publication failures non-fatal', async () => {
        const userDataPath = await temporaryDirectory();
        const directory = observationProcessManifestDirectory(userDataPath);
        const path = observationProcessManifestPath(directory, 'server-core');
        const publisher = new ObservationProcessManifestPublisher({
            directory,
            owner: 'server-core',
            pid: 42,
            startedAt: 1,
        });
        publisher.publish('ready');
        await publisher.flush();
        await chmod(path, 0o644);
        await expect(readObservationProcessManifest(path)).rejects.toThrow('private regular file');

        const blockedDirectory = join(userDataPath, 'blocked');
        await writeFile(blockedDirectory, 'not a directory');
        const blocked = new ObservationProcessManifestPublisher({
            directory: join(blockedDirectory, 'processes'),
            owner: 'terminal-host',
            pid: 43,
            startedAt: 1,
        });
        blocked.publish('failed');
        await expect(blocked.flush()).resolves.toBeUndefined();
        expect(blocked.failureCount()).toBe(1);
    });
});
