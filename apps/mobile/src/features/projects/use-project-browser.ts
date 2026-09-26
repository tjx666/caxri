import { useCallback, useState } from 'react';

import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import type { ProjectBrowserLevel } from './project-browser-model';
import {
    currentProjectBrowserLevel,
    enterProjectBrowserLevel,
    leaveProjectBrowserLevel,
    PROJECT_BROWSER_HOME,
} from './project-browser-model';

export const useProjectBrowser = () => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const { sessions, setNewSessionProjectId } = useHostSessions();
    const [stack, setStack] = useState<ProjectBrowserLevel[]>([PROJECT_BROWSER_HOME]);
    const [addingPath, setAddingPath] = useState<string | null>(null);
    const [addError, setAddError] = useState<string | null>(null);
    const level = currentProjectBrowserLevel(stack);
    const listing = useQuery({
        enabled: connectionScopeKey !== null && isForeground && status === 'connected',
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () =>
            request('mobile.project.browse', level.path === null ? {} : { path: level.path }),
        queryKey: ['mobile', 'project-browse', connectionScopeKey ?? 'unpaired', level.path],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
    });
    const add = useCallback(
        async (path: string): Promise<boolean> => {
            setAddingPath(path);
            setAddError(null);
            try {
                const { project } = await request('mobile.project.add', { path });
                await sessions.refresh();
                setNewSessionProjectId(project.id);
                return true;
            } catch (error) {
                setAddError(error instanceof Error ? error.message : 'Unable to add this folder');
                return false;
            } finally {
                setAddingPath(null);
            }
        },
        [request, sessions, setNewSessionProjectId],
    );
    const enter = useCallback(
        (next: ProjectBrowserLevel) =>
            setStack((current) => enterProjectBrowserLevel(current, next)),
        [],
    );
    return {
        add,
        addError,
        addingPath,
        canGoUp: stack.length > 1,
        enter,
        isConnected: status === 'connected',
        level,
        listing,
        stack,
        up: () => setStack(leaveProjectBrowserLevel),
    };
};
