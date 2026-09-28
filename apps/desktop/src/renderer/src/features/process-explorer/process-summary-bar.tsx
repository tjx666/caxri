import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';
import { Search } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { formatCpuPercent, formatMemoryMb } from '../../lib/resource-usage-format';
import type { ProcessExplorerTotals } from './process-tree';

function SummaryReading({ label, value }: { label: string; value: string }) {
    return (
        <span>
            {label} <strong className="font-semibold text-foreground tabular-nums">{value}</strong>
        </span>
    );
}

/**
 * The whole-app readings above the grid, and the filter that narrows it. Escape clears a non-empty filter.
 */
export function ProcessSummaryBar({
    filter,
    onFilterChange,
    snapshot,
    totals,
}: {
    filter: string;
    onFilterChange: (filter: string) => void;
    snapshot?: ProcessExplorerSnapshot;
    totals: ProcessExplorerTotals;
}) {
    const systemMemory =
        snapshot && snapshot.systemMemoryMb > 0 ? formatMemoryMb(snapshot.systemMemoryMb) : '';
    return (
        <section
            className="process-summary flex items-center gap-5 border-b border-border px-4 py-2.5 text-[12px] text-muted"
            aria-label="Resource summary"
        >
            <SummaryReading
                label="CPU"
                value={snapshot ? formatCpuPercent(totals.cpuPercent) : '—'}
            />
            <span>
                <SummaryReading
                    label="Memory"
                    value={snapshot ? formatMemoryMb(totals.memoryMb) : '—'}
                />
                {systemMemory && <span className="tabular-nums"> / {systemMemory}</span>}
            </span>
            <SummaryReading
                label="Processes"
                value={snapshot ? String(totals.processCount) : '—'}
            />
            <InputGroup appearance="workbench" size="dense" className="ml-auto w-60">
                <Search aria-hidden="true" className="shrink-0 text-muted" size={13} />
                <Input
                    appearance="embedded"
                    size="dense"
                    type="search"
                    placeholder="Filter"
                    aria-label="Filter processes"
                    value={filter}
                    onChange={(event) => onFilterChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (!filter || event.key !== 'Escape') return;
                        event.preventDefault();
                        onFilterChange('');
                    }}
                />
            </InputGroup>
        </section>
    );
}
