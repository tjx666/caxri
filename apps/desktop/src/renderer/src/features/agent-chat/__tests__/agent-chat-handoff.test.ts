import { describe, expect, it } from 'vitest';

import type { AgentChatHandoff } from '../agent-chat-handoff';
import { agentChatHandoffPrompt } from '../agent-chat-handoff';

const handoff: AgentChatHandoff = {
    providerName: 'Claude Code',
    provider: 'claude',
    title: 'Fix the login redirect',
    agentSessionId: '0b7c5d1e-1111-4222-8333-444455556666',
    transcriptPath: '/home/user/.claude/projects/-home-user-app/0b7c5d1e.jsonl',
    cwd: '/home/user/app',
    pendingRequest: '',
};

describe('agentChatHandoffPrompt', () => {
    it('points the new Chat at the previous transcript through one cheap subagent', () => {
        const prompt = agentChatHandoffPrompt(handoff);
        expect(prompt).toContain('Previous conversation: Fix the login redirect');
        expect(prompt).toContain('Previous Agent: Claude Code');
        expect(prompt).toContain(`Previous session ID: ${handoff.agentSessionId}`);
        expect(prompt).toContain(`Previous transcript: ${handoff.transcriptPath}`);
        expect(prompt).toContain('Working directory: /home/user/app');
        expect(prompt).toContain('dispatch exactly one subagent on the Haiku model');
        expect(prompt).toContain('continue where the previous conversation left off');
    });

    it('carries the unsent draft as the request to handle after catching up', () => {
        const prompt = agentChatHandoffPrompt({
            ...handoff,
            pendingRequest: '  Also add a test  ',
        });
        expect(prompt).toMatch(/after catching up:\nAlso add a test$/);
        expect(prompt).not.toContain('left off');
    });

    it('names no provider-specific model or session for other Agents', () => {
        const prompt = agentChatHandoffPrompt({
            ...handoff,
            provider: 'codex',
            providerName: 'Codex',
            agentSessionId: undefined,
        });
        expect(prompt).toContain('subagent on your fastest, lowest-cost model');
        expect(prompt).toContain('Previous session ID: unknown');
    });
});
