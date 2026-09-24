import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';

import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import type { SessionListEntry } from '../hooks/use-session-polling';
import { activeProjectFilter, filterSessionEntries } from '../project-filter';
import { createSessionListInteraction } from '../session-list-interaction';
import { useHostSessions } from './host-sessions-provider';
import { SessionHomeHeader } from './session-home-header';
import { SessionHomeEmpty, SessionHomeStatus } from './session-home-status';
import { SessionRow } from './session-row';

const styles = StyleSheet.create({
    list: { flex: 1 },
    pane: { minWidth: 0 },
    phonePane: { flex: 1 },
    tabletPane: { flexGrow: 0, flexShrink: 0, width: 320 },
    groupHeader: {
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 0.8,
        paddingBottom: 7,
        paddingHorizontal: 16,
        paddingTop: 18,
    },
    newButton: {
        alignItems: 'center',
        borderRadius: 28,
        bottom: 16,
        height: 56,
        justifyContent: 'center',
        position: 'absolute',
        right: 16,
        width: 56,
    },
    newText: { fontSize: 30, lineHeight: 34 },
});

const entryKey = (entry: SessionListEntry): string => entry.id;
const entryType = (entry: SessionListEntry): SessionListEntry['type'] => entry.type;

export const SessionHome = ({
    layout,
    now,
    onNewSession,
    onOpenSession,
    theme,
}: {
    layout: MobileLayoutMode;
    now: number;
    onNewSession: () => void;
    onOpenSession: (sessionId: string) => void;
    theme: MobileTheme;
}) => {
    const { forgetDevice, status } = useMobileClient();
    const { listScrollOffsetRef, sessions, setProjectId, ui } = useHostSessions();
    const listReference = useRef<FlashListRef<SessionListEntry>>(null);
    const hasRestoredScroll = useRef(false);
    const {
        beginListInteraction,
        entries,
        error,
        finishListInteraction,
        hasLoaded,
        hostDisplayName,
        isLoading,
        projects,
        refresh,
        sections,
        selectedId,
    } = sessions;
    const beginInteractionReference = useRef(beginListInteraction);
    const finishInteractionReference = useRef(finishListInteraction);
    const listInteractionReference = useRef<ReturnType<typeof createSessionListInteraction> | null>(
        null,
    );
    useEffect(() => {
        beginInteractionReference.current = beginListInteraction;
        finishInteractionReference.current = finishListInteraction;
    }, [beginListInteraction, finishListInteraction]);
    useEffect(() => {
        const interaction = createSessionListInteraction(
            () => beginInteractionReference.current(),
            () => finishInteractionReference.current(),
        );
        listInteractionReference.current = interaction;
        return () => {
            interaction.dispose();
            listInteractionReference.current = null;
        };
    }, []);
    const activeProjectId = activeProjectFilter(ui.projectId, projects);
    const filtered = useMemo(
        () => filterSessionEntries(entries, activeProjectId),
        [activeProjectId, entries],
    );
    const restoreScroll = useCallback((): void => {
        listReference.current?.scrollToOffset({
            animated: false,
            offset: listScrollOffsetRef.current,
        });
        hasRestoredScroll.current = true;
    }, [listScrollOffsetRef]);
    const rememberScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
            if (hasRestoredScroll.current)
                listScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
            listInteractionReference.current?.scroll();
        },
        [listScrollOffsetRef],
    );
    const chooseProject = useCallback(
        (projectId: string | null): void => {
            setProjectId(projectId);
            listReference.current?.scrollToOffset({ animated: false, offset: 0 });
        },
        [setProjectId],
    );
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<SessionListEntry>) =>
            item.type === 'header' ? (
                <Text style={[styles.groupHeader, { color: theme.muted }]}>{item.label}</Text>
            ) : (
                <SessionRow
                    now={now}
                    onPress={onOpenSession}
                    selected={item.session.id === selectedId && layout !== 'phone'}
                    session={item.session}
                    theme={theme}
                />
            ),
        [layout, now, onOpenSession, selectedId, theme],
    );
    return (
        <View
            style={[
                styles.pane,
                layout === 'phone' ? styles.phonePane : styles.tabletPane,
                { backgroundColor: theme.background },
            ]}
            testID="session-list"
        >
            <SessionHomeHeader
                activeProjectId={activeProjectId}
                forgetDevice={forgetDevice}
                hostDisplayName={hostDisplayName}
                onChooseProject={chooseProject}
                projects={projects}
                status={status}
                theme={theme}
            />
            <SessionHomeStatus
                error={error}
                hasLoaded={hasLoaded}
                isLoading={isLoading}
                onRetry={refresh}
                sections={sections}
                theme={theme}
            />
            {!hasLoaded || filtered.length === 0 ? (
                <SessionHomeEmpty
                    activeProjectId={activeProjectId}
                    error={error}
                    hasLoaded={hasLoaded}
                    isLoading={isLoading}
                    onNewSession={onNewSession}
                    onRetry={refresh}
                    status={status}
                    theme={theme}
                />
            ) : (
                <View
                    style={styles.list}
                    onTouchCancel={() => listInteractionReference.current?.touchCancel()}
                    onTouchEnd={() => listInteractionReference.current?.touchEnd()}
                    onTouchStart={() => listInteractionReference.current?.touchStart()}
                >
                    <FlashList
                        data={filtered}
                        getItemType={entryType}
                        keyExtractor={entryKey}
                        onMomentumScrollBegin={() =>
                            listInteractionReference.current?.momentumStart()
                        }
                        onMomentumScrollEnd={() => listInteractionReference.current?.momentumEnd()}
                        onLoad={restoreScroll}
                        onScroll={rememberScroll}
                        onScrollBeginDrag={() => listInteractionReference.current?.dragStart()}
                        onScrollEndDrag={() => listInteractionReference.current?.dragEnd()}
                        ref={listReference}
                        renderItem={renderEntry}
                    />
                </View>
            )}
            <Pressable
                accessibilityHint="Opens the New Session screen."
                accessibilityLabel="New Session"
                accessibilityRole="button"
                onPress={onNewSession}
                style={[styles.newButton, { backgroundColor: theme.primary }]}
                testID="new-session-button"
            >
                <Text style={[styles.newText, { color: theme.primaryForeground }]}>+</Text>
            </Pressable>
        </View>
    );
};
