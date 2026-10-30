import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { agentChatSendBlock } from '../../composer/send/agent-chat-send-tooltip';
import {
    agentChatAutoContinueLabel,
    agentChatContinuationChoice,
    agentChatContinuationUnavailableLabel,
    agentChatUsageGuardOffer,
    agentChatUsageLimitHeadline,
} from '../agent-chat-continuation';

const NOW = Date.parse('2026-03-02T10:00:00.000Z');
const GUARD = { provider: 'claude', usedPercent: 99.4, resetsAt: NOW + 3_600_000 } as const;

describe('agentChatContinuationChoice', () => {
    it('defaults to the first Agent that can take over and lists the others with why not', () => {
        const choice = agentChatContinuationChoice([
            { provider: 'claude', unavailable: 'current' },
            { provider: 'codex', unavailable: 'usageLimited', resetsAt: NOW + 7_200_000 },
            { provider: 'grok' },
        ]);
        expect(choice.primary).toBe('grok');
        // The Chat's own Agent is never a choice, not even a disabled one.
        expect(choice.targets.map(({ provider }) => provider)).toEqual(['codex', 'grok']);
        expect(
            choice.targets.map((target) =>
                agentChatContinuationUnavailableLabel(target, NOW, translate),
            ),
        ).toEqual(['Close to its weekly limit, resets in 2h', undefined]);
        expect(
            agentChatContinuationUnavailableLabel(
                { provider: 'grok', unavailable: 'notInstalled' },
                NOW,
                translate,
            ),
        ).toBe('Not installed');
    });

    it('has no default when no other Agent can take over', () => {
        expect(
            agentChatContinuationChoice([
                { provider: 'claude', unavailable: 'current' },
                { provider: 'codex', unavailable: 'unsupported' },
            ]).primary,
        ).toBeUndefined();
    });
});

describe('agentChatUsageLimitHeadline', () => {
    it('names the window the provider used up', () => {
        expect(agentChatUsageLimitHeadline({ window: 'session' }, 'Claude', translate)).toBe(
            'Claude used up its 5-hour limit',
        );
        expect(agentChatUsageLimitHeadline({ window: 'weekly' }, 'Codex', translate)).toBe(
            'Codex used up its weekly limit',
        );
        expect(agentChatUsageLimitHeadline({ window: 'unknown' }, 'Codex', translate)).toBe(
            'Codex used up its usage limit',
        );
    });
});

describe('agentChatUsageGuardOffer', () => {
    it('offers the one hand-off only while the lease is free and the provider can still answer', () => {
        expect(agentChatUsageGuardOffer({ ...GUARD, handoff: 'available' }, true)).toEqual({
            generate: true,
            used: false,
        });
        // At 100% the provider refuses the turn, which would spend the lease on nothing.
        expect(
            agentChatUsageGuardOffer({ ...GUARD, usedPercent: 100, handoff: 'available' }, true)
                .generate,
        ).toBe(false);
        expect(agentChatUsageGuardOffer({ ...GUARD, handoff: 'available' }, false).generate).toBe(
            false,
        );
    });

    it('says the lease is gone when another Chat on the account took it', () => {
        expect(agentChatUsageGuardOffer({ ...GUARD, handoff: 'used' }, true)).toEqual({
            generate: false,
            used: true,
        });
        expect(
            agentChatUsageGuardOffer(
                {
                    ...GUARD,
                    handoff: 'used',
                    document: { status: 'generated', text: 'Next', createdAt: NOW },
                },
                true,
            ),
        ).toEqual({ generate: false, used: false });
    });
});

describe('agentChatSendBlock', () => {
    it('refuses a message while the account is at the usage guard', () => {
        expect(
            agentChatSendBlock(
                { status: 'ready', usageGuard: { ...GUARD, handoff: 'available' } },
                'running',
            ),
        ).toBe('usageGuard');
        expect(agentChatSendBlock({ status: 'ready' }, 'running')).toBeUndefined();
    });
});

describe('agentChatAutoContinueLabel', () => {
    it('says when a waiting Chat continues, that it did, or why it will not', () => {
        expect(
            agentChatAutoContinueLabel({ status: 'waiting', at: NOW + 7_380_000 }, NOW, translate),
        ).toMatch(/^Continues automatically at .+ \(in 2h 3m\)$/u);
        expect(
            agentChatAutoContinueLabel({ status: 'waiting', at: NOW + 30_000 }, NOW, translate),
        ).toBe('Continuing automatically…');
        expect(
            agentChatAutoContinueLabel({ status: 'continued', at: NOW }, NOW, translate),
        ).toMatch(/^Continued automatically at /u);
        expect(agentChatAutoContinueLabel({ status: 'missed' }, NOW, translate)).toBe(
            'The limit has reset',
        );
        expect(
            agentChatAutoContinueLabel(
                { status: 'skipped', reason: 'attemptsUsed' },
                NOW,
                translate,
            ),
        ).toBe('Stopped continuing automatically after 3 tries into the limit');
        expect(
            agentChatAutoContinueLabel(
                { status: 'skipped', reason: 'resetTooFar' },
                NOW,
                translate,
            ),
        ).toBe("Won't continue automatically: the limit resets more than 24 hours from now");
    });
});
