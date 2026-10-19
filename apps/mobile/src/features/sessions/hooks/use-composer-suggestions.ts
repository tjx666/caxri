import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { composerActionsRequest, composerSuggestionTrigger } from '../composer-suggestions';
import type { MobileSessionItem } from '../session-model';

export const useComposerSuggestions = (draft: string, session: MobileSessionItem) => {
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const trigger = composerSuggestionTrigger(draft);
    const terminalId = session.primaryAgentTerminalId;
    const enabled = status === 'connected' && isForeground && connectionScopeKey !== null;
    const actions = useQuery({
        enabled: enabled && trigger?.kind === 'action' && Boolean(terminalId),
        // Only the same Terminal's earlier answer may stand in, so the menu does not flicker between keystrokes.
        placeholderData: (previous, previousQuery) =>
            previousQuery?.queryKey[4] === terminalId ? previous : undefined,
        queryFn: () =>
            request(
                'mobile.agent.actions',
                composerActionsRequest(session.id, terminalId!, trigger!.query),
            ),
        queryKey: [
            'mobile',
            'composer-actions',
            connectionScopeKey,
            session.id,
            terminalId,
            trigger?.query,
        ],
        retry: false,
        staleTime: 30_000,
    });
    const files = useQuery({
        enabled: enabled && trigger?.kind === 'file' && Boolean(trigger.query),
        queryFn: () =>
            request('mobile.files.search', { sessionId: session.id, query: trigger!.query }),
        queryKey: ['mobile', 'composer-files', connectionScopeKey, session.id, trigger?.query],
        retry: false,
        staleTime: 15_000,
    });
    if (!trigger) return { trigger: null, items: [] as string[], isPending: false, isError: false };
    if (trigger.kind === 'action') {
        return {
            trigger,
            // Server Core ranks the whole action list by the typed name, as for the Agent Chat menu.
            items: (actions.data?.actions ?? []).map((action) => action.invocation),
            isPending: actions.isPending,
            isError: actions.isError,
        };
    }
    return {
        trigger,
        items: files.data?.paths.map((path) => `@${path}`) ?? [],
        isPending: files.isPending,
        isError: files.isError,
    };
};
