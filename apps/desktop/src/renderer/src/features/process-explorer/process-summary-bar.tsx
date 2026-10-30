import { formatCpuPercent, formatMemoryMb, isPtyUsageHigh } from '@caxri/protocol';
import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';
import { Search } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';
import { cn } from '../../lib/utilities';
import type { ProcessExplorerTotals, ProcessScope } from './process-tree';
import { PROCESS_SCOPES } from './process-tree';

const SCOPE_LABEL_KEYS: Record<ProcessScope, TranslationKey> = {
    agents: 'processExplorer.scope.agents',
    caxri: 'processExplorer.scope.caxri',
    other: 'processExplorer.scope.other',
};

const SCOPE_TOOLTIP_KEYS: Record<ProcessScope, TranslationKey> = {
    agents: 'processExplorer.scope.agentsTooltip',
    caxri: 'processExplorer.scope.caxriTooltip',
    other: 'processExplorer.scope.otherTooltip',
};

function SummaryReading({
    isWarning = false,
    label,
    value,
}: {
    isWarning?: boolean;
    label: string;
    value: string;
}) {
    return (
        <span className={cn(isWarning && 'text-warning')}>
            {label}{' '}
            <strong
                className={cn(
                    'font-semibold tabular-nums',
                    isWarning ? 'text-warning' : 'text-foreground',
                )}
            >
                {value}
            </strong>
        </span>
    );
}

/**
 * The machine's PTY slots in use out of the kernel limit, in the warning color once the Server would alert on them.
 * Hidden where the platform reports no limit.
 */
function PtySummaryReading({ pty }: { pty: ProcessExplorerSnapshot['pty'] }) {
    const { t } = useTranslation();
    if (!pty) return null;
    const isHigh = isPtyUsageHigh(pty);
    return (
        <span className="process-summary-pty">
            <SummaryReading
                isWarning={isHigh}
                label={t('processExplorer.summary.pty')}
                value={String(pty.inUse)}
            />
            <span className={cn('tabular-nums', isHigh && 'text-warning')}> / {pty.limit}</span>
            {isHigh && <span className="sr-only">{t('processExplorer.summary.ptyHigh')}</span>}
        </span>
    );
}

/**
 * The whole-app readings above the grid, the category toggles, and the filter that narrows it. Escape clears a
 * non-empty filter.
 */
export function ProcessSummaryBar({
    filter,
    onFilterChange,
    onScopesChange,
    scopes,
    snapshot,
    totals,
}: {
    filter: string;
    onFilterChange: (filter: string) => void;
    onScopesChange: (scopes: ProcessScope[]) => void;
    scopes: readonly ProcessScope[];
    snapshot?: ProcessExplorerSnapshot;
    totals: ProcessExplorerTotals;
}) {
    const { t } = useTranslation();
    const systemMemory =
        snapshot && snapshot.systemMemoryMb > 0 ? formatMemoryMb(snapshot.systemMemoryMb) : '';
    return (
        <section
            className="process-summary flex items-center gap-5 border-b border-border px-4 py-2.5 text-[12px] text-muted"
            aria-label={t('processExplorer.summary.label')}
        >
            <SummaryReading
                label={t('processExplorer.summary.cpu')}
                value={snapshot ? formatCpuPercent(totals.cpuPercent) : '—'}
            />
            <span>
                <SummaryReading
                    label={t('processExplorer.summary.memory')}
                    value={snapshot ? formatMemoryMb(totals.memoryMb) : '—'}
                />
                {systemMemory && <span className="tabular-nums"> / {systemMemory}</span>}
            </span>
            <SummaryReading
                label={t('processExplorer.summary.processes')}
                value={snapshot ? String(totals.processCount) : '—'}
            />
            <PtySummaryReading pty={snapshot?.pty} />
            <ToggleGroup<ProcessScope>
                aria-label={t('processExplorer.scope.label')}
                className="ml-auto"
                multiple
                value={[...scopes]}
                onValueChange={onScopesChange}
            >
                {PROCESS_SCOPES.map((scope) => (
                    <Tooltip key={scope} content={t(SCOPE_TOOLTIP_KEYS[scope])}>
                        <ToggleGroupItem size="dense" value={scope}>
                            {t(SCOPE_LABEL_KEYS[scope])}
                        </ToggleGroupItem>
                    </Tooltip>
                ))}
            </ToggleGroup>
            <InputGroup appearance="workbench" size="dense" className="w-60">
                <Search aria-hidden="true" className="shrink-0 text-muted" size={13} />
                <Input
                    appearance="embedded"
                    size="dense"
                    type="search"
                    placeholder={t('processExplorer.filter.placeholder')}
                    aria-label={t('processExplorer.filter.label')}
                    value={filter}
                    onChange={(event) => onFilterChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (!filter || event.key !== 'Escape' || isImeComposing(event)) return;
                        event.preventDefault();
                        onFilterChange('');
                    }}
                />
            </InputGroup>
        </section>
    );
}
