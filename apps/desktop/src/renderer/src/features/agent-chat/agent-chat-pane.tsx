import type { ComponentProps } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useTerminal } from '../../stores/selectors';
import { dismissReturn } from '../session/session-look-boundary';
import { useTerminalLinkPicker } from '../terminal/hooks/use-terminal-link-picker';
import { TerminalLinkPicker } from '../terminal/terminal-link-picker';
import {
    canSwitchTerminalSurface,
    switchTerminalSurfaceTo,
} from '../terminal/terminal-surface-commands';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { agentChatReadFollowOptions } from './agent-chat-cache-retention';
import { recoverAgentChat } from './agent-chat-commands';
import { AgentChatDock } from './agent-chat-dock';
import { AgentChatEmptyState } from './agent-chat-empty-state';
import type { AgentChatHost } from './agent-chat-host';
import { agentChatHostCapabilities } from './agent-chat-host';
import { AgentChatComposer } from './composer/agent-chat-composer';
import type { AgentChatComposerInput } from './composer/agent-chat-composer-view';
import { useAgentChatComposerSnapshot } from './composer-snapshot/use-agent-chat-composer-snapshot';
import { AgentChatFindScope } from './find/agent-chat-find-scope';
import { useAgentChatActivationFocus } from './hooks/use-agent-chat-activation-focus';
import { AgentChatEditContext, useAgentChatEditActions } from './hooks/use-agent-chat-edit';
import type { AgentChatExpansion } from './hooks/use-agent-chat-expansion';
import { AgentChatExpansionContext } from './hooks/use-agent-chat-expansion';
import type { AgentChatDropHandlers } from './hooks/use-agent-chat-file-input';
import { useAgentChatHistory } from './hooks/use-agent-chat-history';
import {
    AgentChatMcpServersContext,
    useAgentChatMcpServers,
} from './hooks/use-agent-chat-mcp-server';
import { useAgentChatOpenFile } from './hooks/use-agent-chat-open-file';
import { useAgentChatPaneEscape } from './hooks/use-agent-chat-pane-escape';
import { useAgentChatPending } from './hooks/use-agent-chat-pending';
import { AgentChatReadBackHistoryContext } from './hooks/use-agent-chat-read-back-history';
import { useAgentChatReturnHint } from './hooks/use-agent-chat-return-hint';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';
import { useAgentChatSkillHost } from './hooks/use-agent-chat-skill-host';
import { AgentChatSkillsContext } from './hooks/use-agent-chat-skills';
import { AgentChatTaskLinksContext, useAgentChatTaskLinks } from './hooks/use-agent-chat-task-link';
import { AgentChatTerminalContext } from './hooks/use-agent-chat-terminal';
import { useAgentChatTimelines } from './hooks/use-agent-chat-timelines';
import { useLoadingStyle } from './loading';
import { AgentChatDayBreak } from './messages/agent-chat-message-time';
import {
    AGENT_CHAT_REPLY_NAVIGATION_SHORTCUTS,
    onAgentChatTranscriptKeyDown,
} from './messages/agent-chat-reply-navigation';
import { AgentChatReplyPlaceholder } from './messages/agent-chat-reply-placeholder';
import { AgentChatSelectionToolbar } from './messages/agent-chat-selection-toolbar';
import { AGENT_CHAT_PANE_ATTRIBUTE } from './permissions/agent-chat-approval-commands';
import { AgentChatMessageRail } from './rail/agent-chat-message-rail';
import {
    AGENT_CHAT_USER_MESSAGE_ATTRIBUTE,
    isAgentChatMessageRailShown,
} from './rail/agent-chat-rail-marks';
import { useAgentChatMessageRail } from './rail/hooks/use-agent-chat-message-rail';
import { AgentChatExpansionState } from './transcript/agent-chat-expansion';
import { AgentChatHistoryHead } from './transcript/agent-chat-history-head';
import { AgentChatJumpToLatest } from './transcript/agent-chat-jump-to-latest';
import { AgentChatPendingTimeline } from './transcript/agent-chat-pending-timeline';
import {
    agentChatEmptyHint,
    agentChatEmptyMessage,
    agentChatRecoveryNotice,
    isAgentChatBusy,
    isAgentChatConversationLoading,
} from './transcript/agent-chat-presentation';
import { AgentChatReturnHint } from './transcript/agent-chat-return-hint';
import { AgentChatSettledTimeline } from './transcript/agent-chat-settled-timeline';
import type { AgentChatTimelineEntry } from './transcript/agent-chat-timeline';
import {
    agentChatTimelineEntryKey,
    isAgentChatAwaitingReplyInTimeline,
} from './transcript/agent-chat-timeline';
import { AgentChatTimelineEntryView } from './transcript/agent-chat-timeline-entry-view';
import { AgentChatTurnAnnouncer } from './turns/agent-chat-turn-announcer';
import { markAgentChatOnScreen } from './waiting/agent-chat-on-screen';

