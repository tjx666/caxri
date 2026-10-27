import type { AgentProvider, UsageLimit } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';

/**
 * When the user dismissed each provider's plan pace reminder (`usage.dismissPlanPace`), kept in `app_state` so the
 * dismissal is the Server's, not one Client's: Desktop, the phone, and a relaunched app all read it back as
 * `UsageLimit.paceDismissedAt` and hide the reminder for the rest of their local day (`isPlanPaceDismissed`).
 */
export class PlanPaceDismissals {
    constructor(
        private readonly database: Pick<CaxriDatabase, 'getAppState' | 'setAppState'>,
        private readonly logger: StructuredLogger,
        private readonly now: () => number,
    ) {}

    /**
     * Records the dismissal; `limit` is the provider's current reading, logged for how far behind pace it was.
     */
    dismiss(provider: AgentProvider, limit: UsageLimit | undefined): void {
        const stored = this.database.getAppState('planPaceDismissals') ?? {};
        this.database.setAppState('planPaceDismissals', { ...stored, [provider]: this.now() });
        const weekly = limit?.windows.find((window) => window.windowMinutes >= 1_440);
        this.logger.write('info', logEventCatalog.usage.planPaceDismissed, {
            fields: { provider, usedPercent: weekly ? Math.round(weekly.usedPercent) : null },
        });
    }

    /**
     * The reading with the provider's last dismissal attached, for every surface that returns a plan limit.
     */
    attach(limit: UsageLimit): UsageLimit {
        const paceDismissedAt = this.database.getAppState('planPaceDismissals')?.[limit.provider];
        return paceDismissedAt === undefined ? limit : { ...limit, paceDismissedAt };
    }
}
