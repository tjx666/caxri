import type { ProjectStatusSummary, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { ProjectStatusAlertTracker } from './alerts';
import type { ProjectStatusMerge } from './merge-tracker';
import { ProjectStatusMergeTracker } from './merge-tracker';

export interface ProjectStatusSummaryObserversOptions {
    areAlertsEnabled(): boolean;
    emit?: (event: ServerEvent) => void;
    logger: Pick<StructuredLogger, 'write'>;
    now(): number;
}

/**
 * Everything that reacts to a freshly refreshed Status summary rather than rendering it: delivery-failure alerts and
 * pull request merges in any of the Session's repositories.
 */
export class ProjectStatusSummaryObservers {
    private readonly alerts: ProjectStatusAlertTracker;
    private readonly merges: ProjectStatusMergeTracker;
    /**
     * Late-bound, because the merge notice is assembled after the Project Status Service.
     */
    onMerged?: (sessionId: string, merge: ProjectStatusMerge) => void;

    constructor(private readonly options: ProjectStatusSummaryObserversOptions) {
        this.alerts = new ProjectStatusAlertTracker({ now: () => options.now() });
        this.merges = new ProjectStatusMergeTracker({ now: () => options.now() });
    }

    /**
     * Emits one `projectStatus.alert` per newly failing check or deployment. The tracker is fed even while
     * notifications are disabled so re-enabling them does not replay every failure that accumulated in the meantime as
     * if it had just happened.
     */
    private publishAlerts(sessionId: string, summary: ProjectStatusSummary): void {
        const alerts = this.alerts.observe(summary);
        if (alerts.length === 0 || !this.options.areAlertsEnabled()) return;
        for (const alert of alerts) {
            this.options.logger.write('info', logEventCatalog.projectStatus.alert, {
                fields: { kind: alert.kind },
            });
            this.options.emit?.({ event: 'projectStatus.alert', payload: { sessionId, ...alert } });
        }
    }

    observe(sessionId: string, summary: ProjectStatusSummary): void {
        this.publishAlerts(sessionId, summary);
        for (const merge of this.merges.observe(sessionId, summary))
            this.onMerged?.(sessionId, merge);
    }
}
