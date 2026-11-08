import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useRouter } from 'expo-router';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileUpdateNotice } from '../../update/use-mobile-update-notice';
import { allMobileSessions } from '../hooks/use-session-polling';
import type { selectHomeNotice } from '../session-notices';
import {
    connectionBannerModel,
    connectionIslandLabel,
    connectionNoticeMessage,
    createFirstShownTimes,
    transientNoticeRemainingMs,
} from '../session-notices';
import { useHostSessions } from './host-sessions-provider';
import { NoticeIsland } from './notice-island';

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
 * The stale or unverified connection notice; split out of `SessionHomeNotice` like `UpdateBanner`. An automatic
 * reconnect floats as `NoticeIsland` and takes no height; a notice the user must act on stays a banner.
 */
export const ConnectionBanner = ({
    isListVisible,
    isSessionCovered,
    onRetry,
    saved,
    status,
    theme,
}: {
    isListVisible: boolean;
    /**
     * The side panel's drawer covers the Session. The island then hides as it does under a sheet: floating over the
     * drawer's tab row, it hid the middle tabs and took their taps. Each drawer view says it is offline itself, and the
     * island returns when the drawer closes. A banner stays, since it pushes the drawer down instead of covering it.
     */
    isSessionCovered: boolean;
    onRetry: () => void;
    saved: string | null;
    status: 'stale' | 'unverified';
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { relayFailure } = useMobileClient();
    const { hostId } = useHostSessions();
    const router = useRouter();
    const model = connectionBannerModel(status, relayFailure);
    const actionLabels = {
        reconnect: t('sessions.banner.reconnectNow'),
        retry: t('common.retry'),
        settings: t('sessions.banner.openSettings'),
    };
    const openSettings = (): void => {
        router.navigate(`/h/${encodeURIComponent(hostId)}/settings`);
    };
    const onAction = model.action === 'settings' ? openSettings : onRetry;
    const isSavedCopyShown = status === 'stale' && isListVisible && saved !== null;
    const message = connectionNoticeMessage(
        status,
        isSavedCopyShown ? saved : null,
        t,
        relayFailure,
    );
    if (model.presentation === 'island')
        return isSessionCovered ? null : (
            <NoticeIsland
                accessibilityLabel={message}
                action={{
                    label: actionLabels[model.action],
                    onPress: onAction,
                    testID: 'connection-retry-button',
                }}
                isBusy
                label={connectionIslandLabel(isSavedCopyShown ? saved : null, t, relayFailure)}
                testID="connection-stale-banner"
                theme={theme}
                wrapperTestID={isSavedCopyShown ? 'session-list-saved' : undefined}
            />
        );
    const banner = (
        <NoticeBanner
            actionLabel={actionLabels[model.action]}
            actionTestID="connection-retry-button"
            message={message}
            onAction={onAction}
            testID="connection-stale-banner"
            theme={theme}
            tone={model.tone}
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
 * First-draw times of the truncated island across every mounted Sessions screen; see `createFirstShownTimes`.
 */
const truncatedIslandFirstShown = createFirstShownTimes();

/**
 * The truncated-list notice as a floating island, shown for `TRUNCATED_NOTICE_VISIBLE_MS` once per count and then gone,
 * so it neither pushes the list down nor sits over the header for good. Tapping it opens Session search, where the rest
 * are. The parent keys it by the count, so a new count mounts a fresh island.
 */
const TruncatedIsland = ({
    noticeKey,
    shown,
    theme,
    total,
}: {
    noticeKey: string;
    shown: number;
    theme: MobileTheme;
    total: number;
}) => {
    const { t } = useTranslation();
    const { hostId } = useHostSessions();
    const router = useRouter();
    const [remainingMs] = useState(() => {
        const now = Date.now();
        return transientNoticeRemainingMs(truncatedIslandFirstShown(noticeKey, now), now);
    });
    const [isExpired, setIsExpired] = useState(remainingMs === 0);

    useEffect(() => {
        if (remainingMs === 0) return;
        const timer = setTimeout(() => setIsExpired(true), remainingMs);
        return () => clearTimeout(timer);
    }, [remainingMs]);

    if (isExpired) return null;
    return (
        <NoticeIsland
            accessibilityLabel={t('sessions.home.truncated', { shown, total })}
            action={{
                label: t('sessions.search.open'),
                onPress: () => router.navigate(`/h/${encodeURIComponent(hostId)}/search`),
                testID: 'session-list-truncated-search',
            }}
            label={t('sessions.home.truncatedShort', { shown, total })}
            testID="session-list-truncated"
            theme={theme}
        />
    );
};

/**
 * The Session list's own notices. A failed refresh with Retry stays a banner because it needs the user; the saved-copy
 * age and the truncation count need nothing, so they float as islands and never move the list.
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
    const { hostId, sessions } = useHostSessions();
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
        case 'saved-copy': {
            const message = t('sessions.home.savedCopy', { saved: saved ?? '' });
            return (
                <NoticeIsland
                    accessibilityLabel={message}
                    isBusy
                    label={message}
                    testID="session-list-saved"
                    theme={theme}
                />
            );
        }
        case 'truncated': {
            const shown = allMobileSessions(sections).length;
            const noticeKey = `${hostId}:${shown}/${sections.total}`;
            return (
                <TruncatedIsland
                    key={noticeKey}
                    noticeKey={noticeKey}
                    shown={shown}
                    theme={theme}
                    total={sections.total}
                />
            );
        }
        default:
            return null;
    }
};
