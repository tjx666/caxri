import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { agentChatContinueMenuEntry } from '../agent-chat-continue-menu';

const NOW = Date.parse('2026-03-02T10:00:00.000Z');
const CHAT: Parameters<typeof agentChatContinueMenuEntry>[0] = {
    id: 'terminal-1',
    provider: 'claude',
    surface: 'chat',
    agentSessionId: 'conversation-1',
};

describe('agentChatContinueMenuEntry', () => {
    it('lists every other Agent, the unavailable ones disabled with why', () => {
        const entry = agentChatContinueMenuEntry(
            CHAT,
            [
                { provider: 'claude', unavailable: 'current' },
                { provider: 'codex' },
                { provider: 'grok', unavailable: 'notInstalled' },
            ],
            NOW,
            translate,
        );
        expect(entry).toMatchObject({
            type: 'submenu',
            label: 'Continue in Another Agent',
            entries: [
                { label: 'Codex', disabled: false },
                { label: 'Grok Build', disabled: true, disabledReason: 'Not installed' },
            ],
        });
    });

    it('explains why an Agent that cannot continue yet offers no targets', () => {
        expect(
            agentChatContinueMenuEntry({ ...CHAT, surface: undefined }, [], NOW, translate),
        ).toMatchObject({
            disabled: true,
            disabledReason: expect.stringContaining('as Chat') as string,
        });
        expect(
            agentChatContinueMenuEntry({ ...CHAT, agentSessionId: undefined }, [], NOW, translate),
        ).toMatchObject({ disabled: true, disabledReason: 'This Agent has no conversation yet' });
        expect(
            agentChatContinueMenuEntry(
                CHAT,
                [{ provider: 'claude', unavailable: 'current' }],
                NOW,
                translate,
            ),
        ).toMatchObject({ disabled: true, disabledReason: 'No other Agent can take this over' });
    });

    it('offers nothing for a Shell', () => {
        expect(
            agentChatContinueMenuEntry({ ...CHAT, provider: undefined }, [], NOW, translate),
        ).toBeUndefined();
    });
});
