import type { AgentChatTask, AgentDelegationSession } from '@caxri/protocol';
import {
    isDelegationFailed,
    isDelegationNeedsInput,
    isDelegationRetryPending,
} from '@caxri/protocol';

import type { AgentChatBackgroundWork } from './agent-chat-strip-sections';

/**
 * What a row in the composer strip's Background work list stands for, in the order the list groups them: the larger
 * unit of work the user follows comes first.
 */
type AgentChatBackgroundItemKind = 'delegated' | 'workflow' | 'subagent' | 'shell';

const KIND_ORDER: readonly AgentChatBackgroundItemKind[] = [
    'delegated',
    'workflow',
    'subagent',
    'shell',
];

interface BackgroundItemBase {
    /**
     * Unique across kinds, so one key space serves the list and the dismissed-attention set.
     */
    id: string;
    /**
     * The row needs the user (a question or approval, a failure, an interruption): the header counts it.
     */
    requiresUser: boolean;
}

export type AgentChatBackgroundItem =
    | (BackgroundItemBase & { kind: 'delegated'; entry: AgentDelegationSession })
    | (BackgroundItemBase & { kind: 'workflow' | 'subagent' | 'shell'; task: AgentChatTask });

/**
 * Failures that mean the task was cut short rather than failing at its work: its Terminal was replaced or closed, or a
 * restart reset its host. The Agent cannot resume it on its own, so the row asks the user to look.
 */
const INTERRUPTING_FAILURES: ReadonlySet<NonNullable<AgentDelegationSession['failure']>> = new Set([
    'host_reset',
    'target_changed',
]);

const LIVE_DELEGATION_STATUSES: ReadonlySet<AgentDelegationSession['status']> = new Set([
    'awaiting_ready',
    'blocked',
    'collecting',
    'launching',
    'running',
    'submitting',
]);

/**
 * The dismissed-attention key of a delegated row: its task, so a retry or follow-up in the same Session surfaces again.
 */
export function delegatedBackgroundItemId(
    entry: Pick<AgentDelegationSession, 'delegationId' | 'sessionId'>,
): string {
    return `delegation:${entry.delegationId ?? entry.sessionId}`;
}

/**
 * Where a delegated task stands for the list: `attention` when it needs the user (asks them, failed, or was
 * interrupted), `live` while it still works or waits on its delegating Agent or a scheduled retry, and `undefined` once
 * it settled any other way (completed, stopped by its caller, taken over), which removes it from the list.
 */
export function delegatedBackgroundState(
    entry: AgentDelegationSession,
): 'attention' | 'live' | undefined {
    if (isDelegationNeedsInput(entry) || isDelegationFailed(entry)) return 'attention';
    if (
        entry.status === 'interrupted' ||
        (entry.status === 'failed' &&
            entry.failure !== undefined &&
            INTERRUPTING_FAILURES.has(entry.failure))
    )
        return 'attention';
    if (LIVE_DELEGATION_STATUSES.has(entry.status) || isDelegationRetryPending(entry))
        return 'live';
    return undefined;
}

function taskKind(task: AgentChatTask): 'workflow' | 'subagent' | 'shell' {
    if (task.workflow !== undefined) return 'workflow';
    return task.kind === 'shell' ? 'shell' : 'subagent';
}

/**
 * Every row of the Background work list, in display order: the rows that need the user first across all kinds, then the
 * rest, each part grouped by kind (`KIND_ORDER`) and keeping its source order (delegated rows in the order a person
 * should look at them, tasks in start order). A delegated failure or interruption the user dismissed leaves; one that
 * waits on their answer cannot be dismissed. Task failures arrive already filtered by `agentChatBackgroundWork`.
 */
