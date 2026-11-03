import { useState } from 'react';

import type { AgentProvider, DelegationRetryOption } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useDelegationRetry, useDelegationRetryOptions } from './hooks/use-delegation-retry';

/**
 * The text of an option that cannot run: the reason, or the generic refusal when the Server named none.
 */
function UnavailableReason({ option }: { option: DelegationRetryOption }) {
    const { t } = useTranslation();
    return (
        <span className="text-[11px] text-muted">
            {t(`delegation.retry.reason.${option.unavailableReason ?? 'not_retryable'}`)}
        </span>
    );
}

/**
 * "Retry" for one failed delegated task, as a link-style button that opens a small menu of the retry modes the Server
 * allows now: resume in the same conversation, or start over in a new Session. A mode that cannot run stays in the
 * menu, disabled, with its reason, so it never silently disappears. Choosing a mode asks for confirmation first
 * (`useDelegationRetry`).
 *
 * Render it as a sibling of a row's open button, never inside it: nested buttons are invalid. The options are read only
 * once the pointer or keyboard reaches the action, not per row on mount.
 */
export function DelegationRetryAction({
    className,
    delegationId,
    projectTitle,
    provider,
    sessionTitle,
    showSwitchTargets = false,
}: {
    className?: string;
    delegationId: string;
    projectTitle: string;
    provider: AgentProvider | undefined;
    sessionTitle: string;
    /**
     * Also list "Retry with <Agent>" for each Agent the Server offers. Off where the row already shows those as direct
     * actions (a usage-limit failure), so one action never has two homes.
     */
    showSwitchTargets?: boolean;
}) {
    const { t } = useTranslation();
    const [isInterested, setInterested] = useState(false);
    const [isOpen, setOpen] = useState(false);
    const { isPending, retry } = useDelegationRetry();
    const { data, isError } = useDelegationRetryOptions(delegationId, isInterested || isOpen);
    const providerName = provider
        ? agentProviderCatalog[provider].displayName
        : t('delegation.copy.agentFallback');
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <MenuTrigger
                aria-label={t('delegation.retry.actionAria', { title: sessionTitle })}
                className={cn(
                    'cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45',
                    className,
                )}
                data-delegation-retry={delegationId}
                disabled={isPending}
                onFocus={() => setInterested(true)}
                onPointerEnter={() => setInterested(true)}
            >
                {t('delegation.retry.action')}
            </MenuTrigger>
            <MenuContent align="start">
                {data === undefined ? (
                    <MenuItem disabled className="h-auto min-h-7 py-1">
                        {t(
                            isError
                                ? 'delegation.retry.reason.not_retryable'
                                : 'delegation.retry.checking',
                        )}
                    </MenuItem>
                ) : (
                    [
                        ...data.options.map((option) => (
                            <MenuItem
                                className="h-auto min-h-7 flex-col items-start justify-center gap-0 py-1"
                                data-delegation-retry-mode={option.mode}
                                disabled={!option.available}
                                key={option.mode}
                                onClick={() => {
                                    void retry({
                                        delegationId,
                                        mode: option.mode,
                                        projectTitle,
                                        providerName,
                                    });
                                }}
                            >
                                <span>{t(`delegation.retry.mode.${option.mode}`)}</span>
                                {!option.available && <UnavailableReason option={option} />}
                            </MenuItem>
                        )),
                        ...(showSwitchTargets ? data.switchTargets : []).map((target) => (
                            <MenuItem
                                className="h-auto min-h-7 py-1"
                                data-delegation-retry-switch={target}
                                key={target}
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
                                {t('delegation.retry.switchAction', {
                                    provider: agentProviderCatalog[target].displayName,
                                })}
                            </MenuItem>
                        )),
                    ]
                )}
            </MenuContent>
        </Menu>
    );
}
