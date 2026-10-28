import { formatCreditsBalance, weeklyCreditsNotice } from '@caxri/protocol';
import { Gauge, X } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';
import { usePolledQuery } from '@/hooks/use-polled-query';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { localizedLimitReset } from '../../../lib/usage-format';
import { dismissUsageNotice } from '../../usage/usage-notice-client';

/**
 * A composer strip row in place of the weekly usage guard card when the account still has usable credits: the weekly
 * window is at the guard, but requests go on, now spending credits (`weeklyCreditsNotice`), so nothing is paused and
 * there is no hand-off to offer. `Codex weekly usage at 99%: requests continue on credits, 1,250 left`. It reads the
 * same `terminal.agentUsage` poll as the plan pace reminder, which gives way to it, and dismissing it hides it for a
 * day on every Client (`usage-notice-client`).
 */
export function AgentChatCreditsNotice({
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
    const notice = weeklyCreditsNotice(readout?.limit, now);
    if (!isShown || !provider || !notice) return null;
    const balance = formatCreditsBalance(notice.credits);
    const kind = notice.credits.currency ? 'extraUsage' : 'credits';
    const headline = {
        provider: resolveAgentIcon(provider).label,
        percent: Math.floor(notice.usedPercent),
    };
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-warning"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-credits-notice=""
        >
            <Gauge aria-hidden className="size-3.5 shrink-0" />
            <Tooltip
                content={t('agentChat.creditsNotice.detail', {
                    reset: localizedLimitReset(notice.resetsAt, now, t),
                })}
            >
                <span
                    className="truncate rounded-md focus-visible:outline focus-visible:outline-accent"
                    tabIndex={0}
                >
                    {balance
                        ? t(`agentChat.creditsNotice.${kind}Left`, { ...headline, balance })
                        : t(`agentChat.creditsNotice.${kind}`, headline)}
                </span>
            </Tooltip>
            <Tooltip content={t('agentChat.creditsNotice.dismiss')}>
                <Button
                    aria-label={t('agentChat.creditsNotice.dismiss')}
                    className="-mr-1.5 ml-auto size-6 shrink-0 rounded-md text-muted enabled:hover:text-foreground"
                    size="icon"
                    variant="ghost"
                    onClick={async () => {
                        await dismissUsageNotice(terminalId, provider, 'credits');
                    }}
                >
                    <X aria-hidden className="size-3.5" />
                </Button>
            </Tooltip>
        </div>
    );
}
