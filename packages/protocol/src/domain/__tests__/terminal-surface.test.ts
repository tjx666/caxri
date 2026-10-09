import { describe, expect, it } from 'vitest';

import { agentProviderCatalog, agentProviderIds } from '../../agent/agents.js';
import { sessionMethods } from '../session-contract.js';
import { canUseAgentChat } from '../terminal-surface.js';

describe('canUseAgentChat', () => {
    it('follows each provider catalog Chat capability and never allows the shell', () => {
        for (const provider of agentProviderIds)
            expect(canUseAgentChat(provider)).toBe(
                agentProviderCatalog[provider].capabilities.chat,
            );
        expect(canUseAgentChat('shell')).toBe(false);
    });
});

describe('session.create surface', () => {
    const parameters = sessionMethods['session.create'].params;

    it('accepts an optional Chat or PTY surface', () => {
        expect(parameters.safeParse({ projectId: 'p', defaultAgent: 'codex' }).success).toBe(true);
        expect(
            parameters.safeParse({ projectId: 'p', defaultAgent: 'codex', surface: 'chat' })
                .success,
        ).toBe(true);
    });

    it('rejects an unknown surface', () => {
        expect(
            parameters.safeParse({ projectId: 'p', defaultAgent: 'codex', surface: 'grid' })
                .success,
        ).toBe(false);
    });
});
