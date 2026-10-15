import type { TerminalKind, TerminalSurface } from '@caxri/protocol';
import { canUseAgentChat } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';
import type { MobileWriteFailure } from '../connection/mobile-write-failure';

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
    /**
     * The surface the user picked on this screen; `null` follows the Mac's `session.openAgentsInChat` setting.
     */
    surface: TerminalSurface | null;
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
    surface: null,
});

export const markUncertainSessionsChecked = (
    state: NewSessionCreateState,
): NewSessionCreateState =>
    state.kind === 'uncertain' ? { ...state, checkedSessions: true } : state;

export const acknowledgeCheckedUncertainCreate = (
    state: NewSessionCreateState,
): NewSessionCreateState =>
    state.kind === 'uncertain' && state.checkedSessions ? { kind: 'idle' } : state;

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

/**
 * The surface a new Session opens with, or `null` when the Agent has no Chat and the surface choice is hidden. An
 * explicit pick wins; otherwise the Mac's `session.openAgentsInChat` setting decides, matching Desktop's menus.
 */
export const newSessionSurface = (
    preferred: TerminalSurface | null,
    agent: TerminalKind | null,
    isChatDefault: boolean,
): TerminalSurface | null => {
    if (!agent || !canUseAgentChat(agent)) return null;
    return preferred ?? (isChatDefault ? 'chat' : 'pty');
};

/**
 * The surface `Open as` starts on before any pick here: the computer's `session.openAgentsInChat` setting, or `null`
 * while that setting has not been read.
 */
export const newSessionDefaultSurface = (
    openAgentsInChat: boolean | undefined,
): TerminalSurface | null =>
    openAgentsInChat === undefined ? null : openAgentsInChat ? 'chat' : 'pty';

/**
 * The one-line subtitle under an `Open as` choice: what the surface is, and whether it is the computer's default.
 */
export const newSessionSurfaceDescription = (
    surface: TerminalSurface,
    defaultSurface: TerminalSurface | null,
    t: Translate = translate,
): string => {
    const description = t(
        surface === 'chat' ? 'sessions.new.chatDescription' : 'sessions.new.terminalDescription',
    );
    return surface === defaultSurface
        ? t('sessions.new.defaultSuffix', { description })
        : description;
};

/**
 * The Project a new Session goes to: a pick made on the New Session screen, else the Project the Session list is
 * filtered to (`activeProjectFilter`), else the most recently active one. Without the filter step, + under a Project
 * chip created the Session somewhere the filtered list then hid.
 */
export const selectedNewSessionProject = (
    preferred: string | null,
    projects: NewSessionProject[],
    filterProjectId: string | null,
): string | null => {
    const isGranted = (id: string | null): id is string =>
        id !== null && projects.some((project) => project.id === id);
    if (isGranted(preferred)) return preferred;
    if (isGranted(filterProjectId)) return filterProjectId;
    return projects[0]?.id ?? null;
};

/**
 * The New Session choices after the reader picks another Project chip: the earlier Project pick is forgotten, so the
 * next New Session starts in the chip's Project rather than one the reader has since filtered away from. Returns the
 * same object when there was no pick.
 */
export const forgetNewSessionProject = (selection: NewSessionSelection): NewSessionSelection =>
    selection.projectId === null ? selection : { ...selection, projectId: null };

/**
 * The Session list's Project chip after a Session was created in `createdProjectId`: All stays All, and a chip for
 * another Project follows the new Session, so going back to the list shows it instead of filtering it out.
 */
export const projectFilterAfterCreate = (
    activeFilterProjectId: string | null,
    createdProjectId: string,
): string | null => (activeFilterProjectId === null ? null : createdProjectId);

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
export const newSessionAgentReason = (
    {
        agent,
        isConnected,
        isError,
        isLoading,
    }: {
        agent: { available: boolean; reason?: string } | undefined;
        isConnected: boolean;
        isError: boolean;
        isLoading: boolean;
    },
    t: Translate = translate,
): string | undefined => {
    if (isError) return t('sessions.new.availabilityUnknown');
    if (!agent && !isConnected) return t('sessions.new.availabilityReconnect');
    if (isLoading) return t('sessions.new.availabilityChecking');
    if (agent?.available) return undefined;
    return agent?.reason ?? t('sessions.new.unavailable');
};

/**
 * Plain wording for a Session create the Server explicitly refused, by error code. The Server's own message is
 * diagnostic text written for logs, so it never reaches this screen.
 */
const NEW_SESSION_REJECTION_MESSAGES: Readonly<Partial<Record<string, TranslationKey>>> = {
    CAPACITY: 'sessions.new.rejectedCapacity',
    CONFLICT: 'sessions.new.rejectedConflict',
    FORBIDDEN: 'sessions.new.rejectedForbidden',
    NOT_FOUND: 'sessions.new.rejectedNotFound',
    VALIDATION: 'sessions.new.rejectedValidation',
};

/**
 * The create state after `mobile.session.create` failed, from {@link MobileWriteFailure}: an explicit refusal or no
 * connection can be retried at once, while any other failure may already have created the Session.
 */
export const newSessionCreateFailure = (
    failure: MobileWriteFailure,
    t: Translate = translate,
): NewSessionCreateState => {
    switch (failure.kind) {
        case 'rejected': {
            const key = NEW_SESSION_REJECTION_MESSAGES[failure.code];
            return { kind: 'failed', message: t(key ?? 'sessions.new.rejectedGeneric') };
        }
        case 'offline':
            return { kind: 'failed', message: t('sessions.new.createOffline') };
        case 'unknown':
            return {
                kind: 'uncertain',
                checkedSessions: false,
                message: t('sessions.new.createUncertain'),
            };
    }
};
