import type { SessionCost, SessionResourceUsage } from '@caxri/protocol';
import { formatCpuPercent, formatMemoryMb, formatUsd } from '@caxri/protocol';

import type { Translate } from '../../i18n';

type SessionCardMetricKind = 'cost' | 'cpu' | 'memory';

export interface SessionCardMetric {
    kind: SessionCardMetricKind;
    /**
     * The short visible name before the figure (`CPU`, `Mem`); absent for spend, whose `$` already names it.
     */
    name?: string;
    /**
     * The figure alone (`12%`, `412.0 MB`, `$3.21`).
     */
    value: string;
    /**
     * The figure with its quantity named, for the accessible name and the visible value's tooltip.
     */
    label: string;
}

/**
 * The Session card's metrics line: live CPU and memory while anything of the Session runs, then what its Agent
 * conversations have cost. A metric with no reading is left out rather than shown as zero, so a stopped Session reads
 * as stopped instead of idle, and a Session with no recorded or priced usage does not claim it was free.
 */
export function sessionCardMetrics(
    resources: SessionResourceUsage | null | undefined,
    cost: SessionCost | null | undefined,
    t: Translate,
): SessionCardMetric[] {
    const metrics: SessionCardMetric[] = [];
    if (resources) {
        const cpu = formatCpuPercent(resources.cpuPercent);
        const memory = formatMemoryMb(resources.memoryMb);
        metrics.push(
            {
                kind: 'cpu',
                name: t('primarySidebar.card.cpuName'),
                value: cpu,
                label: t('primarySidebar.card.cpu', { value: cpu }),
            },
            {
                kind: 'memory',
                name: t('primarySidebar.card.memoryName'),
                value: memory,
                label: t('primarySidebar.card.memory', { value: memory }),
            },
        );
    }
    // Nothing but unpriced models adds up to a meaningless `$0+`, so that spend is left out like an unknown one.
    if (cost && !(cost.isPartial && cost.costUsd === 0)) {
        // An unpriced model makes the sum a floor, so the figure says "at least" instead of passing for the total.
        const value = cost.isPartial ? `${formatUsd(cost.costUsd)}+` : formatUsd(cost.costUsd);
        metrics.push({
            kind: 'cost',
            value,
            label: t(
                cost.isPartial ? 'primarySidebar.card.costPartial' : 'primarySidebar.card.cost',
                {
                    value: formatUsd(cost.costUsd),
                },
            ),
        });
    }
    return metrics;
}
