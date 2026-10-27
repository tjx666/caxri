import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { connectToServer } from '@caxri/client/supervise';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import type { DomainHandlers } from '../../domains/domain-services';
import type { CreateDomainServices } from '../domain-service';
import type { ServerCore } from '../server-core';
import { startServerCore } from '../server-core';
import { createMemoryCredentialStores } from './credential-stores.fixture';

const apps: ServerCore[] = [];
const directories: string[] = [];

function fixtureHandlers(overrides: Partial<DomainHandlers>): DomainHandlers {
    return overrides as DomainHandlers;
}

afterEach(async () => {
    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));
    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

function createInvalidEventFixture(): CreateDomainServices {
    return (dependencies) => {
        let isEmitted = false;
        const handlers = {
            'app.health': () => {
                if (!isEmitted) {
                    isEmitted = true;
                    dependencies.send({
                        event: 'files.changed',
                        payload: {
                            sessionId: 'session-1',
                            workbenchProjectId: 'project-1',
                            changes: Array.from({ length: 513 }, (_, index) => ({
                                path: `/private/source-${index}.txt`,
                                kind: 'update' as const,
                            })),
                            overflow: false,
                        },
                    });
                }
                return {
                    ready: true,
                    pid: process.pid,
                    startedAt: Date.now(),
                    activePtyCount: 0,
                };
            },
        } satisfies Partial<DomainHandlers>;
        return Promise.resolve({
            close: async () => dependencies.agentEndpoints?.close(),
            handlers: fixtureHandlers(handlers),
            credentials: createMemoryCredentialStores(),
            protocolRecovery: createTestProtocolRecoveryState(),
            validateRequestContext: () => {},
        });
    };
}

describe('Server Core invalid domain events', () => {
    it('rejects an invalid event without losing later requests or logging its payload', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-invalid-domain-event-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createInvalidEventFixture(),
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const operator = await connectToServer(userDataPath, 2_000);

        await expect(operator.request('app.health')).resolves.toMatchObject({ ready: true });
        await expect(operator.request('app.health')).resolves.toMatchObject({ ready: true });
        const recovery = await operator.request('events.query', { afterCursor: 0 });
        expect(recovery.kind).toBe('events');
        if (recovery.kind !== 'events') throw new Error('Expected event recovery');
        expect(recovery.events.some((event) => event.event === 'state.changed')).toBe(true);
        await vi.waitFor(async () => {
            const log = await readFile(join(userDataPath, 'logs', 'server-core.jsonl'), 'utf8');
            expect(log).toContain('server_core.event_rejected');
            expect(log).toContain('payload.changes:too_big');
            expect(log).not.toContain('/private/source-');
        });

        operator.close();
    });
});
