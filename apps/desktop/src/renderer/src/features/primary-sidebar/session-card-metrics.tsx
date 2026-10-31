import { Skeleton } from '../../components/ui/skeleton';
import { useTranslation } from '../../i18n';
import { useSessionCardGlance } from './hooks/use-session-card-glance';
import { sessionCardMetrics } from './session-card-glance';

/**
 * Live CPU and memory plus all-time spend, read when the card opens. While the first read is in flight an Agent Session
 * reserves the line with a placeholder, since it almost always has spend to show, so the card does not grow a line
 * under the pointer; a shell Session reserves nothing and simply gains the line if a reading arrives.
 */
export function SessionCardMetrics({
    reserveSpace,
    sessionId,
}: {
    reserveSpace: boolean;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const { cost, isLoading, resources } = useSessionCardGlance(sessionId);
    const metrics = sessionCardMetrics(resources, cost, t);
    if (metrics.length === 0)
        return isLoading && reserveSpace ? (
            <div className="mt-1 flex h-4.5 items-center">
                <Skeleton className="h-2.5 w-36" />
            </div>
        ) : null;
    return (
        <p className="session-card-metrics mt-1 mb-0 flex h-4.5 min-w-0 items-center gap-3 text-[12px] text-muted tabular-nums">
            {metrics.map(({ kind, label, name, value }) => (
                <span
                    key={kind}
                    aria-label={label}
                    className="flex flex-none items-baseline gap-1"
                    data-metric={kind}
                    role="img"
                >
                    {name}
                    <span className="text-foreground">{value}</span>
                </span>
            ))}
        </p>
    );
}
