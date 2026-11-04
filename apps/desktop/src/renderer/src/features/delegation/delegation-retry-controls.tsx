import type { AgentDelegationSession, AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, isDelegationRetryPending } from '@caxri/protocol';

import { useClockTick } from '@/hooks/use-clock-tick';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { isRetryCandidate } from './delegation-feed';
import { DELEGATION_LINK_CLASS_NAME } from './delegation-link-class-name';
import { DelegationNextStepActions } from './delegation-next-step-actions';
import { DelegationRetryAction } from './delegation-retry-action';
import { formatRetryTime } from './delegation-retry-time';
import {
    useCancelScheduledRetry,
    useDelegationRetry,
    useDelegationRetryOptions,
} from './hooks/use-delegation-retry';

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
    retryState: { isPending, retry },
    sessionTitle,
}: {
    delegationId: string;
    projectTitle: string;
    provider: AgentProvider | undefined;
    /**
     * The row's one retry request, shared with the Retry menu so a single pending state covers every retry action.
     */
    retryState: ReturnType<typeof useDelegationRetry>;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
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
                        className={DELEGATION_LINK_CLASS_NAME}
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
            className={DELEGATION_LINK_CLASS_NAME}
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
            className={DELEGATION_LINK_CLASS_NAME}
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
 * scheduled retry is pending, otherwise the failure's own fix ("Sign in", "Enable hooks"; see `delegationNextSteps`),
 * the Retry menu plus, for a usage-limit failure, the direct "Retry with <Agent>" and "Retry after <time>" actions.
 * Renders nothing for a task that cannot be retried.
 */
export function DelegationRetryControls({
    className,
    entry,
    projectId,
    projectTitle,
    sessionTitle,
}: {
    className?: string;
    entry: RetryControlsEntry;
    /**
     * The child Session's Project, where "Sign in" opens its Shell Session.
     */
    projectId: string | undefined;
    projectTitle: string;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    const { delegationId } = entry;
    const retryState = useDelegationRetry();
    if (delegationId === undefined) return null;
    const isPending = isDelegationRetryPending(entry);
    if (!isPending && !isRetryCandidate(entry)) return null;
    const isUsageLimit = isUsageLimitFailure(entry);
    return (
        <span className={cn('flex min-w-0 flex-wrap items-center gap-x-3', className)}>
            {isPending ? (
                <CancelScheduledRetry delegationId={delegationId} sessionTitle={sessionTitle} />
            ) : retryState.isPending ? (
                <span className="text-muted" role="status">
                    {t('delegation.retry.retrying')}
                </span>
            ) : (
                <>
                    <DelegationNextStepActions
                        entry={entry}
                        projectId={projectId}
                        sessionTitle={sessionTitle}
                    />
                    <DelegationRetryAction
                        delegationId={delegationId}
                        showSwitchTargets={!isUsageLimit}
                        projectTitle={projectTitle}
                        provider={entry.provider}
                        retryState={retryState}
                        sessionTitle={sessionTitle}
                    />
                    {isUsageLimit && (
                        <UsageLimitRetryActions
                            delegationId={delegationId}
                            projectTitle={projectTitle}
                            provider={entry.provider}
                            retryState={retryState}
                            sessionTitle={sessionTitle}
                        />
                    )}
                </>
            )}
        </span>
    );
}
