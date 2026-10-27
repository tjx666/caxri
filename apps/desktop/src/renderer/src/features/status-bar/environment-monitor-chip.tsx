import { useState } from 'react';

import { AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { formatTime } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';
import { environmentMonitorChipCopy } from './environment-monitor-label';
import { useEnvironmentMonitorActions } from './hooks/use-environment-monitor-actions';
import { statusItemClassName } from './status-item';

const STATUS_POLL_INTERVAL_MS = 30_000;

export function EnvironmentMonitorChip() {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const { data } = usePolledQuery('environmentMonitor.read', undefined, {
        label: 'environmentMonitor.read',
        intervalMs: STATUS_POLL_INTERVAL_MS,
        staleTime: STATUS_POLL_INTERVAL_MS / 2,
        retry: false,
    });
    const actions = useEnvironmentMonitorActions();
    const copy =
        data &&
        environmentMonitorChipCopy(
            data,
            data.checkedAt === undefined
                ? undefined
                : formatTime(data.checkedAt, { withSeconds: true }),
            t,
        );
    if (!data || !copy) return null;
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip content={<StructuredTooltip {...copy.tooltip} />} disabled={open}>
                <PopoverTrigger
                    aria-label={copy.ariaLabel}
                    className={cn(
                        statusItemClassName,
                        'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning hover:bg-[color-mix(in_srgb,var(--warning)_28%,transparent)]',
                    )}
                    data-environment-monitor-state={data.state}
                    data-status-urgent=""
                >
                    <ShieldAlert aria-hidden="true" />
                    <span>{copy.label}</span>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                align="end"
                aria-label={t('statusBar.environmentMonitor.dialogLabel')}
                className="w-88 max-w-[calc(100vw-16px)]"
                side="top"
            >
                <div className="flex flex-col gap-3 p-3">
                    <div className="flex items-start gap-2">
                        <AlertTriangle
                            aria-hidden="true"
                            className="mt-0.5 size-4 flex-none text-warning"
                        />
                        <div className="min-w-0">
                            <div className="font-semibold">{copy.title}</div>
                            <div className="mt-1 text-[11px] leading-[1.45] text-muted">
                                {t('statusBar.environmentMonitor.disclaimer')}
                            </div>
                        </div>
                    </div>
                    <ul
                        className="flex flex-col gap-1"
                        aria-label={t('statusBar.environmentMonitor.issues')}
                    >
                        {copy.issueLabels.map((label) => (
                            <li key={label} className="flex items-start gap-2 text-[11px]">
                                <span
                                    aria-hidden="true"
                                    className="mt-1 size-1.5 flex-none rounded-full bg-warning"
                                />
                                <span>{label}</span>
                            </li>
                        ))}
                    </ul>
                    {data.details && (
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                            {data.details.region && (
                                <>
                                    <dt className="text-muted">
                                        {t('statusBar.environmentMonitor.region')}
                                    </dt>
                                    <dd>{data.details.region}</dd>
                                </>
                            )}
                            {data.details.network && (
                                <>
                                    <dt className="text-muted">
                                        {t('statusBar.environmentMonitor.network')}
                                    </dt>
                                    <dd>{data.details.network}</dd>
                                </>
                            )}
                            {(data.details.egressTimeZone ?? data.details.systemTimeZone) && (
                                <>
                                    <dt className="text-muted">
                                        {t('statusBar.environmentMonitor.timeZones')}
                                    </dt>
                                    <dd>
                                        {data.details.egressTimeZone ??
                                            t('statusBar.environmentMonitor.unknown')}
                                        {' / '}
                                        {data.details.systemTimeZone ??
                                            t('statusBar.environmentMonitor.unknown')}
                                    </dd>
                                </>
                            )}
                            {data.details.proxyMode && (
                                <>
                                    <dt className="text-muted">
                                        {t('statusBar.environmentMonitor.proxyMode')}
                                    </dt>
                                    <dd>
                                        {t(
                                            `statusBar.environmentMonitor.proxyMode.${data.details.proxyMode}`,
                                        )}
                                    </dd>
                                </>
                            )}
                        </dl>
                    )}
                    <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-busy={actions.isRefreshing}
                            onClick={actions.refresh}
                        >
                            {actions.isRefreshing ? (
                                <Spinner size={13} />
                            ) : (
                                <RefreshCw aria-hidden="true" className="size-3.5" />
                            )}
                            {t('statusBar.environmentMonitor.checkAgain')}
                        </Button>
                        {data.canAcceptBaseline && (
                            <Button size="sm" variant="secondary" onClick={actions.acceptBaseline}>
                                {t('statusBar.environmentMonitor.useCurrent')}
                            </Button>
                        )}
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}