/**
 * The rows a sent message rises to the top with: each user message starts a turn, including one still being sent
 * (`data-agent-chat-pending`), so the message rises as it is sent rather than when the provider confirms it.
 */
const AGENT_CHAT_TURN_SELECTOR = `[${AGENT_CHAT_USER_MESSAGE_ATTRIBUTE}], [data-agent-chat-pending]`;

/**
 * The recovery banner's Open as Terminal, offered only when this Terminal can switch surfaces.
 */
function openAsTerminalAction(terminal: ReturnType<typeof useTerminal>): (() => void) | undefined {
    if (!terminal || !canSwitchTerminalSurface(terminal)) return undefined;
    return () => {
        void switchTerminalSurfaceTo(terminal, 'pty');
    };
}

/**
 * Follows a sent message to the bottom. Sending also moves the conversation on from what the user missed, so the return
 * hint about it has done its job.
 */
function sentAction(
    terminal: ReturnType<typeof useTerminal>,
    jumpToLatest: () => void,
): () => void {
    return () => {
        jumpToLatest();
        if (terminal) dismissReturn(terminal.sessionId);
    };
}

interface AgentChatPaneProperties {
    ariaLabel: string;
    /**
     * The window mounting the Chat; its `agentChatHostCapabilities` gate "Fork from here" and "Use as Project default".
     */
    host: AgentChatHost;
    /**
     * Whether the Session holding the Chat is on screen. A kept-alive Session behind the visible one stops following
     * its Chat's stream: re-rendering every streamed patch and every paced-text frame of a transcript nobody can see
     * cost as much React work as the visible Chat (measured in `docs/renderer-performance.md`). The cache stays current
     * through `agentChat.patch`, so showing the Session again renders the latest snapshot once.
     */
    isSessionVisible: boolean;
    /**
     * Whether the Chat is on screen in the active pane, so mounting it is the user activating it.
     */
    isShown: boolean;
    /**
     * The provider catalog's display name, for copy that names the Agent.
     */
    providerName: string;
    /**
     * The provider catalog's `capabilities.chatImages`.
     */
    supportsImages: boolean;
    /**
     * The provider catalog's `capabilities.chatRewindFiles`: whether "Edit from here" can also revert files.
     */
    supportsRewindFiles: boolean;
    terminalId: string;
}

/**
 * The structured surface of a Chat Terminal (ADR 0012): the conversation Server Core projects from the provider's own
 * protocol, rendered in place of a terminal grid. The projection lives in the shared query cache and is kept current by
 * `agentChat.patch` (see `agent-chat-client.ts`), so this view only reads it. Mounted per Terminal (keyed by its id),
 * so scroll-follow state never carries from one Chat to another.
 */
