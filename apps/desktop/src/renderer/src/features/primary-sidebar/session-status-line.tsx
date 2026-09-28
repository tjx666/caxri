import type { SessionRecord } from '@caxri/protocol';

import { useRelativeTime } from '../../hooks/use-relative-time';
import { cn } from '../../lib/utilities';
import { useSessionDiffStat } from './hooks/use-session-diff-stat';
import { sessionStatusLineActivity } from './session-activity';
import type { SessionStatusTerminal } from './session-status';

/**
 * The Session row's second line: what the Agent is doing now and when the Session last moved, e.g. `Working · 4m ago`.
 *
 * The time is `lastSessionActivityAt`, the latest lifecycle transition (a submission, or the Agent starting, waiting,
 * finishing, or failing). Compaction is an operation inside a running turn and does not move it, so `Compacting · 12m
 * ago` still counts from the start of that turn.
 *
 * The trailing `+N −M` is the Workbench Root's lines changed since its branch forked off the default branch (see
 * `sessionDiffStatSchema`), so Sessions sharing one root show the same numbers.
 *
 * The whole line is `aria-hidden`: the status icon's label names the state, and the row's accessible description (see
 * `SessionActivityCard`) carries the activity and the diff stat in words.
 *
 * A component of its own so the shared relative-time clock and each diff-stat poll re-render this line, never the whole
 * row.
 */
export function SessionStatusLine({
    session,
    terminal,
}: {
    session: Pick<SessionRecord, 'id' | 'lastActivityState' | 'lastSessionActivityAt'>;
    terminal?: SessionStatusTerminal;
}) {
    const activity = sessionStatusLineActivity(session, terminal);
    const time = useRelativeTime(session.lastSessionActivityAt, 'narrow');
    const diffStat = useSessionDiffStat(session.id);
    return (
        <span
            aria-hidden="true"
            className="session-status-line flex min-w-0 items-center gap-1 text-[11px] leading-4 whitespace-nowrap text-muted"
        >
            {activity && (
                <>
                    <span className={cn('min-w-0 truncate', activity.indicatorClassName)}>
                        {activity.label}
                    </span>
                    <span>·</span>
                </>
            )}
            <span className="flex-none">{time}</span>
            {diffStat && (
                <span className="session-diff-stat ml-auto flex flex-none gap-1 pl-2 tabular-nums">
                    <span className="text-success">+{diffStat.additions}</span>
                    <span className="text-danger">−{diffStat.deletions}</span>
                </span>
            )}
        </span>
    );
}
