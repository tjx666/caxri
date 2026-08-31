import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    Pressable,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { Redirect } from 'expo-router';

import type { MobileTheme } from '../../../theme/tokens';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { isConnectionFresh } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileLayoutMode } from '../../layout/layout-mode';
import { useSessionAttention } from '../hooks/use-session-attention';
import type { SessionListEntry } from '../hooks/use-session-polling';
import { allMobileSessions, useSessionPolling } from '../hooks/use-session-polling';
import { useTerminalPreview } from '../hooks/use-terminal-preview';
import { mobileSessionDraftKey } from '../session-model';
import { ConnectionBanner } from './connection-banner';
import { SessionDetail } from './session-detail';
import { SessionRow } from './session-row';

const styles = StyleSheet.create({
    detailEmpty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
    empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 28 },
    emptyBody: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
    emptyTitle: { fontSize: 17, fontWeight: '700' },
    errorBanner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    errorBannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
    forgetButton: { justifyContent: 'center', minHeight: 48, paddingHorizontal: 8 },
    forgetLabel: { fontSize: 14, fontWeight: '600' },
    groupHeader: {
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 0.8,
        paddingBottom: 7,
        paddingHorizontal: 16,
        paddingTop: 18,
    },
    limitBanner: { borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 8 },
    limitBannerText: { fontSize: 12, lineHeight: 16 },
    list: { flex: 1 },
    listHeader: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 76,
        paddingHorizontal: 16,
    },
    listPane: { minWidth: 0 },
    listSubtitle: { fontSize: 13, marginTop: 3 },
    listTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
    retryButton: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
    retryLabel: { fontSize: 14, fontWeight: '700' },
    phoneListPane: { flex: 1 },
    safeArea: { flex: 1 },
    split: { flex: 1, flexDirection: 'row' },
    splitDivider: { width: StyleSheet.hairlineWidth },
    tabletListPane: { flexGrow: 0, flexShrink: 0, width: 320 },
});

const sessionEntryKey = (entry: SessionListEntry): string => entry.id;
const sessionEntryType = (entry: SessionListEntry): SessionListEntry['type'] => entry.type;

const SessionGroupHeader = ({ label, theme }: { label: string; theme: MobileTheme }) => (
    <Text style={[styles.groupHeader, { color: theme.muted }]}>{label}</Text>
);

