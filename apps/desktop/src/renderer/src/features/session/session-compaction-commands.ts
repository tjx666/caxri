import type { SessionCompactionOutcome, SessionCompactionResult } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { dismissToastsMatching, pushToast, tryCommand } from '../../stores/toasts';

const descriptions: Record<SessionCompactionOutcome, string> = {
    submitted: 'submitted',
    unsupported: 'unsupported Agent',
    not_running: 'Agent stopped',
    busy: 'busy or compacting',
    unsafe_input: 'draft or idle state unverified',
    usage_unavailable: 'usage unavailable',
    already_compacted: 'already compacted',
    cache_expired: 'cache estimated expired',
    changed: 'state changed',
    failed: 'delivery failed',
    delivery_unknown: 'delivery unconfirmed',
};
const batch = { running: false };
const progressMessage = 'Checking Sessions for warm-cache compaction…';

/**
 * A short headline plus at most one trailing clause, not the four-clause sentence this used to compose: `pushToast` has
 * no generic description slot to hold the skipped/unconfirmed breakdown separately (`stores/toasts.ts` reserves
 * `description` for the reminder mute menu), so that breakdown stays the one clause a toast is allowed, and the "cache
 * availability is estimated" / "requests continue in their Agent windows" boilerplate is dropped rather than folded in
 * beside it.
 */
export function describeSessionCompaction(result: SessionCompactionResult): string {
    const counts = new Map<SessionCompactionOutcome, number>();
    for (const item of result.items) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
    const submitted = counts.get('submitted') ?? 0;
    counts.delete('submitted');
    const details = [...counts].map(([outcome, count]) => `${count} ${descriptions[outcome]}`);
    if (result.deferred) details.push(`${result.deferred} beyond the 200-Session batch limit`);
    const headline = submitted
        ? `Compaction requested for ${submitted} ${submitted === 1 ? 'Session' : 'Sessions'}.`
        : 'No Sessions were eligible for compaction.';
    return details.length > 0 ? `${headline} Skipped: ${details.join('; ')}.` : headline;
}

/**
 * One palette action scans all visible Sessions; the Server owns eligibility and generation checks.
 */
export async function compactWarmSessions(): Promise<void> {
    if (batch.running) return;
    batch.running = true;
    pushToast('info', progressMessage, { history: false });
    try {
        const result = await tryCommand('Batch compaction failed', () =>
            caxri.request('session.compactWarm', {}),
        );
        dismissToastsMatching((message) => message === progressMessage);
        if (result)
            pushToast(
                result.items.some(
                    ({ outcome }) => outcome === 'failed' || outcome === 'delivery_unknown',
                )
                    ? 'warning'
                    : 'info',
                describeSessionCompaction(result),
            );
    } finally {
        dismissToastsMatching((message) => message === progressMessage);
        batch.running = false;
    }
}
