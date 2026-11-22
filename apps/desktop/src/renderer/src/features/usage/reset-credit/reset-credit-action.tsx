import { useState } from 'react';

import type { UsageResetCredits } from '@caxri/protocol';

import { Button } from '../../../components/ui/button';
import { useTranslation } from '../../../i18n';
import { spendResetCredit } from './reset-credit-client';

/**
 * The hover card's `Use reset credit` action beside the banked-resets count. It is enabled only while a plan window is
 * nearly used up (`isResetCreditRedeemable`, which the Server rechecks on a fresh reading), asks for confirmation
 * because spending is irreversible, and stays disabled while a request is in flight so one click is one attempt.
 */
export function ResetCreditAction({
    credits,
    isEnabled,
    terminalId,
}: {
    credits: UsageResetCredits;
    isEnabled: boolean;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isBusy, setIsBusy] = useState(false);
    return (
        <Button
            size="inline"
            variant="link"
            className="ml-1 underline-offset-2"
            disabled={!isEnabled || isBusy}
            onClick={() => {
                setIsBusy(true);
                void spendResetCredit(terminalId, credits).finally(() => setIsBusy(false));
            }}
        >
            {t('statusBar.usage.useResetCredit')}
        </Button>
    );
}
