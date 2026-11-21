import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { AttentionCards } from '../../conversation/attention-cards';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { ComputerRenameSheet } from '../../settings/computer-rename-sheet';
import { useProjectReorder } from '../hooks/use-project-reorder';
import { useRowMarkDone } from '../hooks/use-row-mark-done';
import { useSessionManagement } from '../hooks/use-session-management';
import { activeProjectFilter, filterSessionEntries } from '../project-filter';
import { projectIndexInFullOrder, visibleProjectChips } from '../project-order';
import {
    sessionListAttentionSource,
    shouldListFallbackToTerminal,
} from '../session-list-attention';
import type { SessionListRow } from '../session-list-groups';
import { sessionListRows } from '../session-list-groups';
import { createSessionListInteraction } from '../session-list-interaction';
import { sessionListMotionScope } from '../session-list-motion';
import type { MobileSessionItem } from '../session-model';
import { sessionRowSwipeActions } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { NewSessionFloatingButton } from './new-session-floating-button';
import { ProjectChooserSheet } from './project-chooser-sheet';
import { SessionActionsSheet } from './session-actions-sheet';
import { SessionAttentionSource } from './session-attention-source';
import { SessionChatRequests } from './session-chat-requests';
import { SessionGroupHeader, SessionGroupReveal } from './session-group-header';
import { SessionHomeEmpty } from './session-home-empty';
import { SessionHomeHeader } from './session-home-header';
import { SessionListPage } from './session-list-page';
import { SessionRow } from './session-row';

/**
 * The list's bottom padding on a phone: the floating New Session button (58dp) and its bottom and side margins. The
 * screen's `SafeAreaView` already keeps the whole pane above the system inset, so no extra inset is added here.
 */
const PHONE_NEW_BUTTON_CLEARANCE = 58 + mobileSpace.xl + mobileSpace.lg;

