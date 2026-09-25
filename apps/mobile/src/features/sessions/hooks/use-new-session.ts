import { useCallback, useMemo, useRef } from 'react';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import { useHostSessions } from '../components/host-sessions-provider';
import {
    acknowledgeCheckedUncertainCreate,
    availableNewSessionAgent,
    canCreateNewSession,
    markUncertainSessionsChecked,
    selectedNewSessionProject,
    sortNewSessionProjects,
} from '../new-session-model';

export const useNewSession = () => {
    const router = useRouter();
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const {
        hostId,
        newSessionCreateState,
        newSessionSelection,
        requestComposerFocus,
        sessions,
        setNewSessionAgent,
        setNewSessionCreateState,
        setNewSessionProjectId,
    } = useHostSessions();
    const creatingReference = useRef(false);
    const projects = useMemo(() => sortNewSessionProjects(sessions.projects), [sessions.projects]);
    const selectedProjectId = selectedNewSessionProject(newSessionSelection.projectId, projects);
    const availability = useQuery({
        enabled:
            selectedProjectId !== null &&
            connectionScopeKey !== null &&
            isForeground &&
            status === 'connected',
        gcTime: 0,
        networkMode: 'always',
        queryFn: () => request('mobile.agent.availability', { projectId: selectedProjectId! }),
        queryKey: [
            'mobile',
            'agent-availability',
            connectionScopeKey ?? 'unpaired',
            selectedProjectId,
        ],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    const agents = availability.data?.agents ?? [];
    const selectedAgent = availableNewSessionAgent(newSessionSelection.agent, agents);
    const canCreate = canCreateNewSession({
        agent: selectedAgent,
        createState: newSessionCreateState,
        dashboardError: sessions.error,
        hasDashboard: sessions.hasLoaded,
        isAvailabilityError: availability.isError,
        isAvailabilityLoading: availability.isFetching,
        isForeground,
        projectId: selectedProjectId,
        role: sessions.deviceRole,
        status,
    });

    const openCreatedSession = useCallback(
        (sessionId: string, shouldFocusComposer: boolean): void => {
            setNewSessionCreateState({ kind: 'idle' });
            if (shouldFocusComposer) requestComposerFocus(sessionId);
            sessions.selectSession(sessionId);
            router.replace(`/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}`);
            // eslint-disable-next-line no-void -- The detail route also has a grant-scoped Session read if refresh fails.
            void sessions.refresh().catch(() => {});
        },
        [hostId, requestComposerFocus, router, sessions, setNewSessionCreateState],
    );
    const checkSessions = useCallback((): void => {
        setNewSessionCreateState(markUncertainSessionsChecked);
        router.back();
    }, [router, setNewSessionCreateState]);
    const acknowledgeCheckedCreate = useCallback((): void => {
        setNewSessionCreateState(acknowledgeCheckedUncertainCreate);
    }, [setNewSessionCreateState]);
    const create = useCallback(async (): Promise<void> => {
        if (!selectedProjectId || !selectedAgent || !canCreate || creatingReference.current) return;
        creatingReference.current = true;
        setNewSessionProjectId(selectedProjectId);
        setNewSessionAgent(selectedAgent);
        setNewSessionCreateState({ kind: 'creating' });
        try {
            const result = await request('mobile.session.create', {
                projectId: selectedProjectId,
                defaultAgent: selectedAgent,
            });
            if (result.launchError) {
                setNewSessionCreateState({
                    kind: 'partial',
                    message: result.launchError.message,
                    sessionId: result.sessionId,
                });
                return;
            }
            openCreatedSession(result.sessionId, true);
        } catch (error) {
            const canRetry =
                error instanceof MobileGatewayRequestError &&
                ['CAPACITY', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION'].includes(
                    error.code,
                );
            setNewSessionCreateState(
                canRetry
                    ? { kind: 'failed', message: error.message }
                    : {
                          kind: 'uncertain',
                          checkedSessions: false,
                          message:
                              'Caxri did not confirm whether the Session was created. Check Sessions before trying again.',
                      },
            );
        } finally {
            creatingReference.current = false;
        }
    }, [
        canCreate,
        openCreatedSession,
        request,
        selectedAgent,
        selectedProjectId,
        setNewSessionAgent,
        setNewSessionCreateState,
        setNewSessionProjectId,
    ]);

    return {
        agents,
        canCreate,
        checkSessions,
        create,
        createState: newSessionCreateState,
        deviceRole: sessions.deviceRole,
        isAvailabilityLoading: availability.isPending || availability.isFetching,
        isDashboardLoaded: sessions.hasLoaded,
        isAvailabilityError: availability.isError,
        dashboardError: sessions.error,
        openCreatedSession,
        acknowledgeCheckedCreate,
        projects,
        refreshAvailability: availability.refetch,
        refreshDashboard: sessions.refresh,
        selectedAgent,
        selectedProjectId,
        setNewSessionAgent,
        setNewSessionProjectId,
        status,
    };
};

export type NewSessionViewState = ReturnType<typeof useNewSession>;