export const SessionsScreen = () => {
    const { forgetDevice, lastSeenAt, paired, status } = useMobileClient();
    const theme = useMobileTheme();
    const { width } = useWindowDimensions();
    const layout = mobileLayoutMode(width);
    const [phoneDetail, setPhoneDetail] = useState(false);
    const [now, setNow] = useState(0);
    const {
        beginListInteraction,
        entries,
        error,
        finishListInteraction,
        hasLoaded,
        isLoading,
        refresh,
        sections,
        selected,
        selectedId,
        selectSession,
    } = useSessionPolling();

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
        if (layout !== 'phone' || !phoneDetail) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setPhoneDetail(false);
            return true;
        });
        return () => subscription.remove();
    }, [layout, phoneDetail]);

    const isFresh = isConnectionFresh(status, lastSeenAt, now);
    const isStale = paired && !isFresh;

    const detailVisible = selected !== null && (layout === 'tablet-split' || phoneDetail);
    const preview = useTerminalPreview({
        terminalId: selected?.primaryAgentTerminalId ?? null,
        visible: detailVisible,
    });
    useSessionAttention({
        enabled: isFresh && detailVisible,
        onRefresh: refresh,
        session: selected,
    });

    const openSession = useCallback(
        (sessionId: string): void => {
            selectSession(sessionId);
            setPhoneDetail(true);
        },
        [selectSession],
    );
    const retrySessions = useCallback(async (): Promise<void> => {
        await refresh();
    }, [refresh]);

    const renderSessionEntry = useCallback(
        ({ item }: ListRenderItemInfo<SessionListEntry>) =>
            item.type === 'header' ? (
                <SessionGroupHeader label={item.label} theme={theme} />
            ) : (
                <SessionRow
                    onPress={openSession}
                    selected={item.session.id === selectedId && layout === 'tablet-split'}
                    session={item.session}
                    theme={theme}
                />
            ),
        [layout, openSession, selectedId, theme],
    );

    if (!paired && status !== 'booting') return <Redirect href="/" />;

    const list = (
        <View
            style={[
                styles.listPane,
                layout === 'tablet-split' ? styles.tabletListPane : styles.phoneListPane,
                { backgroundColor: theme.background },
            ]}
            testID="session-list"
        >
            <View style={[styles.listHeader, { borderColor: theme.border }]}>
                <View>
                    <Text
                        accessibilityRole="header"
                        style={[styles.listTitle, { color: theme.text }]}
                    >
                        Sessions
                    </Text>
                    <Text style={[styles.listSubtitle, { color: theme.muted }]}>
                        Your paired Projects
                    </Text>
                </View>
                <Pressable
                    accessibilityHint="Removes this device credential and returns to pairing."
                    accessibilityRole="button"
                    onPress={forgetDevice}
                    style={styles.forgetButton}
                    testID="forget-device-button"
                >
                    <Text style={[styles.forgetLabel, { color: theme.muted }]}>Forget</Text>
                </Pressable>
            </View>
            {hasLoaded && error ? (
                <View
                    accessibilityLiveRegion="polite"
                    style={[
                        styles.errorBanner,
                        { backgroundColor: theme.surface, borderColor: theme.border },
                    ]}
                >
                    <Text
                        accessibilityRole="alert"
                        style={[styles.errorBannerText, { color: theme.text }]}
                    >
                        {error} Showing the last known state.
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: isLoading }}
                        disabled={isLoading}
                        onPress={retrySessions}
                        style={[styles.retryButton, { opacity: isLoading ? 0.5 : 1 }]}
                        testID="session-list-retry"
                    >
                        <Text style={[styles.retryLabel, { color: theme.primary }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : null}
            {sections.truncated ? (
                <View style={[styles.limitBanner, { borderColor: theme.border }]}>
                    <Text style={[styles.limitBannerText, { color: theme.muted }]}>
                        Showing {allMobileSessions(sections).length} of {sections.total} prioritized
                        Sessions
                    </Text>
                </View>
            ) : null}
            {!hasLoaded ? (
                <View
                    style={styles.empty}
                    testID={error ? 'session-list-error' : 'session-list-loading'}
                >
                    {error ? (
                        <>
                            <Text
                                accessibilityRole="alert"
                                style={[styles.emptyTitle, { color: theme.text }]}
                            >
                                Unable to load Sessions
                            </Text>
                            <Text style={[styles.emptyBody, { color: theme.muted }]}>
                                Check the Mac connection, then try again.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityState={{ disabled: isLoading }}
                                disabled={isLoading}
                                onPress={retrySessions}
                                style={styles.retryButton}
                                testID="session-list-initial-retry"
                            >
                                <Text style={[styles.retryLabel, { color: theme.primary }]}>
                                    Retry
                                </Text>
                            </Pressable>
                        </>
                    ) : (
                        <>
                            <ActivityIndicator color={theme.primary} size="small" />
                            <Text style={[styles.emptyBody, { color: theme.muted }]}>
                                Loading Sessions…
                            </Text>
                        </>
                    )}
                </View>
            ) : entries.length === 0 ? (
                <View style={styles.empty} testID="session-list-empty">
                    <Text style={[styles.emptyTitle, { color: theme.text }]}>
                        No active Sessions
                    </Text>
                    <Text style={[styles.emptyBody, { color: theme.muted }]}>
                        Start an Agent Session on your Mac, then it will appear here.
                    </Text>
                </View>
            ) : (
                <View
                    style={styles.list}
                    onTouchCancel={finishListInteraction}
                    onTouchEnd={finishListInteraction}
                    onTouchStart={beginListInteraction}
                >
                    <FlashList
                        data={entries}
                        getItemType={sessionEntryType}
                        keyExtractor={sessionEntryKey}
                        renderItem={renderSessionEntry}
                    />
                </View>
            )}
        </View>
    );

    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
        >
            {isStale ? <ConnectionBanner theme={theme} /> : null}
            {layout === 'phone' ? (
                detailVisible ? (
                    <SessionDetail
                        key={mobileSessionDraftKey(selected)}
                        isConnected={isFresh}
                        onBack={() => setPhoneDetail(false)}
                        onRefresh={refresh}
                        previewState={preview}
                        session={selected}
                        theme={theme}
                    />
                ) : (
                    list
                )
            ) : (
                <View style={styles.split}>
                    {list}
                    <View style={[styles.splitDivider, { backgroundColor: theme.border }]} />
                    {selected ? (
                        <SessionDetail
                            key={mobileSessionDraftKey(selected)}
                            isConnected={isFresh}
                            onRefresh={refresh}
                            previewState={preview}
                            session={selected}
                            theme={theme}
                        />
                    ) : (
                        <View style={styles.detailEmpty}>
                            <Text style={[styles.emptyBody, { color: theme.muted }]}>
                                Select a Session
                            </Text>
                        </View>
                    )}
                </View>
            )}
        </SafeAreaView>
    );
};
