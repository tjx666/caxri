import { useEffect, useState } from 'react';

import { ScreenState } from '../../../components/screen-state';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import {
    describeSessionHomeEmptyState,
    isAwaitingFirstLoad,
    SESSION_LOAD_STALL_MS,
} from '../session-home-empty-state';

/**
 * Turns true once the first Session list read has been pending for {@link SESSION_LOAD_STALL_MS}; resets when it
 * settles.
 */
function useIsFirstLoadStalled(isAwaiting: boolean): boolean {
    const [isStalled, setIsStalled] = useState(false);
    useEffect(() => {
        if (!isAwaiting) return;
        const timer = setTimeout(() => setIsStalled(true), SESSION_LOAD_STALL_MS);
        return () => {
            clearTimeout(timer);
            setIsStalled(false);
        };
    }, [isAwaiting]);
    return isStalled;
}

/**
 * What fills the Session home when there is no list: loading, nothing yet, a failed first read, or a connection that
 * cannot serve Sessions at all (unverified pairing, version mismatch). The notice above explains the cause; this says
 * what the screen is showing.
 */
export const SessionHomeEmpty = ({
    activeProjectId,
    error,
    hasLoaded,
    isLoading,
    onNewSession,
    onRetry,
    status,
    theme,
}: {
    activeProjectId: string | null;
    error: string | null;
    hasLoaded: boolean;
    isLoading: boolean;
    onNewSession: () => void;
    onRetry: () => Promise<void>;
    status: MobileConnectionStatus;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { retryConnection } = useMobileClient();
    const isStalled = useIsFirstLoadStalled(isAwaitingFirstLoad(status, hasLoaded));
    const state = describeSessionHomeEmptyState(
        { activeProjectId, error, hasLoaded, isStalled, status },
        t,
    );
    if (state.showSpinner)
        return (
            <ScreenState kind="loading" testID={state.testID} theme={theme} title={state.body} />
        );
    const kind = hasLoaded ? 'empty' : error ? 'error' : 'offline';
    const actionLabels = {
        new: t('sessions.new.title'),
        reconnect: t('sessions.banner.reconnectNow'),
        retry: t('common.retry'),
    };
    const actionHandlers = {
        new: onNewSession,
        reconnect: retryConnection,
        retry: () => {
            void onRetry();
        },
    };
    return (
        <ScreenState
            actionLabel={state.action ? actionLabels[state.action] : undefined}
            detail={state.body}
            isActionBusy={state.action === 'retry' && isLoading}
            kind={kind}
            onAction={state.action ? actionHandlers[state.action] : undefined}
            testID={state.testID}
            theme={theme}
            title={state.title ?? state.body}
        />
    );
};
