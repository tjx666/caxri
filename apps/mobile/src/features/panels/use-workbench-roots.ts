import { useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';

/**
 * The Session's worktrees and a switch among them. A switch re-reads every query naming this Session, so Files,
 * previews, and Changes all move to the worktree just selected.
 */
export const useWorkbenchRoots = (sessionId: string) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const queryClient = useQueryClient();
    const [switching, setSwitching] = useState(false);
    const query = useQuery({
        enabled: connectionScopeKey !== null && isForeground && status === 'connected',
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.workbenchRoot.list', { sessionId }),
        queryKey: ['mobile', 'workbenchRoots', connectionScopeKey ?? 'unpaired', sessionId],
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 15_000,
    });
    const select = async (projectId: string): Promise<void> => {
        setSwitching(true);
        try {
            await request('mobile.workbenchRoot.select', { sessionId, projectId });
            await queryClient.invalidateQueries({
                predicate: ({ queryKey }) => queryKey.includes(sessionId),
            });
        } finally {
            setSwitching(false);
        }
    };
    return { roots: query.data?.roots ?? [], select, switching };
};
