import type { AgentDelegationSession, AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { useClockTick } from '@/hooks/use-clock-tick';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { isDelegationRetryPending, isRetryCandidate } from './delegation-feed';
import { DelegationRetryAction } from './delegation-retry-action';
import { formatRetryTime } from './delegation-retry-time';
import {
    useCancelScheduledRetry,
    useDelegationRetry,
    useDelegationRetryOptions,
} from './hooks/use-delegation-retry';

const LINK_CLASS_NAME =
    'cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45';

type RetryControlsEntry = Pick<
    AgentDelegationSession,
    | 'delegationId'
    | 'failure'
    | 'provider'
    | 'retriedAs'
    | 'retryScheduledFor'
    | 'status'
    | 'takenOverAt'
>;

/**
 * Whether the failure is the provider's usage limit, the one failure where a retry waits for a reset or moves to
 * another Agent. Only a hint to read the options eagerly; the Server decides what is offered.
 */
function isUsageLimitFailure(entry: Pick<AgentDelegationSession, 'failure'>): boolean {
    return entry.failure === 'quota_exhausted' || entry.failure === 'rate_limited';
}

/**
 * The direct actions of a usage-limit failure, next to Retry: "Retry with <Agent>" for each Agent the Server says a
 * fresh retry could switch to, and "Retry after <time>" when it knows a trusted reset time. The options are read as
 * soon as the row shows (a usage-limit failure is rare), so the actions are not hidden behind a menu. Without a trusted
 * reset time there is no "Retry after" and no guess.
 */
function UsageLimitRetryActions({
    delegationId,
    projectTitle,
    provider,
    sessionTitle,
}: {
    delegationId: string;
    projectTitle: string;
    provider: AgentProvider | undefined;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    const { isPending, retry } = useDelegationRetry();
    const { data } = useDelegationRetryOptions(delegationId, true);
    if (data === undefined) return null;
    const providerName = provider
        ? agentProviderCatalog[provider].displayName
        : t('delegation.copy.agentFallback');
    const { schedule } = data;
    // Resume keeps the work already done, so it wins when it can run; the mode is fixed when the retry is scheduled.
    const scheduledMode = data.options.some(
        (option) => option.mode === 'resume' && option.available,
    )
        ? 'resume'
        : 'fresh';
    const scheduledFor = schedule.available ? schedule.scheduledFor : undefined;
    return (
        <>
            {data.switchTargets.map((target) => {
                const targetName = agentProviderCatalog[target].displayName;
                return (
                    <button
                        aria-label={t('delegation.retry.switchAria', {
                            provider: targetName,
                            title: sessionTitle,
                        })}
                        className={LINK_CLASS_NAME}
                        data-delegation-retry-switch={target}
                        disabled={isPending}
                        key={target}
                        type="button"
                        onClick={() => {
                            void retry({
                                delegationId,
                                mode: 'fresh',
                                projectTitle,
                                providerName,
                                switchTo: target,
                            });
                        }}
                    >
                        {t('delegation.retry.switchAction', { provider: targetName })}
                    </button>
                );
            })}
            {scheduledFor !== undefined && (
                <ScheduleButton
                    isDisabled={isPending}
                    scheduledFor={scheduledFor}
                    sessionTitle={sessionTitle}
                    onSchedule={() => {
                        void retry({
                            delegationId,
                            mode: scheduledMode,
                            projectTitle,
                            providerName,
                            scheduledFor,
                        });
                    }}
                />
            )}
        </>
    );
}

function ScheduleButton({
    isDisabled,
    onSchedule,
    scheduledFor,
    sessionTitle,
}: {
    isDisabled: boolean;
    onSchedule: () => void;
    scheduledFor: number;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    const time = formatRetryTime(scheduledFor, now, t);
    return (
        <button
            aria-label={t('delegation.retry.scheduleAria', { time, title: sessionTitle })}
            className={LINK_CLASS_NAME}
            data-delegation-retry-schedule={scheduledFor}
            disabled={isDisabled}
            type="button"
            onClick={onSchedule}
        >
            {t('delegation.retry.scheduleAction', { time })}
        </button>
    );
}

/**
 * Cancel for a pending scheduled retry. The row's own line already says "Retries at <time>"; this is the one action,
 * and a retry must be cancelled before another can start.
 */
function CancelScheduledRetry({
    delegationId,
    sessionTitle,
}: {
    delegationId: string;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    const { cancel, isPending } = useCancelScheduledRetry();
    return (
        <button
            aria-label={t('delegation.retry.cancelAria', { title: sessionTitle })}
            className={LINK_CLASS_NAME}
            data-delegation-retry-cancel={delegationId}
            disabled={isPending}
            type="button"
            onClick={() => cancel(delegationId)}
        >
            {t('delegation.retry.cancelAction')}
        </button>
    );
}

/**
 * Everything a failed delegated task offers under its row, as siblings of the row's open button: Cancel while a
 * scheduled retry is pending, otherwise the Retry menu plus, for a usage-limit failure, the direct "Retry with <Agent>"
 * and "Retry after <time>" actions. Renders nothing for a task that cannot be retried.
 */
export function DelegationRetryControls({
    className,
    entry,
    projectTitle,
    sessionTitle,
}: {
    className?: string;
    entry: RetryControlsEntry;
    projectTitle: string;
    sessionTitle: string;
}) {
    const { delegationId } = entry;
    if (delegationId === undefined) return null;
    const isPending = isDelegationRetryPending(entry);
    if (!isPending && !isRetryCandidate(entry)) return null;
    const isUsageLimit = isUsageLimitFailure(entry);
    return (
        <span className={cn('flex min-w-0 flex-wrap items-center gap-x-3', className)}>
            {isPending ? (
                <CancelScheduledRetry delegationId={delegationId} sessionTitle={sessionTitle} />
            ) : (
                <>
                    <DelegationRetryAction
                        delegationId={delegationId}
                        showSwitchTargets={!isUsageLimit}
                        projectTitle={projectTitle}
                        provider={entry.provider}
                        sessionTitle={sessionTitle}
                    />
                    {isUsageLimit && (
                        <UsageLimitRetryActions
                            delegationId={delegationId}
                            projectTitle={projectTitle}
                            provider={entry.provider}
                            sessionTitle={sessionTitle}
                        />
                    )}
                </>
            )}
        </span>
    );
}
