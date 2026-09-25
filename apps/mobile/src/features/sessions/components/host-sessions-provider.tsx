import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import type { TerminalKind } from '@caxri/protocol';
import { usePathname } from 'expo-router';

import { isDashboardRouteVisible } from '../dashboard-query';
import { useSessionPolling } from '../hooks/use-session-polling';
import type { NewSessionCreateState, NewSessionSelection } from '../new-session-model';
import { emptyNewSessionSelection } from '../new-session-model';
import { recordHostSessionsDraft, recordHostSessionsMount } from '../session-composer-diagnostic';
import type { HostSessionUiState, SessionSegment } from '../session-ui-state';
import {
    emptyHostSessionUiState,
    rememberSessionDraft,
    rememberSessionSegment,
    selectSessionProject,
} from '../session-ui-state';

interface HostSessionsContextValue {
    hostId: string;
    listScrollOffsetRef: RefObject<number>;
    sessions: ReturnType<typeof useSessionPolling>;
    ui: HostSessionUiState;
    newSessionSelection: NewSessionSelection;
    newSessionCreateState: NewSessionCreateState;
    focusComposerSessionId: string | null;
    consumeComposerFocus: (sessionId: string) => void;
    requestComposerFocus: (sessionId: string) => void;
    setNewSessionAgent: (agent: TerminalKind) => void;
    setNewSessionCreateState: Dispatch<SetStateAction<NewSessionCreateState>>;
    setNewSessionProjectId: (projectId: string) => void;
    setDraft: (sessionId: string, draft: string) => void;
    setProjectId: (projectId: string | null) => void;
    setSegment: (sessionId: string, segment: SessionSegment, previous?: SessionSegment) => void;
}

const HostSessionsContext = createContext<HostSessionsContextValue | null>(null);

export const HostSessionsProvider = ({
    children,
    hostId,
}: {
    children: ReactNode;
    hostId: string;
}) => {
    useEffect(recordHostSessionsMount, []);
    const pathname = usePathname();
    const sessions = useSessionPolling(isDashboardRouteVisible(pathname, hostId));
    const listScrollOffsetReference = useRef(0);
    const [ui, setUi] = useState(emptyHostSessionUiState);
    const [newSessionSelection, setNewSessionSelection] = useState(emptyNewSessionSelection);
    const [newSessionCreateState, setNewSessionCreateState] = useState<NewSessionCreateState>({
        kind: 'idle',
    });
    const [focusComposerSessionId, setFocusComposerSessionId] = useState<string | null>(null);
    const setNewSessionAgent = useCallback((agent: TerminalKind): void => {
        setNewSessionSelection((current) => ({ ...current, agent }));
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
    const setDraft = useCallback((sessionId: string, draft: string): void => {
        recordHostSessionsDraft(draft);
        setUi((current) => rememberSessionDraft(current, sessionId, draft));
    }, []);
    const setProjectId = useCallback((projectId: string | null): void => {
        listScrollOffsetReference.current = 0;
        setUi((current) => selectSessionProject(current, projectId));
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
            listScrollOffsetRef: listScrollOffsetReference,
            sessions,
            ui,
            newSessionSelection,
            newSessionCreateState,
            focusComposerSessionId,
            consumeComposerFocus,
            requestComposerFocus,
            setNewSessionAgent,
            setNewSessionCreateState,
            setNewSessionProjectId,
            setDraft,
            setProjectId,
            setSegment,
        }),
        [
            hostId,
            sessions,
            ui,
            newSessionSelection,
            newSessionCreateState,
            focusComposerSessionId,
            consumeComposerFocus,
            requestComposerFocus,
            setNewSessionAgent,
            setNewSessionCreateState,
            setNewSessionProjectId,
            setDraft,
            setProjectId,
            setSegment,
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
