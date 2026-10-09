import { useEffect, useRef } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { CircleAlert, RotateCcw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useCaxriQuery } from '../../queries/client';
import { registerTerminalFocusHandler, restartTerminal } from '../terminal/terminal-commands';
import { AgentChatComposer } from './agent-chat-composer';
import {
    agentChatFailureMessage,
    canSendAgentChatMessage,
    isAgentChatTurnRunning,
} from './agent-chat-presentation';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { AgentChatPlanCard } from './agent-chat-status-glyph';
import { AgentChatTimelineItem } from './agent-chat-timeline-item';
import { useAgentChatScroll } from './use-agent-chat-scroll';

function AgentChatStatusBanner({
    snapshot,
    isError,
    onRetry,
}: {
    snapshot: AgentChatSnapshot | undefined;
    isError: boolean;
    onRetry: () => void;
}) {
    if (isError || snapshot?.status === 'failed') {
        const message = snapshot?.failure
            ? agentChatFailureMessage(snapshot.failure.reason)
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
    if (!snapshot || snapshot.status === 'starting')
        return (
            <div className="flex items-center gap-2 text-[12px] text-muted">
                <Spinner className="size-3.5" />
                Starting Codex…
            </div>
        );
    return null;
}

/**
 * The structured surface of a Chat Terminal (ADR 0012): the conversation Server Core projects from the provider's own
 * protocol, rendered in place of a terminal grid. The projection lives in the shared query cache and is kept current by
 * `agentChat.patch` (see `agent-chat-client.ts`), so this view only reads it.
 */
export function AgentChatPane({
    ariaLabel,
    terminalId,
}: {
    ariaLabel: string;
    terminalId: string;
}) {
    const query = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const snapshot = query.data;
    const inputReference = useRef<HTMLTextAreaElement | null>(null);
    const { scrollReference, onScroll } = useAgentChatScroll(snapshot?.revision);
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
    const hasDock =
        snapshot !== undefined && (snapshot.plan !== undefined || snapshot.requests.length > 0);
    return (
        <section aria-label={ariaLabel} className="flex h-full min-h-0 flex-col bg-background">
            <div
                className="min-h-0 flex-1 overflow-y-auto"
                ref={scrollReference}
                onScroll={onScroll}
            >
                <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
                    {snapshot?.truncated && (
                        <p className="m-0 text-center text-[11px] text-muted">
                            Earlier messages are not shown
                        </p>
                    )}
                    {snapshot?.items.map((item) => (
                        <AgentChatTimelineItem item={item} key={item.id} />
                    ))}
                    {isEmpty && (
                        <p className="m-0 py-8 text-center text-[13px] text-muted">
                            Send a message to start working with Codex.
                        </p>
                    )}
                    {isAgentChatTurnRunning(snapshot) && (
                        <div className="flex items-center gap-2 text-[12px] text-muted">
                            <Spinner aria-label="Working" className="size-3.5" />
                            Working…
                        </div>
                    )}
                    <AgentChatStatusBanner
                        isError={query.isError}
                        snapshot={snapshot}
                        onRetry={() => {
                            /**
                             * A failed provider stays failed on read so a broken CLI is not relaunched by every render;
                             * only a restart clears the failure and resumes the bound conversation.
                             */
                            if (snapshot?.status === 'failed') restartTerminal(terminalId);
                            // eslint-disable-next-line no-void -- the query owns the refetch result and error state
                            else void query.refetch();
                        }}
                    />
                </div>
            </div>
            {hasDock && (
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2">
                    {snapshot.plan && <AgentChatPlanCard plan={snapshot.plan} />}
                    {snapshot.requests.map((request) => (
                        <AgentChatRequestCard
                            key={request.id}
                            request={request}
                            terminalId={terminalId}
                        />
                    ))}
                </div>
            )}
            <AgentChatComposer
                canSend={canSendAgentChatMessage(snapshot)}
                inputReference={inputReference}
                isTurnRunning={isAgentChatTurnRunning(snapshot)}
                terminalId={terminalId}
            />
        </section>
    );
}
