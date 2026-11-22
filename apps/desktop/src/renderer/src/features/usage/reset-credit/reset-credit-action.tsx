import { useId, useState } from 'react';

import type { UsageResetCredits } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { Spinner } from '../../../components/ui/spinner';
import { useTranslation } from '../../../i18n';
import { spendResetCredit } from './reset-credit-client';

/**
 * The hover card's `Use reset credit` action beside the reset-credit count. It is usable only while a plan window is
 * nearly used up (`isResetCreditRedeemable`, which the Server rechecks on a fresh reading), asks for confirmation
 * because spending is irreversible, and refuses a second click while a request is in flight so one click is one
 * attempt; meanwhile it shows a spinner and `Resetting…`.
 *
 * The unusable state uses `aria-disabled` rather than `disabled`: a natively disabled button takes neither focus nor
 * hover, so its reason (`disabledReason`, rendered as a screen-reader-only description tied by `aria-describedby`)
 * would be unreachable from the very control it explains. The handler blocks activation instead.
 */
export function ResetCreditAction({
    credits,
    disabledReason,
    isEnabled,
    terminalId,
}: {
    credits: UsageResetCredits;
    /**
     * Why the action is unavailable; announced as the control's description while `isEnabled` is false.
     */
    disabledReason: string;
    isEnabled: boolean;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isBusy, setIsBusy] = useState(false);
    const reasonId = useId();
    const isBlocked = !isEnabled || isBusy;
    return (
        <>
            <Button
                size="inline"
                variant="link"
                className="ml-1 underline-offset-2"
                aria-disabled={isBlocked || undefined}
                aria-describedby={isEnabled ? undefined : reasonId}
                onClick={() => {
                    if (isBlocked) return;
                    setIsBusy(true);
                    void spendResetCredit(terminalId, credits).finally(() => setIsBusy(false));
                }}
            >
                {isBusy ? (
                    <>
                        <Spinner className="size-3" aria-hidden />
                        {t('statusBar.usage.resettingCredit')}
                    </>
                ) : (
                    t('statusBar.usage.useResetCredit')
                )}
            </Button>
            {!isEnabled && (
                <span id={reasonId} className="sr-only">
                    {disabledReason}
                </span>
            )}
        </>
    );
}
