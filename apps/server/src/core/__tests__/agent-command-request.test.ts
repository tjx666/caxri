import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentCommandRequest, sessionImportRequest } from '../agent-command-request';
import type { AgentEndpointRegistry } from '../agent-endpoints/registry';

const contextFor = (kind: string, projectIds: string[] = []): CommandExecutionContext =>
    ({ principal: { kind, projectIds } }) as unknown as CommandExecutionContext;

const request = {
    method: 'session.importConversation',
    params: { provider: 'codex', agentSessionId: 'conversation-1' },
} as const;

describe('sessionImportRequest', () => {
    it("binds an Agent's import to its own Project scope", () => {
        expect(sessionImportRequest(request, contextFor('agent', ['project-1']))).toEqual({
            method: 'session.importConversationInternal',
            params: { ...request.params, projectScope: ['project-1'] },
        });
    });

    it('leaves the owner clients unscoped', () => {
        for (const kind of ['desktop', 'human-cli'])
            expect(sessionImportRequest(request, contextFor(kind)).params).toMatchObject({
                projectScope: null,
            });
    });

    it('refuses every other principal', () => {
        for (const kind of ['delegation-client', 'extension', 'paired-device'])
            expect(() => sessionImportRequest(request, contextFor(kind, ['project-1']))).toThrow(
                /owner or an Agent/,
            );
    });
});

describe('agentCommandRequest', () => {
    it('routes a transcript read to its own internal method with the cursor, never to the answer read', () => {
        const context = contextFor('human-cli');
        expect(
            agentCommandRequest(
                {
                    method: 'agent.delegation.transcript',
                    params: { delegationId: 'task-1', after: 'cursor' },
                },
                context,
                'request-1',
                {} as AgentEndpointRegistry,
            ),
        ).toEqual({
            method: 'agent.delegation.transcriptInternal',
            params: {
                principal: context.principal,
                callerTerminalId: undefined,
                delegationId: 'task-1',
                after: 'cursor',
            },
        });
    });
});

describe('agentCommandRequest for the questions of a delegated Agent', () => {
    const context = {
        principal: {
            kind: 'agent',
            id: 'agent',
            endpointId: 'agent',
            generation: 1,
            projectIds: [],
        },
    } as unknown as CommandExecutionContext;
    const endpoints = {
        context: () => ({ endpoint: { terminalId: 'terminal-1' } }),
    } as unknown as AgentEndpointRegistry;
    const authority = { principal: context.principal, callerTerminalId: 'terminal-1' };

    it.each([
        ['agent.delegation.ask', 'agent.delegation.askInternal', { text: 'Synthetic' }],
        [
            'agent.delegation.askWait',
            'agent.delegation.askWaitInternal',
            { questionId: 'question-1', timeoutMs: 1000 },
        ],
        [
            'agent.delegation.askCancel',
            'agent.delegation.askCancelInternal',
            { questionId: 'question-1' },
        ],
        [
            'agent.delegation.questions',
            'agent.delegation.questionsInternal',
            { delegationId: 'task-1' },
        ],
        [
            'agent.delegation.answer',
            'agent.delegation.answerInternal',
            { delegationId: 'task-1', questionId: 'question-1', text: 'Synthetic' },
        ],
        [
            'agent.delegation.approve',
            'agent.delegation.approveInternal',
            { delegationId: 'task-1', requestId: 'request-1', decision: 'accept' },
        ],
        [
            'agent.delegation.history',
            'agent.delegation.historyInternal',
            { query: 'retry', outcome: 'completed', limit: 5 },
        ],
    ] as const)('routes %s to %s with the caller authority', (method, internal, parameters) => {
        expect(
            agentCommandRequest(
                { method, params: parameters } as never,
                context,
                'request-1',
                endpoints,
            ),
        ).toEqual({ method: internal, params: { ...authority, ...parameters } });
    });

    it('refuses a history read from an Agent whose Endpoint expired before any handler runs', () => {
        const expired = {
            context: () => {
                throw new Error('Agent Endpoint expired');
            },
        } as unknown as AgentEndpointRegistry;

        expect(() =>
            agentCommandRequest(
                { method: 'agent.delegation.history', params: { limit: 20 } } as never,
                context,
                'request-1',
                expired,
            ),
        ).toThrow(/expired/u);
    });
});
