import { useCallback } from 'react';

import { useRouter } from 'expo-router';

import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useHostSessions } from '../components/host-sessions-provider';
import { SESSION_ENTRY_PARAM, SWITCH_SESSION_ENTRY } from '../session-route-entry';

/**
 * Selects a Session and shows it: a phone pushes its detail, while a tablet swaps the detail beside the list, since
 * each stacked split view would keep its own Terminal WebView mounted.
 *
 * `switch` replaces the open Session's detail on a phone too, so moving between Sessions with "Previous Session" never
 * grows the Stack: Back still lands on the list in one step.
 */
export const useOpenSession = (layout: MobileLayoutMode) => {
    const router = useRouter();
    const { hostId, sessions } = useHostSessions();
    const { selectSession } = sessions;
    return useCallback(
        (sessionId: string, options?: { switch?: boolean }): void => {
            selectSession(sessionId);
            const href =
                `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}` as const;
            if (layout !== 'phone') router.replace(href);
            else if (options?.switch)
                router.replace(`${href}?${SESSION_ENTRY_PARAM}=${SWITCH_SESSION_ENTRY}`);
            else router.navigate(href);
        },
        [hostId, layout, router, selectSession],
    );
};
