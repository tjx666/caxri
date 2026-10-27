import type { ReactNode } from 'react';

import type { BenchmarkCatalog, BenchmarkEntry } from '@caxri/protocol';
import {
    agentProviderCatalog,
    MAX_BENCHMARK_CHECK_COMMAND_LENGTH,
    MAX_BENCHMARK_CONCURRENCY,
    MAX_BENCHMARK_PROMPT_LENGTH,
    MAX_BENCHMARK_REPEATS,
    MAX_BENCHMARK_TIMEOUT_MINUTES,
} from '@caxri/protocol';
import { Play } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import { useProjects } from '../../stores/selectors';
import { BenchmarkModelPicker } from './benchmark-model-picker';
import { modelLabel } from './benchmark-presentation';
import type { BenchmarkDraft } from './benchmark-selection';
import { attemptCount, defaultJudge, draftProblem, toggleEntry } from './benchmark-selection';

const JUDGE_DEFAULT = 'default';
const JUDGE_OFF = 'off';
const WORKSPACE_EMPTY = 'empty';

function judgeValue(judge: BenchmarkEntry | null | undefined): string {
    if (judge === null) return JUDGE_OFF;
    if (judge === undefined) return JUDGE_DEFAULT;
    return `${judge.provider}\u{0}${judge.model}`;
}

function FormSection({
    title,
    caption,
    children,
}: {
    title: string;
    caption?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section aria-label={title} className="flex flex-col gap-1.5">
            <h2 className="m-0 text-[12px] font-semibold">{title}</h2>
            {children}
            {caption && <p className="m-0 text-[11px] leading-[1.45] text-muted">{caption}</p>}
        </section>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="flex items-center gap-2 text-[12px]">
            <span className="text-muted">{label}</span>
            <Input
                className="w-16 tabular-nums"
                max={max}
                min={min}
                size="dense"
                type="number"
                value={value}
                onChange={(event) => {
                    const next = Math.trunc(Number(event.target.value));
                    if (event.target.value !== '' && Number.isFinite(next))
                        onChange(Math.min(max, Math.max(min, next)));
                }}
            />
        </label>
    );
}

