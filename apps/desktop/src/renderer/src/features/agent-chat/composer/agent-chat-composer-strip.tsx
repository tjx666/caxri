import type { ReactNode } from 'react';

import type { AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';

import { AgentChatGoalBar } from '../activity/agent-chat-goal-bar';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import { AgentChatQueueList } from './agent-chat-queue-list';

/**
 * The strip on the composer card's top edge, inset from its corners like a tab, so the Chat's state reads as separate
 * from the draft. Everything that waits above the input stacks in it as hairline-divided rows rather than separate
 * cards, as LobeHub's input trays and T3 Code's composer drawer do: the goal, queued messages, then the composer's own
 * rows (`children`: the status row nearest the input, since it changes most often, the edit bar, and the context
 * notices). Its last row's hairline overlaps the card's top border; with no row it collapses to `contents`, keeping the
 * status row's live region announced without drawing an empty tab.
 */
export function AgentChatComposerStrip({
    activeTurnId,
    children,
    enterQueuedId,
    isQueuePaused,
    isTurnRunning,
    pendingQueue,
    queue,
    snapshot,
    terminalId,
    onQueueAction,
    onQueueEdit,
}: {
    activeTurnId: string | undefined;
    children: ReactNode;
    /**
     * The queued message Enter in the empty composer steers now (`AgentChatQueueList`).
     */
    enterQueuedId: string | undefined;
    isQueuePaused: boolean;
    isTurnRunning: boolean;
    pendingQueue: readonly AgentChatPendingMessage[];
    queue: readonly AgentChatQueuedMessage[] | undefined;
    snapshot: Pick<AgentChatSnapshot, 'goal' | 'queuePauseReason' | 'turns'> | undefined;
    terminalId: string;
    onQueueAction: () => void;
    onQueueEdit: (text: string) => void;
}) {
    return (
        <div
            className="mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-solid border-border bg-surface not-has-[[data-agent-chat-composer-strip-row]]:contents"
            data-agent-chat-composer-strip=""
        >
            {/*
             * The sections above the composer's own rows share one height cap and scroll past it, so a long queue in a
             * short split pane never squeezes the transcript away.
             */}
            <div className="max-h-64 overflow-y-auto">
                <AgentChatGoalBar
                    activeTurnId={activeTurnId}
                    goal={snapshot?.goal}
                    terminalId={terminalId}
                    turns={snapshot?.turns}
                />
                <AgentChatQueueList
                    enterQueuedId={enterQueuedId}
                    isTurnRunning={isTurnRunning}
                    pending={pendingQueue}
                    queue={queue}
                    snapshot={{
                        queuePaused: isQueuePaused,
                        queuePauseReason: snapshot?.queuePauseReason,
                    }}
                    terminalId={terminalId}
                    onAction={onQueueAction}
                    onEdit={onQueueEdit}
                />
            </div>
            {children}
        </div>
    );
}
