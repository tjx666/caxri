import type { ReactNode, RefObject } from 'react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { usePathname } from 'expo-router';

import { isDashboardRouteVisible } from '../dashboard-query';
import { useSessionPolling } from '../hooks/use-session-polling';
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
    setDraft: (sessionId: string, draft: string) => void;
    setProjectId: (projectId: string | null) => void;
    setSegment: (sessionId: string, segment: SessionSegment) => void;
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
    const setDraft = useCallback((sessionId: string, draft: string): void => {
        setUi((current) => rememberSessionDraft(current, sessionId, draft));
    }, []);
    const setProjectId = useCallback((projectId: string | null): void => {
        listScrollOffsetReference.current = 0;
        setUi((current) => selectSessionProject(current, projectId));
    }, []);
    const setSegment = useCallback((sessionId: string, segment: SessionSegment): void => {
        setUi((current) => rememberSessionSegment(current, sessionId, segment));
    }, []);
    const value = useMemo(
        () => ({
            hostId,
            listScrollOffsetRef: listScrollOffsetReference,
            sessions,
            ui,
            setDraft,
            setProjectId,
            setSegment,
        }),
        [hostId, sessions, ui, setDraft, setProjectId, setSegment],
    );
    return <HostSessionsContext.Provider value={value}>{children}</HostSessionsContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components -- The hook reads this provider's private context.
export const useHostSessions = (): HostSessionsContextValue => {
    const value = useContext(HostSessionsContext);
    if (!value) throw new Error('HostSessionsProvider is missing');
    return value;
};
