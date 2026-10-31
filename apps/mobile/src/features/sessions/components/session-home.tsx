import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { AttentionCards } from '../../conversation/attention-cards';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useProjectReorder } from '../hooks/use-project-reorder';
import { useSessionManagement } from '../hooks/use-session-management';
import type { SwipeRow } from '../open-swipe-row';
import { createOpenSwipeRow } from '../open-swipe-row';
import { activeProjectFilter, filterSessionEntries } from '../project-filter';
import {
    sessionListAttentionSource,
    shouldListFallbackToTerminal,
} from '../session-list-attention';
import type { SessionListRow } from '../session-list-groups';
import { sessionListRows } from '../session-list-groups';
import { createSessionListInteraction } from '../session-list-interaction';
import type { MobileSessionItem } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionActionsSheet } from './session-actions-sheet';
import { SessionChatRequests } from './session-chat-requests';
import { SessionGroupHeader, SessionGroupReveal } from './session-group-header';
import { SessionHomeEmpty } from './session-home-empty';
import { SessionHomeHeader } from './session-home-header';
import { SessionRow } from './session-row';
import { SessionSwipeRow } from './session-swipe-row';

const styles = StyleSheet.create({
    list: { flex: 1 },
    pane: { minWidth: 0 },
    phonePane: { flex: 1 },
    tabletPane: { flexGrow: 0, flexShrink: 0, width: 320 },
    newButton: {
        alignItems: 'center',
        borderRadius: mobileRadius.lg,
        bottom: mobileSpace.xl,
        height: 58,
        justifyContent: 'center',
        position: 'absolute',
        right: mobileSpace.lg,
        width: 58,
    },
    tabletNewButton: {
        alignItems: 'center',
        borderTopWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        justifyContent: 'center',
        minHeight: 56,
    },
    tabletNewText: mobileType.bodyStrong,
});

const entryKey = (entry: SessionListRow): string => entry.id;
const entryType = (entry: SessionListRow): SessionListRow['type'] => entry.type;

