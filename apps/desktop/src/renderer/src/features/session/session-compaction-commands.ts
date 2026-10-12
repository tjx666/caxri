import type { SessionCompactionOutcome, SessionCompactionResult } from '@caxri/protocol';

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
 * One palette action scans all visible Sessions; the Server owns eligibility and generation checks.
 */
export async function compactWarmSessions(): Promise<void> {
    if (batch.running) return;
    batch.running = true;
    // Captured once so dismissal matches the exact text that was shown, even if the language changes mid-batch.
    const progressMessage = translate('session.compaction.progress');
    pushToast('info', progressMessage, { history: false });
    try {
        const result = await tryCommand(translate('session.compaction.failed'), () =>
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
