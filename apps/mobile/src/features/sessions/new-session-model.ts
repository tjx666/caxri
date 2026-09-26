import type { TerminalKind } from '@caxri/protocol';

import type { MobileConnectionStatus } from '../connection/connection-state';

export interface NewSessionProject {
    displayTitle: string;
    id: string;
    lastActivityAt?: number;
}

export interface NewSessionAgent {
    available: boolean;
    kind: TerminalKind;
    reason?: string;
}

export interface NewSessionSelection {
    agent: TerminalKind | null;
    projectId: string | null;
}

export type NewSessionCreateState =
    | { kind: 'idle' }
    | { kind: 'creating' }
    | { kind: 'failed'; message: string }
    | { kind: 'uncertain'; checkedSessions: boolean; message: string }
    | { kind: 'partial'; message: string; sessionId: string };

export const emptyNewSessionSelection = (): NewSessionSelection => ({
    agent: null,
    projectId: null,
});

export const markUncertainSessionsChecked = (
    state: NewSessionCreateState,
): NewSessionCreateState =>
    state.kind === 'uncertain' ? { ...state, checkedSessions: true } : state;

export const acknowledgeCheckedUncertainCreate = (
    state: NewSessionCreateState,
): NewSessionCreateState =>
    state.kind === 'uncertain' && state.checkedSessions ? { kind: 'idle' } : state;

export const NEW_SESSION_AGENT_LABELS: Record<TerminalKind, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    grok: 'Grok',
    shell: 'Shell',
};

export const NEW_SESSION_AGENT_ORDER: TerminalKind[] = ['claude', 'codex', 'grok', 'shell'];

export const sortNewSessionProjects = (projects: NewSessionProject[]): NewSessionProject[] => {
    // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted.
    return [...projects].sort((left, right) => {
        const leftRecent = left.lastActivityAt ?? 0;
        const rightRecent = right.lastActivityAt ?? 0;
        return (
            rightRecent - leftRecent ||
            left.displayTitle.localeCompare(right.displayTitle) ||
            left.id.localeCompare(right.id)
        );
    });
};

export const availableNewSessionAgent = (
    preferred: TerminalKind | null,
    agents: NewSessionAgent[],
): TerminalKind | null => {
    if (preferred && agents.some((agent) => agent.kind === preferred && agent.available))
        return preferred;
    return (
        NEW_SESSION_AGENT_ORDER.find((kind) =>
            agents.some((agent) => agent.kind === kind && agent.available),
        ) ?? null
    );
};

export const selectedNewSessionProject = (
    preferred: string | null,
    projects: NewSessionProject[],
): string | null =>
    preferred && projects.some((project) => project.id === preferred)
        ? preferred
        : (projects[0]?.id ?? null);

export const canCreateNewSession = ({
    agent,
    createState,
    dashboardError,
    hasDashboard,
    isAvailabilityError,
    isAvailabilityLoading,
    isForeground,
    projectId,
    role,
    status,
}: {
    agent: TerminalKind | null;
    createState: NewSessionCreateState;
    dashboardError: string | null;
    hasDashboard: boolean;
    isAvailabilityError: boolean;
    isAvailabilityLoading: boolean;
    isForeground: boolean;
    projectId: string | null;
    role: 'view' | 'reply' | 'control' | null;
    status: MobileConnectionStatus;
}): boolean =>
    projectId !== null &&
    agent !== null &&
    role === 'control' &&
    status === 'connected' &&
    isForeground &&
    hasDashboard &&
    dashboardError === null &&
    !isAvailabilityLoading &&
    !isAvailabilityError &&
    !['partial', 'uncertain', 'creating'].includes(createState.kind);

/**
 * Availability is read only while connected. Offline, before any answer arrived, the read is held back rather than in
 * flight, so "Checking availability…" would never resolve; say what the reader has to do instead.
 */
export const newSessionAgentReason = ({
    agent,
    isConnected,
    isError,
    isLoading,
}: {
    agent: { available: boolean; reason?: string } | undefined;
    isConnected: boolean;
    isError: boolean;
    isLoading: boolean;
}): string | undefined => {
    if (isError) return 'Availability unavailable.';
    if (!agent && !isConnected) return 'Reconnect to check availability.';
    if (isLoading) return 'Checking availability…';
    if (agent?.available) return undefined;
    return agent?.reason ?? 'Not available on this computer.';
};
