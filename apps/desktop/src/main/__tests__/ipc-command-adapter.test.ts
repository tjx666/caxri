import type { CommandAdapter, CommandExecutionContext } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, createCommandDispatcher } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createElectronIpcCommandAdapter } from '../ipc-command-adapter';

const desktop = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'in-memory-desktop', generation: 1 },
} satisfies CommandExecutionContext;

const cases = [
    {
        id: 'read-1',
        method: 'app.health',
        params: {},
    },
    {
        id: 'write-1',
        method: 'session.rename',
        params: { sessionId: 'session-1', displayTitle: 'Renamed' },
    },
] as const;

function handler(): CommandAdapter {
    return {
        invoke(request) {
            if (request.method === 'app.health')
                return { ready: true, pid: 42, startedAt: 1, activePtyCount: 0 };
            if (request.method === 'session.rename')
                return {
                    id: request.params.sessionId,
                    projectId: 'project-1',
                    rootPath: '/project',
                    createdAt: 1,
                    lastOpenedAt: 2,
                    sidebarOrder: 0,
                    lastSessionActivityAt: 1,
                    lastSessionActivityReason: 'created',
                    lastActivityState: 'unknown',
                    attentionEpoch: 0,
                    readAttentionEpoch: 0,
                    hasUnread: false,
                    displayTitle: request.params.displayTitle,
                    titleMode: 'manual',
                };
            return null;
        },
    };
}

describe('Electron IPC command adapter', () => {
    it.each(cases)('matches the in-memory contract for $method', async (testCase) => {
        const envelope = { protocolVersion: CAXRI_PROTOCOL_VERSION, ...testCase };
        const electron = createElectronIpcCommandAdapter({ server: handler() });
        const inMemory = createCommandDispatcher({ server: handler() });

        await expect(electron.dispatch(envelope)).resolves.toEqual(
            await inMemory(envelope, desktop),
        );
    });

    it('preserves the same closed validation error', async () => {
        const envelope = {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'invalid-1',
            method: 'terminal.resize',
            params: { terminalId: 'terminal-1', cols: 0, rows: 24 },
        };
        const electron = createElectronIpcCommandAdapter({ server: handler() });
        const inMemory = createCommandDispatcher({ server: handler() });

        await expect(electron.dispatch(envelope)).resolves.toEqual(
            await inMemory(envelope, desktop),
        );
    });

    it('negotiates an authenticated capability and command welcome', () => {
        const electron = createElectronIpcCommandAdapter({ server: handler() });
        const welcome = electron.negotiate({ supportedVersions: [2] });
        expect(welcome).toMatchObject({
            protocolVersion: 2,
            principal: { kind: 'desktop', id: 'electron-main', generation: 1 },
            capabilities: ['desktop'],
        });
        expect(welcome.commands).toContain('app.health');
        expect(welcome.commands).toContain('session.rename');
    });
});
