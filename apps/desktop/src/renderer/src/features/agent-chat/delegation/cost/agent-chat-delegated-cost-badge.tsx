import { formatUsd } from '@caxri/protocol';

import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { useCaxriQuery } from '../../../../queries/client';
import type { DelegatedCostLabel } from './agent-chat-delegated-cost';

/**
 * The tooltip's body. Mounted only while the tooltip is open, so the Chat's own cost is read when someone asks for it
 * and a closed strip makes no extra request. The Chat's own figure is left out when its usage is unknown, never `$0`.
 */
function DelegatedCostTooltipBody({
    delegatedCostUsd,
    delegatedSessions,
    sessionId,
}: {
    delegatedCostUsd: number;
    delegatedSessions: number;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const { data } = useCaxriQuery('usage.sessionCost', { sessionId }, { staleTime: 30_000 });
    const delegated = formatUsd(delegatedCostUsd);
    const own = data?.costUsd === undefined ? undefined : formatUsd(data.costUsd);
    return (
        <span className="flex max-w-64 flex-col gap-1">
            <span>{t('delegation.strip.cost.basis')}</span>
            <span className="tabular-nums">
                {own === undefined
                    ? t('delegation.strip.cost.parentDelegatedOnly', {
                          count: delegatedSessions,
                          delegated,
                      })
                    : t('delegation.strip.cost.parent', {
                          count: delegatedSessions,
                          delegated,
                          own,
                      })}
            </span>
        </span>
    );
}

/**
 * The strip header's delegated spend (`$1.20 delegated`, `~$1.20` while a task runs, `$1.20+` as a floor). Hovering it
 * states the basis (an estimate at list prices) and the Chat's own spend beside it.
 */
export function AgentChatDelegatedCostBadge({
    delegatedCostUsd,
    delegatedSessions,
    label,
    sessionId,
}: {
    delegatedCostUsd: number;
    delegatedSessions: number;
    label: DelegatedCostLabel;
    sessionId: string;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip
            content={
                <DelegatedCostTooltipBody
                    delegatedCostUsd={delegatedCostUsd}
                    delegatedSessions={delegatedSessions}
                    sessionId={sessionId}
                />
            }
            hoverOnly
        >
            <span data-agent-chat-delegated-cost="">
                {t('delegation.strip.cost.header', { amount: label.text })}
            </span>
        </Tooltip>
    );
}
