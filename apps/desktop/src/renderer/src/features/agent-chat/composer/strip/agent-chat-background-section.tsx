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
import { AgentChatBackgroundHeaderActions } from './agent-chat-background-header-actions';
import type { AgentChatBackgroundItem } from './agent-chat-background-items';
import {
    agentChatBackgroundItems,
    agentChatBackgroundRows,
    isAgentChatBackgroundHeaderless,
    splitAgentChatBackgroundItems,
} from './agent-chat-background-items';
import {
    dismissDelegatedBackgroundItems,
    useDismissedDelegations,
} from './agent-chat-dismissed-delegations';
import { markAgentChatFailuresSeen } from './agent-chat-seen-failures';
import { expandAgentChatStripSection } from './agent-chat-strip-folds';
import { AgentChatStripSection } from './agent-chat-strip-section';
import type { AgentChatBackgroundWork } from './agent-chat-strip-sections';

const NO_DELEGATIONS: readonly AgentDelegationSession[] = [];

/**
 * When this window opened: a delegated interruption that settled before it is from an earlier run of Caxri (or of this
 * window) and counts under the header instead of taking a row (`isEarlierInterruption`). Fixed for the window's
 * lifetime, so reading it during render stays pure.
 */
const WINDOW_OPENED_AT = performance.timeOrigin;

/**
 * The list itself: a collapsible section whose header names it and says what matters even folded (how many rows need
 * the user, how many still run, how many delegations an earlier run left interrupted), then one row per item in
 * `agentChatBackgroundRows` order. A lone row takes no header (`isAgentChatBackgroundHeaderless`): it already says what
 * the header would. The header folds everything, rows that need the user included; unfolded, every row shows and the
 * strip's height cap scrolls them. A polite live region announces what the delegated rows need (the strip announces the
 * task counts). Leaves the strip once nothing runs, nothing needs the user, and no earlier interruption is left.
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
    const dismissedIds = useDismissedDelegations();
    const [isEarlierShown, setEarlierShown] = useState(false);
    const listId = useId();
    const items = agentChatBackgroundItems({ delegated, dismissedIds, work });
    const { current, earlier, needsYouCount, runningCount } = splitAgentChatBackgroundItems(
        items,
        WINDOW_OPENED_AT,
    );
    // Adjusting state during render: once the earlier rows are all dismissed, the next ones start hidden again.
    if (isEarlierShown && earlier.length === 0) setEarlierShown(false);
    if (items.length === 0) return null;
    const delegatedEntries = current.flatMap((item) =>
        item.kind === 'delegated' ? [item.entry] : [],
    );
    const { asking, failed, needsInput, waiting } = delegatedSessionsHeaderParts(
        delegatedSessionsSummary(delegatedEntries),
        t,
    );
    // The task counts live in the strip's own region, which outlives this list; this one adds what the delegated rows need.
    const announcement = [needsInput, failed, waiting, asking].filter(Boolean);
    const dismiss = (item: AgentChatBackgroundItem) => () => {
        if (item.kind === 'delegated') dismissDelegatedBackgroundItems([item.id]);
        else markAgentChatFailuresSeen(terminalId, [item.id]);
    };
    const stoppableTaskIds = (work?.running ?? []).filter(canStopAgentChatTask).map(({ id }) => id);
    const rows = agentChatBackgroundRows(current, earlier, isEarlierShown);
    return (
        <AgentChatStripSection
            actions={
                <AgentChatBackgroundHeaderActions
                    currentCount={current.length}
                    earlierCount={earlier.length}
                    isEarlierShown={isEarlierShown}
                    listId={listId}
                    stoppableTaskIds={stoppableTaskIds}
                    terminalId={terminalId}
                    onClearEarlier={() =>
                        dismissDelegatedBackgroundItems(earlier.map(({ id }) => id))
                    }
                    onToggleEarlier={() => {
                        // Showing the earlier rows inside a folded section would show nothing.
                        if (!isEarlierShown) expandAgentChatStripSection(terminalId, 'background');
                        setEarlierShown((value) => !value);
                    }}
                />
            }
            hasBody={rows.length > 0}
            isHeaderless={isAgentChatBackgroundHeaderless(current, earlier)}
            label={t('agentChat.tasks.backgroundWork')}
            section="background"
            status={
                <>
                    {needsYouCount > 0 && (
                        <span className="min-w-0 truncate text-danger">
                            {t(
                                needsYouCount === 1
                                    ? 'agentChat.tasks.needsYouOne'
                                    : 'agentChat.tasks.needsYouOther',
                                { count: needsYouCount },
                            )}
                        </span>
                    )}
                    {needsYouCount > 0 && runningCount > 0 && (
                        <span aria-hidden="true" className="shrink-0">
                            ·
                        </span>
                    )}
                    {runningCount > 0 && (
                        <span className="min-w-0 truncate">
                            {t('agentChat.tasks.runningCount', { count: runningCount })}
                        </span>
                    )}
                </>
            }
            terminalId={terminalId}
        >
            <span aria-live="polite" className="sr-only" role="status">
                {announcement.join(', ')}
            </span>
            <ul className="m-0 flex list-none flex-col p-0" id={listId}>
                {rows.map((item) =>
                    item.kind === 'delegated' ? (
                        renderDelegated(
                            item,
                            item.requiresUser && !isDelegationNeedsInput(item.entry)
                                ? dismiss(item)
                                : undefined,
                        )
                    ) : (
                        <AgentChatTaskEntry
                            key={item.id}
                            task={item.task}
                            terminalId={terminalId}
                            onDismiss={item.requiresUser ? dismiss(item) : undefined}
                            onOpenTask={onOpenTask}
                        />
                    ),
                )}
            </ul>
        </AgentChatStripSection>
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
