import { cn } from '@/lib/utilities';

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

type LoadingSkeletonProperties = {
    /**
     * Announced through the region's `role="status"`; the shapes themselves are decorative.
     */
    label: string;
    className?: string;
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
);

/**
 * A loading placeholder shaped like the content it stands in for, so a surface keeps its layout while it waits instead
 * of collapsing to a centered "Loading…" line and then jumping when the rows arrive. The region is one `role="status"`
 * named by `label`, so assistive tech still hears what is loading.
 */
export function LoadingSkeleton(properties: LoadingSkeletonProperties) {
    const { label, className } = properties;
    const region = {
        'role': 'status',
        'aria-label': label,
        'aria-busy': true,
    } as const;
    if (properties.variant === 'list') {
        const { rows = 6, indent = 8 } = properties;
        return (
            <div {...region} className={cn('flex min-w-0 flex-col', className)}>
                {Array.from({ length: rows }, (_, index) => (
                    <div
                        key={index}
                        className="flex h-7 shrink-0 items-center gap-2 pr-3"
                        style={{ paddingLeft: `${indent}px` }}
                    >
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
