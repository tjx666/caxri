import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import type { TerminalKind, TerminalSurface } from '@caxri/protocol';
import { usePathname } from 'expo-router';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { useSavedPanels } from '../../panels/use-panels';
import { isDashboardRouteVisible } from '../dashboard-query';
import { useRecentSessions } from '../hooks/use-recent-sessions';
import type { SavedAgentAvailability } from '../hooks/use-saved-agent-availability';
import { useSavedAgentAvailability } from '../hooks/use-saved-agent-availability';
import { useSavedDrafts } from '../hooks/use-saved-drafts';
import { useSessionPolling } from '../hooks/use-session-polling';
import type { NewSessionCreateState, NewSessionSelection } from '../new-session-model';
import { emptyNewSessionSelection, forgetNewSessionProject } from '../new-session-model';
import type { RecentSessions } from '../recent-sessions';
import type { SessionListGroupStates } from '../session-list-groups';
import { revealSessionListGroup, toggleSessionListGroup } from '../session-list-groups';
import type { MobileSessionListGroup } from '../session-model';
import type { HostSessionUiState, SessionSegment } from '../session-ui-state';
import {
    emptyHostSessionUiState,
    rememberSessionDraft,
    rememberSessionSegment,
    selectSessionProject,
} from '../session-ui-state';

interface HostSessionsContextValue {
    hostId: string;
    /**
     * Which Session list groups the reader collapsed or revealed, kept while the app stays on this computer so opening
     * a Session and coming back leaves the list as they arranged it.
     */
    listGroups: SessionListGroupStates;
    listScrollOffsetRef: RefObject<number>;
    /**
     * Sessions this phone opened for the pairing, newest first; the open Session's menu offers the next one back.
     */
    recentSessionIds: RecentSessions;
    rememberSessionVisit: (sessionId: string) => void;
    revealListGroup: (group: MobileSessionListGroup, windowCount: number) => void;
    sessions: ReturnType<typeof useSessionPolling>;
    ui: HostSessionUiState;
    newSessionSelection: NewSessionSelection;
    /**
     * The last Agent availability answer this pairing read, shown on New Session while its own read is in flight.
     */
    savedAgentAvailability: SavedAgentAvailability | null;
    saveAgentAvailability: ReturnType<typeof useSavedAgentAvailability>['save'];
    newSessionCreateState: NewSessionCreateState;
    focusComposerSessionId: string | null;
    consumeComposerFocus: (sessionId: string) => void;
    requestComposerFocus: (sessionId: string) => void;
    setNewSessionAgent: (agent: TerminalKind) => void;
    setNewSessionSurface: (surface: TerminalSurface) => void;
    setNewSessionCreateState: Dispatch<SetStateAction<NewSessionCreateState>>;
    setNewSessionProjectId: (projectId: string) => void;
    /**
     * Takes the draft itself, or an updater that derives it from the current draft when the change arrives late.
     */
    setDraft: (sessionId: string, draft: string | ((current: string) => string)) => void;
    setProjectId: (projectId: string | null) => void;
    setSegment: (sessionId: string, segment: SessionSegment, previous?: SessionSegment) => void;
    toggleListGroup: (group: MobileSessionListGroup) => void;
}

const HostSessionsContext = createContext<HostSessionsContextValue | null>(null);

