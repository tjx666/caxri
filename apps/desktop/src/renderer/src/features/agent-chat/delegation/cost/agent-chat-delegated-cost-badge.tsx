import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { useCaxriQuery } from '../../../../queries/client';
import type { DelegatedCostLabel } from './agent-chat-delegated-cost';
import { delegatedSessionCountLabel, formatCostAmount } from './agent-chat-delegated-cost';

/**
 * The tooltip's body. Mounted only while the tooltip is open, so the Chat's own cost is read when someone asks for it
 * and a closed strip makes no extra request. The Chat's own figure is left out when its usage is unknown, never `$0`.
 */
function DelegatedCostTooltipBody({
    delegatedCostUsd,
    delegatedIsActive,
    delegatedIsPartial,
    delegatedSessions,
    sessionId,
}: {
    delegatedCostUsd: number;
    delegatedIsActive: boolean;
    delegatedIsPartial: boolean;
    delegatedSessions: number;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const { data } = useCaxriQuery('usage.sessionCost', { sessionId }, { staleTime: 30_000 });
    const sessions = delegatedSessionCountLabel(delegatedSessions, t);
    const delegated = formatCostAmount(delegatedCostUsd, delegatedIsPartial) ?? '';
    const own =
        data?.costUsd === undefined
            ? undefined
            : formatCostAmount(data.costUsd, data.isPartial ?? false);
    return (
        <span className="flex max-w-64 flex-col gap-1">
            <span>{t('delegation.strip.cost.basis')}</span>
            <span className="tabular-nums">
                {own === undefined
                    ? t('delegation.strip.cost.parentDelegatedOnly', {
                          delegated,
                          sessions,
                      })
                    : t('delegation.strip.cost.parent', { delegated, own, sessions })}
            </span>
            {delegatedIsActive && <span>{t('delegation.strip.cost.running')}</span>}
        </span>
    );
}

/**
 * The strip header's delegated spend (`$1.20 delegated`, `$1.20+` as a floor). Hovering it states the basis (an
 * estimate at list prices), the Chat's own spend beside it, and that the figure may still grow while a task runs.
 */
export function AgentChatDelegatedCostBadge({
    delegatedCostUsd,
    delegatedIsActive,
    delegatedIsPartial,
    delegatedSessions,
    label,
    sessionId,
}: {
    delegatedCostUsd: number;
    delegatedIsActive: boolean;
    delegatedIsPartial: boolean;
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
                    delegatedIsActive={delegatedIsActive}
                    delegatedIsPartial={delegatedIsPartial}
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