const styles = StyleSheet.create({
    pane: { minWidth: 0 },
    phonePane: { flex: 1 },
    tabletPane: { flexGrow: 0, flexShrink: 0, width: 320 },
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

/**
 * The chip strip's state: the active filter, the chips shown before More, and a drag that places a shown chip within
 * the full Project order. Kept out of {@link SessionHome} to keep its control flow flat
 * (react-doctor/no-high-complexity-react-function).
 */
const useProjectChips = <Project extends { id: string; lastActivityAt?: number }>(
    projects: Project[],
    selectedProjectId: string | null,
    now: number,
) => {
    const projectOrder = useProjectReorder(projects);
    const { move: moveProject } = projectOrder;
    const activeProjectId = activeProjectFilter(selectedProjectId, projects);
    const chips = useMemo(
        () => visibleProjectChips(projectOrder.projects, activeProjectId, now),
        [activeProjectId, now, projectOrder.projects],
    );
    /**
     * A drag places the chip among the shown chips; the Server order also holds the Projects More hides.
     */
    const moveShownProject = useCallback(
        (projectId: string, toIndex: number): void => {
            void moveProject(
                projectId,
                projectIndexInFullOrder(
                    projectOrder.projects.map(({ id }) => id),
                    chips.visible.map(({ id }) => id),
                    projectId,
                    toIndex,
                ),
            );
        },
        [chips.visible, moveProject, projectOrder.projects],
    );
    return { activeProjectId, chips, moveShownProject, projectOrder };
};

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/no-high-complexity-react-function -- already this size before the connection-notice prop; splitting the Session list screen (its row renderer) is its own refactor.
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
    const [isRenamingComputer, setIsRenamingComputer] = useState(false);
    const [isChoosingProject, setIsChoosingProject] = useState(false);
    const { clearError } = management;
    const openActions = useCallback(
        (session: MobileSessionItem): void => {
            clearError();
            setActionSession(session);
        },
        [clearError],
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
        readProjectId,
        refresh,
        savedAt,
        sections,
        selectedId,
    } = sessions;
    const { markDone: markRowDone, pendingIds: markingDoneIds } = useRowMarkDone({
        onRefresh: refresh,
    });
    const { archive: archiveSession, pending: managementPending } = management;
    /**
     * A swipe has no sheet to show a failure in, so it shows as a toast; a success shows the usual Undo toast.
     */
    const archiveRow = useCallback(
        (session: MobileSessionItem): void => {
            void archiveSession(session.id, {
                onError: (message) => showToast('error', message),
            });
        },
        [archiveSession],
    );
    const archivingId =
        managementPending?.action === 'archive' ? managementPending.sessionId : null;
    /**
     * The row whose swipe actions are open. Opening another row or scrolling the list closes it, so at most one row
     * shows its actions and a recycled list cell never carries an open row onto another Session.
     */
    const openRowReference = useRef<SwipeableMethods | null>(null);
    const handleSwipeOpen = useCallback((row: SwipeableMethods): void => {
        if (openRowReference.current !== row) openRowReference.current?.close();
        openRowReference.current = row;
    }, []);
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
    const { activeProjectId, chips, moveShownProject, projectOrder } = useProjectChips(
        projects,
        ui.projectId,
        now,
    );
    /**
     * The Server already filtered a read for this Project; a saved copy or the previous Project's rows shown until the
     * new read answers are narrowed here, and only a read for this filter knows how many rows each group has left.
     */
    const rows = useMemo(
        () =>
            sessionListRows(
                filterSessionEntries(entries, activeProjectId),
                listGroups,
                layout === 'phone' ? undefined : (selectedId ?? undefined),
                readProjectId === activeProjectId ? sections.groupTotals : undefined,
            ),
        [
            activeProjectId,
            entries,
            layout,
            listGroups,
            readProjectId,
            sections.groupTotals,
            selectedId,
        ],
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
            openRowReference.current?.close();
            openRowReference.current = null;
            listInteractionReference.current?.scroll();
        },
        [listScrollOffsetRef],
    );
    /**
     * A newly chosen Project starts at the top of the list, and the remembered offset starts over with it.
     */
    const chooseProject = useCallback(
        (projectId: string | null): void => {
            listScrollOffsetRef.current = 0;
            listReference.current?.scrollToOffset({ animated: false, offset: 0 });
            setProjectId(projectId);
        },
        [listScrollOffsetRef, setProjectId],
    );
    const openTerminal = useCallback(
        (sessionId: string): void => {
            setSegment(sessionId, 'terminal');
            onOpenSession(sessionId);
        },
        [onOpenSession, setSegment],
    );
    const renderRow = useCallback(
        ({ item }: ListRenderItemInfo<SessionListRow>, shouldShowProject: boolean) =>
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
                    <SessionRow
                        isActionPending={
                            markingDoneIds.has(item.session.id) || archivingId === item.session.id
                        }
                        // A recycled list cell must not keep another Session's swipe position.
                        key={item.session.id}
                        now={now}
                        onArchive={archiveRow}
                        onLongPress={deviceRole === 'control' ? openActions : undefined}
                        onMarkDone={markRowDone}
                        onPress={onOpenSession}
                        onSwipeOpen={handleSwipeOpen}
                        savedAt={savedAt}
                        selected={item.session.id === selectedId && layout !== 'phone'}
                        session={item.session}
                        showProject={shouldShowProject}
                        swipeActions={sessionRowSwipeActions(
                            item.session,
                            deviceRole,
                            savedAt !== null,
                        )}
                        theme={theme}
                    />
                    {/* A pinned waiting Session is listed again under Waiting; its cards show there, once. */}
                    {item.session.agentActivityState === 'waiting' && item.group !== 'pinned' ? (
                        sessionListAttentionSource(item.session) === 'chat' &&
                        item.session.primaryTerminal ? (
                            <SessionChatRequests
                                source={
                                    <SessionAttentionSource
                                        onOpen={() => onOpenSession(item.session.id)}
                                        session={item.session}
                                        theme={theme}
                                    />
                                }
                                role={deviceRole}
                                terminal={item.session.primaryTerminal}
                                theme={theme}
                            />
                        ) : (
                            <AttentionCards
                                fallbackToTerminal={shouldListFallbackToTerminal(item.session)}
                                source={
                                    <SessionAttentionSource
                                        onOpen={() => onOpenSession(item.session.id)}
                                        session={item.session}
                                        theme={theme}
                                    />
                                }
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
            archiveRow,
            archivingId,
            deviceRole,
            handleSwipeOpen,
            layout,
            now,
            onOpenSession,
            openActions,
            openTerminal,
            revealListGroup,
            markRowDone,
            markingDoneIds,
            savedAt,
            selectedId,
            theme,
            toggleListGroup,
        ],
    );
    const renderAllEntry = useCallback(
        (info: ListRenderItemInfo<SessionListRow>) => renderRow(info, true),
        [renderRow],
    );
    const renderProjectEntry = useCallback(
        (info: ListRenderItemInfo<SessionListRow>) => renderRow(info, false),
        [renderRow],
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
                onMoveProject={deviceRole === 'control' ? moveShownProject : undefined}
                onOpenArchived={() => router.navigate(`/h/${encodeURIComponent(hostId)}/archived`)}
                onOpenMoreProjects={
                    chips.hiddenCount > 0 ? () => setIsChoosingProject(true) : undefined
                }
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
                onRenameComputer={
                    deviceRole === 'control' ? () => setIsRenamingComputer(true) : undefined
                }
                projects={chips.visible}
                theme={theme}
            />
            <SessionListPage
                empty={
                    !hasLoaded || rows.length === 0 ? (
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
                    ) : null
                }
                interactionRef={listInteractionReference}
                listRef={listReference}
                motionScope={sessionListMotionScope({ activeProjectId, readProjectId })}
                bottomInset={layout === 'phone' ? PHONE_NEW_BUTTON_CLEARANCE : 0}
                onLoad={restoreScroll}
                onScroll={rememberScroll}
                renderEntry={activeProjectId === null ? renderAllEntry : renderProjectEntry}
                rows={rows}
            />
            {layout === 'phone' ? (
                <NewSessionFloatingButton onPress={onNewSession} theme={theme} />
            ) : (
                <Pressable
                    accessibilityHint={t('sessions.home.newSessionHint')}
                    accessibilityLabel={t('sessions.new.title')}
                    accessibilityRole="button"
                    onPress={onNewSession}
                    style={[styles.tabletNewButton, { borderColor: theme.border }]}
                    testID="new-session-button"
                >
                    <Plus color={theme.primary} size={20} strokeWidth={2.25} />
                    <Text style={[styles.tabletNewText, { color: theme.primary }]}>
                        {t('sessions.new.title')}
                    </Text>
                </Pressable>
            )}
            <SessionActionsSheet
                management={management}
                onClose={() => setActionSession(null)}
                onOpenSession={onOpenSession}
                session={actionSession}
                theme={theme}
            />
            {isChoosingProject ? (
                <ProjectChooserSheet
                    activeProjectId={activeProjectId}
                    onChoose={chooseProject}
                    onClose={() => setIsChoosingProject(false)}
                    projects={projectOrder.projects}
                    theme={theme}
                />
            ) : null}
            {isRenamingComputer ? (
                <ComputerRenameSheet
                    currentName={hostDisplayName}
                    onClose={() => setIsRenamingComputer(false)}
                    theme={theme}
                />
            ) : null}
        </View>
    );
};
