import { describe, expect, it } from 'vitest';

import { shouldMarkAgentChatPermission } from '../agent-chat-settings-trigger';

describe('shouldMarkAgentChatPermission', () => {
    it('keeps the provider default level quiet', () => {
        expect(
            shouldMarkAgentChatPermission({
                mode: 'acceptEdits',
                planMode: false,
                provider: 'codex',
            }),
        ).toBe(false);
        expect(
            shouldMarkAgentChatPermission({ mode: 'ask', planMode: false, provider: 'claude' }),
        ).toBe(false);
        expect(
            shouldMarkAgentChatPermission({ mode: 'ask', planMode: false, provider: 'grok' }),
        ).toBe(false);
    });

    it('marks any other level, plan mode, and launch settings that match no level', () => {
        expect(
            shouldMarkAgentChatPermission({
                mode: 'fullAccess',
                planMode: false,
                provider: 'codex',
            }),
        ).toBe(true);
        expect(
            shouldMarkAgentChatPermission({
                mode: 'acceptEdits',
                planMode: false,
                provider: 'claude',
            }),
        ).toBe(true);
        expect(
            shouldMarkAgentChatPermission({
                mode: 'acceptEdits',
                planMode: true,
                provider: 'codex',
            }),
        ).toBe(true);
        expect(
            shouldMarkAgentChatPermission({ mode: undefined, planMode: false, provider: 'codex' }),
        ).toBe(true);
    });
});
