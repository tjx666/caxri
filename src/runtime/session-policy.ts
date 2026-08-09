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
 * input and return plain patches or facts, with no SQL and no side effects. `./db/repository.ts`
 * composes these with `./db/models/*` (pure SQL) inside its own transactions.
 */

/** Neutral automatic title used until a new Session gains useful Agent metadata or a manual name. */
export const DEFAULT_SESSION_TITLE = 'Untitled';

/** Single source of truth for the title a Terminal starts with. */
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

/**
 * Why a Runtime is bulk-marking every still-alive Terminal at connection-open/close time. `unclean`
 * covers a previous process crash/kill discovered on the next `openDatabase` call; `orderly` covers
 * a graceful Runtime shutdown (app quit, Session reload). Both leave still-alive Terminals
 * `interrupted` so the next Runtime start can auto-resume them (with their Agent conversation
 * intact, per GitHub issue #18) — only their primary Agent Session outcome differs: `failed` for an
 * unclean shutdown versus `completed` for an orderly one, since nothing actually failed there.
 * `terminate` covers the explicit user-initiated "Terminate and Close" action
 * (`terminal.terminateAll`): Terminals are marked `stopped`, the same terminal state as a normal
 * exit, so the next Runtime start treats them as finished and does not auto-restore them.
 */
export type ShutdownReason = 'unclean' | 'orderly' | 'terminate';

export interface ShutdownOutcome {
    /** Terminal process states treated as "still alive" and eligible for bulk-marking. */
    liveProcessStates: ProcessState[];
    /** Process state written to every previously-alive Terminal. */
    terminalProcessState: ProcessState;
    /** Session activity state written when a Session's primary Agent Terminal lands in `terminalProcessState`. */
    primaryAgentSessionState: AgentActivityState;
}

const SHUTDOWN_OUTCOMES: Record<ShutdownReason, ShutdownOutcome> = {
    unclean: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'interrupted',
        primaryAgentSessionState: 'failed',
    },
    orderly: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'interrupted',
        primaryAgentSessionState: 'completed',
    },
    terminate: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'stopped',
        primaryAgentSessionState: 'completed',
    },
};

/** Decides the bulk Terminal/Session state transition for a given shutdown `reason`. */
export function shutdownOutcome(reason: ShutdownReason): ShutdownOutcome {
    return SHUTDOWN_OUTCOMES[reason];
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
    session: Pick<SessionRecord, 'displayTitle' | 'primaryAgentTerminalId' | 'titleMode'>,
    terminal: Pick<TerminalRecord, 'id' | 'kind'>,
): PrimaryAgentAssignment | undefined {
    if (terminal.kind === 'shell' || session.primaryAgentTerminalId) return undefined;
    return {
        primaryAgentTerminalId: terminal.id,
        displayTitle: session.displayTitle,
        lastActivityState: 'idle',
    };
}

export interface PrimaryAgentSuccession {
    primaryAgentTerminalId: string | null;
    displayTitle: string;
    lastActivityState: AgentActivityState;
}

/**
 * Picks the next primary Agent Terminal after the current one closes. Another Agent becomes the
 * new title source; when only Shell Terminals remain, the last generated Agent title stays visible.
 */
export function choosePrimaryAgentSuccessor(
    remainingTerminals: TerminalRecord[],
    session: Pick<SessionRecord, 'displayTitle' | 'titleMode'>,
): PrimaryAgentSuccession {
    const nextAgent = remainingTerminals.find((candidate) => candidate.provider);
    return {
        primaryAgentTerminalId: nextAgent?.id ?? null,
        displayTitle:
            session.titleMode === 'manual'
                ? session.displayTitle
                : (nextAgent?.title ?? session.displayTitle),
        lastActivityState: nextAgent ? processActivityState(nextAgent.lastProcessState) : 'idle',
    };
}

/** Removes attachment-only prefixes that Codex includes in a thread title but users cannot act on. */
function agentDisplayTitle(title: string | undefined, fallback: string): string {
    const meaningfulTitle = title
        ?.trim()
        .replace(/^(?:\[image\s+#\d+\]\s*)+/i, '')
        .trim();
    return meaningfulTitle || fallback;
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
    session: Pick<
        SessionRecord,
        'displayTitle' | 'lastActivityState' | 'primaryAgentTerminalId' | 'titleMode'
    >,
    snapshot: AgentSnapshot,
): AgentMetadataDecision | undefined {
    if (!terminal.provider || terminal.provider !== snapshot.provider) return undefined;
    const displayTitle =
        session.titleMode === 'manual'
            ? session.displayTitle
            : agentDisplayTitle(snapshot.title, session.displayTitle);
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
export function withTerminalRemovedFromLayout(
    state: SessionState,
    terminalId: string,
): SessionState {
    return { ...state, layout: removeTerminalFromLayout(state.layout, terminalId) };
}
