import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useTerminal } from '../../stores/selectors';
import { useTerminalLinkPicker } from '../terminal/hooks/use-terminal-link-picker';
import {
    RESTART_AGENT_FAILED,
    restartTerminal,
    restartTerminalWithRecovery,
} from '../terminal/terminal-commands';
import { openTerminalFileTarget } from '../terminal/terminal-file-link-open';
import { parseTerminalFileLocation } from '../terminal/terminal-file-location';
import { TerminalLinkPicker } from '../terminal/terminal-link-picker';
import { registerTerminalFocusHandler } from '../terminal/terminal-pane-handlers';
import { terminalPaneHost } from '../terminal/terminal-pane-host';
import {
    canSwitchTerminalSurface,
    switchTerminalSurfaceTo,
} from '../terminal/terminal-surface-commands';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { AgentChatComposer } from './agent-chat-composer';
import { AgentChatDock } from './agent-chat-dock';
import { AgentChatExpansionState } from './agent-chat-expansion';
import { AgentChatFindScope } from './agent-chat-find-scope';
import type { AgentChatHost } from './agent-chat-host';
import { agentChatHostCapabilities } from './agent-chat-host';
import { AgentChatJumpToLatest } from './agent-chat-jump-to-latest';
import { AgentChatMessageRail } from './agent-chat-message-rail';
import { AgentChatDayBreak } from './agent-chat-message-time';
import {
    agentChatActivity,
    agentChatEmptyHint,
    agentChatEmptyMessage,
    agentChatRecoveryNotice,
    agentChatSendBlock,
    isAgentChatBusy,
} from './agent-chat-presentation';
import { agentChatRailMarks, isAgentChatMessageRailShown } from './agent-chat-rail-marks';
import { announceAgentChatSelectionCopy } from './agent-chat-selection-copy';
import { agentChatDayBreaks } from './agent-chat-time';
import { buildAgentChatTimeline } from './agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import { AgentChatTurnAnnouncer } from './agent-chat-turn-announcer';
import { useAgentChatActivationFocus } from './hooks/use-agent-chat-activation-focus';
import { AGENT_CHAT_PANE_ATTRIBUTE } from './hooks/use-agent-chat-approval-keys';
import { AgentChatEditContext, useAgentChatEditActions } from './hooks/use-agent-chat-edit';
import type { AgentChatExpansion } from './hooks/use-agent-chat-expansion';
import { AgentChatExpansionContext } from './hooks/use-agent-chat-expansion';
import type { AgentChatDropHandlers } from './hooks/use-agent-chat-file-input';
import { useAgentChatMessageRail } from './hooks/use-agent-chat-message-rail';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';
import { AgentChatTaskLinksContext, useAgentChatTaskLinks } from './hooks/use-agent-chat-task-link';
import { AgentChatTerminalContext } from './hooks/use-agent-chat-terminal';

/**
 * The structured surface of a Chat Terminal (ADR 0012): the conversation Server Core projects from the provider's own
 * protocol, rendered in place of a terminal grid. The projection lives in the shared query cache and is kept current by
 * `agentChat.patch` (see `agent-chat-client.ts`), so this view only reads it. Mounted per Terminal (keyed by its id),
 * so scroll-follow state never carries from one Chat to another.
 */
