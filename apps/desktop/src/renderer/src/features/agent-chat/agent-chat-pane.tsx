import { useCallback, useEffect, useMemo, useRef } from 'react';

import { CircleAlert, RotateCcw, Unplug } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useTerminal } from '../../stores/selectors';
import { useTerminalLinkPicker } from '../terminal/hooks/use-terminal-link-picker';
import { registerTerminalFocusHandler, restartTerminal } from '../terminal/terminal-commands';
import { openTerminalFileTarget } from '../terminal/terminal-file-link-open';
import { parseTerminalFileLocation } from '../terminal/terminal-file-location';
import { TerminalLinkPicker } from '../terminal/terminal-link-picker';
import { terminalPaneHost } from '../terminal/terminal-pane-host';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { AgentChatComposer } from './agent-chat-composer';
import { AgentChatJumpToLatest } from './agent-chat-jump-to-latest';
import { AgentChatPlanCard } from './agent-chat-plan-card';
import type { AgentChatRecoveryNotice } from './agent-chat-presentation';
import {
    agentChatActivity,
    agentChatEmptyMessage,
    agentChatRecoveryNotice,
    canSendAgentChatMessage,
    isAgentChatBusy,
    isAgentChatTurnRunning,
} from './agent-chat-presentation';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { openAgentChatTaskTab } from './agent-chat-task-opener';
import { AgentChatTaskStrip } from './agent-chat-task-strip';
import { agentChatTasksByItem } from './agent-chat-tasks';
import { buildAgentChatTimeline } from './agent-chat-timeline';
import { AgentChatTimelineEntryView } from './agent-chat-timeline-entry-view';
import { useAgentChatActivationFocus } from './hooks/use-agent-chat-activation-focus';
import type { AgentChatDropHandlers } from './hooks/use-agent-chat-file-input';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';
import type { AgentChatTaskLinks } from './hooks/use-agent-chat-task-link';
import { AgentChatTaskLinksContext } from './hooks/use-agent-chat-task-link';
import { AgentChatTerminalContext } from './hooks/use-agent-chat-terminal';

/**
 * Why the Chat cannot continue, with the one action that recovers it. It sits in the dock, outside the scrolling
 * timeline, so reading history never hides the action. A failure reads in the danger tone with Retry; a hand-over to
 * another client is not a fault, so it takes the neutral border and the PTY recovery bar's unplugged glyph and Resume.
 */
function AgentChatRecoveryBanner({
    notice,
    onRecover,
}: {
    notice: AgentChatRecoveryNotice | undefined;
    onRecover: () => void;
}) {
    if (!notice) return null;
    const isDetached = notice.kind === 'detached';
    const Icon = isDetached ? Unplug : CircleAlert;
    return (
        <div
            className={cn(
                'flex items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-[12px] leading-5',
                isDetached ? 'border-border' : 'border-danger',
            )}
            data-agent-chat-recovery={notice.kind}
            role={isDetached ? 'status' : 'alert'}
        >
            <Icon
                className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    isDetached ? 'text-muted' : 'text-danger',
                )}
            />
            <div className="min-w-0 flex-1">
                <p className="m-0 text-foreground">{notice.message}</p>
                {notice.detail && <p className="m-0 wrap-anywhere text-muted">{notice.detail}</p>}
            </div>
            <Button size="sm" variant="secondary" onClick={onRecover}>
                <RotateCcw className="size-3.5" />
                {isDetached ? 'Resume' : 'Retry'}
            </Button>
        </div>
    );
}

/**
 * The structured surface of a Chat Terminal (ADR 0012): the conversation Server Core projects from the provider's own
 * protocol, rendered in place of a terminal grid. The projection lives in the shared query cache and is kept current by
 * `agentChat.patch` (see `agent-chat-client.ts`), so this view only reads it. Mounted per Terminal (keyed by its id),
 * so scroll-follow state never carries from one Chat to another.
 */
