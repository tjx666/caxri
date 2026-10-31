import type { AgentChatUsageLimit, AppLocale } from '@caxri/protocol';
import { AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { resetClockTime } from '../agent-usage/agent-usage-model';
import { resetText } from './agent-chat-plan-limits';

type AutoContinue = NonNullable<AgentChatUsageLimit['autoContinue']>;

const HOUR_MS = 3_600_000;

/**
 * A failed turn's headline: which window the provider used up, in Desktop's words.
 */
export const agentChatUsageLimitHeadline = (
    limit: Pick<AgentChatUsageLimit, 'window'>,
    providerName: string,
    t: Translate,
): string => t(`chat.usageLimit.${limit.window}`, { provider: providerName });

/**
 * `Resets in 3h 20m`, or nothing when the provider reported no reset time or the reset already passed (a lasting
 * "resets now" on an old notice reads as if the limit were still in force).
 */
export const agentChatUsageLimitReset = (
    limit: Pick<AgentChatUsageLimit, 'resetsAt'>,
    now: number,
    t: Translate,
): string | undefined =>
    limit.resetsAt === undefined || limit.resetsAt <= now
        ? undefined
        : resetText(limit.resetsAt, now, t);

/**
 * The line about the Chat continuing on its own once its limit resets: when it continues, that it did, that the reset
 * passed, or why it never waited. Mirrors Desktop's `agentChatAutoContinueLabel`.
 */
export const agentChatAutoContinueLabel = (
    autoContinue: AutoContinue,
    now: number,
    locale: AppLocale,
    t: Translate,
): string => {
    switch (autoContinue.status) {
        case 'waiting': {
            const ms = autoContinue.at - now;
            // Sweeps run every few seconds, so a passed time is only a moment before the continuation lands.
            if (ms < 60_000) return t('chat.usageLimit.auto.continuing');
            const minutes = Math.round(ms / 60_000);
            const hours = Math.floor(minutes / 60);
            return t('chat.usageLimit.auto.waiting', {
                duration:
                    ms >= 24 * HOUR_MS
                        ? t('chat.usageGuard.resetDays', {
                              days: Math.floor(hours / 24),
                              hours: hours % 24,
                          })
                        : t('chat.usageGuard.resetHours', { hours, minutes: minutes % 60 }),
                time: resetClockTime(autoContinue.at, now, locale),
            });
        }
        case 'continued': {
            return t('chat.usageLimit.auto.continued', {
                time: resetClockTime(autoContinue.at, autoContinue.at, locale),
            });
        }
        case 'missed': {
            return t('chat.usageLimit.auto.missed');
        }
        case 'skipped': {
            return t(`chat.usageLimit.auto.${autoContinue.reason}`, {
                count: AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS,
            });
        }
    }
};
