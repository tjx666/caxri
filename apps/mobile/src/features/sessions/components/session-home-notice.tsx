import { View } from 'react-native';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileUpdateNotice } from '../../update/use-mobile-update-notice';
import { allMobileSessions } from '../hooks/use-session-polling';
import {
    connectionNoticeMessage,
    isSessionListErrorShown,
    selectHomeNotice,
} from '../session-notices';
import { savedAgeLabel } from '../session-row-model';
import { useHostSessions } from './host-sessions-provider';

/**
 * The one notice across the top of Session home. Connection, update, list failure, saved copy, and truncation can all
 * be true at once; `selectHomeNotice` keeps only the most severe so the bars never stack above the list. The saved
 * copy's age rides inside the stale connection message.
 */
export const SessionHomeNotice = ({
    connection,
    isListVisible,
    now,
    onRetryConnection,
    theme,
    update,
}: {
    /**
     * The connection state that interrupts the screen, or `null` while the connection is fresh or a version mismatch
     * (which the update notice explains).
     */
    connection: 'stale' | 'unverified' | null;
    /**
     * Whether the Session list itself is on screen, as opposed to a Session detail on a phone.
     */
    isListVisible: boolean;
    now: number;
    onRetryConnection: () => void;
    theme: MobileTheme;
    update: MobileUpdateNotice | null;
}) => {
    const { t } = useTranslation();
    const { sessions } = useHostSessions();
    const { error, hasLoaded, isLoading, refresh, savedAt, sections } = sessions;
    const kind = selectHomeNotice({
        connection,
        isListErrorShown: isSessionListErrorShown({
            error,
            hasLoaded,
            isConnectionNoticeShown: connection !== null,
        }),
        isListVisible,
        isSavedCopy: savedAt !== null,
        isTruncated: sections.truncated,
        update: update?.kind ?? null,
    });
    const saved = savedAt === null ? null : savedAgeLabel(savedAt, now, t);
    switch (kind) {
        case null:
            return null;
        case 'update-mismatch':
        case 'update-required':
        case 'update-available':
            return update ? (
                <NoticeBanner
                    actionLabel={update.action ? update.actionLabel : undefined}
                    actionTestID={
                        update.action === 'retry-check'
                            ? 'mobile-update-retry'
                            : 'mobile-update-install'
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
            ) : null;
        case 'connection-stale':
        case 'connection-unverified': {
            const status = kind === 'connection-stale' ? 'stale' : 'unverified';
            const isSavedCopyShown = status === 'stale' && isListVisible && saved !== null;
            const banner = (
                <NoticeBanner
                    actionLabel={status === 'unverified' ? t('common.retry') : undefined}
                    actionTestID="connection-retry-button"
                    message={connectionNoticeMessage(status, isSavedCopyShown ? saved : null, t)}
                    onAction={onRetryConnection}
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
        }
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
    }
};
