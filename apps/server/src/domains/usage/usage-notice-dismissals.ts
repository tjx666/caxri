import type { AgentProvider, UsageLimit, UsageNotice } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';

const STATE_KEYS = {
    planPace: 'planPaceDismissals',
    credits: 'creditsNoticeDismissals',
} as const satisfies Record<UsageNotice, string>;

/**
 * When the user dismissed each provider's plan notices, kept in `app_state` so a dismissal is the Server's, not one
 * Client's: Desktop, the phone, and a relaunched app all read it back on the reading (`UsageLimit.paceDismissedAt`,
 * `UsageLimit.creditsNoticeDismissedAt`) and hide the notice for as long as it says (`isPlanPaceDismissed`,
 * `weeklyCreditsNotice`).
 */
export class UsageNoticeDismissals {
    constructor(
        private readonly options: {
            database: Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;
            logger: StructuredLogger;
            now: () => number;
            /**
             * The newest reading per provider, logged with a dismissal for how much of the week was used.
             */
            limits: () => readonly UsageLimit[];
        },
    ) {}

    dismiss(notice: UsageNotice, provider: AgentProvider): void {
        const { database, logger } = this.options;
        const key = STATE_KEYS[notice];
        const stored = database.getAppState(key) ?? {};
        database.setAppState(key, { ...stored, [provider]: this.options.now() });
        const limit = this.options.limits().find((reading) => reading.provider === provider);
        const weekly = limit?.windows.find((window) => window.windowMinutes >= 1_440);
        logger.write(
            'info',
            notice === 'planPace'
                ? logEventCatalog.usage.planPaceDismissed
                : logEventCatalog.usage.creditsNoticeDismissed,
            { fields: { provider, usedPercent: weekly ? Math.round(weekly.usedPercent) : null } },
        );
    }

    /**
     * The reading with the provider's last dismissals attached, for every surface that returns a plan limit.
     */
    attach(limit: UsageLimit): UsageLimit {
        const { database } = this.options;
        const paceDismissedAt = database.getAppState('planPaceDismissals')?.[limit.provider];
        const creditsNoticeDismissedAt =
            database.getAppState('creditsNoticeDismissals')?.[limit.provider];
        return {
            ...limit,
            ...(paceDismissedAt !== undefined && { paceDismissedAt }),
            ...(creditsNoticeDismissedAt !== undefined && { creditsNoticeDismissedAt }),
        };
    }
}
