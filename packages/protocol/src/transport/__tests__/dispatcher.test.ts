import { describe, expect, it } from 'vitest';

import type { CommandAdapter } from '../dispatcher';
import {
    createCommandDispatcher,
    createProtocolWelcome,
    requestIdFromEnvelope,
} from '../dispatcher';
import { CaxriError } from '../errors';

const desktop = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
} as const;

function request(id: string, method: string, parameters: unknown = {}) {
    return { protocolVersion: 2, id, method, params: parameters };
}

describe('requestIdFromEnvelope', () => {
    it('echoes a valid request id even when other envelope fields are invalid', () => {
        expect(requestIdFromEnvelope({ id: 'kept-1', method: 'bogus.method' })).toBe('kept-1');
    });

    it('returns null when the id itself is missing or malformed', () => {
        expect(requestIdFromEnvelope({ method: 'app.health' })).toBeNull();
        expect(requestIdFromEnvelope({ id: '', method: 'app.health' })).toBeNull();
        expect(requestIdFromEnvelope(null)).toBeNull();
        expect(requestIdFromEnvelope('not an object')).toBeNull();
    });
});

describe('createCommandDispatcher receipt capacity', () => {
    it('rejects a maximumReceipts value outside the 1..4096 bound', () => {
        const host: CommandAdapter = { invoke: () => null };
        expect(() => createCommandDispatcher({ host, maximumReceipts: 0 })).toThrow(CaxriError);
        expect(() => createCommandDispatcher({ host, maximumReceipts: 4_097 })).toThrow(CaxriError);
    });

    it('evicts the oldest settled receipt once at capacity instead of rejecting new idempotent commands', async () => {
        function record(displayTitle: string) {
            return {
                id: 'session-1',
                projectId: 'project-1',
                rootPath: '/private/project-one',
                displayTitle,
                titleMode: 'manual',
                createdAt: 1,
                lastOpenedAt: 1,
                archivedAt: undefined,
                primaryAgentTerminalId: undefined,
                lastActivityState: 'unknown',
                attentionEpoch: 0,
                readAttentionEpoch: 0,
                hasUnread: false,
                layoutVersion: 1,
                workbenchProjectId: 'project-1',
            };
        }
        const host: CommandAdapter = {
            invoke: (command) => {
                if (command.method === 'session.rename')
                    return record((command.params as { displayTitle: string }).displayTitle);
                return null;
            },
        };
        const dispatch = createCommandDispatcher({ host, maximumReceipts: 1 });

        await dispatch(
            request('rename-1', 'session.rename', { sessionId: 's1', displayTitle: 'First' }),
            desktop,
        );
        // A second distinct idempotent request must still succeed by evicting the settled first receipt.
        await expect(
            dispatch(
                request('rename-2', 'session.rename', { sessionId: 's1', displayTitle: 'Second' }),
                desktop,
            ),
        ).resolves.toMatchObject({ ok: true });
    });
});

describe('createCommandDispatcher adapter availability', () => {
    it('reports UNAVAILABLE when the owning adapter is present but reports itself unavailable', async () => {
        const host: CommandAdapter = {
            invoke: () => ({ ready: true, pid: 1, startedAt: 1, activePtyCount: 0 }),
            isAvailable: () => false,
        };
        const dispatch = createCommandDispatcher({ host });
        await expect(dispatch(request('r1', 'app.health'), desktop)).resolves.toMatchObject({
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'Host is unavailable' },
        });
    });

    it('excludes commands owned by an unavailable adapter from the negotiated welcome', () => {
        const host: CommandAdapter = { invoke: () => null, isAvailable: () => false };
        const welcome = createProtocolWelcome({ host }, { supportedVersions: [2] }, desktop);
        expect(welcome.commands).not.toContain('app.health');
    });
});
