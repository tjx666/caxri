import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';

import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { classifyMobileWriteFailure } from '../../connection/mobile-write-failure';
import { useHostSessions } from '../components/host-sessions-provider';
import {
    acknowledgeCheckedUncertainCreate,
    availableNewSessionAgent,
    canCreateNewSession,
    confirmNewSessionLaunch,
    isNewSessionAvailabilityLoading,
    markUncertainSessionsChecked,
    newSessionAvailabilityPlaceholder,
    newSessionCreateFailure,
    newSessionDefaultSurface,
    newSessionSurface,
    projectFilterAfterCreate,
    selectedNewSessionProject,
    sortNewSessionProjects,
} from '../new-session-model';
import { waitForCreatedConversation } from '../new-session-readiness';
import { activeProjectFilter } from '../project-filter';
import { NEW_SESSION_ENTRY, SESSION_ENTRY_PARAM } from '../session-route-entry';

export const useNewSession = () => {
    const router = useRouter();
    const { t } = useTranslation();
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const {
        hostId,
        newSessionCreateState,
        newSessionSelection,
        requestComposerFocus,
        saveAgentAvailability,
        savedAgentAvailability,
        sessions,
        setNewSessionAgent,
        setNewSessionCreateState,
        setNewSessionProjectId,
        setNewSessionSurface,
        setProjectId,
        setSegment,
        ui,
    } = useHostSessions();
    const queryClient = useQueryClient();
    const creatingReference = useRef(false);
    const projects = useMemo(() => sortNewSessionProjects(sessions.projects), [sessions.projects]);
    const filterProjectId = activeProjectFilter(ui.projectId, projects);
    const selectedProjectId = selectedNewSessionProject(
        newSessionSelection.projectId,
        projects,
        filterProjectId,
    );
    const isAvailabilityReadEnabled =
        selectedProjectId !== null &&
        connectionScopeKey !== null &&
        isForeground &&
        status === 'connected';
    const availabilityQuery = useMemo(
        () => ({
            queryFn: () => request('mobile.agent.availability', { projectId: selectedProjectId! }),
            queryKey: [
                'mobile',
                'agent-availability',
                connectionScopeKey ?? 'unpaired',
                selectedProjectId,
            ],
        }),
        [connectionScopeKey, request, selectedProjectId],
    );
    const availability = useQuery({
        ...availabilityQuery,
        enabled: isAvailabilityReadEnabled,
        gcTime: 0,
        networkMode: 'always',
        placeholderData: (previous, previousQuery) =>
            newSessionAvailabilityPlaceholder({
                connectionScopeKey,
                isReadEnabled: isAvailabilityReadEnabled,
                previous,
                previousScopeKey: previousQuery?.queryKey[2],
                saved: savedAgentAvailability,
            }),
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    const liveAvailability = availability.isPlaceholderData ? undefined : availability.data;
    useEffect(() => {
        if (liveAvailability && connectionScopeKey !== null)
            saveAgentAvailability(connectionScopeKey, liveAvailability);
    }, [connectionScopeKey, liveAvailability, saveAgentAvailability]);
    const agents = availability.data?.agents ?? [];
    const selectedAgent = availableNewSessionAgent(newSessionSelection.agent, agents);
    const defaultSurface = newSessionDefaultSurface(availability.data?.openAgentsInChat);
    const selectedSurface = newSessionSurface(
        newSessionSelection.surface,
        selectedAgent,
        defaultSurface === 'chat',
    );
    const isAvailabilityLoading = isNewSessionAvailabilityLoading(availability);
    const canCreate = canCreateNewSession({
        agent: selectedAgent,
        createState: newSessionCreateState,
        dashboardError: sessions.error,
        hasDashboard: sessions.hasLoaded,
        isAvailabilityError: availability.isError,
        isAvailabilityLoading,
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
            router.replace(
                `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}?${SESSION_ENTRY_PARAM}=${NEW_SESSION_ENTRY}`,
            );
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
        setNewSessionCreateState({ kind: 'creating' });
        try {
            let launch = { agent: selectedAgent, surface: selectedSurface };
            if (availability.isPlaceholderData) {
                // The cards still show the previous Project's or the saved answer; wait for this Project's own read (query
                // joins the one in flight) so a stale answer never launches an Agent this Project cannot run.
                let fresh: MethodResult<'mobile.agent.availability'>;
                try {
                    fresh = await queryClient.query(availabilityQuery);
                } catch {
                    // The query's own error state now explains the failure on the Agent cards.
                    setNewSessionCreateState({ kind: 'idle' });
                    return;
                }
                const confirmed = confirmNewSessionLaunch({
                    agent: selectedAgent,
                    agents: fresh.agents,
                    openAgentsInChat: fresh.openAgentsInChat,
                    surfacePreference: newSessionSelection.surface,
                });
                if (!confirmed) {
                    setNewSessionCreateState({ kind: 'idle' });
                    return;
                }
                launch = confirmed;
            }
            setNewSessionProjectId(selectedProjectId);
            setNewSessionAgent(launch.agent);
            let result: MethodResult<'mobile.session.create'>;
            try {
                result = await request('mobile.session.create', {
                    projectId: selectedProjectId,
                    defaultAgent: launch.agent,
                    ...(launch.surface && { surface: launch.surface }),
                });
            } catch (error) {
                setNewSessionCreateState(
                    newSessionCreateFailure(classifyMobileWriteFailure(error), t),
                );
                return;
            }
            // A Session exists from here on, even when its Terminal failed to start, so the list must not hide it.
            const nextFilterProjectId = projectFilterAfterCreate(
                filterProjectId,
                selectedProjectId,
            );
            if (nextFilterProjectId !== filterProjectId) setProjectId(nextFilterProjectId);
            if (result.launchError) {
                setNewSessionCreateState({
                    kind: 'partial',
                    message: result.launchError.message,
                    sessionId: result.sessionId,
                });
                return;
            }
            // A Chat renders its own streamed view with its own composer, so it waits for no transcript.
            const isChat = launch.surface === 'chat';
            if (!isChat && (launch.agent === 'claude' || launch.agent === 'codex')) {
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
        availability.isPlaceholderData,
        availabilityQuery,
        canCreate,
        filterProjectId,
        newSessionSelection.surface,
        openCreatedSession,
        queryClient,
        request,
        selectedAgent,
        selectedProjectId,
        selectedSurface,
        setNewSessionAgent,
        setNewSessionCreateState,
        setNewSessionProjectId,
        setProjectId,
        setSegment,
        t,
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
        isAvailabilityLoading,
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
