import type {
    AppSettings,
    BootstrapState,
    ExtensionTreeViewState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    SourceControlViewState,
    TerminalRecord,
    ThemeTokens,
    ViewContainerId,
} from '@caxri/protocol';
import { activeTab } from '@caxri/protocol';
import { useShallow } from 'zustand/react/shallow';

import { useWorkbenchStore } from './workbench';

const NO_TERMINALS: TerminalRecord[] = [];

export function selectSelectedSession(bootstrap?: BootstrapState): SessionRecord | undefined {
    return bootstrap?.sessions.find((session) => session.id === bootstrap.selectedSessionId);
}

/**
 * Falls back to the standalone Project selection so a Project with no Session still highlights.
 */
export function selectSelectedProject(bootstrap?: BootstrapState): ProjectRecord | undefined {
    if (!bootstrap) return undefined;
    const sessionProjectId = selectSelectedSession(bootstrap)?.projectId;
    return bootstrap.projects.find(
        (project) => project.id === (sessionProjectId ?? bootstrap.selectedProjectId),
    );
}

/**
 * Files, Editor, and Git follow this Project; PrimarySidebar ownership still uses `selectSelectedProject`.
 */
export function selectSelectedWorkbenchProject(
    bootstrap?: BootstrapState,
): ProjectRecord | undefined {
    if (!bootstrap) return undefined;
    const workbenchProjectId = selectSelectedSession(bootstrap)?.workbenchProjectId;
    return bootstrap.projects.find((project) => project.id === workbenchProjectId);
}

function selectSessionState(
    bootstrap?: BootstrapState,
    sessionId?: string,
): SessionState | undefined {
    const targetId = sessionId ?? selectSelectedSession(bootstrap)?.id;
    if (!targetId) return undefined;
    return bootstrap?.sessionStates.find((state) => state.sessionId === targetId);
}

function selectSessionTerminals(bootstrap?: BootstrapState): TerminalRecord[] {
    const sessionId = selectSelectedSession(bootstrap)?.id;
    if (!sessionId) return NO_TERMINALS;
    return (
        bootstrap?.terminals.filter((terminal) => terminal.sessionId === sessionId) ?? NO_TERMINALS
    );
}

/**
 * Non-React read path: the store is the single source of truth for actions and event handlers.
 */
export function getBootstrap(): BootstrapState | undefined {
    return useWorkbenchStore.getState().bootstrap;
}

export function getSelectedSession(): SessionRecord | undefined {
    return selectSelectedSession(getBootstrap());
}

/**
 * File paths belong to a Workbench Project, so mutations reconcile Sessions currently sharing it.
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
 * Returns Sessions whose current structured requests still resolve against this Workbench Root.
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

export function getSessionState(): SessionState | undefined {
    return selectSessionState(getBootstrap());
}

/**
 * The selected Session's id alone. Unlike {@link useSelectedSession} it does not change when the record's activity or
 * timestamps do, so App-level hooks that only key on the id stay quiet.
 */
export function useSelectedSessionId(): string | undefined {
    return useWorkbenchStore((state) => selectSelectedSession(state.bootstrap)?.id);
}

/**
 * `<sessionId>:<workbenchProjectId>` of the selected Session, as one string that only changes when the Session or its
 * Project does.
 */
export function useSelectedSessionScopeKey(): string | undefined {
    return useWorkbenchStore((state) => {
        const session = selectSelectedSession(state.bootstrap);
        return session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    });
}

/**
 * The file path of the active work tab, or undefined when it is not a file. A primitive, so it only notifies when the
 * path itself changes.
 */
export function selectActiveFilePath(bootstrap?: BootstrapState): string | undefined {
    const layout = selectSessionState(bootstrap)?.paneLayout;
    const resource = layout ? activeTab(layout)?.resource : undefined;
    return resource?.kind === 'file' ? resource.path : undefined;
}

