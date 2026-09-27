import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { AttentionCards } from '../../conversation/attention-cards';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useOpenSwipeRow } from '../hooks/use-open-swipe-row';
import { useSessionManagement } from '../hooks/use-session-management';
import type { SessionListEntry } from '../hooks/use-session-polling';
import { activeProjectFilter, filterSessionEntries } from '../project-filter';
import { createSessionListInteraction } from '../session-list-interaction';
import type { MobileSessionItem } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionActionsSheet } from './session-actions-sheet';
import { SessionHomeHeader } from './session-home-header';
import { SessionHomeEmpty, SessionHomeStatus } from './session-home-status';
import { SessionRow } from './session-row';
import { SessionSwipeRow } from './session-swipe-row';

const styles = StyleSheet.create({
    list: { flex: 1 },
    pane: { minWidth: 0 },
    phonePane: { flex: 1 },
    tabletPane: { flexGrow: 0, flexShrink: 0, width: 320 },
    groupHeader: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.6,
        paddingBottom: 6,
        paddingHorizontal: 18,
        paddingTop: 16,
    },
    newButton: {
        alignItems: 'center',
        borderRadius: 18,
        bottom: 20,
        boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.35)',
        height: 58,
        justifyContent: 'center',
        position: 'absolute',
        right: 18,
        width: 58,
    },
    tabletNewButton: {
        alignItems: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'center',
        minHeight: 56,
    },
    tabletNewText: { fontSize: 15, fontWeight: '700' },
    listError: { fontSize: 13, paddingHorizontal: 18, paddingVertical: 8 },
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
    const { status } = useMobileClient();
    const router = useRouter();
    const { hostId, listScrollOffsetRef, sessions, setProjectId, setSegment, ui } =
        useHostSessions();
    const listReference = useRef<FlashListRef<SessionListEntry>>(null);
    const management = useSessionManagement();
    const [actionSession, setActionSession] = useState<MobileSessionItem | null>(null);
    const { archive, clearError } = management;
    const swipe = useOpenSwipeRow();
    const { closeOpen: closeOpenSwipe } = swipe;
    const handleSwipeOpen = useCallback(
        (methods: SwipeableMethods): void => {
            clearError();
            swipe.handleOpen(methods);
        },
        [clearError, swipe],
    );
    const archiveFromSwipe = useCallback(
        async (sessionId: string): Promise<boolean> => {
            const done = await archive(sessionId);
            if (done) swipe.forget();
            return done;
        },
        [archive, swipe],
    );
    /**
     * Like a chat list, the first tap after revealing a row's action dismisses it instead of opening a Session.
     */
    const openSession = useCallback(
        (sessionId: string): void => {
            if (!closeOpenSwipe()) onOpenSession(sessionId);
        },
        [closeOpenSwipe, onOpenSession],
    );
    const openActions = useCallback(
        (session: MobileSessionItem): void => {
            closeOpenSwipe();
            clearError();
            setActionSession(session);
        },
        [clearError, closeOpenSwipe],
    );
    const hasRestoredScroll = useRef(false);
    const {
        beginListInteraction,
        deviceRole,
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
    const openTerminal = useCallback(
        (sessionId: string): void => {
            setSegment(sessionId, 'terminal');
            onOpenSession(sessionId);
        },
        [onOpenSession, setSegment],
    );
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<SessionListEntry>) =>
            item.type === 'header' ? (
                <Text style={[styles.groupHeader, { color: theme.muted }]}>{item.label}</Text>
            ) : (
                <View>
                    <SessionSwipeRow
                        // FlashList recycles row views; an open swipe must not reappear on another Session.
                        key={item.session.id}
                        busy={
                            management.pending?.action === 'archive' &&
                            management.pending.sessionId === item.session.id
                        }
                        enabled={deviceRole === 'control'}
                        onArchive={archiveFromSwipe}
                        onClose={swipe.handleClose}
                        onOpen={handleSwipeOpen}
                        sessionId={item.session.id}
                        theme={theme}
                    >
                        <SessionRow
                            now={now}
                            onLongPress={deviceRole === 'control' ? openActions : undefined}
                            onPress={openSession}
                            selected={item.session.id === selectedId && layout !== 'phone'}
                            session={item.session}
                            showProject={activeProjectId === null}
                            theme={theme}
                        />
                    </SessionSwipeRow>
                    {item.session.lastActivityState === 'waiting' ? (
                        <AttentionCards
                            fallbackToTerminal={item.session.primaryTerminal?.provider !== 'claude'}
                            onOpenTerminal={() => openTerminal(item.session.id)}
                            role={deviceRole}
                            sessionId={item.session.id}
                            theme={theme}
                        />
                    ) : null}
                </View>
            ),
        [
            activeProjectId,
            archiveFromSwipe,
            deviceRole,
            handleSwipeOpen,
            layout,
            management.pending,
            now,
            openActions,
            openSession,
            openTerminal,
            selectedId,
            swipe.handleClose,
            theme,
        ],
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
                hostDisplayName={hostDisplayName}
                onAddProject={
                    deviceRole === 'control'
                        ? () => router.navigate(`/h/${encodeURIComponent(hostId)}/add-project`)
                        : undefined
                }
                onChooseProject={chooseProject}
                onOpenArchived={() => router.navigate(`/h/${encodeURIComponent(hostId)}/archived`)}
                onOpenSettings={() => router.navigate(`/h/${encodeURIComponent(hostId)}/settings`)}
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
            {/* The actions sheet reports its own failures; a swipe archive has no sheet to show one in. */}
            {actionSession === null && management.error ? (
                <Text
                    accessibilityRole="alert"
                    onPress={clearError}
                    style={[styles.listError, { color: theme.danger }]}
                    testID="session-list-archive-error"
                >
                    {management.error}
                </Text>
            ) : null}
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
                        onScrollBeginDrag={() => {
                            closeOpenSwipe();
                            listInteractionReference.current?.dragStart();
                        }}
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
                style={
                    layout === 'phone'
                        ? [styles.newButton, { backgroundColor: theme.primary }]
                        : [styles.tabletNewButton, { borderColor: theme.border }]
                }
                testID="new-session-button"
            >
                <Plus
                    color={layout === 'phone' ? theme.primaryForeground : theme.primary}
                    size={layout === 'phone' ? 28 : 20}
                    strokeWidth={2.25}
                />
                {layout === 'phone' ? null : (
                    <Text style={[styles.tabletNewText, { color: theme.primary }]}>
                        New Session
                    </Text>
                )}
            </Pressable>
            <SessionActionsSheet
                management={management}
                onClose={() => setActionSession(null)}
                session={actionSession}
                theme={theme}
            />
        </View>
    );
};
