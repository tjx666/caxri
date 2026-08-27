import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    internalFaultKinds,
    observationProcessManifestDirectory,
    observationProcessManifestPath,
    ObservationProcessManifestPublisher,
    observationProcessOwners,
} from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import type { OwnerDiagnosticProbes } from '../refactor-parity/owner-diagnostics';
import { diagnoseRefactorOwner } from '../refactor-parity/owner-diagnostics';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('architecture-a6-agent-observability parity owner diagnostics', () => {
    it.each(internalFaultKinds)(
        'classifies seeded %s failure without mutating process state',
        async (failed) => {
            const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-owner-diagnostic-'));
            temporaryDirectories.push(userDataPath);
            const directory = observationProcessManifestDirectory(userDataPath);
            await Promise.all(
                observationProcessOwners.map(async (owner, index) => {
                    const publisher = new ObservationProcessManifestPublisher({
                        context: { bootId: 'boot-1', buildId: 'build-1', serverId: 'server-1' },
                        directory,
                        owner,
                        pid: 100 + index,
                        startedAt: 1,
                    });
                    publisher.publish('ready');
                    await publisher.flush();
                }),
            );
            const paths = observationProcessOwners.map((owner) =>
                observationProcessManifestPath(directory, owner),
            );
            const before = await Promise.all(
                paths.map(async (path) => ({
                    contents: await readFile(path, 'utf8'),
                    metadata: await stat(path),
                })),
            );
            const probes = Object.fromEntries(
                internalFaultKinds.map((kind) => [kind, kind === failed ? 'failed' : 'healthy']),
            ) as OwnerDiagnosticProbes;

            const result = await diagnoseRefactorOwner({
                probes,
                processState: () => 'alive',
                timestamp: '2026-08-26T00:00:00.000Z',
                userDataPath,
            });
            const after = await Promise.all(
                paths.map(async (path) => ({
                    contents: await readFile(path, 'utf8'),
                    metadata: await stat(path),
                })),
            );

            expect(result.classification).toBe(failed);
            expect(result.chain).toHaveLength(1);
            expect(after.map(({ contents }) => contents)).toEqual(
                before.map(({ contents }) => contents),
            );
            expect(after.map(({ metadata }) => metadata.mtimeMs)).toEqual(
                before.map(({ metadata }) => metadata.mtimeMs),
            );
        },
    );
});
