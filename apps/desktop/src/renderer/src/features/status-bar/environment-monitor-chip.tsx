import { ShieldAlert } from 'lucide-react';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { Tooltip } from '../../components/ui/tooltip';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { openEnvironmentPage } from '../environment-monitor/environment-monitor-page-request';
import { environmentIssueLabel } from '../environment-monitor/environment-monitor-presentation';
import { statusItemClassName } from './status-item';

const STATUS_POLL_INTERVAL_MS = 5_000;

export function EnvironmentMonitorChip() {
    const { t } = useTranslation();
    const query = usePolledQuery('environmentMonitor.read', undefined, {
        label: 'environmentMonitor.read',
        intervalMs: STATUS_POLL_INTERVAL_MS,
        retry: false,
    });
    const state = query.data;
    if (state?.state !== 'warning') return null;

    const tooltip = (
        <StructuredTooltip
            title={t('statusBar.environmentMonitor.label')}
            details={state.issues.map((issue) => environmentIssueLabel(issue, t, state.publicIp))}
            hint={t('statusBar.environmentMonitor.clickToOpen')}
        />
    );
    return (
        <Tooltip content={tooltip}>
            <button
                type="button"
                aria-label={t('statusBar.environmentMonitor.ariaLabel', {
                    count: state.issues.length,
                })}
                className={cn(
                    statusItemClassName,
                    'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning hover:bg-[color-mix(in_srgb,var(--warning)_28%,transparent)]',
                )}
                data-environment-monitor-state={state.state}
                data-status-urgent=""
                onClick={openEnvironmentPage}
            >
                <ShieldAlert aria-hidden="true" />
                <span>{t('statusBar.environmentMonitor.label')}</span>
            </button>
        </Tooltip>
    );
}
