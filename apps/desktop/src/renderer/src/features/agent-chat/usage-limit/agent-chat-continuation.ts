import type {
    AgentChatContinuationTarget,
    AgentChatUsageLimit,
    AgentProvider,
} from '@caxri/protocol';
import { AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { localizedDuration, localizedLimitReset } from '../../../lib/usage-format';
import { agentChatMessageTime } from '../transcript/agent-chat-time';

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
    t: Translate,
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
    t: Translate,
): string {
    return t(`agentChat.usageLimit.${limit.window}`, { provider: providerName });
}

/**
 * The line a usage-limit notice shows about the Chat continuing on its own (issue #2220): when a wait continues, that
 * it already did, that the reset passed while the Chat could not continue, or why it never waited.
 */
export function agentChatAutoContinueLabel(
    autoContinue: NonNullable<AgentChatUsageLimit['autoContinue']>,
    now: number,
    t: Translate,
): string {
    switch (autoContinue.status) {
        case 'waiting': {
            const ms = autoContinue.at - now;
            // Sweeps run every few seconds, so a passed time is only a moment before the continuation lands.
            if (ms < 60_000) return t('agentChat.usageLimit.auto.continuing');
            return t('agentChat.usageLimit.auto.waiting', {
                time: agentChatMessageTime(autoContinue.at, t.locale),
                duration: localizedDuration(ms, t),
            });
        }
        case 'continued': {
            return t('agentChat.usageLimit.auto.continued', {
                time: agentChatMessageTime(autoContinue.at, t.locale),
            });
        }
        case 'missed': {
            return t('agentChat.usageLimit.auto.missed');
        }
        case 'skipped': {
            return t(`agentChat.usageLimit.auto.skipped.${autoContinue.reason}`, {
                count: AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS,
            });
        }
    }
}
