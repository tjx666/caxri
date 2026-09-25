import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRouter } from 'expo-router';

import { useMobileTheme } from '../../../theme/use-mobile-theme';
import type { MobileConnectionStatus } from '../../connection/connection-state';
import { isConnectionFresh } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { mobileLayoutMode } from '../../layout/layout-mode';
import { useSessionAttention } from '../hooks/use-session-attention';
import { useSessionConversation } from '../hooks/use-session-conversation';
import { allMobileSessions } from '../hooks/use-session-polling';
import { useSessionShow } from '../hooks/use-session-show';
import { ConnectionBanner } from './connection-banner';
import { useHostSessions } from './host-sessions-provider';
import { SessionDetail } from './session-detail';
import { SessionHome } from './session-home';
import { SessionRouteStatus } from './session-route-status';

const styles = StyleSheet.create({
    safeArea: { flex: 1 },
    split: { flex: 1, flexDirection: 'row' },
    divider: { width: StyleSheet.hairlineWidth },
    detailEmpty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
    emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
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
    const { lastSeenAt, request, retryConnection, status } = useMobileClient();
    const {
        consumeComposerFocus,
        focusComposerSessionId,
        hostId,
        sessions,
        setDraft,
        setSegment,
        ui,
    } = useHostSessions();
    const { refresh, selectSession } = sessions;
    const [now, setNow] = useState(0);

    useEffect(() => {
        const tick = (): void => setNow(Date.now());
        const initial = setTimeout(tick, 0);
        const interval = setInterval(tick, 1_000);
        return () => {
            clearTimeout(initial);
            clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        if (routeSessionId) selectSession(routeSessionId);
    }, [routeSessionId, selectSession]);

    const dashboardSelected = useMemo(() => {
        if (routeSessionId)
            return (
                allMobileSessions(sessions.sections).find(({ id }) => id === routeSessionId) ?? null
            );
        return sessions.selected;
    }, [routeSessionId, sessions.sections, sessions.selected]);
    const shown = useSessionShow(
        routeSessionId,
        routeSessionId !== null && dashboardSelected === null,
    );
    const selected = dashboardSelected ?? shown.session;
    const isDetailVisible = selected !== null && (layout !== 'phone' || routeSessionId !== null);
    const rememberedSegment = selected ? ui.segmentBySession[selected.id] : undefined;
    const conversation = useSessionConversation({
        isDetailVisible,
        remembered: rememberedSegment,
        selected,
    });
    const segment = conversation.segment;
    const fresh = isConnectionFresh(status, lastSeenAt, now);
    useSessionAttention({
        enabled: fresh && isDetailVisible,
        onRefresh: sessions.refresh,
        session: selected,
    });

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
    const goHome = useCallback((): void => {
        router.replace(`/h/${encodeURIComponent(hostId)}`);
    }, [hostId, router]);
    const markRead = useCallback(async (): Promise<void> => {
        if (!selected) return;
        await request('session.markRead', {
            sessionId: selected.id,
            attentionEpoch: selected.attentionEpoch,
        });
        await refresh();
    }, [refresh, request, selected]);
    const detail = selected ? (
        <SessionDetail
            conversationFallback={conversation.fallback}
            conversationTimeline={conversation.timeline}
            deviceRole={sessions.deviceRole}
            draft={ui.draftBySession[selected.id] ?? ''}
            focusComposer={focusComposerSessionId === selected.id}
            hostId={hostId}
            isConnected={fresh}
            isVisible={isDetailVisible}
            onBack={layout === 'phone' ? goHome : undefined}
            onDraftChange={(draft) => setDraft(selected.id, draft)}
            onComposerFocused={() => consumeComposerFocus(selected.id)}
            onMarkRead={markRead}
            onRefresh={sessions.refresh}
            onSegmentChange={(next) => setSegment(selected.id, next)}
            segment={segment}
            session={selected}
            theme={theme}
            wideChanges={layout === 'tablet-wide'}
        />
    ) : routeSessionId ? (
        <SessionRouteStatus
            error={shown.error}
            isLoading={shown.isLoading}
            onRetry={shown.refresh}
            theme={theme}
        />
    ) : (
        <View style={styles.detailEmpty}>
            <Text style={[styles.emptyBody, { color: theme.muted }]}>Select a Session</Text>
        </View>
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
