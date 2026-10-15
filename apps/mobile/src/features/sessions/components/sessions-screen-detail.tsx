import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useIsFocused } from 'expo-router';

import { useTranslation } from '../../../i18n';
import type { useMobileTheme } from '../../../theme/use-mobile-theme';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useSessionAttention } from '../hooks/use-session-attention';
import { useSessionConversation } from '../hooks/use-session-conversation';
import { allMobileSessions } from '../hooks/use-session-polling';
import { useSessionShow } from '../hooks/use-session-show';
import { isSessionDetailVisible, isSideSessionSegment } from '../session-ui-state';
import { useHostSessions } from './host-sessions-provider';
import { SelectedSessionDetail } from './selected-session-detail';
import { SessionRouteStatus } from './session-route-status';

const styles = StyleSheet.create({
    detailEmpty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
    emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
});

export const SessionsScreenDetail = ({
    fresh,
    layout,
    routeSessionId,
    theme,
}: {
    fresh: boolean;
    layout: MobileLayoutMode;
    routeSessionId: string | null;
    theme: ReturnType<typeof useMobileTheme>;
}) => {
    const { t } = useTranslation();
    const { hostId, sessions, ui } = useHostSessions();
    const { selectSession } = sessions;

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
    /**
     * The route Stack keeps covered screens mounted for its transitions; a covered detail must release its Terminal
     * lease and stop polling like one that left the screen.
     */
    const isDetailVisible = isSessionDetailVisible({
        isFocused: useIsFocused(),
        isPhone: layout === 'phone',
        isRouted: routeSessionId !== null,
        isSelected: selected !== null,
    });
    const rememberedSegment = selected ? ui.segmentBySession[selected.id] : undefined;
    const wideBackgroundSegment = selected
        ? (ui.contentSegmentBySession[selected.id] ??
          (selected.primaryAgentEndpoint ? 'conversation' : 'terminal'))
        : 'terminal';
    const conversation = useSessionConversation({
        isDetailVisible,
        keepVisible:
            layout === 'tablet-wide' &&
            rememberedSegment !== undefined &&
            isSideSessionSegment(rememberedSegment) &&
            wideBackgroundSegment === 'conversation',
        remembered: rememberedSegment,
        selected,
    });
    useSessionAttention({
        enabled: fresh && isDetailVisible,
        onRefresh: sessions.refresh,
        session: selected,
    });

    if (selected)
        return (
            <SelectedSessionDetail
                conversation={conversation}
                fresh={fresh}
                isDetailVisible={isDetailVisible}
                layout={layout}
                selected={selected}
                theme={theme}
                wideBackgroundSegment={wideBackgroundSegment}
            />
        );
    if (routeSessionId)
        return (
            <SessionRouteStatus
                error={shown.error}
                isLoading={shown.isLoading}
                isOffline={shown.isOffline}
                hasBack={layout === 'phone'}
                hostId={hostId}
                onRetry={shown.refresh}
                theme={theme}
            />
        );
    return (
        <View style={styles.detailEmpty}>
            <Text style={[styles.emptyBody, { color: theme.muted }]}>
                {t('sessions.detail.selectSession')}
            </Text>
        </View>
    );
};
