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
