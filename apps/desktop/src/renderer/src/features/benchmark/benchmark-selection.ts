import type {
    AgentProvider,
    BenchmarkCatalog,
    BenchmarkEntry,
    BenchmarkStartParameters,
} from '@caxri/protocol';
import {
    benchmarkEntrySchema,
    benchmarkSettingsSchema,
    DEFAULT_BENCHMARK_CONCURRENCY,
    DEFAULT_BENCHMARK_TIMEOUT_MINUTES,
    MAX_BENCHMARK_CHECK_COMMAND_LENGTH,
    MAX_BENCHMARK_ENTRIES,
} from '@caxri/protocol';
import { z } from 'zod';

/**
 * Everything the New run form holds before it becomes `benchmark.start` parameters.
 */
export interface BenchmarkDraft {
    prompt: string;
    entries: BenchmarkEntry[];
    /**
     * The Project an Attempt clones, or `undefined` for an empty folder.
     */
    projectId?: string;
    repeats: number;
    concurrency: number;
    timeoutMinutes: number;
    checkCommand: string;
    /**
     * The judge Entry; `null` with the judge turned off, `undefined` for the default judge ({@link defaultJudge}).
     */
    judge?: BenchmarkEntry | null;
}

export function emptyDraft(): BenchmarkDraft {
    return {
        prompt: '',
        entries: [],
        repeats: 1,
        concurrency: DEFAULT_BENCHMARK_CONCURRENCY,
        timeoutMinutes: DEFAULT_BENCHMARK_TIMEOUT_MINUTES,
        checkCommand: '',
    };
}

function entryKey(entry: BenchmarkEntry): string {
    return `${entry.provider}\u{0}${entry.model}\u{0}${entry.effort ?? ''}`;
}

export function hasEntry(entries: readonly BenchmarkEntry[], entry: BenchmarkEntry): boolean {
    const key = entryKey(entry);
    return entries.some((candidate) => entryKey(candidate) === key);
}

/**
 * Adds the Entry, or removes it when already chosen. Adding past the limit changes nothing; the form says why.
 */
export function toggleEntry(
    entries: readonly BenchmarkEntry[],
    entry: BenchmarkEntry,
): BenchmarkEntry[] {
    const key = entryKey(entry);
    if (entries.some((candidate) => entryKey(candidate) === key))
        return entries.filter((candidate) => entryKey(candidate) !== key);
    if (entries.length >= MAX_BENCHMARK_ENTRIES) return [...entries];
    return [...entries, entry];
}

/**
 * Agents the judge is picked from by default, strongest general reviewer first.
 */
const JUDGE_PREFERENCE: readonly AgentProvider[] = ['claude', 'codex', 'grok', 'antigravity'];

/**
 * The judge a new run starts with: the first ready Agent's default model, so the result can rank by quality without the
 * user configuring anything. `undefined` when no Agent is ready.
 */
export function defaultJudge(catalog: BenchmarkCatalog | undefined): BenchmarkEntry | undefined {
    for (const provider of JUDGE_PREFERENCE) {
        const ready = catalog?.providers.find(
            (candidate) => candidate.provider === provider && candidate.status === 'ready',
        );
        const model = ready?.defaultModel ?? ready?.models[0]?.id;
        if (ready && model) return { provider, model };
    }
    return undefined;
}

export type DraftProblem = 'noPrompt' | 'noEntries';

/**
 * Why the draft cannot start yet, or `undefined` when it can.
 */
export function draftProblem(draft: BenchmarkDraft): DraftProblem | undefined {
    if (draft.prompt.trim().length === 0) return 'noPrompt';
    if (draft.entries.length === 0) return 'noEntries';
    return undefined;
}

export function attemptCount(draft: Pick<BenchmarkDraft, 'entries' | 'repeats'>): number {
    return draft.entries.length * draft.repeats;
}

/**
 * The judge the draft runs with, resolving "default" against the Agents that are ready.
 */
function resolvedJudge(
    draft: Pick<BenchmarkDraft, 'judge'>,
    catalog: BenchmarkCatalog | undefined,
): BenchmarkEntry | undefined {
    if (draft.judge === null) return undefined;
    return draft.judge ?? defaultJudge(catalog);
}

export function startParameters(
    draft: BenchmarkDraft,
    catalog: BenchmarkCatalog | undefined,
): BenchmarkStartParameters {
    const checkCommand = draft.checkCommand.trim();
    const judge = resolvedJudge(draft, catalog);
    return {
        prompt: draft.prompt.trim(),
        entries: draft.entries,
        settings: {
            workspace: draft.projectId
                ? { kind: 'project', projectId: draft.projectId }
                : { kind: 'empty' },
            repeats: draft.repeats,
            concurrency: draft.concurrency,
            timeoutMinutes: draft.timeoutMinutes,
            ...(checkCommand && { checkCommand }),
            ...(judge && { judge }),
        },
    };
}

/**
 * A draft that runs the same thing again, for "Run again" on a finished run. The Project is kept only while it still
 * exists in the Workbench.
 */
export function draftFromRun(
    run: Pick<BenchmarkStartParameters, 'entries' | 'prompt' | 'settings'>,
    hasProject: (projectId: string) => boolean,
): BenchmarkDraft {
    const { workspace } = run.settings;
    return {
        prompt: run.prompt,
        entries: [...run.entries],
        ...(workspace.kind === 'project' &&
            hasProject(workspace.projectId) && { projectId: workspace.projectId }),
        repeats: run.settings.repeats,
        concurrency: run.settings.concurrency,
        timeoutMinutes: run.settings.timeoutMinutes,
        checkCommand: run.settings.checkCommand ?? '',
        judge: run.settings.judge ?? null,
    };
}

const draftPreferencesSchema = z.object({
    entries: z.array(benchmarkEntrySchema).max(MAX_BENCHMARK_ENTRIES),
    repeats: benchmarkSettingsSchema.shape.repeats,
    concurrency: benchmarkSettingsSchema.shape.concurrency,
    timeoutMinutes: benchmarkSettingsSchema.shape.timeoutMinutes,
    checkCommand: z.string().max(MAX_BENCHMARK_CHECK_COMMAND_LENGTH),
    judge: benchmarkEntrySchema.nullable().optional(),
});

/**
 * What a new run remembers from the last one started: the chosen Entries, judge, check, and execution settings, but
 * never the prompt or the Project, which belong to that one task.
 */
export function serializeDraftPreferences(draft: BenchmarkDraft): string {
    const { entries, repeats, concurrency, timeoutMinutes, checkCommand, judge } = draft;
    return JSON.stringify({ entries, repeats, concurrency, timeoutMinutes, checkCommand, judge });
}

/**
 * A new draft seeded from {@link serializeDraftPreferences}, or the empty draft when nothing valid was saved.
 */
export function draftFromPreferences(saved: string | null): BenchmarkDraft {
    if (!saved) return emptyDraft();
    try {
        const parsed = draftPreferencesSchema.safeParse(JSON.parse(saved));
        return parsed.success ? { ...emptyDraft(), ...parsed.data } : emptyDraft();
    } catch {
        return emptyDraft();
    }
}
