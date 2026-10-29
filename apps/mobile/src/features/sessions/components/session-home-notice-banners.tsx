import { View } from 'react-native';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileUpdateNotice } from '../../update/use-mobile-update-notice';
import { allMobileSessions } from '../hooks/use-session-polling';
import type { selectHomeNotice } from '../session-notices';
import { connectionNoticeMessage } from '../session-notices';
import { useHostSessions } from './host-sessions-provider';

/**
 * A notice kind `selectHomeNotice` can pick.
 */
export type HomeNoticeKind = NonNullable<ReturnType<typeof selectHomeNotice>>;

/**
 * The update notice with its Install or Retry and Later actions; split out of `SessionHomeNotice` to keep its control
 * flow flat (react-doctor/no-high-complexity-react-function).
 */
export const UpdateBanner = ({
    theme,
    update,
}: {
    theme: MobileTheme;
    update: MobileUpdateNotice;
}) => (
    <NoticeBanner
        actionLabel={update.action ? update.actionLabel : undefined}
        actionTestID={
            update.action === 'retry-check' ? 'mobile-update-retry' : 'mobile-update-install'
        }
        message={update.message}
        onAction={update.run}
        onSecondaryAction={update.canDismiss ? update.dismiss : undefined}
        secondaryActionLabel={update.canDismiss ? update.dismissLabel : undefined}
        secondaryActionTestID="mobile-update-later"
        testID={update.testID}
        theme={theme}
        tone={update.tone}
    />
);

/**
 * The stale or unverified connection banner; split out of `SessionHomeNotice` like `UpdateBanner`.
 */
export const ConnectionBanner = ({
    isListVisible,
    onRetry,
    saved,
    status,
    theme,
}: {
    isListVisible: boolean;
    onRetry: () => void;
    saved: string | null;
    status: 'stale' | 'unverified';
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { relayFailure } = useMobileClient();
    const isSavedCopyShown = status === 'stale' && isListVisible && saved !== null;
    const banner = (
        <NoticeBanner
            actionLabel={status === 'unverified' ? t('common.retry') : undefined}
            actionTestID="connection-retry-button"
            message={connectionNoticeMessage(
                status,
                isSavedCopyShown ? saved : null,
                t,
                relayFailure,
            )}
            onAction={onRetry}
            testID="connection-stale-banner"
            theme={theme}
            tone={status === 'unverified' ? 'warning' : 'muted'}
        />
    );
    // The saved copy is a fact this message now carries; the wrapper keeps its own id for the Android scenarios.
    return isSavedCopyShown ? (
        <View collapsable={false} testID="session-list-saved">
            {banner}
        </View>
    ) : (
        banner
    );
};

/**
 * The Session list's own notices: a failed refresh with Retry, the saved-copy age, and the truncation count.
 */
export const ListNotice = ({
    kind,
    saved,
    theme,
}: {
    kind: HomeNoticeKind;
    saved: string | null;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { sessions } = useHostSessions();
    const { error, isLoading, refresh, sections } = sessions;
    switch (kind) {
        case 'list-error':
            return (
                <NoticeBanner
                    actionLabel={t('common.retry')}
                    isBusy={isLoading}
                    message={t('sessions.home.listError', { error: error ?? '' })}
                    onAction={() => {
                        void refresh();
                    }}
                    testID="session-list-error-notice"
                    actionTestID="session-list-retry"
                    theme={theme}
                    tone="danger"
                />
            );
        case 'saved-copy':
            return (
                <NoticeBanner
                    message={t('sessions.home.savedCopy', { saved: saved ?? '' })}
                    testID="session-list-saved"
                    theme={theme}
                    tone="muted"
                />
            );
        case 'truncated':
            return (
                <NoticeBanner
                    message={t('sessions.home.truncated', {
                        shown: allMobileSessions(sections).length,
                        total: sections.total,
                    })}
                    testID="session-list-truncated"
                    theme={theme}
                    tone="muted"
                />
            );
        default:
            return null;
    }
};
