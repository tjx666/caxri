import type { BenchmarkCatalog } from '@caxri/protocol';
import { MAX_BENCHMARK_ENTRIES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    defaultJudge,
    draftFromPreferences,
    draftFromRun,
    draftProblem,
    emptyDraft,
    serializeDraftPreferences,
    startParameters,
    toggleEntry,
} from '../benchmark-selection';

const model = (id: string) => ({ id, displayName: id, efforts: [] });

describe('toggleEntry', () => {
    it('adds and removes one model and effort pair', () => {
        const low = { provider: 'codex' as const, model: 'gpt', effort: 'low' as const };
        const high = { ...low, effort: 'high' as const };
        const added = toggleEntry(toggleEntry([], low), high);

        expect(added).toEqual([low, high]);
        expect(toggleEntry(added, { ...low })).toEqual([high]);
    });

    it('stops at the Entry limit', () => {
        const full = Array.from({ length: MAX_BENCHMARK_ENTRIES }, (_value, index) => ({
            provider: 'codex' as const,
            model: `model-${index}`,
        }));

        expect(toggleEntry(full, { provider: 'claude', model: 'opus' })).toHaveLength(
            MAX_BENCHMARK_ENTRIES,
        );
    });
});

describe('defaultJudge', () => {
    it('picks the first ready Agent in preference order', () => {
        const catalog: BenchmarkCatalog = {
            checkedAt: 0,
            providers: [
                { provider: 'claude', status: 'missing', models: [] },
                {
                    provider: 'codex',
                    status: 'ready',
                    defaultModel: 'gpt',
                    models: [model('gpt'), model('mini')],
                },
                { provider: 'grok', status: 'ready', models: [model('grok')] },
            ],
        };

        expect(defaultJudge(catalog)).toEqual({ provider: 'codex', model: 'gpt' });
        expect(defaultJudge(undefined)).toBeUndefined();
    });
});

describe('startParameters', () => {
    it('trims the prompt and omits an empty check command and a disabled judge', () => {
        const draft = {
            ...emptyDraft(),
            prompt: '  Build it  ',
            entries: [{ provider: 'codex' as const, model: 'gpt' }],
            checkCommand: '  ',
            judge: null,
        };

        expect(draftProblem(draft)).toBeUndefined();
        expect(startParameters(draft, undefined)).toEqual({
            prompt: 'Build it',
            entries: [{ provider: 'codex', model: 'gpt' }],
            settings: {
                workspace: { kind: 'empty' },
                repeats: 1,
                concurrency: 3,
                timeoutMinutes: 20,
            },
        });
    });

    it('names what is missing', () => {
        expect(draftProblem(emptyDraft())).toBe('noPrompt');
        expect(draftProblem({ ...emptyDraft(), prompt: 'x' })).toBe('noEntries');
    });

    it('runs a finished run again, dropping a Project that is gone', () => {
        const settings = {
            workspace: { kind: 'project' as const, projectId: 'gone' },
            repeats: 2,
            concurrency: 1,
            timeoutMinutes: 5,
            checkCommand: 'npm test',
        };
        const draft = draftFromRun(
            { prompt: 'Task', entries: [{ provider: 'grok', model: 'grok' }], settings },
            () => false,
        );

        expect(draft.projectId).toBeUndefined();
        expect(startParameters(draft, undefined).settings).toEqual({
            ...settings,
            workspace: { kind: 'empty' },
        });
    });

    it('resolves the default judge against the ready Agents', () => {
        const catalog: BenchmarkCatalog = {
            checkedAt: 0,
            providers: [{ provider: 'grok', status: 'ready', models: [model('grok')] }],
        };
        const draft = {
            ...emptyDraft(),
            prompt: 'x',
            entries: [{ provider: 'grok' as const, model: 'grok' }],
        };

        expect(startParameters(draft, catalog).settings.judge).toEqual({
            provider: 'grok',
            model: 'grok',
        });
    });
});

describe('draft preferences', () => {
    it('remembers the choices but not the prompt or Project', () => {
        const draft = {
            ...emptyDraft(),
            prompt: 'secret task',
            projectId: 'project',
            entries: [{ provider: 'codex' as const, model: 'gpt', effort: 'high' as const }],
            repeats: 3,
            judge: null,
        };
        const restored = draftFromPreferences(serializeDraftPreferences(draft));

        expect(restored).toEqual({ ...draft, prompt: '', projectId: undefined });
    });

    it('falls back to an empty draft for anything invalid', () => {
        expect(draftFromPreferences('{not json')).toEqual(emptyDraft());
        expect(draftFromPreferences(JSON.stringify({ entries: 'x' }))).toEqual(emptyDraft());
        expect(draftFromPreferences(null)).toEqual(emptyDraft());
    });
});
