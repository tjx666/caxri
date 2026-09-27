import { RunningArc } from './session-agent-status-icon';
import type { SessionStatusSummary } from './session-status';

/**
 * The collapsed heading's decorative Agent summary: a small running arc with its count, then one attention dot. Only
 * the dot carries amber, matching the rows, where amber always means unread. It gives way to the hover actions that
 * overlay the heading's trailing edge, the same way a Session row's trailing glyph does.
 */
export function ProjectAgentSummary({ summary }: { summary: SessionStatusSummary }) {
    if (summary.attention === 0 && summary.running === 0) return null;
    return (
        <span
            aria-hidden="true"
            className="project-agent-summary flex flex-none items-center gap-1.5 pr-1 text-[11px] text-muted tabular-nums group-focus-within/project-heading:hidden group-hover/project-heading:hidden group-has-[[data-popup-open]]/project-heading:hidden"
            data-project-attention={summary.attention}
            data-project-running={summary.running}
        >
            {summary.running > 0 && (
                <span className="flex items-center gap-1">
                    <RunningArc className="size-3 text-foreground" strokeWidth={2.5} />
                    {summary.running}
                </span>
            )}
            {summary.attention > 0 && <span className="size-1.5 rounded-full bg-warning" />}
        </span>
    );
}
