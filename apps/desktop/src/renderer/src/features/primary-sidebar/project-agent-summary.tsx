import type { SessionStatusSummary } from './session-status';
import { RunningArc } from './session-status-indicator';

/**
 * The collapsed heading's decorative Agent summary: a small running arc with its count, then one attention dot. Only
 * the dot carries amber, matching the rows, where amber always means unread.
 *
 * It stays visible while the heading's hover actions show. The heading already pads its trailing edge by the actions'
 * width, and the summary sits inside the title button before that padding, so the name fades first and nothing
 * overlaps. Hiding it on `focus-within` instead kept it hidden after a pointer collapse, because the clicked chevron
 * keeps focus inside the heading, which is exactly the moment the summary has to appear.
 */
export function ProjectAgentSummary({ summary }: { summary: SessionStatusSummary }) {
    if (summary.attention === 0 && summary.running === 0) return null;
    return (
        <span
            aria-hidden="true"
            className="project-agent-summary flex flex-none items-center gap-1.5 pr-1 text-[11px] text-muted tabular-nums"
            data-project-attention={summary.attention}
            data-project-running={summary.running}
        >
            {summary.running > 0 && (
                <span className="flex items-center gap-1">
                    <RunningArc />
                    {summary.running}
                </span>
            )}
            {summary.attention > 0 && <span className="size-1.5 rounded-full bg-warning" />}
        </span>
    );
}