export function AgentChatPane({
    ariaLabel,
    host,
    isSessionVisible,
    isShown,
    providerName,
    supportsImages,
    supportsRewindFiles,
    terminalId,
}: AgentChatPaneProperties) {
    const { t } = useTranslation();
    const query = useCaxriQuery(
        'agentChat.read',
        { terminalId },
        { staleTime: Infinity, ...agentChatReadFollowOptions(isSessionVisible) },
    );
    const snapshot = query.data;
    const projectRoot = usePaneViewSession()?.rootPath;
    const inputReference = useRef<AgentChatComposerInput | null>(null);
    const composerDrop = useRef<AgentChatDropHandlers | null>(null);
    const { canFork, canOpenBesideChat, canOpenContext, canSaveProjectDefault } =
        agentChatHostCapabilities(host);
    const { composerEdit, editActions, setEditingId } = useAgentChatEditActions(
        terminalId,
        snapshot,
        { canFork, providerName, supportsRewindFiles },
    );
    const pending = useAgentChatPending(terminalId, snapshot);
    // The waiting popup leaves out a Chat on screen here, whose own request card already asks.
    useEffect(
        () => (isSessionVisible ? markAgentChatOnScreen(terminalId) : undefined),
        [isSessionVisible, terminalId],
    );
    const {
        scrollReference,
        contentReference,
        spacerReference,
        isLatestInView,
        onScroll,
        jumpToLatest,
        stopFollowing,
        anchor,
    } = useAgentChatScroll(snapshot?.revision, {
        isTurnLive: isAgentChatBusy(snapshot) || pending.timeline.length > 0,
        latestPromptId: snapshot?.items.findLast((item) => item.type === 'userMessage')?.id,
        turnSelector: AGENT_CHAT_TURN_SELECTOR,
    });
    /**
     * Which rows the user expanded, kept for the Chat's lifetime so a row stays open when the timeline rebuilds it (a
     * finished turn folding, a live row joining a summary group). Toggling one holds it in place instead of following.
     */
    const [expansionState] = useState(() => new AgentChatExpansionState());
    const expansion = useMemo<AgentChatExpansion>(
        () => ({ state: expansionState, onUserToggle: anchor }),
        [anchor, expansionState],
    );
    const focusComposer = useCallback(() => inputReference.current?.focus(), []);
    /**
     * A cited file resolves exactly like a path printed in a Terminal: against the Projects this Chat Terminal may
     * reach, with the same candidate picker when several match.
     */
    const linkPicker = useTerminalLinkPicker(terminalId, focusComposer);
    const openFile = useAgentChatOpenFile(terminalId);
    const { statusShimmer } = useLoadingStyle();
    // Escape interrupts a running turn from anywhere in the pane; the composer handles its own (see the hook).
    const onKeyDown = useAgentChatPaneEscape({ activeTurnId: snapshot?.activeTurnId, terminalId });
    useAgentChatActivationFocus(inputReference, { isShown, terminalId });
    const history = useAgentChatHistory(terminalId, snapshot, {
        scrollReference,
        contentReference,
        stopFollowing,
    });
    const olderItems = history.history.items;
    const { settledChunks, timeline, dayBreaks, railMarks } = useAgentChatTimelines(
        snapshot,
        history.history,
    );
    const railMarkIds = useMemo(() => railMarks.map((mark) => mark.id), [railMarks]);
    const rail = useAgentChatMessageRail(scrollReference, contentReference, railMarkIds);
    const { jumpTo } = rail;
    const jumpToMessage = useCallback(
        (id: string): void => {
            stopFollowing();
            jumpTo(id);
        },
        [jumpTo, stopFollowing],
    );
    const readBackHistory = useMemo(() => ({ canFork }), [canFork]);
    const taskLinks = useAgentChatTaskLinks(snapshot?.tasks, terminalId, canOpenBesideChat);
    /**
     * Read from the Terminal record like the PTY pane does: a hand-over to another client is recorded there as
     * `detached`, while the projection only reads `stopped`.
     */
    const terminal = useTerminal(terminalId);
    const returnHint = useAgentChatReturnHint(terminal?.sessionId, snapshot, olderItems, {
        scrollReference,
        contentReference,
        isLatestInView,
    });
    const processState = terminal?.lastProcessState;
    const composerView = useAgentChatComposerSnapshot(terminalId, {
        hasConversation: Boolean(terminal?.agentSessionId),
        isSessionVisible,
        processState,
        providerName,
    });
    const openAsTerminal = openAsTerminalAction(terminal);
    const emptyMessage = agentChatEmptyMessage(snapshot, processState, providerName, t);
    const recoveryNotice = agentChatRecoveryNotice(
        snapshot,
        { isLoadError: query.isError, processState },
        providerName,
        t,
    );
    const recover = (): void => {
        /**
         * The banner, and the button that was just clicked, unmount once the Chat restarts. Handing focus to the
         * composer keeps a draft written while the Chat could not send one key away instead of dropping focus on the
         * document body.
         */
        focusComposer();
        recoverAgentChat(terminalId, recoveryNotice, query.refetch);
    };
    return (
        <section
            {...{ [AGENT_CHAT_PANE_ATTRIBUTE]: '' }}
            aria-label={ariaLabel}
            // `relative` anchors the composer's whole-Chat drop tint (see `AgentChatComposer`).
            className="relative flex h-full min-h-0 flex-col bg-background"
            // Picks the status line and running work rows' sweep (`activity-shimmer` in styles.css).
            data-agent-chat-status-shimmer={statusShimmer}
            onKeyDown={onKeyDown}
            onDragLeave={(event) => composerDrop.current?.onDragLeave(event)}
            onDragOver={(event) => composerDrop.current?.onDragOver(event)}
            onDrop={(event) => composerDrop.current?.onDrop(event)}
        >
            <div className="relative min-h-0 flex-1">
                <AgentChatFindScope
                    agentSessionId={terminal?.agentSessionId}
                    contentReference={contentReference}
                    focusComposer={focusComposer}
                    hasUnsearchedHistory={history.hasMore || history.history.truncated}
                    isLoadingEarlier={history.history.status === 'loading'}
                    loadEarlier={history.hasMore ? history.loadOlder : undefined}
                    scrollReference={scrollReference}
                    stopFollowing={stopFollowing}
                    terminalId={terminalId}
                >
                    {/* A named log, so screen readers can find the transcript, and focusable so the keyboard can scroll
                        it without a pointer. `aria-live` is off because a log is polite by default, which would read
                        every streamed token aloud; `AgentChatTurnAnnouncer` owns what is announced. */}
                    <div
                        aria-keyshortcuts={AGENT_CHAT_REPLY_NAVIGATION_SHORTCUTS}
                        aria-label={t('agentChat.timeline.transcriptLabel')}
                        aria-live="off"
                        className={cn(
                            'absolute inset-x-0 top-0 overflow-y-auto outline-none focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent',
                            // The transcript runs on under Jump to latest (DESIGN.md "Scroll edge cues"). The return
                            // hint shows only at the latest entry, so the transcript ends above it instead of covering
                            // the last line; the top stays anchored, so nothing the user is reading moves.
                            returnHint ? 'bottom-10' : 'bottom-0',
                        )}
                        ref={scrollReference}
                        role="log"
                        tabIndex={0}
                        onKeyDown={onAgentChatTranscriptKeyDown}
                        onScroll={onScroll}
                    >
                        <div
                            className={cn(
                                'mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 select-none',
                                // Clear the rail only by what the centering margin lacks (DESIGN.md "Spacing and radius").
                                isAgentChatMessageRailShown(railMarks) &&
                                    'pl-[clamp(1rem,calc(1.75rem_-_(100%_-_48rem)_/_2),1.75rem)]',
                            )}
                            ref={contentReference}
                        >
                            <AgentChatHistoryHead
                                hasFailed={history.history.status === 'failed'}
                                hasMore={history.hasMore}
                                isLoading={history.history.status === 'loading'}
                                isUnavailable={history.history.truncated}
                                loadedCount={olderItems.length}
                                providerName={providerName}
                                scrollReference={scrollReference}
                                onLoad={history.loadOlder}
                                onOpenAsTerminal={openAsTerminal}
                            />
                            {isAgentChatConversationLoading(snapshot, {
                                hasConversation: Boolean(terminal?.agentSessionId),
                                isPending: query.isPending,
                            }) && <ConversationLoading />}
                            <AgentChatExpansionContext value={expansion}>
                                <AgentChatTaskLinksContext value={taskLinks}>
                                    <AgentChatTimelineBody
                                        dayBreaks={dayBreaks}
                                        editActions={editActions}
                                        activeTurnId={snapshot?.activeTurnId}
                                        isAwaitingReply={
                                            pending.timeline.length === 0 &&
                                            isAgentChatAwaitingReplyInTimeline(snapshot, timeline)
                                        }
                                        mcpServers={snapshot?.mcpServers}
                                        pending={pending}
                                        readBackHistory={readBackHistory}
                                        settledChunks={settledChunks}
                                        terminalId={terminalId}
                                        timeline={timeline}
                                        onOpenFile={openFile}
                                    />
                                </AgentChatTaskLinksContext>
                            </AgentChatExpansionContext>
                            <AgentChatEmptyState
                                hint={
                                    processState !== 'detached' &&
                                    agentChatEmptyHint(supportsImages, t)
                                }
                                message={emptyMessage}
                            />
                        </div>
                        <div aria-hidden data-agent-chat-turn-space ref={spacerReference} />
                    </div>
                    {returnHint && terminal && (
                        <AgentChatReturnHint
                            hint={returnHint}
                            onDismiss={() => dismissReturn(terminal.sessionId)}
                            onJump={jumpToMessage}
                        />
                    )}
                    <AgentChatSelectionToolbar
                        contentReference={contentReference}
                        scrollReference={scrollReference}
                        terminalId={terminalId}
                        onQuoted={focusComposer}
                    />
                    <AgentChatMessageRail
                        activeIndex={rail.activeIndex}
                        hasEarlierHistory={history.hasMore || history.history.truncated}
                        marks={railMarks}
                        onJump={jumpToMessage}
                    />
                    <AgentChatJumpToLatest
                        focusTarget={inputReference}
                        isLatestInView={isLatestInView}
                        onJump={jumpToLatest}
                    />
                </AgentChatFindScope>
            </div>
            <AgentChatDock
                answeredRequestIds={pending.answeredRequestIds}
                projectRoot={projectRoot}
                providerName={providerName}
                recoveryNotice={recoveryNotice}
                snapshot={snapshot}
                terminalId={terminalId}
                onAnswered={focusComposer}
                onOpenAsTerminal={openAsTerminal}
                onRecover={recover}
            />
            <AgentChatTurnAnnouncer activeTurnId={snapshot?.activeTurnId} turns={snapshot?.turns} />
            <TerminalLinkPicker
                isOpen={linkPicker.isOpen}
                isTruncated={linkPicker.isTruncated}
                links={linkPicker.links}
                mode={linkPicker.mode}
                status={linkPicker.status}
                onOpenChange={linkPicker.onOpenChange}
                onSelect={linkPicker.selectLink}
            />
            <AgentChatComposer
                activeTurnId={composerView.activeTurnId}
                activity={composerView.activity}
                canOpenContext={canOpenContext}
                canSaveProjectDefault={canSaveProjectDefault}
                sendBlock={composerView.sendBlock}
                commands={composerView.commands}
                dropHandlersReference={composerDrop}
                edit={{
                    handleReference: composerEdit,
                    filesUnsupportedReason: supportsRewindFiles
                        ? undefined
                        : t('agentChat.pane.filesUnsupported', { provider: providerName }),
                    onEditingChange: setEditingId,
                }}
                inputReference={inputReference}
                isBusy={composerView.isBusy}
                isQueuePaused={composerView.isQueuePaused}
                isShown={isShown}
                providerName={providerName}
                onOpenTask={taskLinks.openTask}
                onSent={sentAction(terminal, jumpToLatest)}
                pendingQueue={composerView.pendingQueue}
                queue={composerView.queue}
                snapshot={composerView.snapshot}
                supportsImages={supportsImages}
                terminalId={terminalId}
            />
        </section>
    );
}

