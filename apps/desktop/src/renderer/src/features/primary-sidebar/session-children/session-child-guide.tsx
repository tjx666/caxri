import { cn } from '../../../lib/utilities';
import type { SessionChildGuideInput } from './session-child-guide-paths';
import { sessionChildGuidePaths } from './session-child-guide-paths';

/**
 * The decorative branch guide of one child list under a host Session row (issue #4092): a trunk under the host's Agent
 * icon and a rounded branch to each child's glyph, with the path to the selected child drawn brighter, the way VS Code
 * lights the active indent guide. One SVG per list rather than a border per row, so the trunk never shows a hairline
 * seam between rows and every arc has the same radius.
 *
 * Not a click target and hidden from assistive tech: the tree's `aria-level` already says the rows are children.
 */
export function SessionChildGuide({
    className,
    ...input
}: SessionChildGuideInput & { className?: string }) {
    const { height, paths, selectedPath } = sessionChildGuidePaths(input);
    if (paths.length === 0) return null;
    return (
        <svg
            aria-hidden="true"
            className={cn(
                'session-child-guide pointer-events-none absolute top-0 left-0 overflow-visible text-muted',
                className,
            )}
            fill="none"
            height={height}
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={1}
            width={40}
        >
            {/* One faded group: the trunk segments the branches share are composited once, so they never darken. */}
            <g opacity={0.35}>
                {paths.map((path) => (
                    <path key={path} d={path} />
                ))}
            </g>
            {selectedPath && <path d={selectedPath} opacity={0.85} />}
        </svg>
    );
}
