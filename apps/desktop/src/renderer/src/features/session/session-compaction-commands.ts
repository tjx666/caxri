import type {
    SessionCompactionOutcome,
    SessionCompactionResult,
    SessionInterruptCompactionResult,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { dismissToastsMatching, pushToast, tryCommand } from '../../stores/toasts';

const batch = { running: false };

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
    const details = [...counts].map(([outcome, count]: [SessionCompactionOutcome, number]) =>
        translate(`session.compaction.outcome.${outcome}`, { count }),
    );
    if (result.deferred)
        details.push(translate('session.compaction.deferred', { count: result.deferred }));
    const headline = submitted
        ? translate(
              submitted === 1
                  ? 'session.compaction.requestedOne'
                  : 'session.compaction.requestedOther',
              { count: submitted },
          )
        : translate('session.compaction.noneEligible');
    return details.length > 0
        ? translate('session.compaction.withSkipped', {
              headline,
              details: details.join(translate('session.compaction.detailSeparator')),
          })
        : headline;
}

/**
 * Prefixes the batch description with how many running turns were interrupted first, when any were.
 */
export function describeInterruptCompaction(result: SessionInterruptCompactionResult): string {
    const description = describeSessionCompaction(result);
    if (result.interrupted === 0) return description;
    const interrupted = translate(
        result.interrupted === 1
            ? 'session.compaction.interruptedOne'
            : 'session.compaction.interruptedOther',
        { count: result.interrupted },
    );
    return `${interrupted} ${description}`;
}

/**
 * Both palette actions scan all visible Sessions and share one in-flight guard; the Server owns eligibility and
 * generation checks.
 */
async function runCompactionBatch<Result extends SessionCompactionResult>(
    progressKey: 'session.compaction.interruptProgress' | 'session.compaction.progress',
    request: () => Promise<Result>,
    describe: (result: Result) => string,
): Promise<void> {
    if (batch.running) return;
    batch.running = true;
    // Captured once so dismissal matches the exact text that was shown, even if the language changes mid-batch.
    const progressMessage = translate(progressKey);
    pushToast('info', progressMessage, { history: false });
    try {
        const result = await tryCommand(translate('session.compaction.failed'), request);
        dismissToastsMatching((message) => message === progressMessage);
        if (result)
            pushToast(
                result.items.some(
                    ({ outcome }) => outcome === 'failed' || outcome === 'delivery_unknown',
                )
                    ? 'warning'
                    : 'info',
                describe(result),
            );
    } finally {
        dismissToastsMatching((message) => message === progressMessage);
        batch.running = false;
    }
}

export async function compactWarmSessions(): Promise<void> {
    await runCompactionBatch(
        'session.compaction.progress',
        () => caxri.request('session.compactWarm', {}),
        describeSessionCompaction,
    );
}

/**
 * Interrupts every running turn first; the interrupted Agents stay idle afterwards.
 */
export async function interruptAndCompactSessions(): Promise<void> {
    await runCompactionBatch(
        'session.compaction.interruptProgress',
        () => caxri.request('session.interruptAndCompact', {}),
        describeInterruptCompaction,
    );
}
