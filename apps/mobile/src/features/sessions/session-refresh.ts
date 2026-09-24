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

export const fetchMobileSessionDashboard = async (
    source: MobileSessionRefreshSource,
): Promise<MobileDashboardSnapshot> => {
    const dashboard = await source.dashboard();
    return {
        deviceRole: dashboard.deviceRole,
        hostDisplayName: dashboard.hostDisplayName,
        projects: dashboard.projects,
        sections: buildMobileSessionSections({
            sessions: dashboard.sessions,
            total: dashboard.total,
            truncated: dashboard.truncated,
        }),
    };
};
