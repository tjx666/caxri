import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileUpdateNotice } from '../../update/use-mobile-update-notice';
import { isSessionListErrorShown, selectHomeNotice } from '../session-notices';
import { savedAgeLabel } from '../session-row-model';
import { useHostSessions } from './host-sessions-provider';
import type { HomeNoticeKind } from './session-home-notice-banners';
import { ConnectionBanner, ListNotice, UpdateBanner } from './session-home-notice-banners';

/**
 * Which banner renders each notice kind, so `SessionHomeNotice` branches on three families rather than eight kinds
 * (react-doctor/no-high-complexity-react-function).
 */
const homeNoticeFamily: Record<HomeNoticeKind, 'connection' | 'list' | 'update'> = {
    'connection-stale': 'connection',
    'connection-unverified': 'connection',
    'list-error': 'list',
    'saved-copy': 'list',
    'truncated': 'list',
    'update-available': 'update',
    'update-mismatch': 'update',
    'update-required': 'update',
};

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
    const { error, hasLoaded, savedAt, sections } = sessions;
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
    if (kind === null) return null;
    const saved = savedAt === null ? null : savedAgeLabel(savedAt, now, t);
    switch (homeNoticeFamily[kind]) {
        case 'update':
            return update ? <UpdateBanner theme={theme} update={update} /> : null;
        case 'connection':
            return (
                <ConnectionBanner
                    isListVisible={isListVisible}
                    onRetry={onRetryConnection}
                    saved={saved}
                    status={kind === 'connection-stale' ? 'stale' : 'unverified'}
                    theme={theme}
                />
            );
        case 'list':
            return <ListNotice kind={kind} saved={saved} theme={theme} />;
    }
};
