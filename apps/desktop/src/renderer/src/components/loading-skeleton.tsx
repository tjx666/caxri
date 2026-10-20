import type { ReactNode } from 'react';
import { createContext, useContext, useLayoutEffect, useState } from 'react';

import { cn } from '@/lib/utilities';

import type { LoadingSkeletonClock } from './loading-skeleton-delay';
import {
    claimLoadingSkeletonClock,
    createLoadingSkeletonClock,
    releaseLoadingSkeletonClock,
    remainingLoadingSkeletonDelay,
    scheduleLoadingSkeletonReveal,
} from './loading-skeleton-delay';
import { Skeleton } from './ui/skeleton';

/**
 * Widths come from fixed tables rather than `Math.random()` so render stays pure and a remount never reshuffles them.
 */
const LIST_ROW_WIDTHS = ['62%', '44%', '76%', '52%', '68%', '38%', '58%', '48%'];
/**
 * `width: undefined` is a blank line, the gap between two blocks of text.
 */
const DOCUMENT_LINES: ReadonlyArray<{ indent: number; width?: string }> = [
    { indent: 0, width: '34%' },
    { indent: 1, width: '58%' },
    { indent: 1, width: '46%' },
    { indent: 2, width: '64%' },
    { indent: 2, width: '40%' },
    { indent: 1, width: '28%' },
    { indent: 0 },
    { indent: 0, width: '42%' },
    { indent: 1, width: '70%' },
    { indent: 1, width: '52%' },
    { indent: 0, width: '16%' },
    { indent: 0 },
    { indent: 0, width: '38%' },
    { indent: 1, width: '60%' },
];
const DOCUMENT_INDENT_REM = 1.25;
/**
 * One tree level's indent in pixels, matching the extension tree rows (`extension-tree-item-row.tsx`).
 */
const TREE_LEVEL_INDENT = 14;
/**
 * One Chat turn per entry: the width of the user's message bubble, then the widths of the reply's lines.
 */
const TRANSCRIPT_TURNS: ReadonlyArray<{ prompt: string; reply: readonly string[] }> = [
    { prompt: '46%', reply: ['92%', '84%', '58%'] },
    { prompt: '28%', reply: ['88%', '96%', '72%', '40%'] },
    { prompt: '38%', reply: ['80%', '64%'] },
];

const LoadingSkeletonClockContext = createContext<LoadingSkeletonClock | undefined>(undefined);

/**
 * Makes the placeholders inside one surface (an editor pane, a tree view) share one wait. A placeholder that takes over
 * from another, such as the editor module load after the file read, continues that wait's delay instead of restarting
 * it, so the surface never draws a skeleton, goes blank, and draws it again. Outside a scope every placeholder times
 * its own wait.
 */
export function LoadingSkeletonScope({ children }: { children: ReactNode }) {
    const [clock] = useState(createLoadingSkeletonClock);
    return (
        <LoadingSkeletonClockContext.Provider value={clock}>
            {children}
        </LoadingSkeletonClockContext.Provider>
    );
}

type LoadingSkeletonProperties = {
    /**
     * Announced through the region's `role="status"`; the shapes themselves are decorative.
     */
    label: string;
    className?: string;
    /**
     * Draws the shapes in the first frame instead of after `LOADING_SKELETON_DELAY_MS`. Only for a region inside a
     * surface that is already on screen, where a blank region would read as real empty content rather than a wait: a
     * Chat transcript under its own header and composer looks like an empty conversation until its turns arrive.
     */
    isImmediate?: boolean;
} & (
    | {
          /**
           * Tree and list rows: an icon slot and a label bar per row, at the 28px row height the view trees use.
           */
          variant: 'list';
          rows?: number;
          /**
           * Left padding in pixels, so a nested branch's placeholder lines up with that branch's children.
           */
          indent?: number;
          /**
           * Per-row nesting below `indent`, one tree level ({@link TREE_LEVEL_INDENT}) each, so a view's first load
           * reads as a parent and its children rather than a flat list. A row with a deeper row after it draws a
           * disclosure chevron slot; a leaf draws the matching spacer. Omitted, every row sits at `indent` with no
           * slot.
           */
          depths?: readonly number[];
      }
    | {
          /**
           * Indented text lines for an editor, diff, transcript, preview, or log body.
           */
          variant: 'document';
          lines?: number;
      }
    | {
          /**
           * A page heading over a column of bordered cards, for Settings, Usage, and status pages.
           */
          variant: 'page';
          cards?: number;
      }
    | {
          /**
           * Chat turns: a user message bubble on the right over the reply's text lines, for an Agent Chat transcript.
           */
          variant: 'transcript';
      }
);

