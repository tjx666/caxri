import type { MethodResult } from '@caxri/protocol';

import type { MobileSessionSections } from '../session-model';
import { buildMobileSessionSections } from '../session-model';

export interface MobileSessionRefreshSource {
    dashboard(): Promise<MethodResult<'mobile.dashboard'>>;
}

export interface MobileDashboardSnapshot {
    deviceRole: MethodResult<'mobile.dashboard'>['deviceRole'];
    hostDisplayName: string;
    /**
     * The Project filter the Server applied to this read; `null` for All. Group totals describe only that filter.
     */
    projectId: string | null;
    projects: MethodResult<'mobile.dashboard'>['projects'];
    sections: MobileSessionSections;
}

/**
 * The phone's view of one Dashboard read, live or saved.
 */
export const projectMobileDashboard = (
    dashboard: MethodResult<'mobile.dashboard'>,
    projectId: string | null = null,
): MobileDashboardSnapshot => ({
    deviceRole: dashboard.deviceRole,
    hostDisplayName: dashboard.hostDisplayName,
    projectId,
    projects: dashboard.projects,
    sections: buildMobileSessionSections({
        groupTotals: dashboard.groupTotals,
        sessions: dashboard.sessions,
        total: dashboard.total,
    }),
});

export const fetchMobileSessionDashboard = async (
    source: MobileSessionRefreshSource,
    projectId: string | null = null,
): Promise<MobileDashboardSnapshot> => projectMobileDashboard(await source.dashboard(), projectId);
