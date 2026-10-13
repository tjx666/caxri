import { useState } from 'react';

import { RefreshCw } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Empty, EmptyTitle } from '../../components/ui/empty';
import { useTranslation } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useProjects } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { cancelBenchmark, deleteBenchmark, startBenchmark } from './benchmark-commands';
import { BenchmarkHistory } from './benchmark-history';
import { BenchmarkNewRun } from './benchmark-new-run';
import { rememberDraftPreferences, useBenchmarkPageStore } from './benchmark-page-store';
import {
    useBenchmarkCatalog,
    useBenchmarkEvents,
    useBenchmarkRun,
    useBenchmarkRuns,
} from './benchmark-queries';
import { BenchmarkRunView } from './benchmark-run-view';
import { draftFromRun, startParameters } from './benchmark-selection';

function RunBoard({ runId }: { runId: string }) {
    const { t } = useTranslation();
    const query = useBenchmarkRun(runId);
    const catalog = useBenchmarkCatalog();
    const projects = useProjects();
    const setSelection = useBenchmarkPageStore((state) => state.setSelection);
    const setDraft = useBenchmarkPageStore((state) => state.setDraft);
    if (query.isError)
        return (
            <Empty className="h-full">
                <EmptyTitle className="text-danger">{t('benchmark.run.loadFailed')}</EmptyTitle>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- a failed retry surfaces through the same error state
                        void query.refetch();
                    }}
                >
                    <RefreshCw aria-hidden="true" size={12} />
                    {t('common.retry')}
                </Button>
            </Empty>
        );
    if (!query.data) return <LoadingSkeleton variant="page" label={t('benchmark.run.loading')} />;
    const run = query.data;
    return (
        <BenchmarkRunView
            catalog={catalog.data}
            run={run}
            onCancel={() => {
                // eslint-disable-next-line no-void -- tryCommand reports its own failure
                void tryCommand(t('benchmark.run.cancel'), () => cancelBenchmark(runId));
            }}
            onDelete={() => {
                // eslint-disable-next-line no-void -- tryCommand reports its own failure
                void (async () => {
                    const isConfirmed = await caxri.window.showConfirm({
                        title: t('benchmark.run.deleteTitle'),
                        message: t('benchmark.run.deleteMessage'),
                        confirmLabel: t('benchmark.run.delete'),
                    });
                    if (!isConfirmed) return;
                    await tryCommand(t('benchmark.run.delete'), async () => {
                        await deleteBenchmark(runId);
                        setSelection({ kind: 'new' });
                    });
                })();
            }}
            onRunAgain={() => {
                setDraft(
                    draftFromRun(run, (projectId) =>
                        Boolean(projects?.some((project) => project.id === projectId)),
                    ),
                );
                setSelection({ kind: 'new' });
            }}
        />
    );
}

/**
 * Benchmark Workbench tab: run one prompt across several Agents, models, and efforts, each in its own folder, and
 * compare quality, time, tokens, and cost on a chart and a ranked table. See `docs/benchmark.md`.
 */
export function BenchmarkWorkbenchPage() {
    const { t } = useTranslation();
    useBenchmarkEvents();
    const runs = useBenchmarkRuns();
    const catalog = useBenchmarkCatalog();
    const selection = useBenchmarkPageStore((state) => state.selection);
    const draft = useBenchmarkPageStore((state) => state.draft);
    const setSelection = useBenchmarkPageStore((state) => state.setSelection);
    const setDraft = useBenchmarkPageStore((state) => state.setDraft);
    const [isStarting, setIsStarting] = useState(false);
    const start = async () => {
        setIsStarting(true);
        try {
            const runId = await tryCommand(t('benchmark.form.startLabel'), () =>
                startBenchmark(startParameters(draft, catalog.data)),
            );
            if (!runId) return;
            rememberDraftPreferences(draft);
            setDraft((current) => ({ ...current, prompt: '' }));
            setSelection({ kind: 'run', runId });
        } finally {
            setIsStarting(false);
        }
    };
    return (
        // `p-px` keeps the page fill off the pane's 1px inset focus ring, as the Usage page does.
        <div
            className="grid h-full grid-cols-[220px_minmax(0,1fr)] overflow-hidden p-px"
            data-benchmark-page
        >
            <BenchmarkHistory
                isNewRunSelected={selection.kind === 'new'}
                runs={runs.data?.runs}
                selectedRunId={selection.kind === 'run' ? selection.runId : undefined}
                onNewRun={() => setSelection({ kind: 'new' })}
                onSelect={(runId) => setSelection({ kind: 'run', runId })}
            />
            <div className="min-h-0 overflow-y-auto">
                {selection.kind === 'run' ? (
                    <RunBoard key={selection.runId} runId={selection.runId} />
                ) : (
                    <>
                        <div className="mx-auto w-full max-w-4xl px-6 pt-5">
                            <h1 className="m-0 text-[15px] font-semibold">
                                {t('benchmark.title')}
                            </h1>
                            <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                                {t('benchmark.caption')}
                            </p>
                        </div>
                        <BenchmarkNewRun
                            catalog={catalog.data}
                            draft={draft}
                            isCatalogLoading={catalog.isPending}
                            isCatalogRefreshing={catalog.isRefreshing}
                            isStarting={isStarting}
                            onChange={setDraft}
                            onRefreshCatalog={() => {
                                // eslint-disable-next-line no-void -- tryCommand reports its own failure
                                void tryCommand(t('benchmark.picker.refresh'), catalog.refresh);
                            }}
                            onStart={() => {
                                // eslint-disable-next-line no-void -- tryCommand inside reports the failure
                                void start();
                            }}
                        />
                    </>
                )}
            </div>
        </div>
    );
}
