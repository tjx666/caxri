import { describe, expect, it } from 'vitest';

import type { AgentChatPermissionTrigger } from '../agent-chat-permission-choice';
import {
    shouldMarkAgentChatPermission,
    visibleAgentChatPermissionTrigger,
} from '../agent-chat-settings-trigger';

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

describe('visibleAgentChatPermissionTrigger', () => {
    const trigger = { isPlanMode: false } as AgentChatPermissionTrigger;
    const base = {
        hasModelTrigger: true,
        mode: 'ask' as const,
        provider: 'claude' as const,
        trigger,
    };

    it('hides the chip without a trigger or a provider', () => {
        expect(visibleAgentChatPermissionTrigger({ ...base, trigger: undefined })).toBeUndefined();
        expect(visibleAgentChatPermissionTrigger({ ...base, provider: undefined })).toBeUndefined();
    });

    it('shows the chip whenever the model chip cannot', () => {
        expect(visibleAgentChatPermissionTrigger({ ...base, hasModelTrigger: false })).toBe(
            trigger,
        );
    });

    it('keeps the default level quiet beside the model chip and marks the rest', () => {
        expect(visibleAgentChatPermissionTrigger(base)).toBeUndefined();
        expect(visibleAgentChatPermissionTrigger({ ...base, mode: 'fullAccess' })).toBe(trigger);
    });
});