/**
 * A loading placeholder shaped like the content it stands in for, so a surface keeps its layout while it waits instead
 * of collapsing to a centered "Loading…" line and then jumping when the rows arrive. The region is one `role="status"`
 * named by `label`, so assistive tech still hears what is loading.
 *
 * The region mounts at once (still `aria-busy`, still named), but its shapes wait `LOADING_SKELETON_DELAY_MS`: a local
 * load that finishes first never flashes a skeleton. Inside a `LoadingSkeletonScope` the delay counts from when the
 * scope's wait began, not from this mount.
 */
export function LoadingSkeleton(properties: LoadingSkeletonProperties) {
    const { label, className, isImmediate = false } = properties;
    const clock = useContext(LoadingSkeletonClockContext);
    const [isRevealed, setRevealed] = useState(isImmediate);
    // A layout effect, so a placeholder continuing a wait already past the delay draws its shapes before the first
    // paint instead of showing one blank frame.
    useLayoutEffect(() => {
        if (isImmediate) return;
        const now = performance.now();
        const startedAt = clock ? claimLoadingSkeletonClock(clock, now) : now;
        const remaining = remainingLoadingSkeletonDelay(startedAt, now);
        const cancel =
            remaining === 0
                ? undefined
                : scheduleLoadingSkeletonReveal(() => setRevealed(true), undefined, remaining);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- must land before paint, see above
        if (remaining === 0) setRevealed(true);
        return () => {
            cancel?.();
            if (clock) releaseLoadingSkeletonClock(clock, performance.now());
        };
    }, [clock, isImmediate]);
    const region = {
        'role': 'status',
        'aria-label': label,
        'aria-busy': true,
    } as const;
    if (!isRevealed) return <div {...region} className={cn('min-w-0', className)} />;
    if (properties.variant === 'list') {
        const { depths, indent = 8 } = properties;
        const rows = depths?.length ?? properties.rows ?? 6;
        return (
            <div {...region} className={cn('flex min-w-0 flex-col', className)}>
                {Array.from({ length: rows }, (_, index) => (
                    <div
                        key={index}
                        className="flex h-7 shrink-0 items-center gap-2 pr-3"
                        style={{
                            paddingLeft: `${indent + (depths?.[index] ?? 0) * TREE_LEVEL_INDENT}px`,
                        }}
                    >
                        {depths &&
                            ((depths[index + 1] ?? -1) > depths[index] ? (
                                <Skeleton className="size-2.5 shrink-0" />
                            ) : (
                                <span aria-hidden="true" className="w-2.5 shrink-0" />
                            ))}
                        <Skeleton className="size-3.5 shrink-0" />
                        <Skeleton
                            className="h-2.5"
                            style={{ width: LIST_ROW_WIDTHS[index % LIST_ROW_WIDTHS.length] }}
                        />
                    </div>
                ))}
            </div>
        );
    }
    if (properties.variant === 'document') {
        const { lines = DOCUMENT_LINES.length } = properties;
        return (
            <div
                {...region}
                className={cn(
                    'flex h-full min-w-0 flex-col gap-2.5 overflow-hidden p-4',
                    className,
                )}
            >
                {Array.from({ length: lines }, (_, index) => {
                    const line = DOCUMENT_LINES[index % DOCUMENT_LINES.length];
                    return line.width ? (
                        <Skeleton
                            key={index}
                            className="h-2.5 shrink-0"
                            style={{
                                marginLeft: `${line.indent * DOCUMENT_INDENT_REM}rem`,
                                width: line.width,
                            }}
                        />
                    ) : (
                        <div key={index} aria-hidden="true" className="h-2.5 shrink-0" />
                    );
                })}
            </div>
        );
    }
    if (properties.variant === 'transcript') {
        return (
            <div {...region} className={cn('flex min-w-0 flex-col gap-3', className)}>
                {TRANSCRIPT_TURNS.map((turn, index) => (
                    <div key={index} aria-hidden="true" className="flex flex-col gap-3">
                        <Skeleton
                            className="h-9 self-end rounded-lg"
                            style={{ width: turn.prompt }}
                        />
                        <div className="flex flex-col gap-2.5 py-1">
                            {turn.reply.map((width, line) => (
                                <Skeleton key={line} className="h-2.5" style={{ width }} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }
    const { cards = 3 } = properties;
    return (
        <div
            {...region}
            className={cn('flex h-full min-w-0 flex-col gap-4 overflow-hidden p-6', className)}
        >
            <Skeleton className="h-4 w-40 shrink-0" />
            {Array.from({ length: cards }, (_, index) => (
                <div
                    key={index}
                    aria-hidden="true"
                    className="flex shrink-0 flex-col gap-2.5 rounded-md border border-border p-4"
                >
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-2.5 w-[72%]" />
                    <Skeleton className="h-2.5 w-[54%]" />
                </div>
            ))}
        </div>
    );
}
