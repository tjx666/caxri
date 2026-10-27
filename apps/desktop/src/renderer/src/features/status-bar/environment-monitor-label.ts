import type { EnvironmentMonitorState } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

export interface EnvironmentMonitorChipCopy {
    ariaLabel: string;
    label: string;
    issueLabels: string[];
    title: string;
    tooltip: StructuredTooltipData;
}

function issueLabel(issue: EnvironmentMonitorState['issues'][number], t: Translate): string {
    return t(`statusBar.environmentMonitor.issue.${issue}`);
}

export function environmentMonitorChipCopy(
    state: EnvironmentMonitorState,
    checkedAt: string | undefined,
    t: Translate = translate,
): EnvironmentMonitorChipCopy | undefined {
    if (
        state.state === 'disabled' ||
        state.state === 'checking' ||
        state.state === 'healthy' ||
        state.issues.length === 0
    )
        return undefined;
    const issueLabels = state.issues.map((issue) => issueLabel(issue, t));
    const isUnavailable = state.state === 'unavailable';
    const label = isUnavailable
        ? t('statusBar.environmentMonitor.unavailableLabel')
        : t('statusBar.environmentMonitor.warningLabel', { count: state.issues.length });
    const title = isUnavailable
        ? t('statusBar.environmentMonitor.unavailableTitle')
        : t('statusBar.environmentMonitor.warningTitle', { count: state.issues.length });
    const details = state.details;
    const rows = [
        details?.region
            ? { label: t('statusBar.environmentMonitor.region'), value: details.region }
            : undefined,
        details?.network
            ? { label: t('statusBar.environmentMonitor.network'), value: details.network }
            : undefined,
        details?.egressTimeZone
            ? {
                  label: t('statusBar.environmentMonitor.egressTimeZone'),
                  value: details.egressTimeZone,
              }
            : undefined,
        details?.systemTimeZone
            ? {
                  label: t('statusBar.environmentMonitor.systemTimeZone'),
                  value: details.systemTimeZone,
              }
            : undefined,
        details?.proxyMode
            ? {
                  label: t('statusBar.environmentMonitor.proxyMode'),
                  value: t(`statusBar.environmentMonitor.proxyMode.${details.proxyMode}`),
              }
            : undefined,
        checkedAt
            ? { label: t('statusBar.environmentMonitor.lastChecked'), value: checkedAt }
            : undefined,
    ].filter((row): row is NonNullable<typeof row> => Boolean(row));
    return {
        ariaLabel: t('statusBar.environmentMonitor.ariaLabel', {
            count: state.issues.length,
            issues: issueLabels.join(t('statusBar.listSeparator')),
        }),
        label,
        issueLabels,
        title,
        tooltip: {
            eyebrow: t('statusBar.environmentMonitor.eyebrow'),
            title,
            rows,
            details: issueLabels,
            notes: [t('statusBar.environmentMonitor.disclaimer')],
            hint: t('statusBar.environmentMonitor.hint'),
        },
    };
}