export const HostSessionsProvider = ({
    children,
    hostId,
}: {
    children: ReactNode;
    hostId: string;
}) => {
    const pathname = usePathname();
    const sessions = useSessionPolling(isDashboardRouteVisible(pathname, hostId));
    const listScrollOffsetReference = useRef(0);
    const [ui, setUi] = useState(emptyHostSessionUiState);
    const [listGroups, setListGroups] = useState<SessionListGroupStates>({});
    const toggleListGroup = useCallback((group: MobileSessionListGroup): void => {
        setListGroups((current) => toggleSessionListGroup(current, group));
    }, []);
    const revealListGroup = useCallback(
        (group: MobileSessionListGroup, windowCount: number): void => {
            setListGroups((current) => revealSessionListGroup(current, group, windowCount));
        },
        [],
    );
    useSavedDrafts(ui.draftBySession, setUi);
    const { recentSessionIds, rememberSessionVisit } = useRecentSessions();
    useSavedPanels();
    const { connectionScopeKey } = useMobileClient();
    const { save: saveAgentAvailability, saved: savedAgentAvailability } =
        useSavedAgentAvailability(connectionScopeKey);
    const [newSessionSelection, setNewSessionSelection] = useState(emptyNewSessionSelection);
    const [newSessionCreateState, setNewSessionCreateState] = useState<NewSessionCreateState>({
        kind: 'idle',
    });
    const [focusComposerSessionId, setFocusComposerSessionId] = useState<string | null>(null);
    const setNewSessionAgent = useCallback((agent: TerminalKind): void => {
        setNewSessionSelection((current) => ({ ...current, agent }));
    }, []);
    const setNewSessionSurface = useCallback((surface: TerminalSurface): void => {
        setNewSessionSelection((current) => ({ ...current, surface }));
    }, []);
    const setNewSessionProjectId = useCallback((projectId: string): void => {
        setNewSessionSelection((current) => ({ ...current, projectId }));
    }, []);
    const requestComposerFocus = useCallback((sessionId: string): void => {
        setFocusComposerSessionId(sessionId);
    }, []);
    const consumeComposerFocus = useCallback((sessionId: string): void => {
        setFocusComposerSessionId((current) => (current === sessionId ? null : current));
    }, []);
    const setDraft = useCallback(
        (sessionId: string, draft: string | ((current: string) => string)): void => {
            setUi((current) =>
                rememberSessionDraft(
                    current,
                    sessionId,
                    typeof draft === 'string'
                        ? draft
                        : draft(current.draftBySession[sessionId] ?? ''),
                ),
            );
        },
        [],
    );
    const setProjectId = useCallback((projectId: string | null): void => {
        listScrollOffsetReference.current = 0;
        setUi((current) => selectSessionProject(current, projectId));
        setNewSessionSelection(forgetNewSessionProject);
    }, []);
    const setSegment = useCallback(
        (sessionId: string, segment: SessionSegment, previous?: SessionSegment): void => {
            setUi((current) => rememberSessionSegment(current, sessionId, segment, previous));
        },
        [],
    );
    const value = useMemo(
        () => ({
            hostId,
            listGroups,
            listScrollOffsetRef: listScrollOffsetReference,
            recentSessionIds,
            rememberSessionVisit,
            revealListGroup,
            sessions,
            ui,
            newSessionSelection,
            savedAgentAvailability,
            saveAgentAvailability,
            newSessionCreateState,
            focusComposerSessionId,
            consumeComposerFocus,
            requestComposerFocus,
            setNewSessionAgent,
            setNewSessionSurface,
            setNewSessionCreateState,
            setNewSessionProjectId,
            setDraft,
            setProjectId,
            setSegment,
            toggleListGroup,
        }),
        [
            hostId,
            listGroups,
            recentSessionIds,
            rememberSessionVisit,
            revealListGroup,
            sessions,
            ui,
            newSessionSelection,
            savedAgentAvailability,
            saveAgentAvailability,
            newSessionCreateState,
            focusComposerSessionId,
            consumeComposerFocus,
            requestComposerFocus,
            setNewSessionAgent,
            setNewSessionSurface,
            setNewSessionCreateState,
            setNewSessionProjectId,
            setDraft,
            setProjectId,
            setSegment,
            toggleListGroup,
        ],
    );
    return <HostSessionsContext.Provider value={value}>{children}</HostSessionsContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The hook reads this provider's private context.
export const useHostSessions = (): HostSessionsContextValue => {
    const value = useContext(HostSessionsContext);
    if (!value) throw new Error('HostSessionsProvider is missing');
    return value;
};
