import type {
    AgentChatModel,
    BenchmarkCatalog,
    BenchmarkCatalogProvider,
    BenchmarkEntry,
} from '@caxri/protocol';
import { agentProviderCatalog, MAX_BENCHMARK_ENTRIES } from '@caxri/protocol';
import { RefreshCw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Toggle } from '../../components/ui/toggle';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { hasEntry } from './benchmark-selection';

/**
 * One model row: its name, then a chip per effort it accepts. Every model leads with `Default`, the provider's own
 * effort, which is the baseline a comparison of explicit efforts is read against.
 */
function ModelRow({
    model,
    provider,
    entries,
    isFull,
    onToggle,
}: {
    model: AgentChatModel;
    provider: BenchmarkCatalogProvider['provider'];
    entries: readonly BenchmarkEntry[];
    isFull: boolean;
    onToggle: (entry: BenchmarkEntry) => void;
}) {
    const { t } = useTranslation();
    const efforts: Array<BenchmarkEntry['effort']> = [undefined, ...model.efforts];
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 py-1">
            <span className="w-44 flex-none truncate text-[12px]" title={model.id}>
                {model.displayName || model.id}
            </span>
            <div className="flex flex-wrap items-center gap-1">
                {efforts.map((effort) => {
                    const entry: BenchmarkEntry = {
                        provider,
                        model: model.id,
                        ...(effort && { effort }),
                    };
                    const isPressed = hasEntry(entries, entry);
                    return (
                        <Toggle
                            key={effort ?? ''}
                            aria-label={t('benchmark.picker.chipLabel', {
                                model: model.displayName || model.id,
                                effort: effort ?? t('benchmark.picker.defaultEffort'),
                            })}
                            className="border-border uppercase data-pressed:border-accent data-pressed:bg-accent/15"
                            data-benchmark-chip
                            disabled={!isPressed && isFull}
                            pressed={isPressed}
                            onPressedChange={() => onToggle(entry)}
                        >
                            {effort ?? t('benchmark.picker.defaultEffort')}
                        </Toggle>
                    );
                })}
            </div>
        </div>
    );
}

function ProviderGroup({
    provider,
    entries,
    isFull,
    onToggle,
}: {
    provider: BenchmarkCatalogProvider;
    entries: readonly BenchmarkEntry[];
    isFull: boolean;
    onToggle: (entry: BenchmarkEntry) => void;
}) {
    const { t } = useTranslation();
    const name = agentProviderCatalog[provider.provider].displayName;
    const selected = entries.filter((entry) => entry.provider === provider.provider).length;
    return (
        <section aria-label={name} className="border-t border-border py-2 first:border-t-0">
            <div className="flex items-center gap-2 pb-1">
                <AgentIdentityIcon identity={provider.provider} size={14} />
                <h3 className="m-0 text-[12px] font-semibold">{name}</h3>
                {selected > 0 && (
                    <span className="text-[11px] text-muted">
                        {t('benchmark.picker.selectedCount', { count: selected })}
                    </span>
                )}
            </div>
            {provider.status === 'ready' ? (
                provider.models.length > 0 ? (
                    provider.models.map((model) => (
                        <ModelRow
                            key={model.id}
                            entries={entries}
                            isFull={isFull}
                            model={model}
                            provider={provider.provider}
                            onToggle={onToggle}
                        />
                    ))
                ) : (
                    <p className="m-0 py-1 text-[12px] text-muted">
                        {t('benchmark.picker.noModels')}
                    </p>
                )
            ) : (
                <p className="m-0 py-1 text-[12px] text-muted">
                    {provider.status === 'missing'
                        ? t('benchmark.picker.missing', { agent: name })
                        : t('benchmark.picker.failed', {
                              agent: name,
                              message: provider.message ?? t('benchmark.picker.failedUnknown'),
                          })}
                </p>
            )}
        </section>
    );
}

/**
 * The models every installed Agent offers, grouped by Agent. Each chip is one Entry: a model at one effort.
 */
export function BenchmarkModelPicker({
    catalog,
    isLoading,
    isRefreshing,
    entries,
    onToggle,
    onRefresh,
}: {
    catalog: BenchmarkCatalog | undefined;
    isLoading: boolean;
    isRefreshing: boolean;
    entries: readonly BenchmarkEntry[];
    onToggle: (entry: BenchmarkEntry) => void;
    onRefresh: () => void;
}) {
    const { t } = useTranslation();
    const isFull = entries.length >= MAX_BENCHMARK_ENTRIES;
    return (
        <div data-benchmark-picker>
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                    {isFull
                        ? t('benchmark.picker.full', { count: MAX_BENCHMARK_ENTRIES })
                        : t('benchmark.picker.hint')}
                </span>
                <Button disabled={isRefreshing} size="sm" variant="ghost" onClick={onRefresh}>
                    {isRefreshing ? (
                        <Spinner aria-hidden="true" className="size-3" />
                    ) : (
                        <RefreshCw aria-hidden="true" size={12} />
                    )}
                    {t('benchmark.picker.refresh')}
                </Button>
            </div>
            <div className="rounded-md border border-border bg-surface px-3 py-1">
                {catalog ? (
                    catalog.providers.map((provider) => (
                        <ProviderGroup
                            key={provider.provider}
                            entries={entries}
                            isFull={isFull}
                            provider={provider}
                            onToggle={onToggle}
                        />
                    ))
                ) : (
                    <div className="flex items-center gap-2 py-3 text-[12px] text-muted">
                        {isLoading && <Spinner aria-hidden="true" className="size-3" />}
                        {t(isLoading ? 'benchmark.picker.loading' : 'benchmark.picker.loadFailed')}
                    </div>
                )}
            </div>
        </div>
    );
}
