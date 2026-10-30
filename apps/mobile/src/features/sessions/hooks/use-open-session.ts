import { useCallback } from 'react';

import { useRouter } from 'expo-router';

import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useHostSessions } from '../components/host-sessions-provider';

/**
 * Selects a Session and shows it: a phone pushes its detail, while a tablet swaps the detail beside the list, since
 * each stacked split view would keep its own Terminal WebView mounted.
 */
export const useOpenSession = (layout: MobileLayoutMode) => {
    const router = useRouter();
    const { hostId, sessions } = useHostSessions();
    const { selectSession } = sessions;
    return useCallback(
        (sessionId: string): void => {
            selectSession(sessionId);
            const href =
                `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}` as const;
            if (layout === 'phone') router.navigate(href);
            else router.replace(href);
        },
        [hostId, layout, router, selectSession],
    );
};
