import { useCallback } from 'react';

import { useRouter } from 'expo-router';

import { useMobileClient } from '../connection/mobile-client-provider';

/**
 * Opens a file the Session's messages cite in the read-only file viewer, which reads it from the computer through the
 * Session's own file access.
 */
export const useOpenSessionFile = (sessionId: string): ((reference: string) => void) => {
    const router = useRouter();
    const { hostId } = useMobileClient();
    return useCallback(
        (reference: string) => {
            if (!hostId) return;
            router.push({
                params: { 'host-id': hostId, reference, 'session': sessionId },
                pathname: '/h/[host-id]/file',
            });
        },
        [hostId, router, sessionId],
    );
};
