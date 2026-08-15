import type {
    AppSettings,
    BootstrapState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalRecord,
    ThemeTokens,
} from '@shared/types';
import { useShallow } from 'zustand/react/shallow';

import { useWorkbenchStore } from './workbench';

const NO_TERMINALS: TerminalRecord[] = [];

export function selectSelectedSession(bootstrap?: BootstrapState): SessionRecord | undefined {
    return bootstrap?.sessions.find((session) => session.id === bootstrap.selectedSessionId);
}

/**
Falls back to the standalone Project selection so a Project with no Session still highlights.
 */
export function selectSelectedProject(bootstrap?: BootstrapState): ProjectRecord | undefined {
    if (!bootstrap) return undefined;
    const sessionProjectId = selectSelectedSession(bootstrap)?.projectId;
    return bootstrap.projects.find(
        (project) => project.id === (sessionProjectId ?? bootstrap.selectedProjectId),
    );
}

/**
Files, Editor, and Git follow this Project; Sidebar ownership still uses `selectSelectedProject`.
 */
function selectSelectedWorkbenchProject(bootstrap?: BootstrapState): ProjectRecord | undefined {
    if (!bootstrap) return undefined;
    const workbenchProjectId = selectSelectedSession(bootstrap)?.workbenchProjectId;
    return bootstrap.projects.find((project) => project.id === workbenchProjectId);
}

function selectSessionState(bootstrap?: BootstrapState): SessionState | undefined {
    const sessionId = selectSelectedSession(bootstrap)?.id;
    return bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
}

function selectSessionTerminals(bootstrap?: BootstrapState): TerminalRecord[] {
    const sessionId = selectSelectedSession(bootstrap)?.id;
    if (!sessionId) return NO_TERMINALS;
    return (
        bootstrap?.terminals.filter((terminal) => terminal.sessionId === sessionId) ?? NO_TERMINALS
    );
}

/**
Non-React read path: the store is the single source of truth for actions and event handlers.
 */
export function getBootstrap(): BootstrapState | undefined {
    return useWorkbenchStore.getState().bootstrap;
}

export function getSelectedSession(): SessionRecord | undefined {
    return selectSelectedSession(getBootstrap());
}

/**
File paths belong to a Workbench Project, so mutations reconcile Sessions currently sharing it.
 */
export function getProjectSessionIds(originSessionId: string): string[] {
    const sessions = getBootstrap()?.sessions ?? [];
    const projectId = sessions.find(
        (session) => session.id === originSessionId,
    )?.workbenchProjectId;
    if (!projectId) return [originSessionId];
    const sessionIds: string[] = [];
    for (const session of sessions) {
        if (session.workbenchProjectId === projectId) sessionIds.push(session.id);
    }
    return sessionIds;
}

/**
Returns Sessions whose current structured requests still resolve against this Workbench Root.
 */
export function getWorkbenchProjectSessionIds(
    workbenchProjectId: string,
    fallbackSessionId?: string,
): string[] {
    const sessionIds = (getBootstrap()?.sessions ?? [])
        .filter((session) => session.workbenchProjectId === workbenchProjectId)
        .map((session) => session.id);
    return sessionIds.length > 0 ? sessionIds : fallbackSessionId ? [fallbackSessionId] : [];
}

export function getSessionProjectId(sessionId: string): string | undefined {
    return getBootstrap()?.sessions.find((session) => session.id === sessionId)?.workbenchProjectId;
}

export function getSessionOwnerProjectId(sessionId: string): string | undefined {
    return getBootstrap()?.sessions.find((session) => session.id === sessionId)?.projectId;
}

export function getSessionState(): SessionState | undefined {
    return selectSessionState(getBootstrap());
}

export function getSessionTerminals(): TerminalRecord[] {
    return selectSessionTerminals(getBootstrap());
}

export function useSelectedSession(): SessionRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedSession(state.bootstrap));
}

export function useSelectedProject(): ProjectRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedProject(state.bootstrap));
}

export function useSelectedWorkbenchProject(): ProjectRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedWorkbenchProject(state.bootstrap));
}

export function useSessionState(): SessionState | undefined {
    return useWorkbenchStore((state) => selectSessionState(state.bootstrap));
}

export function useSessionTerminals(): TerminalRecord[] {
    return useWorkbenchStore(useShallow((state) => selectSessionTerminals(state.bootstrap)));
}

export function useTerminal(terminalId: string): TerminalRecord | undefined {
    return useWorkbenchStore((state) =>
        state.bootstrap?.terminals.find((terminal) => terminal.id === terminalId),
    );
}

export function useTheme(): ThemeTokens | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.theme);
}

export function useSettings(): AppSettings | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.settings);
}

export function useProjects(): ProjectRecord[] | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.projects);
}

export function useSessions(): SessionRecord[] | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.sessions);
}

/**
Stable shallow ID list for caches that must discard state after Session deletion.
 */
export function useSessionIds(): string[] {
    return useWorkbenchStore(
        useShallow((state) => state.bootstrap?.sessions.map((session) => session.id) ?? []),
    );
}

export function useTerminals(): TerminalRecord[] {
    return useWorkbenchStore((state) => state.bootstrap?.terminals ?? NO_TERMINALS);
}

/**
Mirrors the native window's fullscreen state; see `window.fullScreen` in `stores/workbench.ts`.
 */
export function useIsFullScreen(): boolean {
    return useWorkbenchStore((state) => state.isFullScreen);
}
