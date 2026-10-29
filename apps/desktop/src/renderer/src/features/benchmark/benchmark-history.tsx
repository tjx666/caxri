import type { BenchmarkRunSummary } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { formatDate } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';

/**
 * The Agents a run compared, each once, in the order they first appear.
 */
function runProviders(run: BenchmarkRunSummary) {
    return [...new Set(run.entries.map((entry) => entry.provider))];
}

/**
 * The left column: New run, then every past run, newest first. The selected row is the board on the right.
 */
export function BenchmarkHistory({
    runs,
    selectedRunId,
    isNewRunSelected,
    onNewRun,
    onSelect,
}: {
    runs: BenchmarkRunSummary[] | undefined;
    selectedRunId: string | undefined;
    isNewRunSelected: boolean;
    onNewRun: () => void;
    onSelect: (runId: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <nav
            aria-label={t('benchmark.history.label')}
            className="flex min-h-0 flex-col border-r border-border bg-surface"
        >
            <div className="p-3">
                <Button
                    className="w-full"
                    data-benchmark-new
                    size="sm"
                    variant={isNewRunSelected ? 'default' : 'secondary'}
                    onClick={onNewRun}
                >
                    <Plus aria-hidden="true" size={12} />
                    {t('benchmark.history.newRun')}
                </Button>
            </div>
            <h2 className="m-0 px-3 pb-1 text-[11px] font-normal text-muted">
                {t('benchmark.history.title')}
            </h2>
            <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2">
                {runs?.length === 0 && (
                    <li className="px-3 py-2 text-[12px] text-muted">
                        {t('benchmark.history.empty')}
                    </li>
                )}
                {runs?.map((run) => (
                    <li key={run.id}>
                        <button
                            type="button"
                            aria-current={run.id === selectedRunId ? 'page' : undefined}
                            className={cn(
                                'flex w-full cursor-pointer flex-col gap-0.5 border-0 bg-transparent px-3 py-1.5 text-left text-inherit hover:bg-list-hover-background',
                                run.id === selectedRunId && 'bg-list-inactive-selection-background',
                            )}
                            data-benchmark-history-row={run.id}
                            onClick={() => onSelect(run.id)}
                        >
                            <span className="truncate text-[12px]">{run.title}</span>
                            <span className="flex items-center gap-1.5 text-[11px] text-muted">
                                {run.status === 'running' && (
                                    <Spinner aria-hidden="true" className="size-3" />
                                )}
                                <span className="flex items-center gap-0.5">
                                    {runProviders(run).map((provider) => (
                                        <AgentIdentityIcon
                                            key={provider}
                                            identity={provider}
                                            size={11}
                                        />
                                    ))}
                                </span>
                                <span className="truncate tabular-nums">
                                    {t('benchmark.history.meta', {
                                        configs: run.entries.length,
                                        date: formatDate(run.createdAt, t.locale),
                                    })}
                                </span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
