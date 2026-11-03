import type { SessionListWindow } from '@caxri/protocol';
import { sessionListWindow } from '@caxri/protocol';

/**
 * Settled nested Sessions one host shows before its `Show N more` row appears. A host that delegated a dozen tasks
 * would otherwise push every Project below it off the screen once they finish.
 */
export const DELEGATED_IDLE_VISIBLE_COUNT = 3;

interface DelegatedChildWindowInput {
    /**
     * Nested Sessions that currently show a status (running, unread or waiting for you, usage wait, detached, failed).
     * They are never folded away: a running or failed task is the reason the user is looking at this host.
     */
    activeSessionIds: ReadonlySet<string>;
    /**
     * How many idle Sessions the user revealed so far (`undefined` until they ask for more).
     */
    revealedCount: number | undefined;
    selectedSessionId: string | undefined;
}

/**
 * The nested Sessions one host renders: every active one, plus the newest {@link DELEGATED_IDLE_VISIBLE_COUNT} idle ones
 * and any idle ones the user revealed, with the rest behind a reveal row. The selected nested Session always renders.
 *
 * Independent of the Project's own Session window: a host's children never consume the Project's newest-N. The counts
 * (`hiddenCount`, `nextRevealCount`, `windowCount`) describe the idle Sessions only, because active ones are never part
 * of what a reveal adds.
 *
 * `children` arrive in sidebar order, which this keeps for the visible subset.
 */
export function delegatedChildWindow<TSession extends { id: string }>(
    children: readonly TSession[],
    { activeSessionIds, revealedCount, selectedSessionId }: DelegatedChildWindowInput,
): SessionListWindow<TSession> {
    const idle = children.filter((child) => !activeSessionIds.has(child.id));
    const idleWindow = sessionListWindow(idle, revealedCount, selectedSessionId, {
        initialCount: DELEGATED_IDLE_VISIBLE_COUNT,
    });
    const visibleIdleIds = new Set(idleWindow.visibleSessions.map((child) => child.id));
    return {
        ...idleWindow,
        visibleSessions: children.filter(
            (child) => activeSessionIds.has(child.id) || visibleIdleIds.has(child.id),
        ),
    };
}
