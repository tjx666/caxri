import type {
    AgentChatContinuationTarget,
    AgentChatUsageGuard,
    AgentChatUsageLimit,
    AgentProvider,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';
import { localizedLimitReset } from '../../../lib/usage-format';

/**
 * The continuation control's default and its alternatives: the first provider that can take the work over is the split
 * button's leading half, and the menu lists every provider, the unavailable ones disabled with their reason, so the
 * user sees why an Agent they expected is missing.
 */
export function agentChatContinuationChoice(targets: readonly AgentChatContinuationTarget[]): {
    primary: AgentProvider | undefined;
    targets: readonly AgentChatContinuationTarget[];
} {
    return {
        primary: targets.find((target) => target.unavailable === undefined)?.provider,
        targets: targets.filter((target) => target.unavailable !== 'current'),
    };
}

/**
 * Why a provider cannot take the work over, as the menu's trailing text, or `undefined` when it can.
 */
export function agentChatContinuationUnavailableLabel(
    target: AgentChatContinuationTarget,
    now: number,
    t: Translate = translate,
): string | undefined {
    switch (target.unavailable) {
        case undefined: {
            return undefined;
        }
        case 'usageLimited': {
            return target.resetsAt === undefined
                ? t('agentChat.usageLimit.unavailable.usageLimited')
                : t('agentChat.usageLimit.unavailable.usageLimitedUntil', {
                      reset: localizedLimitReset(target.resetsAt, now, t),
                  });
        }
        default: {
            return t(`agentChat.usageLimit.unavailable.${target.unavailable}`);
        }
    }
}

/**
 * The failed turn's headline: which window the provider used up.
 */
export function agentChatUsageLimitHeadline(
    limit: Pick<AgentChatUsageLimit, 'window'>,
    providerName: string,
    t: Translate = translate,
): string {
    return t(`agentChat.usageLimit.${limit.window}`, { provider: providerName });
}

/**
 * What the usage guard's card offers right now. `generate` is the one hand-off, offered while the account's lease is
 * free, the provider can run a tool-less side turn, and the window is not already at 100%, where the provider would
 * refuse the turn and spend the lease on nothing. `used` tells the user why it is gone when another Chat took it.
 */
export function agentChatUsageGuardOffer(
    guard: Pick<AgentChatUsageGuard, 'document' | 'handoff' | 'usedPercent'>,
    canAskSideQuestion: boolean,
): { generate: boolean; used: boolean } {
    const isOpen = guard.handoff === 'available' && guard.document === undefined;
    return {
        generate: isOpen && canAskSideQuestion && guard.usedPercent < 100,
        used: guard.handoff !== 'available' && guard.document === undefined,
    };
}
