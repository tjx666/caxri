import type { AgentProviderSettings, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { agentChatEndpoint } from '../chat-endpoint';

const botTerminal = {
    id: 'bot-terminal',
    sessionId: 'bot-session',
    provider: 'codex',
} as TerminalRecord;

function endpoint({ hasSession = true } = {}) {
    const session = hasSession ? ({ projectId: 'bot-project' } as SessionRecord) : undefined;
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
            caxriBotRows: () => ({
                projectId: 'bot-project',
                sessionId: 'bot-session',
                terminalId: botTerminal.id,
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
    it('prepares a bot-role Endpoint for a Caxri Bot Chat', async () => {
        const { chatEndpoint, endpoints, settings } = endpoint();

        await expect(chatEndpoint.environment(botTerminal, 'launch-1')).resolves.toEqual({
            CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
        });
        expect(endpoints.environment).toHaveBeenCalledWith(
            botTerminal,
            'bot-project',
            settings,
            'launch-1',
            'bot',
        );
    });

    it('prepares an ordinary Endpoint for every other Chat', async () => {
        const { chatEndpoint, endpoints, settings } = endpoint();
        const other = { ...botTerminal, id: 'other-terminal', sessionId: 'user-session' };

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
        await chatEndpoint.activate(botTerminal.id);
        expect(endpoints.activate).toHaveBeenCalledExactlyOnceWith(botTerminal.id);
    });

    it('refuses a Chat whose Session is gone', async () => {
        const { chatEndpoint } = endpoint({ hasSession: false });

        await expect(chatEndpoint.environment(botTerminal, 'launch-1')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });
});
