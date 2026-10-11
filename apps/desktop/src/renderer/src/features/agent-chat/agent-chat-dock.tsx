import type { AgentChatSnapshot } from '@caxri/protocol';
import { CircleAlert, RotateCcw, SquareTerminal, Unplug } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utilities';
import { AgentChatPlanCard } from './agent-chat-plan-card';
import type { AgentChatRecoveryNotice } from './agent-chat-presentation';
import { isAgentChatTurnRunning } from './agent-chat-presentation';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { AgentChatTaskStrip } from './agent-chat-task-strip';

/**
 * Why the Chat cannot continue, with the one action that recovers it. It sits in the dock, outside the scrolling
 * timeline, so reading history never hides the action. A failure reads in the danger tone with Retry; a hand-over to
 * another client is not a fault, so it takes the neutral border and the PTY recovery bar's unplugged glyph and Resume.
 * A failure the Chat cannot explain also offers Open as Terminal, where the provider's own output says what went
 * wrong.
 */
function AgentChatRecoveryBanner({
    notice,
    onOpenAsTerminal,
    onRecover,
}: {
    notice: AgentChatRecoveryNotice | undefined;
    onOpenAsTerminal: (() => void) | undefined;
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
            {notice.canOpenAsTerminal && onOpenAsTerminal && (
                <Button size="sm" variant="secondary" onClick={onOpenAsTerminal}>
                    <SquareTerminal className="size-3.5" />
                    Open as Terminal
                </Button>
            )}
            <Button size="sm" variant="secondary" onClick={onRecover}>
                <RotateCcw className="size-3.5" />
                {isDetached ? 'Resume' : 'Retry'}
            </Button>
        </div>
    );
}

/**
 * What docks above the composer, outside the scrolling timeline: the recovery banner, the Agent's plan, each pending
 * approval or question, and the strip of running subagents and background shells.
 */
export function AgentChatDock({
    projectRoot,
    providerName,
    recoveryNotice,
    snapshot,
    terminalId,
    onAnswered,
    onOpenAsTerminal,
    onRecover,
}: {
    projectRoot: string | undefined;
    providerName: string;
    recoveryNotice: AgentChatRecoveryNotice | undefined;
    snapshot: AgentChatSnapshot | undefined;
    terminalId: string;
    onAnswered: () => void;
    onOpenAsTerminal: (() => void) | undefined;
    onRecover: () => void;
}) {
    return (
        <div className="mx-auto flex max-h-[60%] w-full max-w-3xl shrink-0 flex-col gap-2 overflow-y-auto px-4 empty:hidden">
            <AgentChatRecoveryBanner
                notice={recoveryNotice}
                onOpenAsTerminal={onOpenAsTerminal}
                onRecover={onRecover}
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
                    onAnswered={onAnswered}
                    projectRoot={projectRoot}
                    providerName={providerName}
                    request={request}
                    terminalId={terminalId}
                />
            ))}
            <AgentChatTaskStrip tasks={snapshot?.tasks} terminalId={terminalId} />
        </div>
    );
}
