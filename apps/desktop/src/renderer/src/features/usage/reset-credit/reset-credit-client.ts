import type { UsageResetCreditOutcome, UsageResetCredits } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../queries/client';
import { pushToast } from '../../../stores/toasts';

/**
 * The attempt Codex did not confirm, kept until it settles. The next click checks this attempt with the same id instead
 * of starting a new one, so a request that did land is never spent twice. Memory only: a reload starts a fresh attempt,
 * which the Server rechecks against the account's windows, so at worst a spent credit is not spent again because the
 * windows are no longer nearly used up.
 */
const attempt: { unconfirmedId?: string } = {};

/**
 * Whether a Codex Chat's plan windows were reset: both `reset` and `alreadyRedeemed` mean the credit is spent.
 */
function isSpent(outcome: UsageResetCreditOutcome): boolean {
    return outcome === 'reset' || outcome === 'alreadyRedeemed';
}

const OUTCOME_TOASTS = {
    reset: ['success', 'statusBar.usage.resetCreditDone'],
    alreadyRedeemed: ['success', 'statusBar.usage.resetCreditDone'],
    nothingToReset: ['info', 'statusBar.usage.resetCreditNothingToReset'],
    noCredit: ['info', 'statusBar.usage.resetCreditNoCredit'],
    notEligible: ['info', 'statusBar.usage.resetCreditNotEligible'],
    unavailable: ['error', 'statusBar.usage.resetCreditUnavailable'],
    unconfirmed: ['warning', 'statusBar.usage.resetCreditUnconfirmed'],
} as const satisfies Record<UsageResetCreditOutcome, readonly [string, string]>;

/**
 * Asks the user to confirm, then spends one Codex banked reset through the Terminal's Codex Chat. The confirmation
 * names the consequence (irreversible, one credit); after an unconfirmed answer the same prompt offers to check that
 * attempt again and says no new credit is spent. The reading refreshes at once on success so the row and the chip drop
 * the spent credit without waiting for the next poll.
 */
export async function spendResetCredit(
    terminalId: string,
    credits: UsageResetCredits,
): Promise<void> {
    const isRetry = attempt.unconfirmedId !== undefined;
    const isConfirmed = await caxri.window.showConfirm(
        isRetry
            ? {
                  title: translate('statusBar.usage.resetCreditRetryTitle'),
                  message: translate('statusBar.usage.resetCreditRetryMessage'),
                  confirmLabel: translate('statusBar.usage.resetCreditRetryConfirm'),
              }
            : {
                  title: translate('statusBar.usage.resetCreditConfirmTitle'),
                  message: translate('statusBar.usage.resetCreditConfirmMessage', {
                      count: credits.availableCount,
                  }),
                  confirmLabel: translate('statusBar.usage.resetCreditConfirm'),
              },
    );
    if (!isConfirmed) return;
    const attemptId = attempt.unconfirmedId ?? crypto.randomUUID();
    let outcome: UsageResetCreditOutcome;
    try {
        ({ outcome } = await caxri.request('usage.redeemResetCredit', { terminalId, attemptId }));
    } catch {
        // The request itself failed (Server unreachable): the credit may or may not have been spent.
        outcome = 'unconfirmed';
    }
    attempt.unconfirmedId = outcome === 'unconfirmed' ? attemptId : undefined;
    const [kind, key] = OUTCOME_TOASTS[outcome];
    pushToast(kind, translate(key));
    if (isSpent(outcome)) {
        await queryClient.invalidateQueries({
            queryKey: caxriQueryKey('terminal.agentUsage', { terminalId }),
        });
    }
}
