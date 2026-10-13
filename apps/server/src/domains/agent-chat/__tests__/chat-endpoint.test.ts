import type { AgentProviderSettings, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { agentChatEndpoint } from '../chat-endpoint';

const commanderTerminal = {
    id: 'commander-terminal',
    sessionId: 'commander-session',
    provider: 'codex',
} as TerminalRecord;

function endpoint({ hasSession = true } = {}) {
    const session = hasSession ? ({ projectId: 'commander-project' } as SessionRecord) : undefined;
    const ordinarySession = { projectId: 'user-project' } as SessionRecord;
    const endpoints = {
        activate: vi.fn(() => Promise.resolve()),
        environment: vi.fn(() => Promise.resolve({ CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1' })),
        preparedEndpointForTerminal: vi.fn((terminalId: string) =>
            terminalId === 'unprepared-terminal' ? undefined : ({} as never),
        ),
        retire: vi.fn(() => Promise.resolve()),
    };
    const settings = {} as AgentProviderSettings;
    const chatEndpoint = agentChatEndpoint({
        database: {
            agentCommanderRows: () => ({
                projectId: 'commander-project',
                sessionId: 'commander-session',
                terminalId: commanderTerminal.id,
                sessionIds: [],
            }),
            getSession: (id: string) => (id === 'user-session' ? ordinarySession : session),
        },
        endpoints,
        providerSettings: () => settings,
    });
    return { chatEndpoint, endpoints, settings };
}

describe('agentChatEndpoint', () => {
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

    it('prepares an ordinary Endpoint for every other Chat', async () => {
        const { chatEndpoint, endpoints, settings } = endpoint();
        const other = { ...commanderTerminal, id: 'other-terminal', sessionId: 'user-session' };

        await expect(chatEndpoint.environment(other, 'launch-1')).resolves.toEqual({
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
        });
        expect(endpoints.environment).toHaveBeenCalledWith(
            other,
            'user-project',
            settings,
            'launch-1',
            undefined,
        );
    });

    it('activates only a prepared Endpoint', async () => {
        const { chatEndpoint, endpoints } = endpoint();

        await chatEndpoint.activate('unprepared-terminal');
        await chatEndpoint.activate(commanderTerminal.id);
        expect(endpoints.activate).toHaveBeenCalledExactlyOnceWith(commanderTerminal.id);
    });

    it('refuses a Chat whose Session is gone', async () => {
        const { chatEndpoint } = endpoint({ hasSession: false });

        await expect(chatEndpoint.environment(commanderTerminal, 'launch-1')).rejects.toMatchObject(
            {
                code: 'CONFLICT',
            },
        );
    });
});
