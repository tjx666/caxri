import type { AgentProvider } from '@caxri/protocol';
import { formatUsd } from '@caxri/protocol';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { useTranslation } from '../../i18n';
import { LOCAL_TIME_ZONE } from '../usage/usage-custom-range';
import { useUsageFilterStore } from '../usage/usage-filter-store';
import { dailyCostSeries } from './agent-usage-label';
import { StatusBars } from './status-bars';

/**
 * Matches the Usage page: the report rescans only changed transcripts, and a day's spend moves slowly.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Bars wide enough that a week of days does not read as a sparkline of samples.
 */
const DAY_BAR_WIDTH = 8;

/**
 * The Agent's estimated spend per local day over the last week, today last, captioned with the busiest day. Counts
 * every conversation of this Agent in the Usage page's remembered scope, so the bars agree with that page's Activity
 * chart. It lives inside the hover card so the report is only requested while the card is open; the TanStack cache
 * makes the next hover instant.
 */
export function AgentDailyCostBars({ provider }: { provider: AgentProvider }) {
    const { t } = useTranslation();
    const scope = useUsageFilterStore((state) => state.scope);
    const { data: report, isError } = usePolledQuery(
        'usage.report',
        { timeZone: LOCAL_TIME_ZONE, range: '7d', provider, scope },
        { label: 'Usage chip daily cost', intervalMs: REFRESH_INTERVAL_MS, retry: false },
    );
    if (!report) {
        // Reserve the chart's height while loading so the card does not grow under the pointer.
        return isError ? t('statusBar.usage.dailyCostUnavailable') : <span className="block h-6" />;
    }
    const days = dailyCostSeries(report.activity, report.today);
    if (days.every((day) => day.costUsd === 0)) return t('statusBar.usage.dailyCostNone');
    return (
        <StatusBars
            barWidth={DAY_BAR_WIDTH}
            bars={days.map((day) => ({ key: day.date, value: day.costUsd }))}
            caption={(max) => t('statusBar.usage.dailyCostMax', { cost: formatUsd(max) })}
        />
    );
}