// react-doctor-disable-next-line react-doctor/no-giant-component -- already this size before the connection-notice prop; splitting the Session list screen is its own refactor.
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
    const { t } = useTranslation();
    const router = useRouter();
    const {
        hostId,
        listGroups,
        listScrollOffsetRef,
        revealListGroup,
        sessions,
        setProjectId,
        setSegment,
        toggleListGroup,
        ui,
    } = useHostSessions();
    const listReference = useRef<FlashListRef<SessionListRow>>(null);
    const management = useSessionManagement();
    const [actionSession, setActionSession] = useState<MobileSessionItem | null>(null);
    const { archive, clearError } = management;
    const archiveError = management.error;
    /**
     * The actions sheet reports its own failures; a swipe archive has no sheet to show one in, so it uses the toast.
     */
    useEffect(() => {
        if (actionSession !== null || !archiveError) return;
        showToast('error', archiveError);
        clearError();
    }, [actionSession, archiveError, clearError]);
    const [swipe] = useState(createOpenSwipeRow);
    const { closeOpen: closeOpenSwipe, hasOpen: hasOpenSwipe } = swipe;
    const handleSwipeOpen = useCallback(
        (row: SwipeRow): void => {
            clearError();
            swipe.handleOpen(row);
        },
        [clearError, swipe],
    );
    /**
     * Like a chat list, the first tap after revealing a row's action dismisses it instead of opening a Session.
     */
    const openSession = useCallback(
        (sessionId: string): void => {
            if (hasOpenSwipe()) closeOpenSwipe();
            else onOpenSession(sessionId);
        },
        [closeOpenSwipe, hasOpenSwipe, onOpenSession],
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
        savedAt,
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
    const projectOrder = useProjectReorder(projects);
    const { move: moveProject } = projectOrder;
    const activeProjectId = activeProjectFilter(ui.projectId, projects);
    const filtered = useMemo(
        () =>
            sessionListRows(
                filterSessionEntries(entries, activeProjectId),
                listGroups,
                layout === 'phone' ? undefined : (selectedId ?? undefined),
            ),
        [activeProjectId, entries, layout, listGroups, selectedId],
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
        ({ item }: ListRenderItemInfo<SessionListRow>) =>
            item.type === 'header' ? (
                <SessionGroupHeader
                    count={item.count}
                    group={item.group}
                    isCollapsed={item.isCollapsed}
                    label={item.label}
                    onToggle={toggleListGroup}
                    theme={theme}
                />
            ) : item.type === 'reveal' ? (
                <SessionGroupReveal
                    count={item.nextRevealCount}
                    group={item.group}
                    onReveal={revealListGroup}
                    theme={theme}
                    windowCount={item.windowCount}
                />
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
                        onArchive={archive}
                        onClose={swipe.handleClose}
                        onOpen={handleSwipeOpen}
                        onOpenStart={swipe.handleDragStart}
                        sessionId={item.session.id}
                        theme={theme}
                    >
                        <SessionRow
                            now={now}
                            onLongPress={deviceRole === 'control' ? openActions : undefined}
                            onPress={openSession}
                            savedAt={savedAt}
                            selected={item.session.id === selectedId && layout !== 'phone'}
                            session={item.session}
                            showProject={activeProjectId === null}
                            theme={theme}
                        />
                    </SessionSwipeRow>
                    {/* A pinned waiting Session is listed again under Waiting; its cards show there, once. */}
                    {item.session.agentActivityState === 'waiting' && item.group !== 'pinned' ? (
                        sessionListAttentionSource(item.session) === 'chat' &&
                        item.session.primaryTerminal ? (
                            <SessionChatRequests
                                role={deviceRole}
                                terminal={item.session.primaryTerminal}
                                theme={theme}
                            />
                        ) : (
                            <AttentionCards
                                fallbackToTerminal={shouldListFallbackToTerminal(item.session)}
                                onOpenTerminal={() => openTerminal(item.session.id)}
                                role={deviceRole}
                                sessionId={item.session.id}
                                theme={theme}
                            />
                        )
                    ) : null}
                </View>
            ),
        [
            activeProjectId,
            archive,
            deviceRole,
            handleSwipeOpen,
            layout,
            management.pending,
            now,
            openActions,
            openSession,
            openTerminal,
            revealListGroup,
            savedAt,
            selectedId,
            swipe.handleClose,
            swipe.handleDragStart,
            theme,
            toggleListGroup,
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
                onMoveProject={deviceRole === 'control' ? moveProject : undefined}
                onOpenArchived={() => router.navigate(`/h/${encodeURIComponent(hostId)}/archived`)}
                onOpenInbox={
                    deviceRole === 'control'
                        ? () => router.navigate(`/h/${encodeURIComponent(hostId)}/inbox`)
                        : undefined
                }
                onOpenSearch={() => router.navigate(`/h/${encodeURIComponent(hostId)}/search`)}
                onOpenSettings={() => router.navigate(`/h/${encodeURIComponent(hostId)}/settings`)}
                onOpenStatus={
                    deviceRole === 'control'
                        ? () => router.navigate(`/h/${encodeURIComponent(hostId)}/status`)
                        : undefined
                }
                onOpenUsage={() => router.navigate(`/h/${encodeURIComponent(hostId)}/usage`)}
                projects={projectOrder.projects}
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
                accessibilityHint={t('sessions.home.newSessionHint')}
                accessibilityLabel={t('sessions.new.title')}
                accessibilityRole="button"
                onPress={onNewSession}
                style={
                    layout === 'phone'
                        ? [
                              styles.newButton,
                              {
                                  backgroundColor: theme.primary,
                                  boxShadow: `0px 4px 12px ${theme.shadow}`,
                              },
                          ]
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
                        {t('sessions.new.title')}
                    </Text>
                )}
            </Pressable>
            <SessionActionsSheet
                management={management}
                onClose={() => setActionSession(null)}
                onOpenSession={onOpenSession}
                session={actionSession}
                theme={theme}
            />
        </View>
    );
};
