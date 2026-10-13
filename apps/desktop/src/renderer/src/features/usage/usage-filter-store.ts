import type { AgentProvider, UsageRange, UsageScope } from '@caxri/protocol';
import { agentProviderIds, usageRangeIds, usageScopeIds } from '@caxri/protocol';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const FILTERS_STORAGE_KEY = 'caxri.usage.filters';

export const ALL_AGENTS = 'all';
export type UsageAgentFilter = AgentProvider | typeof ALL_AGENTS;

/**
 * The Usage page's last scope, Agent, and range choice, remembered on this device so reopening the tab shows the slice
 * the user was reading instead of resetting to Caxri, All Agents, and 30 days. Presentation state only: the Server
 * never sees it. A Session filter is not remembered; it comes from an explicit request (the status bar usage chip or a
 * Most expensive Sessions row) and opens on all time without overwriting the remembered range.
 */
export interface UsageFilters {
    agent: UsageAgentFilter;
    range: UsageRange;
    scope: UsageScope;
}

export const DEFAULT_USAGE_FILTERS: UsageFilters = {
    agent: ALL_AGENTS,
    range: '30d',
    scope: 'caxri',
};

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * Reads a stored entry field by field, so one stale or corrupt field (an Agent Caxri no longer ships) falls back to its
 * default without discarding the others.
 */
export function parseUsageFilters(stored: unknown): UsageFilters {
    const entry =
        typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    return {
        agent:
            entry.agent === ALL_AGENTS || isOneOf(agentProviderIds, entry.agent)
                ? entry.agent
                : DEFAULT_USAGE_FILTERS.agent,
        range: isOneOf(usageRangeIds, entry.range) ? entry.range : DEFAULT_USAGE_FILTERS.range,
        scope: isOneOf(usageScopeIds, entry.scope) ? entry.scope : DEFAULT_USAGE_FILTERS.scope,
    };
}

export const useUsageFilterStore = createStore<UsageFilters>('usage-filters', () =>
    parseUsageFilters(readLocalStorageJson(FILTERS_STORAGE_KEY)),
);

/**
 * Applies and remembers a choice the user made in the page header.
 */
export function rememberUsageFilters(change: Partial<UsageFilters>): void {
    useUsageFilterStore.setState(change);
    const { agent, range, scope } = useUsageFilterStore.getState();
    writeLocalStorageJson(FILTERS_STORAGE_KEY, { agent, range, scope });
}
