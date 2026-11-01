/**
 * Failed E2E case summary for `watch-ci.ts`. A failed hosted E2E job otherwise ends the watcher with only the job name,
 * and finding the failing specs meant downloading the whole log and filtering the public reporter's `CAXRI_E2E_PUBLIC`
 * lines by hand. Job logs exist only once the run completes, so this runs after a failed run settles.
 */

import { execFileAsync } from './exec';

const PUBLIC_MARKER = 'CAXRI_E2E_PUBLIC ';

interface PublicTestEnd {
    event?: string;
    failureClass?: { frames?: string[]; kind?: string; matcher?: string };
    location?: string;
    retry?: number;
    status?: string;
}

/**
 * Formats each failed or timed-out `test-end` event of `scripts/reporters/public-e2e-reporter.ts` in `log` as one line,
 * keeping the reporter's order. Lines that are not valid public events are skipped.
 */
export function summarizeE2EFailures(log: string): string[] {
    const failures: string[] = [];
    for (const line of log.split('\n')) {
        const markerIndex = line.indexOf(PUBLIC_MARKER);
        if (markerIndex === -1) continue;
        let event: PublicTestEnd;
        try {
            event = JSON.parse(line.slice(markerIndex + PUBLIC_MARKER.length)) as PublicTestEnd;
        } catch {
            continue;
        }
        if (
            event.event !== 'test-end' ||
            (event.status !== 'failed' && event.status !== 'timedOut')
        )
            continue;
        const where = event.failureClass?.frames?.[0] ?? event.location ?? 'unknown location';
        const kind = [event.failureClass?.kind ?? 'unclassified', event.failureClass?.matcher]
            .filter(Boolean)
            .join(' ');
        failures.push(`${where} · ${event.status} · ${kind} · retry ${event.retry ?? 0}`);
    }
    return failures;
}

/**
 * Prints the failed E2E cases of a settled run; a log that cannot be read is reported, never fatal.
 */
export async function printE2EFailures(runId: string): Promise<void> {
    let log: string;
    try {
        ({ stdout: log } = await execFileAsync('gh', ['run', 'view', runId, '--log-failed'], {
            maxBuffer: 256 * 1024 * 1024,
            timeout: 120_000,
        }));
    } catch (error) {
        console.log(`run ${runId}: failed E2E cases unavailable (${String(error)})`);
        return;
    }
    const failures = summarizeE2EFailures(log);
    if (failures.length === 0) return;
    console.log(`run ${runId}: failed E2E cases`);
    for (const failure of failures) console.log(`  ${failure}`);
}
