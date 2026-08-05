import { useShallow } from 'zustand/react/shallow';

import type {
    AppSettings,
    BootstrapState,
    Keybinding,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalRecord,
    ThemeTokens,
} from '@shared/types';

import { useWorkbenchStore } from './workbench';

const NO_TERMINALS: TerminalRecord[] = [];

export function selectSelectedSession(bootstrap?: BootstrapState): SessionRecord | undefined {
    return bootstrap?.sessions.find((session) => session.id === bootstrap.selectedSessionId);
}

/** Falls back to the standalone Project selection so a Project with no Session still highlights. */
export function selectSelectedProject(bootstrap?: BootstrapState): ProjectRecord | undefined {
    if (!bootstrap) return undefined;
    const sessionProjectId = selectSelectedSession(bootstrap)?.projectId;
    return bootstrap.projects.find(
        (project) => project.id === (sessionProjectId ?? bootstrap.selectedProjectId),
    );
}

export function selectSessionState(bootstrap?: BootstrapState): SessionState | undefined {
    const sessionId = selectSelectedSession(bootstrap)?.id;
    return bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
}

export function selectSessionTerminals(bootstrap?: BootstrapState): TerminalRecord[] {
    const sessionId = selectSelectedSession(bootstrap)?.id;
    if (!sessionId) return NO_TERMINALS;
    return (
        bootstrap?.terminals.filter((terminal) => terminal.sessionId === sessionId) ?? NO_TERMINALS
    );
}

/** Non-React read path: the store is the single source of truth for actions and event handlers. */
export function getBootstrap(): BootstrapState | undefined {
    return useWorkbenchStore.getState().bootstrap;
}

export function getSelectedSession(): SessionRecord | undefined {
    return selectSelectedSession(getBootstrap());
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

export function useKeybindings(): Keybinding[] | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.keybindings);
}

export function useProjects(): ProjectRecord[] | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.projects);
}

export function useSessions(): SessionRecord[] | undefined {
    return useWorkbenchStore((state) => state.bootstrap?.sessions);
}

export function useTerminals(): TerminalRecord[] {
    return useWorkbenchStore((state) => state.bootstrap?.terminals ?? NO_TERMINALS);
}
