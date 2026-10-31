import { useCallback, useMemo, useState } from 'react';

import { agentChatDraftWithReturnedMessage, isPinnedSession } from '@caxri/protocol';
import { useRouter } from 'expo-router';

import type { useMobileTheme } from '../../../theme/use-mobile-theme';
import type { MobileAgentChatSessionCommand } from '../../agent-chat/agent-chat-app-commands';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileLayoutMode } from '../../layout/layout-mode';
import { useOpenSession } from '../hooks/use-open-session';
import type { useSessionConversation } from '../hooks/use-session-conversation';
import { useSessionManagement } from '../hooks/use-session-management';
import type { SessionActionsMode, SessionMenuActions } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionActionsSheet } from './session-actions-sheet';
import { SessionDetail } from './session-detail';

export const SelectedSessionDetail = ({
    conversation,
    fresh,
    isDetailVisible,
    layout,
    selected,
    theme,
    wideBackgroundSegment,
}: {
    conversation: ReturnType<typeof useSessionConversation>;
    fresh: boolean;
    isDetailVisible: boolean;
    layout: MobileLayoutMode;
    selected: MobileSessionItem;
    theme: ReturnType<typeof useMobileTheme>;
    wideBackgroundSegment: 'conversation' | 'terminal';
}) => {
    const router = useRouter();
    const { request } = useMobileClient();
    const {
        consumeComposerFocus,
        focusComposerSessionId,
        hostId,
        requestComposerFocus,
        sessions,
        setDraft,
        setSegment,
        ui,
    } = useHostSessions();
    const { refresh } = sessions;
    /**
     * Pops back to the list the detail was pushed from; a detail opened without that history replaces itself instead.
     */
    const goHome = useCallback((): void => {
        router.dismissTo(`/h/${encodeURIComponent(hostId)}`);
    }, [hostId, router]);
    const markRead = useCallback(async (): Promise<void> => {
        await request('session.markRead', {
            sessionId: selected.id,
            attentionGeneration: selected.attentionGeneration,
        });
        await refresh();
    }, [refresh, request, selected]);
    const management = useSessionManagement();
    const { archive, clearError, fork, handOverToBot, resume, setPinned, takeBackFromBot } =
        management;
    const openSession = useOpenSession(layout);
    const [sheetMode, setSheetMode] = useState<SessionActionsMode | null>(null);
    const terminalId = selected.primaryTerminal?.id;
    const selectedId = selected.id;
    const createdBySessionId = selected.createdBySessionId;
    const isBusy = management.pending?.sessionId === selectedId;
    /**
     * Only a control device may fork, continue, delete, or use the Agent group, as only it sees the long-press sheet. A
     * failure the sheet shows is not repeated under the header.
     */
    const sessionActions = useMemo<SessionMenuActions | undefined>(
        () =>
            sessions.deviceRole === 'control'
                ? {
                      error: sheetMode === null ? management.error : null,
                      isBusy,
                      onAction: (action) => {
                          clearError();
                          switch (action) {
                              case 'fork': {
                                  if (!terminalId) return;
                                  void fork(selectedId, terminalId).then((sessionId) => {
                                      if (sessionId) openSession(sessionId);
                                  });
                                  return;
                              }
                              case 'goToCreator': {
                                  if (createdBySessionId) openSession(createdBySessionId);
                                  return;
                              }
                              case 'resume': {
                                  void resume(selectedId);
                                  return;
                              }
                              case 'handOver': {
                                  void handOverToBot(selectedId);
                                  return;
                              }
                              case 'takeBack': {
                                  void takeBackFromBot(selectedId);
                                  return;
                              }
                              default: {
                                  setSheetMode(action);
                              }
                          }
                      },
                  }
                : undefined,
        [
            clearError,
            createdBySessionId,
            fork,
            handOverToBot,
            isBusy,
            management.error,
            openSession,
            resume,
            selectedId,
            sessions.deviceRole,
            sheetMode,
            takeBackFromBot,
            terminalId,
        ],
    );
    /**
     * Runs the Chat's `/rename`, `/archive`, and `/pin` as the Session menu does: Rename opens the same sheet step, and
     * archiving leaves the Session on a phone, as archiving the open Session on Desktop does. A failure shows under the
     * header with the menu's own.
     */
    const runSessionCommand = (command: MobileAgentChatSessionCommand): void => {
        clearError();
        if (command === 'rename') setSheetMode('rename');
        else if (command === 'pin') void setPinned(selectedId, !isPinnedSession(selected));
        else
            void archive(selectedId).then((done) => {
                if (done && layout === 'phone') goHome();
            });
    };

    return (
        <>
            <SessionDetail
                conversationFallback={conversation.fallback}
                conversationTimeline={conversation.timeline}
                deviceRole={sessions.deviceRole}
                draft={ui.draftBySession[selected.id] ?? ''}
                focusComposer={focusComposerSessionId === selected.id}
                hasConversation={conversation.hasConversation}
                hostId={hostId}
                isConnected={fresh}
                isVisible={isDetailVisible}
                onBack={layout === 'phone' ? goHome : undefined}
                onDraftChange={(draft) => setDraft(selected.id, draft)}
                onComposerFocused={() => consumeComposerFocus(selected.id)}
                onEditQueued={(text) => {
                    // An updater, not the rendered draft: the text arrives after a round trip the user may have typed through.
                    setDraft(selected.id, (current) =>
                        agentChatDraftWithReturnedMessage(current, text),
                    );
                    requestComposerFocus(selected.id);
                }}
                onMarkRead={markRead}
                onRequestComposerFocus={() => requestComposerFocus(selected.id)}
                onRefresh={refresh}
                onSegmentChange={(next) => setSegment(selected.id, next, conversation.segment)}
                onSessionCommand={sessions.deviceRole === 'control' ? runSessionCommand : undefined}
                savedAt={sessions.savedAt}
                segment={conversation.segment}
                session={selected}
                sessionActions={sessionActions}
                theme={theme}
                wideChanges={layout === 'tablet-wide'}
                wideBackgroundSegment={wideBackgroundSegment}
            />
            {sheetMode ? (
                <SessionActionsSheet
                    management={management}
                    mode={sheetMode}
                    onClose={() => setSheetMode(null)}
                    onDeleted={goHome}
                    onOpenSession={openSession}
                    session={selected}
                    theme={theme}
                />
            ) : null}
        </>
    );
};
