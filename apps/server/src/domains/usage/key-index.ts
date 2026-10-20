import type { UsageRecord } from './record';

/**
 * Which transcript holds a set of billed-unit digests, so a unit copied into several transcripts is counted by exactly
 * one: the earliest-created file, ties broken by reference. `claude --resume <id> --fork-session` and a Grok resume or
 * fork copy earlier units (IDs and timestamps unchanged) into a new file, which is always created after its source.
 *
 * Scan order is arbitrary (the outside-Caxri scan reads newest first, and several transcripts are scanned at once), so
 * a copy may be scanned before or while its source is indexed and count the shared units. {@link store} reports every
 * such copy, including the record being indexed when a source arrived during its scan; rescanning it then skips them.
 * Each transcript is rescanned at most once per newly indexed source.
 */
export class UsageKeyIndex {
    /**
     * Digest → holder → the {@link version} at which the holder indexed it.
     */
    private readonly holders = new Map<string, Map<string, number>>();
    private readonly keysByReference = new Map<string, readonly string[]>();
    private readonly bornAtByReference = new Map<string, number>();
    /**
     * References whose `bornAt` moved later since their last {@link store}, with the earliest value they held. The scan
     * announces the new `bornAt` through {@link countedElsewhere} before its record is stored.
     */
    private readonly movedLaterFrom = new Map<string, number>();
    /**
     * Advances on every {@link store}; a scan notes it at its start and passes it back when its record is indexed.
     */
    version = 0;

    private ranksBefore(left: string, right: string): boolean {
        const leftBornAt = this.bornAtByReference.get(left) ?? Infinity;
        const rightBornAt = this.bornAtByReference.get(right) ?? Infinity;
        return leftBornAt < rightBornAt || (leftBornAt === rightBornAt && left < right);
    }

    private noteBornAt(reference: string, bornAt: number): void {
        const known = this.bornAtByReference.get(reference);
        if (known !== undefined && bornAt > known)
            this.movedLaterFrom.set(
                reference,
                Math.min(this.movedLaterFrom.get(reference) ?? known, known),
            );
        this.bornAtByReference.set(reference, bornAt);
    }

    /**
     * The predicate a scan of `reference` uses to skip units an earlier-ranked transcript already counts. `bornAt` is
     * the file's current creation time, which ranks it even before its first record is indexed.
     */
    countedElsewhere(reference: string, bornAt: number): (digest: string) => boolean {
        this.noteBornAt(reference, bornAt);
        return (digest) => {
            const holders = this.holders.get(digest);
            if (!holders) return false;
            for (const holder of holders.keys())
                if (holder !== reference && this.ranksBefore(holder, reference)) return true;
            return false;
        };
    }

    /**
     * Indexes the units a freshly stored record holds and returns the transcripts that may have counted a unit another
     * one owns, so they need a rescan: later-ranked holders of this record's new units, and this record itself when an
     * earlier-ranked holder indexed one of its units after `scannedSince` (the {@link version} its scan started at),
     * which its skip predicate could not have seen. When the record's `bornAt` moved later (its source file was
     * rewritten), holders of the same units that now rank before it are reported too: they skipped those units while it
     * owned them, and the rewrite made them the owner.
     */
    store(
        reference: string,
        record: Pick<UsageRecord, 'keys' | 'bornAt'> | undefined,
        scannedSince = Infinity,
    ): string[] {
        this.version += 1;
        const previous = new Set(this.keysByReference.get(reference));
        for (const digest of previous) this.holders.get(digest)?.delete(reference);
        const keys = record?.keys ?? [];
        if (record?.bornAt !== undefined) this.noteBornAt(reference, record.bornAt);
        const movedFrom = this.movedLaterFrom.get(reference);
        this.movedLaterFrom.delete(reference);
        if (keys.length === 0) {
            this.keysByReference.delete(reference);
            return [];
        }
        this.keysByReference.set(reference, keys);
        const stale = new Set<string>();
        for (const digest of keys) {
            let holders = this.holders.get(digest);
            if (!holders) {
                holders = new Map();
                this.holders.set(digest, holders);
            }
            for (const [holder, indexedAt] of holders) {
                if (holder !== reference) {
                    if (this.ranksBefore(reference, holder)) {
                        if (!previous.has(digest)) stale.add(holder);
                    } else {
                        if (indexedAt > scannedSince) stale.add(reference);
                        if (
                            movedFrom !== undefined &&
                            (this.bornAtByReference.get(holder) ?? Infinity) >= movedFrom
                        )
                            stale.add(holder);
                    }
                }
            }
            holders.set(reference, this.version);
        }
        return [...stale];
    }
}
