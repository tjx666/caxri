import { cn } from '../../lib/utilities';

/**
 * Not a live region. Its timestamp changes on every two-second sample, so announcing it would talk over the user for as
 * long as the window is open while saying nothing they asked for. The table already reports sampling through
 * `aria-busy`, and this line stays readable on demand.
 */
export function ProcessFooter({
    intervalSeconds,
    isLive,
    sampledAt,
}: {
    intervalSeconds: number;
    isLive: boolean;
    sampledAt?: number;
}) {
    return (
        <footer className="flex items-center gap-1.5 border-t border-border px-3 text-[11px] text-muted">
            <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-full', isLive ? 'bg-success' : 'bg-muted')}
            />
            Live · updates every {intervalSeconds} seconds
            <span className="ml-auto tabular-nums">
                {sampledAt === undefined
                    ? 'No current sample'
                    : `Updated ${new Date(sampledAt).toLocaleTimeString('en-US')}`}
            </span>
        </footer>
    );
}
