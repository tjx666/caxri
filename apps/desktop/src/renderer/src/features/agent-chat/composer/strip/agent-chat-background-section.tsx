import type { ReactNode } from 'react';
import { useId, useState } from 'react';

import type { AgentDelegationSession } from '@caxri/protocol';
import { canStopAgentChatTask, isDelegationNeedsInput } from '@caxri/protocol';

import { useTranslation } from '../../../../i18n';
import { AgentChatDelegatedSessionRow } from '../../delegation/agent-chat-delegated-session-row';
import {
    delegatedSessionsHeaderParts,
    delegatedSessionsSummary,
} from '../../delegation/agent-chat-delegated-sessions';
import {
    delegatedCostLabel,
    sumDelegatedCost,
} from '../../delegation/cost/agent-chat-delegated-cost';
import { useChatDelegatedSessions } from '../../delegation/hooks/use-chat-delegated-sessions';
import { useDelegatedCost } from '../../delegation/hooks/use-delegated-cost';
import { AgentChatTaskEntry } from '../../tasks/agent-chat-task-entry';
import type { AgentChatBackgroundItem } from './agent-chat-background-items';
import {
    AGENT_CHAT_BACKGROUND_FOLDED_ROWS,
    agentChatBackgroundItems,
    foldAgentChatBackgroundItems,
} from './agent-chat-background-items';
import { AgentChatBackgroundMoreRow } from './agent-chat-background-more-row';
import { markAgentChatFailuresSeen, useAgentChatSeenFailures } from './agent-chat-seen-failures';
import type { AgentChatBackgroundWork } from './agent-chat-strip-sections';

const NO_DELEGATIONS: readonly AgentDelegationSession[] = [];

/**
 * The list itself: one row per item in `agentChatBackgroundItems` order, folded to the rows that need the user plus up
 * to `AGENT_CHAT_BACKGROUND_FOLDED_ROWS`, with a `⋯ N more` line for the rest. No header: the rows say what runs, and a
 * polite live region announces what the delegated rows need (the strip announces the task counts). Leaves the strip
 * once nothing runs and nothing needs the user.
 */