export function useSelectedSession(): SessionRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedSession(state.bootstrap));
}

/**
 * A Session by id rather than by selection. Required wherever a view may belong to a Session that is mounted but not on
 * screen: a Terminal in a kept-alive Workbench still resolves paths against its own Project root, not the selected
 * Session's (issue #657).
 */
export function useSessionById(sessionId: string | undefined): SessionRecord | undefined {
    return useWorkbenchStore((state) =>
        sessionId
            ? state.bootstrap?.sessions.find((session) => session.id === sessionId)
            : undefined,
    );
}

export function useProjectById(projectId: string | undefined): ProjectRecord | undefined {
    return useWorkbenchStore((state) =>
        projectId
            ? state.bootstrap?.projects.find((project) => project.id === projectId)
            : undefined,
    );
}

export function useSelectedProject(): ProjectRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedProject(state.bootstrap));
}

export function useSelectedWorkbenchProject(): ProjectRecord | undefined {
    return useWorkbenchStore((state) => selectSelectedWorkbenchProject(state.bootstrap));
}

/**
 * The selected Session's state, or a named Session's when the caller owns more than one at a time. The Workbench keeps
 * recently used Sessions mounted off screen (issue #657), and each of those panes must keep reading its own layout
 * rather than following the selection it no longer holds.
 */
export function useSessionState(sessionId?: string): SessionState | undefined {
    return useWorkbenchStore((state) => selectSessionState(state.bootstrap, sessionId));
}

/**
 * The two ids a Session-scoped view keys its reads on, and nothing else from the Session.
 *
 * The narrowing is the point. `SessionState` also carries `paneLayout`, which moves on every work-tab switch, so a view
 * that read the whole record re-rendered for a tab change it has no stake in, including while it was hidden, where the
 * user pays for the work and cannot even see the result.
 */
export function useSessionViewScope(): {
    sessionId?: string;
    workbenchProjectId?: string;
} {
    return useWorkbenchStore(
        useShallow((state) => {
            const sessionState = selectSessionState(state.bootstrap);
            return {
                sessionId: sessionState?.sessionId,
                workbenchProjectId: sessionState?.workbenchProjectId,
            };
        }),
    );
}

/**
 * One Source Control view's persisted disclosure and mode state. Same narrowing as {@link useSessionViewScope}: a view
 * subscribes to its own entry, so another view's persisted state moving leaves it alone.
 */
export function useSourceControlViewState(viewId: string): SourceControlViewState | undefined {
    return useWorkbenchStore(
        (state) => selectSessionState(state.bootstrap)?.sourceControlViewStates?.[viewId],
    );
}

/**
 * One extension tree's persisted expansion and selection state, narrowed the same way.
 */
export function useExtensionTreeViewState(viewId: string): ExtensionTreeViewState | undefined {
    return useWorkbenchStore(
        (state) => selectSessionState(state.bootstrap)?.extensionTreeViewStates?.[viewId],
    );
}

/**
 * The Session's durable secondary-sidebar choice, plus whether there is a Session to own one at all. The container
 * surface falls back to a window-local selection when there is not, which is why both travel together.
 */
export function useDesiredSecondarySidebarView(): {
    desiredId?: ViewContainerId;
    hasSession: boolean;
} {
    return useWorkbenchStore(
        useShallow((state) => {
            const sessionState = selectSessionState(state.bootstrap);
            return {
                desiredId: sessionState?.desiredSecondarySidebarViewContainerId,
                hasSession: sessionState !== undefined,
            };
        }),
    );
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

export function useTerminals(): TerminalRecord[] {
    return useWorkbenchStore((state) => state.bootstrap?.terminals ?? NO_TERMINALS);
}

/**
 * Mirrors the native window's fullscreen state; see `window.fullScreen` in `stores/workbench.ts`.
 */
export function useIsFullScreen(): boolean {
    return useWorkbenchStore((state) => state.isFullScreen);
}
