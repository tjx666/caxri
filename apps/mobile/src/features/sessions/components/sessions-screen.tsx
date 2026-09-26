import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { useMobileTheme } from '../../../theme/use-mobile-theme';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { isConnectionFresh } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { mobileLayoutMode } from '../../layout/layout-mode';
import { ConnectionBanner } from './connection-banner';
import { useHostSessions } from './host-sessions-provider';
import { SessionHome } from './session-home';
import { SessionsScreenDetail } from './sessions-screen-detail';

const styles = StyleSheet.create({
    safeArea: { flex: 1 },
    split: { flex: 1, flexDirection: 'row' },
    divider: { width: StyleSheet.hairlineWidth },
    versionBanner: { borderBottomWidth: 1, gap: 3, paddingHorizontal: 16, paddingVertical: 12 },
    versionTitle: { fontSize: 14, fontWeight: '700' },
    versionBody: { fontSize: 13, lineHeight: 18 },
});

const SessionsScreenStatus = ({
    fresh,
    onRetry,
    status,
    theme,
}: {
    fresh: boolean;
    onRetry: () => void;
    status: MobileConnectionStatus;
    theme: ReturnType<typeof useMobileTheme>;
}) => (
    <>
        {!fresh && status !== 'version-mismatch' ? (
            <ConnectionBanner
                onRetry={onRetry}
                status={status === 'unverified' ? 'unverified' : 'stale'}
                theme={theme}
            />
        ) : null}
        {status === 'version-mismatch' ? (
            <View
                style={[
                    styles.versionBanner,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
                testID="mobile-version-mismatch"
            >
                <Text
                    accessibilityRole="alert"
                    style={[styles.versionTitle, { color: theme.text }]}
                >
                    Update required
                </Text>
                <Text style={[styles.versionBody, { color: theme.muted }]}>
                    This app and Caxri on your computer use different versions. Update both to the
                    latest build.
                </Text>
            </View>
        ) : null}
    </>
);

const SessionsScreenLayout = ({
    detail,
    layout,
    now,
    onNewSession,
    onOpenSession,
    routeSessionId,
    theme,
}: {
    detail: ReactNode;
    layout: MobileLayoutMode;
    now: number;
    onNewSession: () => void;
    onOpenSession: (sessionId: string) => void;
    routeSessionId: string | null;
    theme: ReturnType<typeof useMobileTheme>;
}) => {
    const home = (
        <SessionHome
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
    const [{ now, lastSeenAt }, setClock] = useState<{ now: number; lastSeenAt: number | null }>({
        now: 0,
        lastSeenAt: null,
    });

    useEffect(() => {
        const tick = (): void => setClock({ now: Date.now(), lastSeenAt: getLastSeenAt() });
        const initial = setTimeout(tick, 0);
        const interval = setInterval(tick, 1_000);
        return () => {
            clearTimeout(initial);
            clearInterval(interval);
        };
    }, [getLastSeenAt, status]);

    const fresh = isConnectionFresh(status, lastSeenAt, now);

    const openSession = useCallback(
        (sessionId: string): void => {
            selectSession(sessionId);
            router.navigate(`/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}`);
        },
        [hostId, router, selectSession],
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
                onRetry={retryConnection}
                status={status}
                theme={theme}
            />
            <SessionsScreenLayout
                detail={detail}
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
