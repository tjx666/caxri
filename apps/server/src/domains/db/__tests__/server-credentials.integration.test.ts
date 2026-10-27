import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabaseConnection } from '../index';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabaseConnection }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-credentials-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const database = new CaxriDatabaseConnection(path);
    onTestFinished(() => database.close());
    return { path, database };
}

const phone = {
    deviceId: 'device_1',
    displayName: 'Phone',
    platform: 'android',
    credential: 'ab'.repeat(32),
    generation: 1,
    role: 'reply',
    projectIds: ['project-1'],
    createdAt: 1,
};

describe('Server credential stores', () => {
    it('starts empty and keeps paired phones and gateway preferences across a reopen', async () => {
        const { path, database } = await openDatabase();
        expect(database.credentials.mobileDevices.load()).toEqual({ devices: [], preferences: {} });

        database.credentials.mobileDevices.write(
            [phone, { ...phone, deviceId: 'device_2', lastConnectedAt: 5, revokedAt: 6 }],
            { accessEnabled: true, preferredPort: 47_000 },
        );
        database.close();

        const reopened = new CaxriDatabaseConnection(path);
        onTestFinished(() => reopened.close());
        expect(reopened.credentials.mobileDevices.load()).toEqual({
            devices: [phone, { ...phone, deviceId: 'device_2', lastConnectedAt: 5, revokedAt: 6 }],
            preferences: { accessEnabled: true, preferredPort: 47_000 },
        });
    });

    it('replaces the whole device set and rolls a rejected write back', async () => {
        const { database } = await openDatabase();
        const store = database.credentials.mobileDevices;
        store.write([phone], {});

        expect(() =>
            store.write([{ ...phone, platform: 'symbian' }], { preferredPort: 1 }),
        ).toThrow(/CHECK constraint failed/u);
        expect(store.load()).toEqual({ devices: [phone], preferences: {} });

        store.write([], {});
        expect(store.load().devices).toEqual([]);
    });

    it('keeps delegation clients, digest only, across a reopen', async () => {
        const { path, database } = await openDatabase();
        const client = {
            clientId: '0f8fad5b-d9cb-469f-a165-70867728950e',
            generation: 2,
            projectId: 'project-1',
            sessionId: 'session-1',
            callerProvider: 'codex',
            tokenDigest: 'cd'.repeat(32),
            createdAt: 1,
            expiresAt: 2,
        };
        database.credentials.delegationClients.write([
            client,
            { ...client, clientId: 'other', revokedAt: 3 },
        ]);
        database.close();

        const reopened = new CaxriDatabaseConnection(path);
        onTestFinished(() => reopened.close());
        expect(reopened.credentials.delegationClients.load()).toEqual([
            client,
            { ...client, clientId: 'other', revokedAt: 3 },
        ]);
    });

    it('rejects a write after the database closed as UNAVAILABLE', async () => {
        const { database } = await openDatabase();
        const { delegationClients, mobileDevices } = database.credentials;
        database.close();

        expect(() => mobileDevices.write([phone], {})).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }),
        );
        expect(() => delegationClients.write([])).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }),
        );
    });
});
