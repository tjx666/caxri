import { useWindowDimensions } from 'react-native';

import { useRouter } from 'expo-router';

import { mobileLayoutMode } from '../layout/layout-mode';
import { useHostSessions } from '../sessions/components/host-sessions-provider';

/**
 * Opens a Session the phone lists from a link in the timeline (a delegation's source, a hand-off's target). A tablet's
 * split view swaps the Session it shows, as the list does, so it never stacks a second Terminal.
 */
export const useOpenSession = (): ((sessionId: string) => void) => {
    const router = useRouter();
    const { height, width } = useWindowDimensions();
    const { hostId, sessions } = useHostSessions();
    return (sessionId) => {
        sessions.selectSession(sessionId);
        const href = `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}` as const;
        if (mobileLayoutMode(width, height) === 'phone') router.navigate(href);
        else router.replace(href);
    };
};
