import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatUsageActionBlockedReason,
    agentChatUsageGuardButtons,
    agentChatUsageLimitButtons,
} from '../agent-chat-usage-actions';

const AT = Date.parse('2026-10-19T12:00:00.000Z');

const summary = (buttons: ReturnType<typeof agentChatUsageLimitButtons>) =>
    buttons.map(({ action, isPrimary, label }) => ({
        action,
        isPrimary,
        label: translate(label),
    }));

describe('agentChatUsageLimitButtons', () => {
    it('offers Continue now and Cancel while the Chat waits for its limit to reset', () => {
        expect(
            summary(
                agentChatUsageLimitButtons(
                    { autoContinue: { status: 'waiting', at: AT } },
                    'turn-1',
                ),
            ),
        ).toEqual([
            { action: 'continueNow', isPrimary: true, label: 'Continue now' },
            { action: 'cancel', isPrimary: false, label: 'Cancel' },
        ]);
    });

    it('offers Continue alone once the reset passed while the Chat could not continue', () => {
        expect(
            summary(agentChatUsageLimitButtons({ autoContinue: { status: 'missed' } }, 'turn-1')),
        ).toEqual([{ action: 'continueNow', isPrimary: true, label: 'Continue' }]);
    });

    it('offers nothing once the Chat continued, when it never waited, or without its turn', () => {
        expect(
            agentChatUsageLimitButtons({ autoContinue: { status: 'continued', at: AT } }, 'turn-1'),
        ).toEqual([]);
        expect(
            agentChatUsageLimitButtons(
                { autoContinue: { status: 'skipped', reason: 'resetTooFar' } },
                'turn-1',
            ),
        ).toEqual([]);
        expect(agentChatUsageLimitButtons({}, 'turn-1')).toEqual([]);
        expect(
            agentChatUsageLimitButtons({ autoContinue: { status: 'waiting', at: AT } }, undefined),
        ).toEqual([]);
    });
});

describe('agentChatUsageGuardButtons', () => {
    it('leads with Generate hand-off while the hand-off is on offer, then Continue anyway', () => {
        expect(summary(agentChatUsageGuardButtons({}, { generate: true }))).toEqual([
            { action: 'generateHandoff', isPrimary: true, label: 'Generate hand-off' },
            { action: 'bypassUsageGuard', isPrimary: false, label: 'Continue anyway' },
        ]);
    });

    it('offers Cancel for the stopped turn that waits to continue, and never Continue now', () => {
        const guard = {
            autoContinue: { status: 'waiting', at: AT },
            autoContinueTurnId: 'turn-1',
        } as const;
        expect(summary(agentChatUsageGuardButtons(guard, { generate: false }))).toEqual([
            { action: 'cancel', isPrimary: false, label: 'Cancel' },
            { action: 'bypassUsageGuard', isPrimary: false, label: 'Continue anyway' },
        ]);
        expect(
            agentChatUsageGuardButtons(
                { autoContinue: guard.autoContinue },
                { generate: false },
            ).map(({ action }) => action),
        ).toEqual(['bypassUsageGuard']);
    });
});

describe('agentChatUsageActionBlockedReason', () => {
    it('needs reply access first, then a connection', () => {
        expect(
            agentChatUsageActionBlockedReason({ canSend: false, isConnected: false }, translate),
        ).toBe('Reply access is required to act on usage limits.');
        expect(
            agentChatUsageActionBlockedReason({ canSend: true, isConnected: false }, translate),
        ).toBe('Reconnect to act on usage limits.');
        expect(
            agentChatUsageActionBlockedReason({ canSend: true, isConnected: true }, translate),
        ).toBeUndefined();
    });
});
