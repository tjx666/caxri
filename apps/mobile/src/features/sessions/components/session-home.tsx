import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';

import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { AttentionCards } from '../../conversation/attention-cards';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useProjectReorder } from '../hooks/use-project-reorder';
import { useRowMarkDone } from '../hooks/use-row-mark-done';
import { useSessionManagement } from '../hooks/use-session-management';
import { activeProjectFilter, filterSessionEntries, projectPagerWindow } from '../project-filter';
import {
    sessionListAttentionSource,
    shouldListFallbackToTerminal,
} from '../session-list-attention';
import type { SessionListRow } from '../session-list-groups';
import { sessionListRows } from '../session-list-groups';
import { createSessionListInteraction } from '../session-list-interaction';
import type { MobileSessionItem } from '../session-model';
import { canMarkDoneFromRow } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionActionsSheet } from './session-actions-sheet';
import { SessionChatRequests } from './session-chat-requests';
import { SessionGroupHeader, SessionGroupReveal } from './session-group-header';
import { SessionHomeEmpty } from './session-home-empty';
import { SessionHomeHeader } from './session-home-header';
import { SessionListPage } from './session-list-page';
import { SessionProjectPager } from './session-project-pager';
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
    newButton: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
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
        refresh,
        savedAt,
        selectedId,
    } = sessions;
    const { markDone: markRowDone, pendingIds: markingDoneIds } = useRowMarkDone({
        onRefresh: refresh,
    });
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
    /**
     * The pager's pages in chip order: All, then each Project.
     */
    const pageIds = useMemo(
        () => [null, ...projectOrder.projects.map(({ id }) => id)],
        [projectOrder.projects],
    );
    const activeIndex = Math.max(0, pageIds.indexOf(activeProjectId));
    /**
     * The pager's place in pages, shared with the Project filters so their highlight follows a swipe.
     */
    const pageProgress = useSharedValue(activeIndex);
    /**
     * Rows for the current page and its mounted neighbors, so a swipe draws the next Project's real list.
     */
    const pageRows = useMemo(() => {
        const rows = new Map<number, SessionListRow[]>();
        for (const index of projectPagerWindow(activeIndex, pageIds.length))
            rows.set(
                index,
                sessionListRows(
                    filterSessionEntries(entries, pageIds[index] ?? null),
                    listGroups,
                    layout === 'phone' ? undefined : (selectedId ?? undefined),
                ),
            );
        return rows;
    }, [activeIndex, entries, layout, listGroups, pageIds, selectedId]);
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
    /**
     * Every Project page other than the current one rests at the top, so a newly chosen Project starts there and the
     * remembered offset starts over with it.
     */
    const chooseProject = useCallback(
        (projectId: string | null): void => {
            listScrollOffsetRef.current = 0;
            setProjectId(projectId);
        },
        [listScrollOffsetRef, setProjectId],
    );
    const settlePage = useCallback(
        (index: number): void => chooseProject(pageIds[index] ?? null),
        [chooseProject, pageIds],
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
                        isMarkingDone={markingDoneIds.has(item.session.id)}
                        now={now}
                        onLongPress={deviceRole === 'control' ? openActions : undefined}
                        onMarkDone={
                            canMarkDoneFromRow(item.session, deviceRole, savedAt !== null)
                                ? markRowDone
                                : undefined
                        }
                        onPress={onOpenSession}
                        savedAt={savedAt}
                        selected={item.session.id === selectedId && layout !== 'phone'}
                        session={item.session}
                        showProject={shouldShowProject}
                        theme={theme}
                    />
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
            deviceRole,
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
    const renderPage = (index: number) => {
        const projectId = pageIds[index] ?? null;
        const rows = pageRows.get(index) ?? [];
        return (
            <SessionListPage
                empty={
                    !hasLoaded || rows.length === 0 ? (
                        <SessionHomeEmpty
                            activeProjectId={projectId}
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
                isActive={index === activeIndex}
                activeListRef={listReference}
                bottomInset={layout === 'phone' ? PHONE_NEW_BUTTON_CLEARANCE : 0}
                onLoad={restoreScroll}
                onScroll={rememberScroll}
                renderEntry={projectId === null ? renderAllEntry : renderProjectEntry}
                rows={rows}
            />
        );
    };
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
                pageProgress={pageProgress}
                projects={projectOrder.projects}
                theme={theme}
            />
            <SessionProjectPager
                activeIndex={activeIndex}
                onSettle={settlePage}
                pageCount={pageIds.length}
                pageKey={(index) => `project:${pageIds[index] ?? 'all'}`}
                progress={pageProgress}
                renderPage={renderPage}
            />
            <Pressable
                accessibilityHint={t('sessions.home.newSessionHint')}
                accessibilityLabel={t('sessions.new.title')}
                accessibilityRole="button"
                android_ripple={layout === 'phone' ? { color: theme.primaryRipple } : undefined}
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