export function agentChatBackgroundItems({
    delegated,
    dismissedIds,
    work,
}: {
    delegated: readonly AgentDelegationSession[];
    dismissedIds: ReadonlySet<string>;
    work: Pick<AgentChatBackgroundWork, 'failed' | 'running'> | undefined;
}): AgentChatBackgroundItem[] {
    const items: AgentChatBackgroundItem[] = [];
    for (const entry of delegated) {
        const state = delegatedBackgroundState(entry);
        if (state === undefined) continue;
        const id = delegatedBackgroundItemId(entry);
        if (state === 'attention' && !isDelegationNeedsInput(entry) && dismissedIds.has(id))
            continue;
        items.push({ entry, id, kind: 'delegated', requiresUser: state === 'attention' });
    }
    const failed = work?.failed ?? [];
    const running = work?.running ?? [];
    for (const task of failed)
        items.push({ id: task.id, kind: taskKind(task), requiresUser: true, task });
    for (const task of running)
        items.push({ id: task.id, kind: taskKind(task), requiresUser: false, task });
    const rank = (item: AgentChatBackgroundItem): number =>
        (item.requiresUser ? 0 : KIND_ORDER.length) + KIND_ORDER.indexOf(item.kind);
    return items.toSorted((left, right) => rank(left) - rank(right));
}

/**
 * Whether a row is an interruption that settled before `openedAt` (when this window opened): a delegated task its
 * Terminal or a restart cut short during an earlier run of Caxri. Those pile up after a restart, so the list counts
 * them in its header (`N interrupted earlier`) and shows their rows only on request. A real failure stays a row: it
 * carries its retry actions. An interruption without `settledAt` counts as current.
 */
function isEarlierInterruption(item: AgentChatBackgroundItem, openedAt: number): boolean {
    if (item.kind !== 'delegated') return false;
    const { entry } = item;
    const isInterruption =
        entry.status === 'interrupted' ||
        (entry.status === 'failed' &&
            entry.failure !== undefined &&
            INTERRUPTING_FAILURES.has(entry.failure));
    return isInterruption && entry.settledAt !== undefined && entry.settledAt < openedAt;
}

/**
 * The list split for its header: `current` rows (in display order) and the `earlier` interruptions
 * (`isEarlierInterruption`) the header counts instead of listing, with what the header says about `current`: how many
 * rows need the user and how many still run.
 */
export function splitAgentChatBackgroundItems(
    items: readonly AgentChatBackgroundItem[],
    openedAt: number,
): {
    current: AgentChatBackgroundItem[];
    earlier: AgentChatBackgroundItem[];
    needsYouCount: number;
    runningCount: number;
} {
    const current: AgentChatBackgroundItem[] = [];
    const earlier: AgentChatBackgroundItem[] = [];
    for (const item of items)
        (isEarlierInterruption(item, openedAt) ? earlier : current).push(item);
    const needsYouCount = current.filter((item) => item.requiresUser).length;
    return { current, earlier, needsYouCount, runningCount: current.length - needsYouCount };
}

/**
 * Whether the list drops its header: one current row and no earlier interruptions. The row already says everything the
 * header would (its status, its own Stop or Dismiss), Stop all needs two tasks, and folding a single row saves nothing,
 * so the header would only repeat the row above it.
 */
export function isAgentChatBackgroundHeaderless(
    current: readonly AgentChatBackgroundItem[],
    earlier: readonly AgentChatBackgroundItem[],
): boolean {
    return current.length === 1 && earlier.length === 0;
}

/**
 * The rows the list shows: the current rows that need the user, then the earlier interruptions when the user opened
 * them, then the work still running. Opening the earlier rows only inserts rows, never moves one already in view.
 */
export function agentChatBackgroundRows(
    current: readonly AgentChatBackgroundItem[],
    earlier: readonly AgentChatBackgroundItem[],
    isEarlierShown: boolean,
): AgentChatBackgroundItem[] {
    const attention = current.filter((item) => item.requiresUser);
    const live = current.filter((item) => !item.requiresUser);
    return [...attention, ...(isEarlierShown ? earlier : []), ...live];
}
