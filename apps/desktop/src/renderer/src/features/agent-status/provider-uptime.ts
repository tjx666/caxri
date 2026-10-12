import type { AgentProviderServiceStatus, AgentProviderStatusUptime } from '@caxri/protocol';
import { agentProviderServiceStatuses } from '@caxri/protocol';

/**
 * Days drawn in a component's uptime strip, the same window status.openai.com draws.
 */
const PROVIDER_UPTIME_DAYS = 90;

export interface ProviderUptimeDay {
    /**
     * Local midnight the day starts at, epoch milliseconds.
     */
    start: number;
    /**
     * Worst status any impact gave the component during the day; `noData` before the page started recording it.
     */
    status: AgentProviderServiceStatus | 'noData';
}

const statusRank = new Map(agentProviderServiceStatuses.map((status, index) => [status, index]));

function localMidnight(time: number, dayOffset = 0): number {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    // `setDate` rather than adding 24 hours, so a day that gains or loses an hour to daylight saving still starts at
    // midnight.
    date.setDate(date.getDate() + dayOffset);
    return date.getTime();
}

/**
 * Splits a component's impact intervals into the {@link PROVIDER_UPTIME_DAYS} local days ending on the day the window
 * ends, oldest first, each colored by its worst impact. An open impact lasts until the window's end.
 */
export function providerUptimeDays(
    uptime: AgentProviderStatusUptime,
    count = PROVIDER_UPTIME_DAYS,
): ProviderUptimeDay[] {
    return Array.from({ length: count }, (_, index): ProviderUptimeDay => {
        const start = localMidnight(uptime.windowEnd, index - count + 1);
        const end = localMidnight(uptime.windowEnd, index - count + 2);
        if (uptime.dataAvailableSince !== undefined && end <= uptime.dataAvailableSince)
            return { start, status: 'noData' };
        let status: AgentProviderServiceStatus = 'operational';
        for (const impact of uptime.impacts) {
            const isOverlaps = impact.startAt < end && (impact.endAt ?? uptime.windowEnd) > start;
            if (isOverlaps && (statusRank.get(impact.status) ?? 0) > (statusRank.get(status) ?? 0))
                status = impact.status;
        }
        return { start, status };
    });
}

const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/**
 * `99.95`, or `100` rather than `100.00`, as the status page itself prints it.
 */
export function formatUptimePercent(percent: number): string {
    return percentFormat.format(percent);
}
