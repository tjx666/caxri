import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { UsageCostDisplay } from './usage-metrics';

/**
 * One cost figure on the Usage page, worded the same way in every card: `No price` in muted text when none of the usage
 * could be priced, and a muted `partial` beside the figure when some of it could not.
 */
export function UsageCost({
    className,
    display,
}: {
    className?: string;
    display: UsageCostDisplay;
}) {
    const { t } = useTranslation();
    if (display.kind === 'unpriced')
        return (
            <span className={cn(className, 'font-normal text-muted')}>
                {t('usage.cost.noPrice')}
            </span>
        );
    return (
        <span className={cn('tabular-nums', className)}>
            {display.label}
            {display.kind === 'partial' && (
                <span className="font-normal text-muted"> {t('usage.cost.partial')}</span>
            )}
        </span>
    );
}
