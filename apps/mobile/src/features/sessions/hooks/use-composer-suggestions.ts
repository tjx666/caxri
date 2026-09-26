import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { composerSuggestionTrigger, isComposerActionMatch } from '../composer-suggestions';
import type { MobileSessionItem } from '../session-model';

export const useComposerSuggestions = (draft: string, session: MobileSessionItem) => {
    const { request, connectionScopeKey, isForeground, status } = useMobileClient();
    const trigger = composerSuggestionTrigger(draft);
    const terminalId = session.primaryAgentTerminalId;
    const enabled = status === 'connected' && isForeground && connectionScopeKey !== null;
    const actions = useQuery({
        enabled: enabled && trigger?.kind === 'action' && Boolean(terminalId),
        queryFn: () =>
            request('mobile.agent.actions', { sessionId: session.id, terminalId: terminalId! }),
        queryKey: ['mobile', 'composer-actions', connectionScopeKey, session.id, terminalId],
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
            items: (actions.data?.actions ?? [])
                .filter((action) => isComposerActionMatch(action.invocation, trigger.query))
                .map((action) => action.invocation),
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