function BackgroundList({
    delegated,
    renderDelegated,
    terminalId,
    work,
    onOpenTask,
}: {
    delegated: readonly AgentDelegationSession[];
    renderDelegated: (
        item: Extract<AgentChatBackgroundItem, { kind: 'delegated' }>,
        onDismiss: (() => void) | undefined,
    ) => ReactNode;
    terminalId: string;
    work: AgentChatBackgroundWork | undefined;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const dismissedIds = useAgentChatSeenFailures(terminalId);
    const [isExpanded, setExpanded] = useState(false);
    const listId = useId();
    const items = agentChatBackgroundItems({ delegated, dismissedIds, work });
    const { hiddenCount, shown } = foldAgentChatBackgroundItems(items);
    const canFold = hiddenCount > 0;
    // Adjusting state during render: a list that shrank back under the fold starts folded the next time it grows.
    if (isExpanded && items.length <= AGENT_CHAT_BACKGROUND_FOLDED_ROWS) setExpanded(false);
    if (items.length === 0) return null;
    const delegatedEntries = items.flatMap((item) =>
        item.kind === 'delegated' ? [item.entry] : [],
    );
    const { asking, failed, needsInput, waiting } = delegatedSessionsHeaderParts(
        delegatedSessionsSummary(delegatedEntries),
        t,
    );
    // The task counts live in the strip's own region, which outlives this list; this one adds what the delegated rows need.
    const announcement = [needsInput, failed, waiting, asking].filter(Boolean);
    const dismiss = (id: string) => () => markAgentChatFailuresSeen(terminalId, [id]);
    const rows = isExpanded || !canFold ? items : shown;
    return (
        <section
            aria-label={t('agentChat.tasks.backgroundWork')}
            className="group/background border-0 border-b border-solid border-border p-1"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-strip-section="background"
        >
            <span aria-live="polite" className="sr-only" role="status">
                {announcement.join(', ')}
            </span>
            <ul
                className="m-0 flex max-h-48 list-none flex-col overflow-y-auto overscroll-contain p-0"
                id={listId}
            >
                {rows.map((item) =>
                    item.kind === 'delegated' ? (
                        renderDelegated(
                            item,
                            item.requiresUser && !isDelegationNeedsInput(item.entry)
                                ? dismiss(item.id)
                                : undefined,
                        )
                    ) : (
                        <AgentChatTaskEntry
                            key={item.id}
                            task={item.task}
                            terminalId={terminalId}
                            onDismiss={item.requiresUser ? dismiss(item.id) : undefined}
                            onOpenTask={onOpenTask}
                        />
                    ),
                )}
            </ul>
            {canFold && (
                <AgentChatBackgroundMoreRow
                    hiddenCount={hiddenCount}
                    isExpanded={isExpanded}
                    listId={listId}
                    stoppableTaskIds={(work?.running ?? [])
                        .filter(canStopAgentChatTask)
                        .map(({ id }) => id)}
                    terminalId={terminalId}
                    onToggle={() => setExpanded((value) => !value)}
                />
            )}
        </section>
    );
}

/**
 * The list with this Chat's delegated Sessions in it: reads the delegation feed and the children's spend, so it mounts
 * only for a Chat on screen in a window that shows delegations (the hidden-Chat render budget).
 */
function DelegatedBackgroundList({
    terminalId,
    work,
    onOpenTask,
}: {
    terminalId: string;
    work: AgentChatBackgroundWork | undefined;
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    const { t } = useTranslation();
    const { attempts, chainSessionIds, entries, sessionId, viaBySessionId } =
        useChatDelegatedSessions(terminalId);
    const cost = useDelegatedCost(sessionId, entries.length > 0);
    return (
        <BackgroundList
            delegated={entries}
            renderDelegated={({ entry, requiresUser }, onDismiss) => (
                <AgentChatDelegatedSessionRow
                    attempt={
                        entry.delegationId === undefined
                            ? undefined
                            : attempts.get(entry.delegationId)
                    }
                    cost={delegatedCostLabel(
                        cost &&
                            sumDelegatedCost(
                                chainSessionIds.get(entry.sessionId) ?? [entry.sessionId],
                                cost.children,
                            ),
                        t,
                    )}
                    entry={entry}
                    key={entry.sessionId}
                    requiresUser={requiresUser}
                    viaSessionId={viaBySessionId.get(entry.sessionId)}
                    onDismiss={onDismiss}
                />
            )}
            terminalId={terminalId}
            work={work}
            onOpenTask={onOpenTask}
        />
    );
}

/**
 * The composer strip's Background work list: the Sessions this Chat's Agent delegated to, its workflow runs, subagents,
 * and background shells, one row each and grouped in that order. Running work shows until it ends; work that needs the
 * user (a question or approval, a failure, an interruption) shows until it is handled or dismissed. Finished work
 * leaves: the Agent reports results in the conversation, and the sidebar lists the child Sessions.
 */
export function AgentChatBackgroundSection({
    terminalId,
    withDelegated,
    work,
    onOpenTask,
}: {
    terminalId: string;
    /**
     * Includes the delegated Sessions; false for a Chat in the background or a window that shows no delegations.
     */
    withDelegated: boolean;
    work: AgentChatBackgroundWork | undefined;
    /**
     * Opens a task's tab beside the Chat; absent where the host cannot, which leaves each task a plain row.
     */
    onOpenTask: ((taskId: string) => void) | undefined;
}) {
    if (withDelegated)
        return (
            <DelegatedBackgroundList terminalId={terminalId} work={work} onOpenTask={onOpenTask} />
        );
    if (!work) return null;
    return (
        <BackgroundList
            delegated={NO_DELEGATIONS}
            renderDelegated={() => null}
            terminalId={terminalId}
            work={work}
            onOpenTask={onOpenTask}
        />
    );
}
