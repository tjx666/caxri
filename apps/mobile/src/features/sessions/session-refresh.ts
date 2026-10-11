import type { MethodResult } from '@caxri/protocol';

import type { MobileSessionSections } from './session-model';
import { buildMobileSessionSections } from './session-model';

export interface MobileSessionRefreshSource {
    dashboard(): Promise<MethodResult<'mobile.dashboard'>>;
}

export interface MobileDashboardSnapshot {
    deviceRole: MethodResult<'mobile.dashboard'>['deviceRole'];
    hostDisplayName: string;
    projects: MethodResult<'mobile.dashboard'>['projects'];
    sections: MobileSessionSections;
}

/**
 * The phone's view of one Dashboard read, live or saved.
 */
export const projectMobileDashboard = (
    dashboard: MethodResult<'mobile.dashboard'>,
): MobileDashboardSnapshot => ({
    deviceRole: dashboard.deviceRole,
    hostDisplayName: dashboard.hostDisplayName,
    projects: dashboard.projects,
    sections: buildMobileSessionSections({
        sessions: dashboard.sessions,
        total: dashboard.total,
        truncated: dashboard.truncated,
    }),
});

export const fetchMobileSessionDashboard = async (
    source: MobileSessionRefreshSource,
): Promise<MobileDashboardSnapshot> => projectMobileDashboard(await source.dashboard());
