import { memo, useCallback, useEffect, useRef } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { ArrowDown, CircleAlert, RotateCcw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useCaxriQuery } from '../../queries/client';
import { useTerminalLinkPicker } from '../terminal/hooks/use-terminal-link-picker';
import { registerTerminalFocusHandler, restartTerminal } from '../terminal/terminal-commands';
import { openTerminalFileTarget } from '../terminal/terminal-file-link-open';
import { parseTerminalFileLocation } from '../terminal/terminal-file-location';
import { TerminalLinkPicker } from '../terminal/terminal-link-picker';
import { terminalPaneHost } from '../terminal/terminal-pane-host';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { AgentChatComposer } from './agent-chat-composer';
import {
    agentChatActivityLabel,
    agentChatContextSummary,
    agentChatFailureMessage,
    canSendAgentChatMessage,
    isAgentChatTurnRunning,
} from './agent-chat-presentation';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { AgentChatPlanCard } from './agent-chat-status-glyph';
import { AgentChatTimelineItem } from './agent-chat-timeline-item';
import { useAgentChatScroll } from './use-agent-chat-scroll';

/**
 * A streamed delta replaces only the item it appends to (`applyAgentChatPatch` keeps every other item's identity), so
 * the rest of the transcript skips rendering entirely.
 */
const MemoizedAgentChatTimelineItem = memo(AgentChatTimelineItem);

/**
 * Why the Chat cannot continue, with the one action that recovers it. It sits in the dock, outside the scrolling
 * timeline, so reading history never hides the Retry button.
 */
function AgentChatFailureBanner({
    snapshot,
    isError,
    onRetry,
    providerName,
}: {
    snapshot: AgentChatSnapshot | undefined;
    isError: boolean;
    onRetry: () => void;
    providerName: string;
}) {
    if (!isError && snapshot?.status !== 'failed') return null;
    const message = snapshot?.failure
        ? agentChatFailureMessage(snapshot.failure.reason, providerName)
        : 'The conversation could not be loaded.';
    return (
        <div
            className="flex items-start gap-2 rounded-lg border border-danger bg-surface px-3 py-2 text-[12px] leading-5"
            role="alert"
        >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
                <p className="m-0 text-foreground">{message}</p>
                {snapshot?.failure?.detail && (
                    <p className="m-0 wrap-anywhere text-muted">{snapshot.failure.detail}</p>
                )}
            </div>
            <Button size="sm" variant="secondary" onClick={onRetry}>
                <RotateCcw className="size-3.5" />
                Retry
            </Button>
        </div>
    );
}

/**
 * The one-line activity indicator under the timeline. It is the Chat's polite status region: transitions between
 * starting, working, and waiting are announced, while streamed reply text never is.
 */
function AgentChatActivity({
    snapshot,
    providerName,
}: {
    snapshot: AgentChatSnapshot | undefined;
    providerName: string;
}) {
    const label = agentChatActivityLabel(snapshot, providerName);
    return (
        <div aria-live="polite" className="text-[12px] text-muted" role="status">
            {label && (
                <span className="flex items-center gap-2">
                    {label.isBusy && <Spinner className="size-3.5" />}
                    {label.text}
                </span>
            )}
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
    providerName,
    terminalId,
}: {
    ariaLabel: string;
    /**
     * The provider catalog's display name, for copy that names the Agent.
     */
    providerName: string;
    terminalId: string;
}) {
    const query = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const snapshot = query.data;
    const projectRoot = usePaneViewSession()?.rootPath;
    const inputReference = useRef<HTMLTextAreaElement | null>(null);
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
    const isEmpty = snapshot?.status === 'ready' && snapshot.items.length === 0;
    const retry = (): void => {
        /**
         * A failed provider stays failed on read so a broken CLI is not relaunched by every render; only a restart
         * clears the failure and resumes the bound conversation.
         */
        if (snapshot?.status === 'failed') restartTerminal(terminalId);
        // eslint-disable-next-line no-void -- the query owns the refetch result and error state
        else void query.refetch();
    };
    return (
        <section aria-label={ariaLabel} className="flex h-full min-h-0 flex-col bg-background">
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
                        {snapshot?.items.map((item) => (
                            <MemoizedAgentChatTimelineItem
                                item={item}
                                key={item.id}
                                onOpenFile={openFile}
                            />
                        ))}
                        {isEmpty && (
                            <p className="m-0 py-8 text-center text-[13px] text-muted">
                                Send a message to start working with {providerName}.
                            </p>
                        )}
                        <AgentChatActivity providerName={providerName} snapshot={snapshot} />
                    </div>
                </div>
                {!isFollowing && (
                    <Button
                        className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-md"
                        size="sm"
                        variant="secondary"
                        onClick={jumpToLatest}
                    >
                        <ArrowDown className="size-3.5" />
                        Jump to latest
                    </Button>
                )}
            </div>
            <div className="mx-auto flex max-h-[45%] w-full max-w-3xl shrink-0 flex-col gap-2 overflow-y-auto px-4 empty:hidden">
                <AgentChatFailureBanner
                    isError={query.isError}
                    providerName={providerName}
                    snapshot={snapshot}
                    onRetry={retry}
                />
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
                        projectRoot={projectRoot}
                        request={request}
                        terminalId={terminalId}
                    />
                ))}
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
                canSend={canSendAgentChatMessage(snapshot)}
                contextSummary={agentChatContextSummary(snapshot)}
                inputReference={inputReference}
                providerName={providerName}
                terminalId={terminalId}
            />
        </section>
    );
}
