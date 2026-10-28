import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatAutoContinueLabel,
    agentChatUsageLimitHeadline,
    agentChatUsageLimitReset,
} from '../agent-chat-usage-limit';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const HOUR = 3_600_000;

describe('agentChatUsageLimitHeadline', () => {
    it('names the window the provider used up', () => {
        expect(agentChatUsageLimitHeadline({ window: 'session' }, 'Claude Code', translate)).toBe(
            'Claude Code used up its 5-hour limit',
        );
        expect(agentChatUsageLimitHeadline({ window: 'weekly' }, 'Codex', translate)).toBe(
            'Codex used up its weekly limit',
        );
        expect(agentChatUsageLimitHeadline({ window: 'unknown' }, 'Codex', translate)).toBe(
            'Codex used up its usage limit',
        );
    });
});

describe('agentChatUsageLimitReset', () => {
    it('reads the time to the reset, and nothing without one', () => {
        expect(agentChatUsageLimitReset({ resetsAt: NOW + 3 * HOUR }, NOW, translate)).toBe(
            'Resets in 3h 0m',
        );
        expect(agentChatUsageLimitReset({}, NOW, translate)).toBeUndefined();
    });
});

describe('agentChatAutoContinueLabel', () => {
    it('says a passed or imminent wait is continuing now', () => {
        expect(
            agentChatAutoContinueLabel(
                { status: 'waiting', at: NOW + 30_000 },
                NOW,
                'en',
                translate,
            ),
        ).toBe('Continuing automatically…');
    });

    it('states when a longer wait continues and how long that is', () => {
        const label = agentChatAutoContinueLabel(
            { status: 'waiting', at: NOW + 2 * HOUR },
            NOW,
            'en',
            translate,
        );
        expect(label).toMatch(/^Continues automatically at .+ \(in 2h 0m\)$/u);
    });

    it('explains why it never waited', () => {
        expect(
            agentChatAutoContinueLabel(
                { status: 'skipped', reason: 'attemptsUsed' },
                NOW,
                'en',
                translate,
            ),
        ).toBe('Stopped continuing automatically after 3 tries into the limit');
        expect(agentChatAutoContinueLabel({ status: 'missed' }, NOW, 'en', translate)).toBe(
            'The limit has reset',
        );
    });
});