/**
 * Placeholder turns while the conversation is read. They are drawn at once rather than after the usual skeleton delay:
 * the header and composer are already on screen, so a blank transcript reads as an empty conversation, not a wait.
 */
function ConversationLoading() {
    const { t } = useTranslation();
    return (
        <LoadingSkeleton
            isImmediate
            label={t('agentChat.timeline.loadingConversation')}
            variant="transcript"
        />
    );
}

/**
 * The live timeline's rows, each preceded by the day break that starts its calendar day.
 */
function LiveTimelineEntries({
    dayBreaks,
    onOpenFile,
    timeline,
}: {
    dayBreaks: ReadonlyMap<string, number>;
    onOpenFile: (reference: string) => void;
    timeline: readonly AgentChatTimelineEntry[];
}) {
    return timeline.map((entry) => {
        const key = agentChatTimelineEntryKey(entry);
        const dayBreak = dayBreaks.get(key);
        return (
            <Fragment key={key}>
                {dayBreak !== undefined && <AgentChatDayBreak timestamp={dayBreak} />}
                <AgentChatTimelineEntryView entry={entry} onOpenFile={onOpenFile} />
            </Fragment>
        );
    });
}

/**
 * The Chat's settled, live, and pending timelines under the contexts their rows read.
 */
function AgentChatTimelineBody({
    activeTurnId,
    dayBreaks,
    editActions,
    isAwaitingReply,
    mcpServers,
    onOpenFile,
    pending,
    readBackHistory,
    settledChunks,
    terminalId,
    timeline,
}: {
    activeTurnId: string | undefined;
    dayBreaks: ReadonlyMap<string, number>;
    editActions: ComponentProps<typeof AgentChatEditContext>['value'];
    isAwaitingReply: boolean;
    mcpServers: AgentChatSnapshot['mcpServers'];
    onOpenFile: (reference: string) => void;
    pending: ComponentProps<typeof AgentChatPendingTimeline>['pending'];
    readBackHistory: ComponentProps<typeof AgentChatReadBackHistoryContext>['value'];
    settledChunks: ComponentProps<typeof AgentChatSettledTimeline>['chunks'];
    terminalId: string;
    timeline: readonly AgentChatTimelineEntry[];
}) {
    const servers = useAgentChatMcpServers(mcpServers);
    const skills = useAgentChatSkillHost(terminalId);
    return (
        <AgentChatMcpServersContext value={servers}>
            <AgentChatTerminalContext value={terminalId}>
                <AgentChatSkillsContext value={skills}>
                    {/*
                     * History read back is not in the projection, so it never offers Edit, Fork, or Restore; keeping it
                     * outside the actions, which change with every patch, lets a patch skip it. Its menus list Edit and
                     * Fork disabled with why.
                     */}
                    <AgentChatReadBackHistoryContext value={readBackHistory}>
                        <AgentChatSettledTimeline chunks={settledChunks} onOpenFile={onOpenFile} />
                    </AgentChatReadBackHistoryContext>
                    <AgentChatEditContext value={editActions}>
                        <LiveTimelineEntries
                            dayBreaks={dayBreaks}
                            timeline={timeline}
                            onOpenFile={onOpenFile}
                        />
                        {isAwaitingReply && <AgentChatReplyPlaceholder turnId={activeTurnId} />}
                        <AgentChatPendingTimeline pending={pending} onOpenFile={onOpenFile} />
                    </AgentChatEditContext>
                </AgentChatSkillsContext>
            </AgentChatTerminalContext>
        </AgentChatMcpServersContext>
    );
}
