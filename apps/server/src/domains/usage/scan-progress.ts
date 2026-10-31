import { mapWithConcurrency } from '@caxri/system';

import type { DiscoveredTranscript } from '../agents';
import type { UsageTranscriptFiles, UsageTranscriptLocator } from './scanner';

/**
 * Transcripts parsed concurrently during one ledger sync.
 */
export const SCAN_CONCURRENCY = 4;

export interface DescribedTranscript {
    transcript: DiscoveredTranscript;
    files: UsageTranscriptFiles | undefined;
}

/**
 * Stats every outside transcript so the scan can order them newest first. A long history holds thousands of them, and
 * each describe walks the filesystem for side files, so the walks share the parse step's concurrency budget instead of
 * all starting at once.
 */
export function describeOutsideTranscripts(
    queue: readonly DiscoveredTranscript[],
    describe: UsageTranscriptLocator['describe'],
): Promise<DescribedTranscript[]> {
    return mapWithConcurrency(queue, SCAN_CONCURRENCY, async (transcript) => ({
        transcript,
        files: await describe(transcript.provider, transcript.main),
    }));
}

/**
 * Transcripts a report says are still being read. Discovery runs before the queue is counted, so a running scan reports
 * at least one: otherwise the page would read as finished and stop polling quickly while discovery is still walking a
 * large history.
 */
export function reportedPendingScans(isScanning: boolean, counted: number): number {
    return isScanning ? Math.max(1, counted) : 0;
}
