import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../../index';
import { MAX_PROTOCOL_CHANGEFEED_EVENTS } from '../protocol-state';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDatabasePath(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return join(directory, 'state.db');
}

function successfulReply(id: string, result?: unknown) {
    return {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id,
        ok: true as const,
        result: result ?? { accepted: true },
    };
}

describe('ProtocolStateModel identity', () => {
    it('preserves Server ID and State Epoch while the database is reopened', async () => {
        const path = await temporaryDatabasePath('caxri-protocol-identity-');
        const database = new CaxriDatabase(path);
        const first = database.protocolState.identity(1_000);
        database.close();

        const reopened = new CaxriDatabase(path);
        expect(reopened.protocolState.identity(2_000)).toEqual(first);
        expect(first.serverId).toMatch(/^[0-9a-f]{32}$/u);
        expect(first.stateEpoch).toMatch(/^[0-9a-f]{32}$/u);
        reopened.close();
    });
});

describe('ProtocolStateModel command receipts', () => {
    it('replays a successful bounded reply and rejects request-ID reuse with different input', async () => {
        const path = await temporaryDatabasePath('caxri-protocol-receipt-');
        const database = new CaxriDatabase(path);
        const { stateEpoch } = database.protocolState.identity();
        const input = {
            stateEpoch,
            clientId: 'desktop:workbench-1',
            requestId: 'request-1',
            requestFingerprint: 'a'.repeat(64),
            method: 'session.rename' as const,
            reply: successfulReply('request-1'),
            createdAt: 1_000,
        };

        database.protocolState.saveReceipt(input);
        expect(
            database.protocolState.getReceipt(stateEpoch, input.clientId, input.requestId),
        ).toMatchObject({
            method: 'session.rename',
            requestFingerprint: 'a'.repeat(64),
            reply: input.reply,
        });
        expect(() =>
            database.protocolState.saveReceipt({
                ...input,
                requestFingerprint: 'b'.repeat(64),
            }),
        ).toThrow(/cannot be reused/u);
        database.close();
    });

    it('does not persist failed effects or unbounded reply data', async () => {
        const path = await temporaryDatabasePath('caxri-protocol-receipt-budget-');
        const database = new CaxriDatabase(path);
        const { stateEpoch } = database.protocolState.identity();
        const base = {
            stateEpoch,
            clientId: 'desktop:workbench-1',
            requestId: 'request-1',
            requestFingerprint: 'a'.repeat(64),
            method: 'session.rename' as const,
            createdAt: 1_000,
        };

        expect(() =>
            database.protocolState.saveReceipt({
                ...base,
                reply: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: base.requestId,
                    ok: false,
                    error: { code: 'CONFLICT', message: 'retry later' },
                },
            }),
        ).toThrow(/Failed commands/u);
        expect(() =>
            database.protocolState.saveReceipt({
                ...base,
                reply: successfulReply(base.requestId, { value: 'x'.repeat(600 * 1024) }),
            }),
        ).toThrow(/storage budget/u);
        expect(database.protocolState.inspect().commandReceipts).toBe(0);
        database.close();
    });
});

describe('ProtocolStateModel changefeed', () => {
    it('persists only durable events and keeps one bounded replay window', async () => {
        const path = await temporaryDatabasePath('caxri-protocol-changefeed-');
        const database = new CaxriDatabase(path);
        const { stateEpoch } = database.protocolState.identity();
        for (let index = 0; index <= MAX_PROTOCOL_CHANGEFEED_EVENTS; index += 1)
            database.protocolState.appendEvent(stateEpoch, {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            });

        const bounds = database.protocolState.changefeedBounds(stateEpoch);
        expect(bounds).toEqual({
            count: MAX_PROTOCOL_CHANGEFEED_EVENTS,
            earliest: 2,
            latest: MAX_PROTOCOL_CHANGEFEED_EVENTS + 1,
        });
        expect(database.protocolState.eventsAfter(stateEpoch, bounds.earliest - 1)).toHaveLength(
            MAX_PROTOCOL_CHANGEFEED_EVENTS,
        );
        expect(() =>
            database.protocolState.appendEvent(stateEpoch, {
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'private output' },
            } as never),
        ).toThrow(/Transient events/u);
        expect(database.protocolState.inspect()).toEqual({
            changefeedEntries: MAX_PROTOCOL_CHANGEFEED_EVENTS,
            commandReceipts: 0,
        });
        database.close();
    });
});
