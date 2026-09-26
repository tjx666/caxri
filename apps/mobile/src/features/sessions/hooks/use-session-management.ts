import { useCallback, useState } from 'react';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { useHostSessions } from '../components/host-sessions-provider';
import { sessionManagementErrorMessage } from '../session-management-model';

type Action = 'archive' | 'rename' | 'restore';

/**
 * Rename, archive, and restore for a control device. Each call refreshes the dashboard afterwards so the home list
 * reflects the change without waiting for the next poll.
 */
export const useSessionManagement = () => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const [pending, setPending] = useState<{ action: Action; sessionId: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const run = useCallback(
        async (
            action: Action,
            sessionId: string,
            send: () => Promise<unknown>,
            fallback: string,
        ): Promise<boolean> => {
            setPending({ action, sessionId });
            setError(null);
            try {
                await send();
                await sessions.refresh();
                return true;
            } catch (error_) {
                setError(sessionManagementErrorMessage(error_, fallback));
                return false;
            } finally {
                setPending(null);
            }
        },
        [sessions],
    );
    const rename = useCallback(
        (sessionId: string, displayTitle: string) =>
            run(
                'rename',
                sessionId,
                () => request('mobile.session.rename', { sessionId, displayTitle }),
                'Unable to rename this Session',
            ),
        [request, run],
    );
    const archive = useCallback(
        (sessionId: string) =>
            run(
                'archive',
                sessionId,
                () => request('mobile.session.archive', { sessionId }),
                'Unable to archive this Session',
            ),
        [request, run],
    );
    const restore = useCallback(
        (sessionId: string) =>
            run(
                'restore',
                sessionId,
                () => request('mobile.session.restore', { sessionId }),
                'Unable to restore this Session',
            ),
        [request, run],
    );
    const clearError = useCallback(() => setError(null), []);
    return { archive, clearError, error, pending, rename, restore };
};
