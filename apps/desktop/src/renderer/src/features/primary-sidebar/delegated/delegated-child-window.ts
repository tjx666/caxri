import type { SessionListWindow } from '@caxri/protocol';
import { sessionListWindow } from '@caxri/protocol';

/**
 * Settled nested Sessions one host shows before its `Show N more` row appears. A host that delegated a dozen tasks
 * would otherwise push every Project below it off the screen once they finish.
 */
export const DELEGATED_IDLE_VISIBLE_COUNT = 3;

/**
 * What a host row says about its nested Sessions while the user folded them away.
 */
export interface DelegatedHostSummary {
    /**
     * Nested Sessions under the host, whether or not they are on screen.
     */
    count: number;
    /**
     * True when a nested Session other than the selected one waits on the user (unread, a question or approval, a usage
     * wait) or failed, so a folded host still says it hides work that needs a person. A running one does not count: it
     * needs nobody yet.
     */
    needsYou: boolean;
}

const NEEDS_YOU_STATUS_KINDS: ReadonlySet<string> = new Set(['attention', 'failed', 'usageWait']);

/**
 * One host row's summary as the primitive props `ActiveSessionRow` takes. Primitives rather than the summary object
 * keep the memoized row from re-rendering when the summaries map is rebuilt with equal values.
 */
export function delegatedHostRowProperties(
    summaries: ReadonlyMap<string, DelegatedHostSummary> | undefined,
    sessionId: string,
): { nestedNeedsYou: boolean; nestedSessionCount: number } {
    const summary = summaries?.get(sessionId);
    return {
        nestedNeedsYou: summary?.needsYou ?? false,
        nestedSessionCount: summary?.count ?? 0,
    };
}

/**
 * Summarizes one host's nested Sessions from each one's `sessionStatus` kind. The selected one is left out of
 * `needsYou` because it stays on screen under a folded host.
 */
export function delegatedHostSummary(
    children: ReadonlyArray<{ id: string }>,
    statusKinds: ReadonlyMap<string, string>,
    selectedSessionId: string | undefined,
): DelegatedHostSummary {
    return {
        count: children.length,
        needsYou: children.some(
            (child) =>
                child.id !== selectedSessionId &&
                NEEDS_YOU_STATUS_KINDS.has(statusKinds.get(child.id) ?? 'default'),
        ),
    };
}

interface DelegatedChildWindowInput {
    /**
     * Nested Sessions that currently show a status (running, unread or waiting for you, usage wait, detached, failed).
     * They are never folded away: a running or failed task is the reason the user is looking at this host.
     */
    activeSessionIds: ReadonlySet<string>;
    /**
     * True when the user folded the host's child rows (`session-children-collapse.ts`).
     */
    isCollapsed?: boolean;
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
 *
 * A collapsed host shows only the selected nested Session, active ones included: folding is the user's explicit request
 * to stop seeing them, and the host row's count says what it hides. It has no reveal row, since expanding the host is
 * how the rest come back.
 */
export function delegatedChildWindow<TSession extends { id: string }>(
    children: readonly TSession[],
    {
        activeSessionIds,
        isCollapsed = false,
        revealedCount,
        selectedSessionId,
    }: DelegatedChildWindowInput,
): SessionListWindow<TSession> {
    if (isCollapsed) {
        const visibleSessions = children.filter((child) => child.id === selectedSessionId);
        return {
            hiddenCount: 0,
            nextRevealCount: 0,
            visibleSessions,
            windowCount: visibleSessions.length,
        };
    }
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
