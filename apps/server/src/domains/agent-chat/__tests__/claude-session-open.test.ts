import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../chat-provider';
import { claudeQueryOptions } from '../claude-session-open';

function options(instructions?: string) {
    return claudeQueryOptions({
        host: {
            cwd: '/project',
            executable: '/bin/claude',
            environment: {},
            clientVersion: '0.0.0',
            ...(instructions && { instructions }),
        } as AgentChatSessionHost,
        settings: {
            permissionMode: 'default',
            additionalDirectories: [],
            allowedTools: [],
            disallowedTools: [],
        },
        resumeId: undefined,
        resumeAt: undefined,
        sessionId: 'session-1',
        spawn: vi.fn(),
        canUseTool: vi.fn(),
        hooks: {},
    });
}

describe('claudeQueryOptions instructions', () => {
    it("appends Caxri's instructions to Claude Code's own system prompt", () => {
        expect(options('Use Caxri.').systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Use Caxri.',
        });
    });

    it('keeps the plain Claude Code system prompt without instructions', () => {
        expect(options().systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });
});