export function AgentChatPane({
    ariaLabel,
    isShown,
    providerName,
    supportsImages,
    terminalId,
}: {
    ariaLabel: string;
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
    terminalId: string;
}) {
    const query = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const snapshot = query.data;
    const projectRoot = usePaneViewSession()?.rootPath;
    const inputReference = useRef<HTMLTextAreaElement | null>(null);
    const composerDrop = useRef<AgentChatDropHandlers | null>(null);
    const { scrollReference, contentReference, isFollowing, onScroll, jumpToLatest } =
        useAgentChatScroll(snapshot?.revision);
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
    const tasks = snapshot?.tasks;
    /**
     * Rows that started a subagent or background shell open its tab beside this Chat. Memoized on the task list so a
     * streamed delta that leaves tasks alone does not re-render every memoized work row.
     */
    const taskLinks = useMemo<AgentChatTaskLinks>(
        () => ({
            tasksByItem: agentChatTasksByItem(tasks),
            openTask: (taskId) => openAgentChatTaskTab(terminalId, taskId),
        }),
        [tasks, terminalId],
    );
    /**
     * Read from the Terminal record like the PTY pane does: a hand-over to another client is recorded there as
     * `detached`, while the projection only reads `stopped`.
     */
    const processState = useTerminal(terminalId)?.lastProcessState;
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
        if (recoveryNotice?.recovery === 'restart') restartTerminal(terminalId);
        // eslint-disable-next-line no-void -- the query owns the refetch result and error state
        else void query.refetch();
    };
    return (
        <section
            aria-label={ariaLabel}
            className="flex h-full min-h-0 flex-col bg-background"
            onDragLeave={(event) => composerDrop.current?.onDragLeave(event)}
            onDragOver={(event) => composerDrop.current?.onDragOver(event)}
            onDrop={(event) => composerDrop.current?.onDrop(event)}
        >
            <div className="relative min-h-0 flex-1">
                <div className="h-full overflow-y-auto" ref={scrollReference} onScroll={onScroll}>
                    <div
                        className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4"
                        ref={contentReference}
                    >
                        {snapshot?.truncated && (
                            <p className="m-0 text-center text-[11px] text-muted">
                                Earlier messages are not shown
                            </p>
                        )}
                        <AgentChatTaskLinksContext value={taskLinks}>
                            <AgentChatTerminalContext value={terminalId}>
                                {timeline.map((entry) => (
                                    <AgentChatTimelineEntryView
                                        entry={entry}
                                        key={entry.kind === 'item' ? entry.item.id : entry.id}
                                        onOpenFile={openFile}
                                    />
                                ))}
                            </AgentChatTerminalContext>
                        </AgentChatTaskLinksContext>
                        {emptyMessage && (
                            <p className="m-0 py-8 text-center text-[13px] text-muted">
                                {emptyMessage}
                            </p>
                        )}
                    </div>
                </div>
                <AgentChatJumpToLatest
                    focusTarget={inputReference}
                    isFollowing={isFollowing}
                    onJump={jumpToLatest}
                />
            </div>
            <div className="mx-auto flex max-h-[45%] w-full max-w-3xl shrink-0 flex-col gap-2 overflow-y-auto px-4 empty:hidden">
                <AgentChatRecoveryBanner notice={recoveryNotice} onRecover={recover} />
                {snapshot?.plan && (
                    <AgentChatPlanCard
                        isTurnRunning={isAgentChatTurnRunning(snapshot)}
                        plan={snapshot.plan}
                    />
                )}
                {snapshot?.requests.map((request) => (
                    <AgentChatRequestCard
                        key={request.id}
                        linkedItem={
                            request.kind === 'question'
                                ? undefined
                                : snapshot.items.find((item) => item.id === request.itemId)
                        }
                        onAnswered={focusComposer}
                        projectRoot={projectRoot}
                        providerName={providerName}
                        request={request}
                        terminalId={terminalId}
                    />
                ))}
                <AgentChatTaskStrip tasks={tasks} terminalId={terminalId} />
            </div>
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
                activity={agentChatActivity(snapshot, providerName)}
                canSend={canSendAgentChatMessage(snapshot, processState)}
                commands={snapshot?.commands}
                dropHandlersReference={composerDrop}
                inputReference={inputReference}
                isBusy={isAgentChatBusy(snapshot)}
                isQueuePaused={snapshot?.queuePaused ?? false}
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
