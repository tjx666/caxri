import { ScreenState } from '../../../components/screen-state';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { describeSessionHomeEmptyState } from '../session-home-empty-state';

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
    const state = describeSessionHomeEmptyState({ activeProjectId, error, hasLoaded, status }, t);
    if (state.showSpinner)
        return (
            <ScreenState kind="loading" testID={state.testID} theme={theme} title={state.body} />
        );
    const kind = hasLoaded ? 'empty' : error ? 'error' : 'offline';
    return (
        <ScreenState
            actionLabel={
                state.action === 'new'
                    ? t('sessions.new.title')
                    : state.action === 'retry'
                      ? t('common.retry')
                      : undefined
            }
            detail={state.body}
            isActionBusy={state.action === 'retry' && isLoading}
            kind={kind}
            onAction={
                state.action === 'new'
                    ? onNewSession
                    : state.action === 'retry'
                      ? () => {
                            void onRetry();
                        }
                      : undefined
            }
            testID={state.testID}
            theme={theme}
            title={state.title ?? state.body}
        />
    );
};
