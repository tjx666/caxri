import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { useMobileTheme } from '../../../theme/use-mobile-theme';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { initialConnectionClock, nextConnectionClock } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { mobileLayoutMode } from '../../layout/layout-mode';
import { MobileUpdateBanner } from '../../update/mobile-update-banner';
import { isConnectionBannerShown } from '../session-notices';
import { ConnectionBanner } from './connection-banner';
import { useHostSessions } from './host-sessions-provider';
import { SessionHome } from './session-home';
import { SessionsScreenDetail } from './sessions-screen-detail';

const styles = StyleSheet.create({
    safeArea: { flex: 1 },
    split: { flex: 1, flexDirection: 'row' },
    divider: { width: StyleSheet.hairlineWidth },
});

/**
 * A version mismatch is not a connection problem the Retry banner can fix; `MobileUpdateBanner` explains it instead.
 */
const SessionsScreenStatus = ({
    fresh,
    isSavedCopyLabeled,
    onRetry,
    status,
    theme,
}: {
    fresh: boolean;
    isSavedCopyLabeled: boolean;
    onRetry: () => void;
    status: MobileConnectionStatus;
    theme: ReturnType<typeof useMobileTheme>;
}) =>
    isConnectionBannerShown(fresh, status) ? (
        <ConnectionBanner
            isSavedCopyLabeled={isSavedCopyLabeled}
            onRetry={onRetry}
            status={status === 'unverified' ? 'unverified' : 'stale'}
            theme={theme}
        />
    ) : null;

const SessionsScreenLayout = ({
    detail,
    isConnectionNoticeShown,
    layout,
    now,
    onNewSession,
    onOpenSession,
    routeSessionId,
    theme,
}: {
    detail: ReactNode;
    isConnectionNoticeShown: boolean;
    layout: MobileLayoutMode;
    now: number;
    onNewSession: () => void;
    onOpenSession: (sessionId: string) => void;
    routeSessionId: string | null;
    theme: ReturnType<typeof useMobileTheme>;
}) => {
    const home = (
        <SessionHome
            isConnectionNoticeShown={isConnectionNoticeShown}
            layout={layout}
            now={now}
            onNewSession={onNewSession}
            onOpenSession={onOpenSession}
            theme={theme}
        />
    );
    if (layout === 'phone') return routeSessionId ? detail : home;
    return (
        <View style={styles.split}>
            {home}
            <View style={[styles.divider, { backgroundColor: theme.border }]} />
            {detail}
        </View>
    );
};

export const SessionsScreen = ({ routeSessionId }: { routeSessionId: string | null }) => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { height, width } = useWindowDimensions();
    const layout = mobileLayoutMode(width, height);
    const { getLastSeenAt, retryConnection, status } = useMobileClient();
    const { hostId, sessions } = useHostSessions();
    const { selectSession } = sessions;
    /**
     * Lazy-initialized so the first paint already reflects the client's current `lastSeenAt` instead of the
     * guaranteed-stale `null` placeholder (see `initialConnectionClock`).
     */
    const [{ fresh, now }, setClock] = useState(() =>
        initialConnectionClock(status, getLastSeenAt),
    );

    useEffect(() => {
        /**
         * Sampled every second, but a sample that changes nothing on screen returns the same clock and skips the
         * render.
         */
        const tick = (): void =>
            setClock((previous) =>
                nextConnectionClock(previous, status, getLastSeenAt(), Date.now()),
            );
        const initial = setTimeout(tick, 0);
        const interval = setInterval(tick, 1_000);
        return () => {
            clearTimeout(initial);
            clearInterval(interval);
        };
    }, [getLastSeenAt, status]);

    const openSession = useCallback(
        (sessionId: string): void => {
            selectSession(sessionId);
            const href =
                `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}` as const;
            /**
             * Each stacked split view would keep its own Terminal WebView mounted, so a tablet swaps the one it shows.
             */
            if (layout === 'phone') router.navigate(href);
            else router.replace(href);
        },
        [hostId, layout, router, selectSession],
    );
    const openNewSession = useCallback((): void => {
        router.navigate(`/h/${encodeURIComponent(hostId)}/new`);
    }, [hostId, router]);
    const detail = (
        <SessionsScreenDetail
            fresh={fresh}
            layout={layout}
            routeSessionId={routeSessionId}
            theme={theme}
        />
    );

    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
        >
            <SessionsScreenStatus
                fresh={fresh}
                isSavedCopyLabeled={sessions.savedAt !== null}
                onRetry={retryConnection}
                status={status}
                theme={theme}
            />
            <MobileUpdateBanner theme={theme} />
            <SessionsScreenLayout
                detail={detail}
                isConnectionNoticeShown={isConnectionBannerShown(fresh, status)}
                layout={layout}
                now={now}
                onNewSession={openNewSession}
                onOpenSession={openSession}
                routeSessionId={routeSessionId}
                theme={theme}
            />
        </SafeAreaView>
    );
};
