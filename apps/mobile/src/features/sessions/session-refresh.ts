import type { MethodResult } from '@caxri/protocol';

import type { MobileSessionSections } from './session-model';
import { buildMobileSessionSections } from './session-model';

export interface MobileSessionRefreshSource {
    dashboard(): Promise<MethodResult<'mobile.dashboard'>>;
}

export type MobileSessionRefreshResult =
    | {
          hostDisplayName: string;
          projects: MethodResult<'mobile.dashboard'>['projects'];
          sections: MobileSessionSections;
          status: 'success';
      }
    | { status: 'error' };

/**
 * Keeps the last valid screen when any part of a refresh fails. The connection provider separately transitions a failed
 * transport to stale, so surfacing the same transient failure as an unhandled polling rejection would replace useful
 * state with developer noise during sleep, Wi-Fi handoff, or Server restart.
 */
export const loadMobileSessionSections = async (
    source: MobileSessionRefreshSource,
): Promise<MobileSessionRefreshResult> => {
    try {
        const dashboard = await source.dashboard();
        return {
            hostDisplayName: dashboard.hostDisplayName,
            projects: dashboard.projects,
            sections: buildMobileSessionSections({
                sessions: dashboard.sessions,
                total: dashboard.total,
                truncated: dashboard.truncated,
            }),
            status: 'success',
        };
    } catch {
        return { status: 'error' };
    }
};
