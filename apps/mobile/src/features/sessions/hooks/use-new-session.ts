import { useCallback, useMemo, useRef } from 'react';

import type { MethodResult } from '@caxri/protocol';
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
    newSessionDefaultSurface,
    newSessionSurface,
    selectedNewSessionProject,
    sortNewSessionProjects,
} from '../new-session-model';
import { waitForCreatedConversation } from '../new-session-readiness';

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
        setNewSessionSurface,
        setSegment,
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
    const defaultSurface = newSessionDefaultSurface(availability.data?.openAgentsInChat);
    const selectedSurface = newSessionSurface(
        newSessionSelection.surface,
        selectedAgent,
        defaultSurface === 'chat',
    );
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
            let result: MethodResult<'mobile.session.create'>;
            try {
                result = await request('mobile.session.create', {
                    projectId: selectedProjectId,
                    defaultAgent: selectedAgent,
                    ...(selectedSurface && { surface: selectedSurface }),
                });
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
                return;
            }
            if (result.launchError) {
                setNewSessionCreateState({
                    kind: 'partial',
                    message: result.launchError.message,
                    sessionId: result.sessionId,
                });
                return;
            }
            // A Chat renders its own streamed view with its own composer, so it waits for no transcript.
            const isChat = selectedSurface === 'chat';
            if (!isChat && (selectedAgent === 'claude' || selectedAgent === 'codex')) {
                setSegment(result.sessionId, 'conversation');
                await waitForCreatedConversation(() =>
                    request('mobile.timeline.read', { sessionId: result.sessionId }),
                );
            }
            openCreatedSession(result.sessionId, !isChat);
        } finally {
            creatingReference.current = false;
        }
    }, [
        canCreate,
        openCreatedSession,
        request,
        selectedAgent,
        selectedProjectId,
        selectedSurface,
        setNewSessionAgent,
        setNewSessionCreateState,
        setNewSessionProjectId,
        setSegment,
    ]);

    return {
        agents,
        canCreate,
        checkSessions,
        create,
        createState: newSessionCreateState,
        defaultSurface,
        deviceRole: sessions.deviceRole,
        hostId,
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
        selectedSurface,
        setNewSessionAgent,
        setNewSessionProjectId,
        setNewSessionSurface,
        status,
    };
};

export type NewSessionViewState = ReturnType<typeof useNewSession>;
