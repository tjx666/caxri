import type { AgentProviderSettings, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { commanderChatEndpoint } from '../chat-endpoint';

const commanderTerminal = {
    id: 'commander-terminal',
    sessionId: 'commander-session',
    provider: 'codex',
} as TerminalRecord;

function endpoint({ hasSession = true } = {}) {
    const session = hasSession ? ({ projectId: 'commander-project' } as SessionRecord) : undefined;
    const endpoints = {
        activate: vi.fn(() => Promise.resolve()),
        environment: vi.fn(() => Promise.resolve({ CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1' })),
        preparedEndpointForTerminal: vi.fn((terminalId: string) =>
            terminalId === commanderTerminal.id ? ({} as never) : undefined,
        ),
        retire: vi.fn(() => Promise.resolve()),
    };
    const settings = {} as AgentProviderSettings;
    const chatEndpoint = commanderChatEndpoint({
        database: {
            agentCommanderRows: () => ({
                projectId: 'commander-project',
                sessionId: 'commander-session',
                terminalId: commanderTerminal.id,
                sessionIds: [],
            }),
            getSession: () => session,
        },
        endpoints,
        providerSettings: () => settings,
    });
    return { chatEndpoint, endpoints, settings };
}

describe('commanderChatEndpoint', () => {
    it('prepares a commander-role Endpoint for the Commander Chat', async () => {
        const { chatEndpoint, endpoints, settings } = endpoint();

        await expect(chatEndpoint.environment(commanderTerminal, 'launch-1')).resolves.toEqual({
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
        });
        expect(endpoints.environment).toHaveBeenCalledWith(
            commanderTerminal,
            'commander-project',
            settings,
            'launch-1',
            'commander',
        );
    });

    it('gives every other Chat no Endpoint', async () => {
        const { chatEndpoint, endpoints } = endpoint();
        const other = { ...commanderTerminal, id: 'other-terminal' };

        await expect(chatEndpoint.environment(other, 'launch-1')).resolves.toEqual({});
        await chatEndpoint.activate(other.id);
        expect(endpoints.environment).not.toHaveBeenCalled();
        expect(endpoints.activate).not.toHaveBeenCalled();
    });

    it('activates only a prepared Endpoint', async () => {
        const { chatEndpoint, endpoints } = endpoint();

        await chatEndpoint.activate(commanderTerminal.id);
        expect(endpoints.activate).toHaveBeenCalledExactlyOnceWith(commanderTerminal.id);
    });

    it('refuses a Commander Chat whose Session is gone', async () => {
        const { chatEndpoint } = endpoint({ hasSession: false });

        await expect(chatEndpoint.environment(commanderTerminal, 'launch-1')).rejects.toMatchObject(
            {
                code: 'CONFLICT',
            },
        );
    });
});
