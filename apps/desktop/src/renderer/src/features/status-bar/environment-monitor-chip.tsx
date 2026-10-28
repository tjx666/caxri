import { useState } from 'react';

import type { EnvironmentMonitorIssue } from '@caxri/protocol';
import { RefreshCw, ShieldAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Tooltip } from '../../components/ui/tooltip';
import { usePolledQuery } from '../../hooks/use-polled-query';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import {
    checkEnvironmentNow,
    useCurrentEnvironmentIp,
} from '../environment-monitor/environment-monitor-client';
import { statusItemClassName } from './status-item';

const STATUS_POLL_INTERVAL_MS = 5_000;

function issueLabel(issue: EnvironmentMonitorIssue, t: Translate): string {
    switch (issue.kind) {
        case 'publicIpChanged':
            return t('statusBar.environmentMonitor.issue.publicIpChanged');
        case 'timeZoneMismatch':
            return t('statusBar.environmentMonitor.issue.timeZoneMismatch', {
                actual: issue.actualTimeZone,
                expected: issue.expectedTimeZone,
            });
        case 'routeNodeMismatch':
            return t('statusBar.environmentMonitor.issue.routeNodeMismatch', {
                actual: issue.observedChain.join(' → '),
                domain: issue.domain,
                expected: issue.expectedNode,
            });
    }
}

export function EnvironmentMonitorChip() {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<'check' | 'useIp'>();
    const query = usePolledQuery('environmentMonitor.read', undefined, {
        label: 'environmentMonitor.read',
        intervalMs: STATUS_POLL_INTERVAL_MS,
        retry: false,
    });
    const state = query.data;
    if (state?.state !== 'warning') return null;

    const update = async (
        action: 'check' | 'useIp',
        run: typeof checkEnvironmentNow,
    ): Promise<void> => {
        if (busy) return;
        setBusy(action);
        const result = await tryCommand(t('statusBar.environmentMonitor.actionFailed'), run);
        if (result)
            queryClient.setQueryData(caxriQueryKey('environmentMonitor.read', undefined), result);
        setBusy(undefined);
    };

    const tooltip =
        state.issues.length === 1
            ? issueLabel(state.issues[0], t)
            : t('statusBar.environmentMonitor.tooltipMany', { count: state.issues.length });
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip content={tooltip} disabled={open}>
                <PopoverTrigger
                    aria-label={t('statusBar.environmentMonitor.ariaLabel', {
                        count: state.issues.length,
                    })}
                    className={cn(
                        statusItemClassName,
                        'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning hover:bg-[color-mix(in_srgb,var(--warning)_28%,transparent)]',
                    )}
                    data-environment-monitor-state={state.state}
                    data-status-urgent=""
                >
                    <ShieldAlert aria-hidden="true" />
                    <span>{t('statusBar.environmentMonitor.label')}</span>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                align="end"
                aria-label={t('statusBar.environmentMonitor.dialogLabel')}
                className="w-96 max-w-[calc(100vw-16px)]"
                side="top"
            >
                <div className="flex flex-col gap-3 p-3">
                    <div>
                        <div className="font-semibold">
                            {t('statusBar.environmentMonitor.title')}
                        </div>
                        <div className="mt-1 text-[11px] leading-[1.45] text-muted">
                            {t('statusBar.environmentMonitor.description')}
                        </div>
                    </div>
                    <ul
                        className="flex flex-col gap-1.5"
                        aria-label={t('statusBar.environmentMonitor.issues')}
                    >
                        {state.issues.map((issue) => (
                            <li
                                key={issueLabel(issue, t)}
                                className="flex items-start gap-2 text-[11px] leading-[1.45]"
                            >
                                <span
                                    aria-hidden="true"
                                    className="mt-1 size-1.5 flex-none rounded-full bg-warning"
                                />
                                <span>{issueLabel(issue, t)}</span>
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                        <Button
                            aria-disabled={Boolean(busy)}
                            size="sm"
                            variant="ghost"
                            onClick={async () => update('check', checkEnvironmentNow)}
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={
                                    busy === 'check'
                                        ? 'animate-spin motion-reduce:animate-none'
                                        : ''
                                }
                                size={13}
                            />
                            {t('statusBar.environmentMonitor.checkNow')}
                        </Button>
                        {state.canUseCurrentIp ? (
                            <Button
                                aria-disabled={Boolean(busy)}
                                size="sm"
                                variant="secondary"
                                onClick={async () => update('useIp', useCurrentEnvironmentIp)}
                            >
                                {t('statusBar.environmentMonitor.useCurrentIp')}
                            </Button>
                        ) : null}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