export function AgentChatPane({
    ariaLabel,
    host,
    isShown,
    providerName,
    supportsImages,
    supportsRewindFiles,
    terminalId,
}: {
    ariaLabel: string;
    /**
     * The window mounting the Chat; its `agentChatHostCapabilities` gate "Fork from here" and "Use as Project default".
     */
    host: AgentChatHost;
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
}) {
    const query = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const snapshot = query.data;
    const projectRoot = usePaneViewSession()?.rootPath;
    const inputReference = useRef<HTMLTextAreaElement | null>(null);
    const composerDrop = useRef<AgentChatDropHandlers | null>(null);
    const { canFork, canSaveProjectDefault } = agentChatHostCapabilities(host);
    const { composerEdit, editActions, setEditingId } = useAgentChatEditActions(
        terminalId,
        snapshot,
        { canFork, providerName, supportsRewindFiles },
    );
    const {
        scrollReference,
        contentReference,
        isFollowing,
        onScroll,
        jumpToLatest,
        stopFollowing,
        anchor,
    } = useAgentChatScroll(snapshot?.revision);
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
    const openFile = useCallback(
        (reference: string) => {
            const { target, location } = parseTerminalFileLocation(reference);
            // eslint-disable-next-line no-void -- the opener reports its own failures as toasts
            void openTerminalFileTarget(terminalId, target, location, {
                hasWorkbenchLinks: terminalPaneHost().hasWorkbenchLinks,
            });
        },
        [terminalId],
    );
    useEffect(
        () =>
            registerTerminalFocusHandler(
                terminalId,
                () => inputReference.current?.focus(),
                () => inputReference.current,
            ),
        [terminalId],
    );
    useAgentChatActivationFocus(inputReference, { isShown, terminalId });
    const items = snapshot?.items;
    const turns = snapshot?.turns;
    const activeTurnId = snapshot?.activeTurnId;
    const timeline = useMemo(
        () => (items && turns ? buildAgentChatTimeline(items, turns, activeTurnId) : []),
        [items, turns, activeTurnId],
    );
    const dayBreaks = useMemo(() => agentChatDayBreaks(timeline), [timeline]);
    const railMarks = useMemo(() => agentChatRailMarks(timeline), [timeline]);
    const railMarkIds = useMemo(() => railMarks.map((mark) => mark.id), [railMarks]);
    const rail = useAgentChatMessageRail(scrollReference, contentReference, railMarkIds);
    const jumpToMessage = (id: string): void => {
        stopFollowing();
        rail.jumpTo(id);
    };
    const taskLinks = useAgentChatTaskLinks(snapshot?.tasks, terminalId);
    /**
     * Read from the Terminal record like the PTY pane does: a hand-over to another client is recorded there as
     * `detached`, while the projection only reads `stopped`.
     */
    const terminal = useTerminal(terminalId);
    const processState = terminal?.lastProcessState;
    const openAsTerminal =
        terminal && canSwitchTerminalSurface(terminal)
            ? () => {
                  // eslint-disable-next-line no-void -- the switch reports its own failures as toasts
                  void switchTerminalSurfaceTo(terminal, 'pty');
              }
            : undefined;
    const emptyMessage = agentChatEmptyMessage(snapshot, processState, providerName);
    const recoveryNotice = agentChatRecoveryNotice(
        snapshot,
        { isLoadError: query.isError, processState },
        providerName,
    );
    const recover = (): void => {
        /**
         * The banner, and the button that was just clicked, unmount once the Chat restarts. Handing focus to the
         * composer keeps a draft written while the Chat could not send one key away instead of dropping focus on the
         * document body.
         */
        focusComposer();
        if (recoveryNotice?.recovery === 'restart') {
            /**
             * Only a hand-over can still have a turn running elsewhere. A failed Chat, or one whose conversation is
             * open in another client, has no turn left to stop, so its Retry restarts without the running-turn
             * confirmation.
             */
            if (recoveryNotice.kind !== 'detached')
                restartTerminalWithRecovery(terminalId, RESTART_AGENT_FAILED);
            else restartTerminal(terminalId);
        }
        // eslint-disable-next-line no-void -- the query owns the refetch result and error state
        else void query.refetch();
    };
    return (
        <section
            {...{ [AGENT_CHAT_PANE_ATTRIBUTE]: '' }}
            aria-label={ariaLabel}
            // `relative` anchors the composer's whole-Chat drop tint (see `AgentChatComposer`).
            className="relative flex h-full min-h-0 flex-col bg-background"
            onDragLeave={(event) => composerDrop.current?.onDragLeave(event)}
            onDragOver={(event) => composerDrop.current?.onDragOver(event)}
            onDrop={(event) => composerDrop.current?.onDrop(event)}
        >
            <div className="relative min-h-0 flex-1">
                <AgentChatFindScope
                    contentReference={contentReference}
                    focusComposer={focusComposer}
                    scrollReference={scrollReference}
                    stopFollowing={stopFollowing}
                    terminalId={terminalId}
                >
                    <div
                        className="h-full overflow-y-auto"
                        ref={scrollReference}
                        onScroll={onScroll}
                    >
                        <div
                            className={cn(
                                'mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 select-none',
                                // The rail sits at `left-1` and is 20px wide; 28px clears it with the usual gap.
                                isAgentChatMessageRailShown(railMarks) && 'pl-7',
                            )}
                            ref={contentReference}
                            onCopy={announceAgentChatSelectionCopy}
                        >
                            {snapshot?.truncated && (
                                <p className="m-0 text-center text-[11px] text-muted">
                                    Earlier messages are not shown: Chat keeps only the recent part
                                    of a long conversation. {providerName} still has all of it.
                                    {openAsTerminal && (
                                        <>
                                            {' '}
                                            <button
                                                className="cursor-pointer border-0 bg-transparent p-0 text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                                                type="button"
                                                onClick={openAsTerminal}
                                            >
                                                Open as Terminal
                                            </button>
                                        </>
                                    )}
                                </p>
                            )}
                            <AgentChatExpansionContext value={expansion}>
                                <AgentChatTaskLinksContext value={taskLinks}>
                                    <AgentChatTerminalContext value={terminalId}>
                                        <AgentChatEditContext value={editActions}>
                                            {timeline.map((entry) => {
                                                const key =
                                                    entry.kind === 'item'
                                                        ? entry.item.id
                                                        : entry.id;
                                                const dayBreak = dayBreaks.get(key);
                                                return (
                                                    <Fragment key={key}>
                                                        {dayBreak !== undefined && (
                                                            <AgentChatDayBreak
                                                                timestamp={dayBreak}
                                                            />
                                                        )}
                                                        <AgentChatTimelineEntryView
                                                            entry={entry}
                                                            onOpenFile={openFile}
                                                        />
                                                    </Fragment>
                                                );
                                            })}
                                        </AgentChatEditContext>
                                    </AgentChatTerminalContext>
                                </AgentChatTaskLinksContext>
                            </AgentChatExpansionContext>
                            {emptyMessage && (
                                <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                                    <p className="m-0 text-[13px] text-muted">{emptyMessage}</p>
                                    {processState !== 'detached' && (
                                        <p className="m-0 text-[11px] leading-4 text-muted">
                                            {agentChatEmptyHint(supportsImages)}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    <AgentChatMessageRail
                        activeIndex={rail.activeIndex}
                        marks={railMarks}
                        onJump={jumpToMessage}
                    />
                    <AgentChatJumpToLatest
                        focusTarget={inputReference}
                        isFollowing={isFollowing}
                        onJump={jumpToLatest}
                    />
                </AgentChatFindScope>
            </div>
            <AgentChatDock
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
                activeTurnId={snapshot?.activeTurnId}
                activity={agentChatActivity(snapshot, providerName, {
                    hasConversation: Boolean(terminal?.agentSessionId),
                })}
                canSaveProjectDefault={canSaveProjectDefault}
                sendBlock={agentChatSendBlock(snapshot, processState)}
                commands={snapshot?.commands}
                dropHandlersReference={composerDrop}
                edit={{
                    handleReference: composerEdit,
                    filesUnsupportedReason: supportsRewindFiles
                        ? undefined
                        : `${providerName} cannot restore files; only the conversation rewinds`,
                    onEditingChange: setEditingId,
                }}
                inputReference={inputReference}
                isBusy={isAgentChatBusy(snapshot)}
                isQueuePaused={snapshot?.queuePaused ?? false}
                isShown={isShown}
                providerName={providerName}
                onSent={jumpToLatest}
                queue={snapshot?.queue}
                snapshot={snapshot}
                supportsImages={supportsImages}
                terminalId={terminalId}
            />
        </section>
    );
}