function JudgeSelect({
    catalog,
    judge,
    onChange,
}: {
    catalog: BenchmarkCatalog | undefined;
    judge: BenchmarkEntry | null | undefined;
    onChange: (judge: BenchmarkEntry | null | undefined) => void;
}) {
    const { t } = useTranslation();
    const fallback = defaultJudge(catalog);
    const options =
        catalog?.providers
            .filter((provider) => provider.status === 'ready')
            .flatMap((provider) =>
                provider.models.map((model) => ({
                    value: judgeValue({ provider: provider.provider, model: model.id }),
                    entry: { provider: provider.provider, model: model.id },
                    label: `${agentProviderCatalog[provider.provider].displayName} · ${model.displayName || model.id}`,
                })),
            ) ?? [];
    const labelOf = (value: string) => {
        if (value === JUDGE_OFF) return t('benchmark.judge.off');
        if (value === JUDGE_DEFAULT)
            return fallback
                ? t('benchmark.judge.default', {
                      model: `${agentProviderCatalog[fallback.provider].displayName} · ${modelLabel(catalog, fallback)}`,
                  })
                : t('benchmark.judge.defaultUnavailable');
        return (
            options.find((option) => option.value === value)?.label ??
            (judge ? `${agentProviderCatalog[judge.provider].displayName} · ${judge.model}` : value)
        );
    };
    return (
        <Select
            value={judgeValue(judge)}
            onValueChange={(value: string | null) => {
                if (value === null || value === JUDGE_DEFAULT) onChange(undefined);
                else if (value === JUDGE_OFF) onChange(null);
                else onChange(options.find((option) => option.value === value)?.entry);
            }}
        >
            <SelectTrigger
                aria-label={t('benchmark.judge.title')}
                className="h-7 max-w-96 text-[12px]"
            >
                <SelectValue>{labelOf(judgeValue(judge))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={JUDGE_DEFAULT}>{labelOf(JUDGE_DEFAULT)}</SelectItem>
                <SelectItem value={JUDGE_OFF}>{labelOf(JUDGE_OFF)}</SelectItem>
                {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/**
 * Where each Attempt works: a fresh empty folder, or a copy of any Project. The Benchmark window has no selected
 * Session, so every Project is offered; a remembered Project that was removed reads as the empty folder.
 */
function WorkspaceSelect({
    projectId,
    onChange,
}: {
    projectId: string | undefined;
    onChange: (projectId: string | undefined) => void;
}) {
    const { t } = useTranslation();
    const projects = useProjects() ?? [];
    const project = projects.find((candidate) => candidate.id === projectId);
    const value = project?.id ?? WORKSPACE_EMPTY;
    return (
        <>
            <Select
                value={value}
                onValueChange={(next: string | null) =>
                    onChange(next && next !== WORKSPACE_EMPTY ? next : undefined)
                }
            >
                <SelectTrigger
                    aria-label={t('benchmark.form.workspace')}
                    className="h-7 max-w-96 text-[12px]"
                >
                    <SelectValue>
                        {project
                            ? t('benchmark.form.workspaceProject', {
                                  project: project.title,
                              })
                            : t('benchmark.form.workspaceEmpty')}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={WORKSPACE_EMPTY}>
                        {t('benchmark.form.workspaceEmpty')}
                    </SelectItem>
                    {projects.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                            {t('benchmark.form.workspaceProject', {
                                project: candidate.title,
                            })}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <p className="m-0 text-[11px] leading-[1.45] text-muted">
                {project
                    ? t('benchmark.form.workspaceProjectCaption', {
                          project: project.title,
                      })
                    : t('benchmark.form.workspaceEmptyCaption')}
            </p>
        </>
    );
}

/**
 * The New run form: the prompt, the Entries to compare, where they run, and how the result is scored. Everything but
 * the prompt and the Project is remembered for the next run.
 */
export function BenchmarkNewRun({
    draft,
    catalog,
    isCatalogLoading,
    isCatalogRefreshing,
    isStarting,
    onChange,
    onRefreshCatalog,
    onStart,
}: {
    draft: BenchmarkDraft;
    catalog: BenchmarkCatalog | undefined;
    isCatalogLoading: boolean;
    isCatalogRefreshing: boolean;
    isStarting: boolean;
    onChange: (update: (current: BenchmarkDraft) => BenchmarkDraft) => void;
    onRefreshCatalog: () => void;
    onStart: () => void;
}) {
    const { t } = useTranslation();
    const problem = draftProblem(draft);
    const update = (patch: Partial<BenchmarkDraft>) =>
        onChange((current) => ({ ...current, ...patch }));
    return (
        <form
            data-benchmark-new-run
            className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 pt-5 pb-8"
            onSubmit={(event) => {
                event.preventDefault();
                if (!problem && !isStarting) onStart();
            }}
        >
            <FormSection title={t('benchmark.form.prompt')}>
                <Textarea
                    aria-label={t('benchmark.form.prompt')}
                    className="min-h-[120px] text-[13px]"
                    maxLength={MAX_BENCHMARK_PROMPT_LENGTH}
                    placeholder={t('benchmark.form.promptPlaceholder')}
                    value={draft.prompt}
                    onChange={(event) => update({ prompt: event.target.value })}
                    onKeyDown={(event) => {
                        if (!(event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                            return;
                        }

                        event.preventDefault();
                        if (!problem && !isStarting) onStart();
                    }}
                />
            </FormSection>
            <FormSection title={t('benchmark.form.models')}>
                <BenchmarkModelPicker
                    catalog={catalog}
                    entries={draft.entries}
                    isLoading={isCatalogLoading}
                    isRefreshing={isCatalogRefreshing}
                    onRefresh={onRefreshCatalog}
                    onToggle={(entry) =>
                        onChange((current) => ({
                            ...current,
                            entries: toggleEntry(current.entries, entry),
                        }))
                    }
                />
            </FormSection>
            <FormSection title={t('benchmark.form.workspace')}>
                <WorkspaceSelect
                    projectId={draft.projectId}
                    onChange={(projectId) => update({ projectId })}
                />
            </FormSection>
            <FormSection title={t('benchmark.judge.title')} caption={t('benchmark.judge.caption')}>
                <JudgeSelect
                    catalog={catalog}
                    judge={draft.judge}
                    onChange={(judge) => update({ judge })}
                />
            </FormSection>
            <FormSection
                title={t('benchmark.form.check')}
                caption={t('benchmark.form.checkCaption')}
            >
                <Input
                    aria-label={t('benchmark.form.check')}
                    className="max-w-md font-mono"
                    maxLength={MAX_BENCHMARK_CHECK_COMMAND_LENGTH}
                    placeholder={t('benchmark.form.checkPlaceholder')}
                    size="dense"
                    spellCheck={false}
                    value={draft.checkCommand}
                    onChange={(event) => update({ checkCommand: event.target.value })}
                />
            </FormSection>
            <FormSection title={t('benchmark.form.execution')}>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <NumberField
                        label={t('benchmark.form.repeats')}
                        max={MAX_BENCHMARK_REPEATS}
                        min={1}
                        value={draft.repeats}
                        onChange={(repeats) => update({ repeats })}
                    />
                    <NumberField
                        label={t('benchmark.form.concurrency')}
                        max={MAX_BENCHMARK_CONCURRENCY}
                        min={1}
                        value={draft.concurrency}
                        onChange={(concurrency) => update({ concurrency })}
                    />
                    <NumberField
                        label={t('benchmark.form.timeout')}
                        max={MAX_BENCHMARK_TIMEOUT_MINUTES}
                        min={1}
                        value={draft.timeoutMinutes}
                        onChange={(timeoutMinutes) => update({ timeoutMinutes })}
                    />
                </div>
            </FormSection>
            <div className="flex items-center gap-3 border-t border-border pt-4">
                <Button
                    data-benchmark-start
                    disabled={Boolean(problem) || isStarting}
                    type="submit"
                >
                    <Play aria-hidden="true" size={14} />
                    {draft.repeats > 1
                        ? t('benchmark.form.startRepeated', {
                              count: draft.entries.length,
                              repeats: draft.repeats,
                          })
                        : t(
                              draft.entries.length === 1
                                  ? 'benchmark.form.startOne'
                                  : 'benchmark.form.startOther',
                              { count: draft.entries.length },
                          )}
                </Button>
                <span className="text-[11px] text-muted">
                    {problem
                        ? t(`benchmark.form.problem.${problem}`)
                        : t(
                              attemptCount(draft) === 1
                                  ? 'benchmark.form.attemptsOne'
                                  : 'benchmark.form.attemptsOther',
                              { count: attemptCount(draft) },
                          )}
                </span>
            </div>
        </form>
    );
}
