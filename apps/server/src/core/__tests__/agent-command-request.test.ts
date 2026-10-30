import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionImportRequest } from '../agent-command-request';

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
