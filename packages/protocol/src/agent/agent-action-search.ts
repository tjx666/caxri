import { sortedCopy } from '@caxri/utils';
import type { FuseResult, IFuseOptions } from 'fuse.js';
import Fuse from 'fuse.js';

import type { AgentAction } from './agent-action-contract.js';

interface SearchableAgentAction {
    action: AgentAction;
    index: number;
    invocation: string;
    name: string;
    description: string;
}

const searchOptions = {
    includeMatches: true,
    includeScore: true,
    ignoreLocation: true,
    keys: [
        { name: 'name', weight: 4 },
        { name: 'invocation', weight: 3 },
        { name: 'description', weight: 1 },
    ],
    minMatchCharLength: 1,
    threshold: 0.35,
    tokenMatch: 'all',
    useTokenSearch: true,
} satisfies IFuseOptions<SearchableAgentAction>;

const actionName = (invocation: string): string => invocation.slice(1);

const actionInitials = (name: string): string =>
    name
        .split(/[-_:./]+/u)
        .filter(Boolean)
        .map((part) => [...part][0])
        .join('');

function fuzzyMatchTier(result: FuseResult<SearchableAgentAction> | undefined): number | undefined {
    if (!result) return undefined;
    return result.matches?.some(({ key }) => key === 'name' || key === 'invocation') ? 3 : 4;
}

/**
 * Ranks Agent actions for a typed query. One ranking serves every surface: the Desktop picker and Chat menu call it
 * directly, and Server Core ranks `mobile.agent.actions` with it before keeping the phone's bounded top slice.
 *
 * Fuse's Bitap score treats `pr` → `pull-request` as an edit rather than a word-boundary abbreviation. Explicit tiers
 * keep invocation/name matches ahead of descriptions while Fuse still supplies typo tolerance inside each tier.
 *
 * @see https://github.com/tjx666/caxri/issues/424
 */
export function searchAgentActions(
    actions: readonly AgentAction[],
    rawQuery: string,
): readonly AgentAction[] {
    const query = rawQuery.trim();
    if (!query) return actions;

    const normalizedQuery = query.toLowerCase();
    const invocationPrefix = normalizedQuery.startsWith('$')
        ? '$'
        : normalizedQuery.startsWith('/')
          ? '/'
          : undefined;
    const nameQuery = invocationPrefix ? normalizedQuery.slice(1) : normalizedQuery;
    const records = actions.flatMap((action, index): SearchableAgentAction[] => {
        if (invocationPrefix && !action.invocation.startsWith(invocationPrefix)) return [];
        return [
            {
                action,
                index,
                invocation: action.invocation,
                name: actionName(action.invocation),
                description: action.description ?? '',
            },
        ];
    });
    if (!nameQuery) return records.map(({ action }) => action);

    const fuzzyResults = new Fuse(records, searchOptions).search(nameQuery);
    const fuzzyByInvocation = new Map(
        fuzzyResults.map((result) => [result.item.invocation, result]),
    );

    const matches = records.flatMap((record) => {
        const invocation = record.invocation.toLowerCase();
        const name = record.name.toLowerCase();
        const fuzzyResult = fuzzyByInvocation.get(record.invocation);
        const tier =
            invocation === normalizedQuery || name === nameQuery
                ? 0
                : invocation.startsWith(normalizedQuery) || name.startsWith(nameQuery)
                  ? 1
                  : nameQuery.length > 1 && actionInitials(name).startsWith(nameQuery)
                    ? 2
                    : fuzzyMatchTier(fuzzyResult);
        return tier === undefined
            ? []
            : [
                  {
                      action: record.action,
                      index: record.index,
                      score: fuzzyResult?.score ?? 1,
                      tier,
                  },
              ];
    });
    // The phone's Chat menu ranks with this too, and its Hermes runtime lacks ES2023 `toSorted`.
    return sortedCopy(matches, (left, right) =>
        left.tier === right.tier
            ? left.score === right.score
                ? left.index - right.index
                : left.score - right.score
            : left.tier - right.tier,
    ).map(({ action }) => action);
}
