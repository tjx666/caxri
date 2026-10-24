import type { ReloadEntry, ReloadStageName } from '@desktop-shared/performance-monitor';

import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { formatMilliseconds } from './format';

const STAGES: ReadonlyArray<{ key: ReloadStageName; label: TranslationKey }> = [
    { key: 'domReady', label: 'performanceMonitor.reload.stage.domReady' },
    { key: 'didFinishLoad', label: 'performanceMonitor.reload.stage.didFinishLoad' },
    { key: 'loaderRemoved', label: 'performanceMonitor.reload.stage.loaderRemoved' },
    { key: 'firstFrame', label: 'performanceMonitor.reload.stage.firstFrame' },
];

const FAILURE_LABEL = {
    'did-fail-load': 'performanceMonitor.reload.failure.did-fail-load',
    'render-process-gone': 'performanceMonitor.reload.failure.render-process-gone',
    'unresponsive': 'performanceMonitor.reload.failure.unresponsive',
} as const satisfies Record<NonNullable<ReloadEntry['failure']>, TranslationKey>;

function totalMs(entry: ReloadEntry): number | undefined {
    const { firstFrame, loaderRemoved, didFinishLoad, domReady } = entry.stages;
    return firstFrame ?? loaderRemoved ?? didFinishLoad ?? domReady;
}

function ReloadRow({ entry }: { entry: ReloadEntry }) {
    const { t } = useTranslation();
    const total = totalMs(entry);
    const scale = Math.max(total ?? 0, 1);
    return (
        <li
            className="border-b border-border px-3 py-2 last:border-b-0"
            data-reload-entry={entry.id}
            data-reload-outcome={entry.outcome}
        >
            <div className="flex items-baseline justify-between text-[12px]">
                <span>
                    {t(
                        entry.kind === 'reload'
                            ? 'performanceMonitor.reload.kind.reload'
                            : 'performanceMonitor.reload.kind.hardReload',
                    )}
                </span>
                <span
                    className={cn(
                        'font-mono tabular-nums',
                        entry.outcome === 'failed' && 'text-danger',
                        entry.outcome === 'loading' && 'text-muted',
                    )}
                    data-reload-total
                >
                    {entry.outcome === 'failed' && entry.failure
                        ? t(FAILURE_LABEL[entry.failure])
                        : total === undefined
                          ? t('performanceMonitor.reload.loading')
                          : formatMilliseconds(total)}
                </span>
            </div>
            <ul className="mt-1.5 grid gap-1">
                {STAGES.map(({ key, label }) => {
                    const value = entry.stages[key];
                    if (value === undefined) return null;
                    return (
                        <li
                            key={key}
                            className="grid grid-cols-[88px_1fr_52px] items-center gap-2 text-[11px] text-muted"
                        >
                            <span>{t(label)}</span>
                            <span className="h-1 rounded-sm bg-border">
                                <span
                                    className="block h-full rounded-sm bg-chart"
                                    style={{ width: `${Math.min(100, (value / scale) * 100)}%` }}
                                />
                            </span>
                            <span className="text-right font-mono tabular-nums">
                                {formatMilliseconds(value)}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </li>
    );
}

/**
 * The last ten Workbench loads, newest first, each with its cumulative stage timings.
 */
export function ReloadTimeline({ reloads }: { reloads: readonly ReloadEntry[] }) {
    const { t } = useTranslation();
    if (reloads.length === 0)
        return (
            <p className="px-3 py-3 text-[12px] text-muted">
                {t('performanceMonitor.reload.empty')}
            </p>
        );
    return (
        <ul data-reload-timeline>
            {reloads.map((entry) => (
                <ReloadRow key={entry.id} entry={entry} />
            ))}
        </ul>
    );
}
