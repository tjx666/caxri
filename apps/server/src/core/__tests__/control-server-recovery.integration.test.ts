import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import { protocolFeatures } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CaxriDatabaseConnection } from '../../domains/db';
import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

function session(displayTitle: string) {
    return {
        id: 'session-1',
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/private/project-one',
        displayTitle,
        titleMode: 'manual' as const,
        createdAt: 1,
        lastOpenedAt: 1,
        sidebarOrder: 0,
        lastSessionActivityAt: 1,
        lastSessionActivityReason: 'created' as const,
        archivedAt: undefined,
        primaryAgentTerminalId: undefined,
        lastActivityState: 'unknown' as const,
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
    };
}

describe('ControlServer durable command recovery', () => {
    it('replays a persisted receipt after reply loss and Server replacement', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-reply-loss-'));
        const databasePath = join(userDataPath, 'state.db');
        let database: CaxriDatabaseConnection | undefined;
        let lease: Awaited<ReturnType<typeof acquireServerProfile>> | undefined;
        let server: ControlServer | undefined;
        let client: ServerClient | undefined;
        const invoke = vi.fn((request: { method: string }) => {
            if (request.method !== 'session.rename') throw new Error('Unexpected command');
            return session('Persisted once');
        });

        try {
            database = new CaxriDatabaseConnection(databasePath);
            const protocolIdentity = database.protocolState.identity();
            lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
            const firstBootId = lease.identity.processIdentity;
            let isDropReply = true;
            server = new ControlServer({
                adapters: {
                    durableReceipts: database.protocolState,
                    features: protocolFeatures,
                    server: { invoke },
                },
                desktopCredential: lease.desktopCredential,
                identity: lease.identity,
                protocolIdentity,
                shouldDropCommandReply: (request) => {
                    if (!isDropReply || request.id !== 'rename-reply-loss') return false;
                    isDropReply = false;
                    return true;
                },
            });
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 1_000, {
                kind: 'desktop',
                desktopId: 'desktop-recovery',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });

            await expect(
                client.requestWithId('rename-reply-loss', 'session.rename', {
                    sessionId: 'session-1',
                    displayTitle: 'Persisted once',
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(invoke).toHaveBeenCalledOnce();

            client.close();
            client = undefined;
            await server.close();
            server = undefined;
            database.close();
            database = undefined;
            await lease.release();
            lease = undefined;

            database = new CaxriDatabaseConnection(databasePath);
            expect(database.protocolState.identity()).toEqual(protocolIdentity);
            lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
            expect(lease.identity.processIdentity).not.toBe(firstBootId);
            server = new ControlServer({
                adapters: {
                    durableReceipts: database.protocolState,
                    features: protocolFeatures,
                    server: { invoke },
                },
                desktopCredential: lease.desktopCredential,
                identity: lease.identity,
                protocolIdentity,
            });
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 1_000, {
                kind: 'desktop',
                desktopId: 'desktop-recovery',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });

            await expect(
                client.requestWithId('rename-reply-loss', 'session.rename', {
                    sessionId: 'session-1',
                    displayTitle: 'Persisted once',
                }),
            ).resolves.toMatchObject({ displayTitle: 'Persisted once' });
            expect(invoke).toHaveBeenCalledOnce();
            expect(database.protocolState.inspect().commandReceipts).toBe(1);
        } finally {
            client?.close();
            await server?.close();
            database?.close();
            await lease?.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });
});
