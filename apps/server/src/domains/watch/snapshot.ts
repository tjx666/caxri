const MAX_SNAPSHOT_LABELS = 64;

interface WatchHubSnapshotEntry {
    label: string;
    native: number;
    polling: number;
    eventBatches: number;
    lastEventAt?: number;
}

export interface WatchHubSnapshot {
    registrations: number;
    native: number;
    polling: number;
    gateTrips: number;
    entries: WatchHubSnapshotEntry[];
}

/**
 * What the census reads from one registration.
 */
interface CensusEntry {
    readonly label: string;
    readonly mode: string;
    readonly eventBatches: number;
    readonly lastEventAt?: number;
}

/**
 * Content-free listener census for diagnostics: counts and labels only, never paths.
 */
export function summarizeWatchRegistrations(
    registrations: Iterable<CensusEntry>,
    gateTrips: number,
): WatchHubSnapshot {
    const byLabel = new Map<string, WatchHubSnapshotEntry>();
    let count = 0;
    let native = 0;
    let polling = 0;
    for (const entry of registrations) {
        count += 1;
        if (entry.mode === 'native') native += 1;
        else if (entry.mode === 'polling') polling += 1;
        const aggregate = byLabel.get(entry.label) ?? {
            label: entry.label,
            native: 0,
            polling: 0,
            eventBatches: 0,
        };
        if (entry.mode === 'native') aggregate.native += 1;
        else if (entry.mode === 'polling') aggregate.polling += 1;
        aggregate.eventBatches += entry.eventBatches;
        if (
            entry.lastEventAt !== undefined &&
            (aggregate.lastEventAt === undefined || entry.lastEventAt > aggregate.lastEventAt)
        )
            aggregate.lastEventAt = entry.lastEventAt;
        byLabel.set(entry.label, aggregate);
    }
    return {
        registrations: count,
        native,
        polling,
        gateTrips,
        entries: byLabel
            .values()
            .toArray()
            .toSorted((left, right) => left.label.localeCompare(right.label))
            .slice(0, MAX_SNAPSHOT_LABELS),
    };
}
