import { removeTerminal as removeTerminalFromLayout } from '../shared/terminal-layout';
import type {
    AgentActivityState,
    AgentSnapshot,
    ProcessState,
    SessionRecord,
    SessionState,
    TerminalKind,
    TerminalRecord,
} from '../shared/types';

/**
 * Domain policy for the persisted Project/Session/Terminal model: decisions take plain records as
 * input and return plain patches or facts, with no SQL and no side effects. `../runtime/database.ts`
 * composes these with `./store/*` (pure SQL) inside its own transactions.
 */

/** Single source of truth for the title a Terminal (or a newly promoted primary Agent) starts with. */
const DEFAULT_TERMINAL_TITLE: Record<TerminalKind, string> = {
    shell: 'Shell',
    claude: 'Claude Code',
    codex: 'Codex',
};

export function defaultTerminalTitle(kind: TerminalKind): string {
    return DEFAULT_TERMINAL_TITLE[kind];
}

/** Maps a Terminal process lifecycle state onto the coarser Agent activity state shown in the UI. */
export function processActivityState(state: ProcessState): AgentActivityState {
    if (state === 'running' || state === 'starting') return 'running';
    if (state === 'stopped') return 'completed';
    return 'failed';
}

export interface PrimaryAgentAssignment {
    primaryAgentTerminalId: string;
    displayTitle: string;
    lastActivityState: 'idle';
}

/**
 * Decides whether a freshly created Terminal becomes its Session's primary Agent. Only an Agent
 * Terminal (never a shell) can become primary, and only when the Session does not already have one.
 * A brand-new Session (no `primaryAgentTerminalId` yet) and an existing Session gaining its first
 * Agent Terminal both flow through this same rule.
 */
export function choosePrimaryAgentForNewTerminal(
    session: Pick<SessionRecord, 'primaryAgentTerminalId'>,
    terminal: Pick<TerminalRecord, 'id' | 'kind'>,
): PrimaryAgentAssignment | undefined {
    if (terminal.kind === 'shell' || session.primaryAgentTerminalId) return undefined;
    return {
        primaryAgentTerminalId: terminal.id,
        displayTitle: defaultTerminalTitle(terminal.kind),
        lastActivityState: 'idle',
    };
}

export interface PrimaryAgentSuccession {
    primaryAgentTerminalId: string | null;
    displayTitle: string;
    lastActivityState: AgentActivityState;
}

/**
 * Picks the next primary Agent Terminal after the current one closes: prefer another Agent
 * Terminal in the Session, otherwise fall back to any remaining Terminal so the Session keeps a
 * title source, otherwise reset to an untitled idle Session.
 */
export function choosePrimaryAgentSuccessor(
    remainingTerminals: TerminalRecord[],
): PrimaryAgentSuccession {
    const nextAgent = remainingTerminals.find((candidate) => candidate.provider);
    const fallback = nextAgent ?? remainingTerminals[0];
    return {
        primaryAgentTerminalId: nextAgent?.id ?? null,
        displayTitle: fallback?.title ?? 'Session',
        lastActivityState: nextAgent ? processActivityState(nextAgent.lastProcessState) : 'idle',
    };
}

export interface AgentMetadataDecision {
    /** New value to persist on the Terminal row (`undefined` clears the column). */
    agentSessionId: string | undefined;
    /** Present only when this Terminal is the Session's primary Agent and its title/status changed. */
    sessionPatch?: { displayTitle: string; lastActivityState: AgentActivityState };
}

/**
 * Decides how an Agent CLI probe result should update persisted state, or returns `undefined` when
 * nothing changed (a provider mismatch, or an identical no-op snapshot) so the caller can skip the
 * write entirely.
 */
export function decideAgentMetadataUpdate(
    terminal: Pick<TerminalRecord, 'id' | 'provider' | 'agentSessionId'>,
    session: Pick<SessionRecord, 'displayTitle' | 'lastActivityState' | 'primaryAgentTerminalId'>,
    snapshot: AgentSnapshot,
): AgentMetadataDecision | undefined {
    if (!terminal.provider || terminal.provider !== snapshot.provider) return undefined;
    const displayTitle = snapshot.title?.trim() || session.displayTitle;
    const agentSessionId = snapshot.sessionId?.trim() || undefined;
    const isPrimaryAgent = terminal.id === session.primaryAgentTerminalId;
    const noOp =
        (!isPrimaryAgent ||
            (session.displayTitle === displayTitle &&
                session.lastActivityState === snapshot.status)) &&
        terminal.agentSessionId === agentSessionId;
    if (noOp) return undefined;
    return {
        agentSessionId,
        sessionPatch: isPrimaryAgent
            ? { displayTitle, lastActivityState: snapshot.status }
            : undefined,
    };
}

export interface FallbackSelection {
    projectId: string | null;
    sessionId: string | null;
}

/**
 * Picks the next Project/Session pair to select after the currently selected target is deleted.
 * Both Project deletion and Session deletion feed their already-scoped fallback candidate through
 * this one rule instead of maintaining two near-identical selection algorithms: a candidate Session
 * (already ordered/scoped by the caller) wins outright; otherwise fall back to `fallbackProjectId`.
 */
export function selectFallbackAfterDeletion(
    fallbackSession: SessionRecord | undefined,
    fallbackProjectId: string | null,
): FallbackSelection {
    return {
        projectId: fallbackSession?.projectId ?? fallbackProjectId,
        sessionId: fallbackSession?.id ?? null,
    };
}

/**
 * Removes a closed Terminal from the persisted split layout. Composes the pure layout helpers in
 * `../shared/terminal-layout.ts` instead of letting the persistence layer perform its own JSON
 * surgery on UI layout state.
 */
export function withTerminalRemovedFromLayout(state: SessionState, terminalId: string): SessionState {
    return { ...state, layout: removeTerminalFromLayout(state.layout, terminalId) };
}
