import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../../../chat-provider';
import { claudeQueryOptions } from '../session-open';

function options(instructions?: string) {
    return claudeQueryOptions({
        host: {
            cwd: '/project',
            executable: '/bin/claude',
            // A Server Core started from inside another Claude session inherits its label.
            environment: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } as NodeJS.ProcessEnv,
            clientVersion: '0.0.0',
            ...(instructions && { instructions }),
        } as Partial<AgentChatSessionHost> as AgentChatSessionHost,
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

describe('claudeQueryOptions environment', () => {
    it("labels the process as Caxri's own entrypoint, overwriting an inherited one", () => {
        expect(options().env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: 'caxri' });
    });
});
