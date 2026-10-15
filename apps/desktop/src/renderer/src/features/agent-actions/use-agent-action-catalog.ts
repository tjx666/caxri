import { useMemo, useState } from 'react';

import type {
    AgentAction,
    AgentActionRecentSettings,
    AgentActionsSettings,
    AgentProvider,
} from '@caxri/protocol';
import { mergeAgentActions, resolveRecentAgentActions, searchAgentActions } from '@caxri/protocol';

import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../queries/client';
import { useSettings, useTerminal } from '../../stores/selectors';

interface RecentOverride {
    provider: AgentProvider;
    recent: AgentActionRecentSettings;
}

/**
 * The recents to render. `recordRecent` returns the list the Server just persisted, which arrives before the settings
 * push that carries it, so an override wins over `actionSettings`, but only for the provider it was recorded against,
 * since switching Terminals can change the provider before that push lands.
 */
function visibleRecentActions(
    actions: readonly AgentAction[],
    actionSettings: AgentActionsSettings | undefined,
    provider: AgentProvider | undefined,
    override: RecentOverride | undefined,
): AgentAction[] {
    if (!actionSettings) return [];
    return resolveRecentAgentActions(actions, {
        ...actionSettings,
        recent:
            override && override.provider === provider ? override.recent : actionSettings.recent,
    });
}

/**
 * Splits ranked actions into the picker's Commands and Skills groups, keeping each group's ranked order.
 */
function groupAgentActions(ranked: readonly AgentAction[]) {
    const groupedActions = new Map<AgentAction['kind'], AgentAction[]>();
    for (const action of ranked) {
        const group = groupedActions.get(action.kind);
        if (group) group.push(action);
        else groupedActions.set(action.kind, [action]);
    }
    return [...groupedActions].map(([kind, grouped]) => ({ grouped, kind }));
}

/**
 * The picker's action catalog for the target Terminal's Agent: discovered actions (or the settings fallback while
 * discovery runs), the search-ranked groups, the recents, and the discovery status lines.
 */
export function useAgentActionCatalog({
    isOpen,
    search,
    terminalId,
}: {
    isOpen: boolean;
    search: string;
    terminalId: string | undefined;
}) {
    const [recentOverride, setRecentOverride] = useState<RecentOverride>();
    const settings = useSettings();
    const terminal = useTerminal(terminalId ?? '');
    const provider = terminal?.provider;
    const isAgentRunning = isAgentProcessRunning(terminal?.lastAgentProcessState);
    const query = useCaxriQuery(
        'agentActions.list',
        { terminalId: terminalId ?? '' },
        { enabled: Boolean(isOpen && terminalId && provider && isAgentRunning), staleTime: 0 },
    );
    const fallbackActions = useMemo(
        () =>
            provider && settings
                ? mergeAgentActions(provider, [], settings['agents.providers'][provider].actions)
                : [],
        [provider, settings],
    );
    /**
     * A zero-stale-time refetch can retain the previous result while it runs. Render only the current settings fallback
     * until this open's discovery settles, so a deleted or newly disabled skill never flashes as selectable.
     */
    const actions =
        query.data && !query.isFetching && !query.isError ? query.data.actions : fallbackActions;
    // An `@` search lists Sessions instead of actions.
    const isSessionSearch = search.trimStart().startsWith('@');
    const visibleActionGroups = useMemo(
        () => groupAgentActions(isSessionSearch ? [] : searchAgentActions(actions, search)),
        [actions, isSessionSearch, search],
    );
    const actionSettings = provider ? settings?.['agents.providers'][provider].actions : undefined;
    const recentActions = visibleRecentActions(actions, actionSettings, provider, recentOverride);
    return {
        actions,
        isDiscovering: query.isFetching && !isSessionSearch,
        isPartial: query.isError || query.data?.discovery === 'partial',
        recentActions: search.trim() === '' ? recentActions : [],
        setRecentOverride,
        visibleActionGroups,
    };
}
