import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_USAGE_FILTERS, parseUsageFilters } from '../usage-filter-store';

const STORAGE_KEY = 'caxri.usage.filters';

/**
 * The suite runs under Vitest's `node` environment, so a test installs `window` and `localStorage` itself. The store
 * reads storage when its module loads, which is when the Usage tab first opens, so each case loads a fresh copy.
 */
function stubStorage(entries: Map<string, string>): void {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    });
}

async function openPage() {
    vi.resetModules();
    return import('../usage-filter-store');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('parseUsageFilters', () => {
    it('falls back per field so one stale value keeps the others', () => {
        expect(parseUsageFilters(undefined)).toEqual(DEFAULT_USAGE_FILTERS);
        expect(parseUsageFilters('7d')).toEqual(DEFAULT_USAGE_FILTERS);
        expect(parseUsageFilters({ agent: 'retired-agent', range: '7d', scope: 'all' })).toEqual({
            agent: 'all',
            range: '7d',
            custom: undefined,
            scope: 'all',
        });
        expect(parseUsageFilters({ agent: 'codex', range: 'week', scope: 'everywhere' })).toEqual({
            agent: 'codex',
            range: '30d',
            custom: undefined,
            scope: 'caxri',
        });
    });

    it('keeps a custom range only with valid ordered days', () => {
        const custom = { start: '2026-10-25', end: '2026-10-27' };
        expect(parseUsageFilters({ range: 'custom', custom })).toMatchObject({
            range: 'custom',
            custom,
        });
        expect(
            parseUsageFilters({
                range: 'custom',
                custom: { start: '2026-10-27', end: '2026-10-25' },
            }),
        ).toMatchObject({ range: '30d', custom: undefined });
        expect(
            parseUsageFilters({ range: 'custom', custom: { start: 'yesterday' } }),
        ).toMatchObject({ range: '30d', custom: undefined });
        expect(parseUsageFilters({ range: 'today', custom })).toMatchObject({
            range: 'today',
            custom,
        });
    });
});

describe('useUsageFilterStore', () => {
    it('reopens the page on the scope, Agent, and range last picked', async () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        const first = await openPage();
        expect(first.useUsageFilterStore.getState()).toMatchObject(DEFAULT_USAGE_FILTERS);
        first.rememberUsageFilters({ scope: 'all' });
        first.rememberUsageFilters({ agent: 'claude', range: '90d' });
        expect(JSON.parse(entries.get(STORAGE_KEY) ?? 'null')).toEqual({
            agent: 'claude',
            range: '90d',
            scope: 'all',
        });
        first.rememberUsageFilters({
            range: 'custom',
            custom: { start: '2026-10-25', end: '2026-10-27' },
        });
        expect(JSON.parse(entries.get(STORAGE_KEY) ?? 'null')).toMatchObject({
            range: 'custom',
            custom: { start: '2026-10-25', end: '2026-10-27' },
        });
        first.rememberUsageFilters({ range: '90d' });

        const reopened = await openPage();
        expect(reopened.useUsageFilterStore.getState()).toMatchObject({
            agent: 'claude',
            range: '90d',
            scope: 'all',
        });
    });

    it('keeps the choice for this window when storage is unavailable', async () => {
        const { rememberUsageFilters, useUsageFilterStore } = await openPage();
        rememberUsageFilters({ range: '7d' });
        expect(useUsageFilterStore.getState().range).toBe('7d');
    });
});
