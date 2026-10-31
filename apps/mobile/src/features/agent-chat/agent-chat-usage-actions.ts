import { createContext } from 'react';

import type { AgentChatUsageGuard, AgentChatUsageLimit } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';

/**
 * What a usage-limit or usage guard card can do: answer the Chat's wait for its limit to reset, or the guard's Generate
 * hand-off and Continue anyway. Each maps to one `mobile.agentChat.*` method.
 */
export type AgentChatUsageAction =
    'bypassUsageGuard' | 'cancel' | 'continueNow' | 'generateHandoff';

/**
 * One button on a usage card: the action, its label, and whether it is the card's one filled answer.
 */
export interface AgentChatUsageButton {
    action: AgentChatUsageAction;
    hint?: TranslationKey;
    isPrimary: boolean;
    label: TranslationKey;
}

/**
 * The Chat a usage-limit card inside the timeline acts on, and why it cannot act right now. Provided by the Chat view
 * around its timeline; absent in a read-only timeline, whose cards show the failure without actions, as Desktop's task
 * tab does.
 */
export const AgentChatUsageActionScope = createContext<
    { blockedReason: string | undefined; terminalId: string } | undefined
>(undefined);

/**
 * Why this device cannot act on a usage limit right now, or `undefined` when it can. The actions decide how the Chat's
 * next turn runs, so they need what sending needs: reply access and a live connection.
 */
export const agentChatUsageActionBlockedReason = (
    { canSend, isConnected }: { canSend: boolean; isConnected: boolean },
    t: Translate,
): string | undefined => {
    if (!canSend) return t('chat.usageActions.access');
    if (!isConnected) return t('chat.usageActions.offline');
    return undefined;
};

/**
 * The usage-limit card's buttons, after Desktop's `AgentChatAutoContinueActions`: Continue now (or Continue, once the
 * reset passed while the Chat could not continue) and, while it still waits, Cancel. Nothing for a Chat that already
 * continued or never waited, or a notice without the turn the wait belongs to.
 */
export const agentChatUsageLimitButtons = (
    usageLimit: Pick<AgentChatUsageLimit, 'autoContinue'>,
    turnId: string | undefined,
): AgentChatUsageButton[] => {
    const status = usageLimit.autoContinue?.status;
    if (!turnId || (status !== 'waiting' && status !== 'missed')) return [];
    const continueNow: AgentChatUsageButton = {
        action: 'continueNow',
        isPrimary: true,
        label:
            status === 'waiting'
                ? 'chat.usageLimit.auto.continueNow'
                : 'chat.usageLimit.auto.continue',
    };
    if (status === 'missed') return [continueNow];
    return [
        continueNow,
        {
            action: 'cancel',
            hint: 'chat.usageLimit.auto.cancelHint',
            isPrimary: false,
            label: 'chat.usageLimit.auto.cancel',
        },
    ];
};

/**
 * The usage guard card's buttons, after Desktop's `AgentChatUsageGuardCard`: Generate hand-off while the account's one
 * hand-off is on offer (`agentChatUsageGuardOffer`), Cancel while the turn the guard stopped waits to continue on its
 * own (nothing can continue now while the guard holds), and Continue anyway. Generate hand-off is the one filled
 * answer; Continue anyway spends the kept budget, so it never is.
 */
export const agentChatUsageGuardButtons = (
    guard: Pick<AgentChatUsageGuard, 'autoContinue' | 'autoContinueTurnId'>,
    offer: { generate: boolean },
): AgentChatUsageButton[] => [
    ...(offer.generate
        ? [
              {
                  action: 'generateHandoff',
                  hint: 'chat.usageGuard.generateHint',
                  isPrimary: true,
                  label: 'chat.usageGuard.generate',
              } as const,
          ]
        : []),
    ...(guard.autoContinue?.status === 'waiting' && guard.autoContinueTurnId
        ? [
              {
                  action: 'cancel',
                  hint: 'chat.usageLimit.auto.cancelHint',
                  isPrimary: false,
                  label: 'chat.usageLimit.auto.cancel',
              } as const,
          ]
        : []),
    {
        action: 'bypassUsageGuard',
        hint: 'chat.usageGuard.continueAnywayHint',
        isPrimary: false,
        label: 'chat.usageGuard.continueAnyway',
    },
];

/**
 * The toast an action shows when the Server refuses it, in Desktop's words.
 */
export const AGENT_CHAT_USAGE_ACTION_FAILURES = {
    bypassUsageGuard: 'chat.usageGuard.continueAnywayFailed',
    cancel: 'chat.usageLimit.auto.cancelFailed',
    continueNow: 'chat.usageLimit.auto.continueFailed',
    generateHandoff: 'chat.usageGuard.generateFailed',
} as const satisfies Record<AgentChatUsageAction, TranslationKey>;
