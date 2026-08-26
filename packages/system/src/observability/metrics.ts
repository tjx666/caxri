export const observationMetricNames = [
    'changefeed.lag',
    'changefeed.snapshot',
    'connection.buffered_bytes',
    'connection.closed',
    'persistence.contention',
    'persistence.latency',
    'process.memory',
    'process.open_fds',
    'process.restarts',
    'pty.dropped_bytes',
    'pty.throughput',
    'queue.depth',
    'queue.wait',
    'startup.phase',
    'watcher.count',
] as const;

export const observationOwners = [
    'control',
    'server-core',
    'terminal-host',
    'extension-host',
    'persistence',
    'stream',
] as const;

export const observationPhases = [
    'admission',
    'attach',
    'commit',
    'execute',
    'flush',
    'probe',
    'recovery',
    'runtime',
    'shutdown',
    'startup',
    'transfer',
] as const;

export const observationOutcomes = [
    'cancelled',
    'failure',
    'overflow',
    'restart',
    'success',
    'timeout',
] as const;

export type ObservationMetricName = (typeof observationMetricNames)[number];
export type ObservationOwner = (typeof observationOwners)[number];
export type ObservationPhase = (typeof observationPhases)[number];
export type ObservationOutcome = (typeof observationOutcomes)[number];

export interface ObservationMetricLabels {
    outcome?: ObservationOutcome;
    owner: ObservationOwner;
    phase?: ObservationPhase;
}

export interface ObservationMetricSnapshot {
    average: number;
    count: number;
    labels: ObservationMetricLabels;
    last: number;
    maximum: number;
    minimum: number;
    name: ObservationMetricName;
    total: number;
}

export interface ObservationMetricRegistrySnapshot {
    rejectedSeries: number;
    series: ObservationMetricSnapshot[];
}

type ObservationMetricAggregate = ObservationMetricSnapshot;

export const MAX_OBSERVATION_METRIC_SERIES = 256;

function metricKey(name: ObservationMetricName, labels: ObservationMetricLabels): string {
    return `${name}:${labels.owner}:${labels.phase ?? ''}:${labels.outcome ?? ''}`;
}

/**
 * In-memory aggregates only: no exporter, per-request samples, or arbitrary labels. The fixed label vocabulary and hard
 * series ceiling make collection constant-space even when callers handle untrusted projects and requests.
 */
export class BoundedMetricRegistry {
    private readonly aggregates = new Map<string, ObservationMetricAggregate>();
    private rejectedSeries = 0;

    record(name: ObservationMetricName, value: number, labels: ObservationMetricLabels): void {
        if (!Number.isFinite(value) || value < 0) return;
        const key = metricKey(name, labels);
        const aggregate = this.aggregates.get(key);
        if (aggregate) {
            aggregate.count += 1;
            aggregate.last = value;
            aggregate.maximum = Math.max(aggregate.maximum, value);
            aggregate.minimum = Math.min(aggregate.minimum, value);
            aggregate.total += value;
            aggregate.average = aggregate.total / aggregate.count;
            return;
        }
        if (this.aggregates.size >= MAX_OBSERVATION_METRIC_SERIES) {
            this.rejectedSeries += 1;
            return;
        }
        this.aggregates.set(key, {
            average: value,
            count: 1,
            labels: { ...labels },
            last: value,
            maximum: value,
            minimum: value,
            name,
            total: value,
        });
    }

    snapshot(): ObservationMetricRegistrySnapshot {
        return {
            rejectedSeries: this.rejectedSeries,
            series: this.aggregates
                .values()
                .map((aggregate) => ({ ...aggregate, labels: { ...aggregate.labels } }))
                .toArray()
                .toSorted((left, right) =>
                    metricKey(left.name, left.labels).localeCompare(
                        metricKey(right.name, right.labels),
                    ),
                ),
        };
    }
}
