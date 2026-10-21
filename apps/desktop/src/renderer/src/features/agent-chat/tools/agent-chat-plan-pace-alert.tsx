import { limitPaceShortfall, remainingLimitPercent } from '@caxri/protocol';
import { TrendingUp, X } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { localizedLimitReset, localizedLimitWindowName } from '../../../lib/usage-format';
import {
    dismissPlanPace,
    isPlanPaceDismissed,
    usePlanPaceDismissals,
} from '../../usage/plan-pace-dismissals';
import { useClockTick } from '../hooks/use-clock-tick';

/**
 * A composer strip row warning that the plan's weekly limit is running ahead of an even pace (`limitPaceShortfall`):
 * `Weekly limit ahead of pace: 40% left, resets in 4d 2h`. It reads the same `terminal.agentUsage` poll as the status
 * bar's usage chip, so it adds no request, and like the context notices it gives way to the activity and edit rows.
 * Dismissing it hides it for the rest of the local day for that provider, across restarts (`plan-pace-dismissals`).
 */
export function AgentChatPlanPaceAlert({
    isShown,
    terminalId,
}: {
    /**
     * Whether the strip has room for the row: no activity row and no "Edit from here" bar.
     */
    isShown: boolean;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const { data: readout } = usePolledQuery(
        'terminal.agentUsage',
        { terminalId },
        { label: 'terminal.agentUsage', intervalMs: 2_000, staleTime: 1_000, retry: false },
    );
    const provider = readout?.provider;
    const dismissedOn = usePlanPaceDismissals((state) => state.dismissedOn);
    const shortfall = limitPaceShortfall(readout?.limit, now);
    if (!isShown || !provider || !shortfall || isPlanPaceDismissed(dismissedOn, provider, now))
        return null;
    const { window, evenPacePercent } = shortfall;
    const windowName = localizedLimitWindowName(window.windowMinutes, t);
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-warning"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-plan-pace-alert=""
        >
            <TrendingUp aria-hidden className="size-3.5 shrink-0" />
            <Tooltip
                content={t('agentChat.planPace.detail', {
                    window: windowName,
                    even: evenPacePercent,
                })}
            >
                <span
                    className="truncate rounded-md focus-visible:outline focus-visible:outline-accent"
                    tabIndex={0}
                >
                    {t('agentChat.planPace.text', {
                        window: windowName,
                        percent: remainingLimitPercent(window.usedPercent),
                        reset: localizedLimitReset(window.resetsAt, now, t),
                    })}
                </span>
            </Tooltip>
            <Tooltip content={t('agentChat.planPace.dismiss')}>
                <Button
                    aria-label={t('agentChat.planPace.dismiss')}
                    className="-mr-1.5 ml-auto size-6 shrink-0 rounded-md text-muted enabled:hover:text-foreground"
                    size="icon"
                    variant="ghost"
                    onClick={() => dismissPlanPace(provider, now)}
                >
                    <X aria-hidden className="size-3.5" />
                </Button>
            </Tooltip>
        </div>
    );
}
