import type {
    AgentActivityState,
    AgentSnapshot,
    ProcessState,
    ProjectRecord,
    SessionActivityReason,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    compareSessionSidebarOrder,
    DEFAULT_SESSION_TITLE,
    isTopLevelProject,
    normalizeTerminalTitle,
    removePaneTerminal,
} from '@caxri/protocol';

import type { AgentLifecyclePhase } from './agents';

/**
 * Domain policy for the persisted Project/Session/Terminal model: decisions take plain records as input and return
 * plain patches or facts, with no SQL and no side effects. `./db/repository.ts` composes these with `./db/models/*`
 * (pure SQL) inside its own transactions.
 */

export { DEFAULT_SESSION_TITLE };

export function defaultTerminalTitle(kind: TerminalKind): string {
    return kind === 'shell' ? 'Shell' : agentProviderCatalog[kind].displayName;
}

/**
 * Maps a real Primary Agent child-process exit onto the coarser Agent activity state shown in the UI. Live PTY state is
 * deliberately excluded because an interactive Agent process also stays alive while idle at its prompt.
 */
export function processExitActivityState(
    state: Extract<ProcessState, 'dead' | 'stopped'>,
): Extract<AgentActivityState, 'completed' | 'failed'> {
    return state === 'stopped' ? 'completed' : 'failed';
}

/**
 * Maps only user-relevant Primary Agent states onto the content-free Session Activity reason allowlist. Idle and
 * unknown observations are reconciliation states, not evidence that work progressed.
 */
export function sessionActivityReasonForAgentState(
    state: AgentActivityState,
): SessionActivityReason | undefined {
    switch (state) {
        case 'running':
            return 'agent_started';
        case 'waiting':
            return 'agent_waiting';
        case 'completed':
            return 'agent_completed';
        case 'failed':
            return 'agent_failed';
        default:
            return undefined;
    }
}

/**
 * Why a Server is bulk-marking every still-alive Terminal at connection-open/close time. `unclean` covers a previous
 * process crash/kill discovered on the next `openDatabase` call; `orderly` covers a graceful Server shutdown (app quit,
 * Session reload). Both leave still-alive Terminals `interrupted` so the next Server start can auto-resume them (with
 * their Agent conversation intact). None of these shutdown reasons changes Session activity: ending a process does not
 * complete its conversation. `terminate` covers the explicit user-initiated "Terminate and Close" action
 * (`terminal.terminateAll`): Terminals are marked `stopped`, the same terminal state as a normal exit, so the next
 * Server start treats them as finished and does not auto-restore them.
 */
export type ShutdownReason = 'unclean' | 'orderly' | 'terminate';

export interface ShutdownOutcome {
    /**
     * Terminal process states treated as "still alive" and eligible for bulk-marking.
     */
    liveProcessStates: ProcessState[];
    /**
     * Process state written to every previously-alive Terminal.
     */
    terminalProcessState: ProcessState;
}

const SHUTDOWN_OUTCOMES: Record<ShutdownReason, ShutdownOutcome> = {
    /**
     * Caxri died; the Agents did not. Writing a Session state here used to stamp `failed` on every live Session at
     * once, which is a fact about Caxri's process wearing a field that means "what is this conversation doing". Nothing
     * ever cleared it, so each unclean exit permanently converted every live Session into a top-of-list Activity row
     * the user could not act on or dismiss. The Session keeps whatever it was: a Session waiting on the user still is,
     * and `interrupted` on the Terminal carries the process truth on its own. See
     * https://github.com/tjx666/caxri/issues/1124.
     */
    unclean: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'interrupted',
    },
    orderly: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'interrupted',
    },
    terminate: {
        liveProcessStates: ['running', 'starting'],
        terminalProcessState: 'stopped',
    },
};

/**
 * Decides the Terminal process transition for a shutdown. Exiting or terminating Caxri does not complete a
 * conversation: Session activity must survive every shutdown reason independently of Terminal process state.
 */
export function shutdownOutcome(reason: ShutdownReason): ShutdownOutcome {
    return SHUTDOWN_OUTCOMES[reason];
}

export interface PrimaryAgentAssignment {
    primaryAgentTerminalId: string;
    displayTitle: string;
    lastActivityState: 'idle';
}

/**
 * Decides whether a freshly created Terminal becomes its Session's primary Agent. Only an Agent Terminal (never a
 * shell) can become primary, and only when the Session does not already have one. A brand-new Session (no
 * `primaryAgentTerminalId` yet) and an existing Session gaining its first Agent Terminal both flow through this same
 * rule.
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
 * Picks the next primary Agent Terminal after the current one closes. The visible title stays stable until useful
 * metadata from the successor arrives; when only Shell Terminals remain, the last generated Agent title stays visible.
 */
export function choosePrimaryAgentSuccessor(
    remainingTerminals: TerminalRecord[],
    session: Pick<SessionRecord, 'displayTitle'>,
): PrimaryAgentSuccession {
    const nextAgent = remainingTerminals.find((candidate) => candidate.provider);
    return {
        primaryAgentTerminalId: nextAgent?.id ?? null,
        displayTitle: session.displayTitle,
        lastActivityState: nextAgent ? 'unknown' : 'idle',
    };
}

/**
 * Promotes a live secondary Agent after the current primary Agent process exits while its Shell Terminal stays open.
 * Keeping the current primary when no live successor exists preserves that Terminal's durable resume identity.
 */
export function chooseLivePrimaryAgentSuccessor(
    terminals: TerminalRecord[],
    session: Pick<SessionRecord, 'displayTitle' | 'primaryAgentTerminalId'>,
    exitedTerminalId: string,
): PrimaryAgentSuccession | undefined {
    if (session.primaryAgentTerminalId !== exitedTerminalId) return undefined;
    const nextAgent = terminals.find(
        (candidate) =>
            candidate.id !== exitedTerminalId &&
            candidate.provider !== undefined &&
            (candidate.lastAgentProcessState === 'starting' ||
                candidate.lastAgentProcessState === 'running'),
    );
    if (!nextAgent) return undefined;
    return {
        primaryAgentTerminalId: nextAgent.id,
        displayTitle: session.displayTitle,
        lastActivityState: 'unknown',
    };
}

/**
 * Removes attachment-only prefixes that Codex includes in a thread title but users cannot act on.
 */
function agentDisplayTitle(title: string | undefined, fallback: string): string {
    const meaningfulTitle = title
        ?.trim()
        .replace(/^(?:\[image\s+#\d+\]\s*)+/i, '')
        .trim();
    // `||` (not `??`) is deliberate: a title reduced to `''` by trimming/prefix removal is not
    // meaningful either and must also fall back to `fallback`.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is also not a meaningful title
    return meaningfulTitle || fallback;
}

export interface AgentMetadataDecision {
    /**
     * New value to persist on the Terminal row (`undefined` clears the column).
     */
    agentSessionId: string | undefined;
    /**
     * New title for the Terminal row, present only when it differs from what the row already carries. Unlike
     * `sessionPatch` below this applies to every Agent Terminal, primary or not: a secondary Agent's tab shows its own
     * conversation name, so it must not be left displaying the bare provider name.
     */
    terminalTitle?: string;
    /**
     * Present only when this Terminal is the Session's primary Agent and its title/status changed.
     */
    sessionPatch?: {
        attentionKind?: SessionAttentionKind;
        displayTitle: string;
        lastActivityState: AgentActivityState;
    };
}

/**
 * Emits one attention generation per reliable state transition, never for process fallbacks.
 */
function reliableAttentionTransition(
    session: Pick<SessionRecord, 'lastActivityState' | 'lastAttentionKind'>,
    status: AgentActivityState,
    kind?: SessionAttentionKind,
): SessionAttentionKind | undefined {
    if (!kind || status !== kind) return undefined;
    if (session.lastActivityState === kind && session.lastAttentionKind === kind) return undefined;
    return kind;
}

/**
 * States in which a probe claims the Agent's turn has ended. A provider writes these the moment it starts too, so on
 * their own they cannot distinguish "settled since launch" from "settled because a turn just finished".
 */
const PROBED_TURN_END_STATES = new Set<AgentActivityState>(['completed', 'waiting']);

/**
 * States a probed turn-end reading is allowed to replace.
 *
 * `running` is the only state carrying a turn the probe can prove ended. `failed` is the blanket marker
 * {@link shutdownOutcome} stamps on every live Session after an unclean Caxri shutdown, which describes Caxri crashing
 * rather than the Agent failing: those Terminals are auto-resumed and answering probes again, so keeping it would
 * strand the recovered Session behind a failure the user can only clear by sending a throwaway message.
 */
const PROBE_CORRECTABLE_STATES = new Set<AgentActivityState>(['running', 'failed']);

/**
 * Keeps the stored state whenever a probed turn-end reading cannot improve on it, so an ambiguous provider reading
 * never overwrites the more precise state an explicit hook signal recorded.
 *
 * Persisting an untrusted turn-end state is what made an already-read Session look permanently unattended: the
 * PrimarySidebar's acknowledged-waiting cue keyed off `lastActivityState` alone and never consulted
 * `readAttentionEpoch`, so a probe landing after the user acknowledged a finished turn relit an amber row that no later
 * read could clear. Hook-driven `attentionRequested` signals bypass this because they are explicit.
 */
function metadataActivityState(
    session: Pick<SessionRecord, 'lastActivityState'>,
    status: AgentActivityState,
): AgentActivityState {
    if (
        PROBED_TURN_END_STATES.has(status) &&
        !PROBE_CORRECTABLE_STATES.has(session.lastActivityState)
    )
        return session.lastActivityState;
    return status;
}

export interface AgentLifecycleDecision {
    attentionKind?: SessionAttentionKind;
    lastActivityState: AgentActivityState;
}

const NON_SESSION_ACTIVITY_PHASES = new Set<AgentLifecyclePhase>([
    'sessionIdentified',
    'subagentStarted',
    'shellToolStarted',
    'shellToolFinished',
    'shellToolFailed',
    'compactionStarted',
    'compactionFinished',
]);

/**
 * Converts one validated provider lifecycle signal into a Session-only patch. The result cannot carry `agentSessionId`,
 * so a hook event can never clear a Terminal's resume binding.
 */
export function decideAgentLifecycleUpdate(
    terminal: Pick<TerminalRecord, 'id' | 'provider'>,
    session: Pick<
        SessionRecord,
        'lastActivityState' | 'lastAttentionKind' | 'primaryAgentTerminalId'
    >,
    provider: TerminalRecord['provider'],
    phase: AgentLifecyclePhase,
): AgentLifecycleDecision | undefined {
    if (NON_SESSION_ACTIVITY_PHASES.has(phase)) return undefined;
    if (
        !provider ||
        terminal.provider !== provider ||
        terminal.id !== session.primaryAgentTerminalId
    ) {
        return undefined;
    }
    if (phase === 'toolBatchFinished' || phase === 'attentionResolved')
        return session.lastActivityState === 'waiting'
            ? { lastActivityState: 'running' }
            : undefined;
    const lastActivityState: AgentActivityState =
        phase === 'turnStarted'
            ? 'running'
            : phase === 'turnFailed'
              ? 'failed'
              : phase === 'attentionRequested'
                ? 'waiting'
                : 'completed';
    const requestedAttention = ['attentionRequested', 'turnFinished', 'turnFailed'].includes(phase)
        ? (lastActivityState as SessionAttentionKind)
        : undefined;
    const attentionKind = reliableAttentionTransition(
        session,
        lastActivityState,
        requestedAttention,
    );
    if (!attentionKind && session.lastActivityState === lastActivityState) return undefined;
    return { lastActivityState, ...(attentionKind && { attentionKind }) };
}

/**
 * Decides how an Agent CLI probe result should update persisted state, or returns `undefined` when nothing changed (a
 * provider mismatch, or an identical no-op snapshot) so the caller can skip the write entirely.
 */
export function decideAgentMetadataUpdate(
    terminal: Pick<TerminalRecord, 'id' | 'provider' | 'agentSessionId' | 'title'>,
    session: Pick<
        SessionRecord,
        | 'displayTitle'
        | 'lastActivityState'
        | 'lastAttentionKind'
        | 'primaryAgentTerminalId'
        | 'titleMode'
    >,
    snapshot: AgentSnapshot,
): AgentMetadataDecision | undefined {
    if (!terminal.provider || terminal.provider !== snapshot.provider) return undefined;
    const isPrimaryAgent = terminal.id === session.primaryAgentTerminalId;
    const isManuallyTitled = session.titleMode === 'manual';
    const displayTitle = isManuallyTitled
        ? session.displayTitle
        : agentDisplayTitle(snapshot.title, session.displayTitle);
    /**
     * A targeted probe may temporarily miss a hook-bound thread when the provider store has not flushed it yet or its
     * recorded cwd differs from the Terminal cwd. Only launch reset explicitly clears an identity; an empty snapshot
     * must preserve the exact binding instead of undoing the preceding authenticated hook signal.
     */
    // `||` (not `??`) is deliberate: a trimmed `''` sessionId is not a real identifier either.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string must also preserve the current id
    const agentSessionId = snapshot.sessionId?.trim() || terminal.agentSessionId;
    /**
     * An Agent CLI names its own conversation but (unlike a Shell) does not report that name through OSC 0/2, so
     * without this the Terminal row keeps the `defaultTerminalTitle` provider name it was created with and every Agent
     * tab reads "Claude"/"Codex" forever. Falling back to the row's current title (rather than to the provider name)
     * means a probe carrying no title leaves an existing OSC- or provider-supplied title alone instead of resetting
     * it.
     *
     * Agent metadata is as untrusted as PTY output (it is whatever text a model wrote into a conversation store) and
     * `Terminal.title` is re-sent as `agentEndpoint.begin.name` on the next launch, where the Server schema rejects
     * anything past 200 characters and would fail the start. `normalizeTerminalTitle` is the same flatten/sanitize/cap
     * pass OSC 0/2 titles already go through, so both title sources land in the tab under one bound.
     *
     * The primary Agent's tab is the Session's own face, so a Session the user named by hand wins over the Agent's
     * conversation name there. Without this the two halves of one Session disagreed on screen: the sidebar row kept the
     * typed name while the tab drifted to whatever the Agent CLI last called its thread. That is not an edge case:
     * `SessionRenameService` commits the local title but skips provider synchronization for a provider without native
     * rename and for an Agent that has not produced a session yet, and an Agent may rename its own thread afterwards in
     * any event. A secondary Agent Terminal is unaffected: its tab is the only thing naming that conversation.
     */
    const preferredTitle =
        isPrimaryAgent && isManuallyTitled
            ? session.displayTitle
            : agentDisplayTitle(snapshot.title, terminal.title);
    const terminalTitle = normalizeTerminalTitle(preferredTitle) ?? terminal.title;
    const lastActivityState = metadataActivityState(session, snapshot.status);
    const attentionKind = isPrimaryAgent
        ? reliableAttentionTransition(session, lastActivityState, snapshot.attentionKind)
        : undefined;
    const isNoOp =
        (!isPrimaryAgent ||
            (session.displayTitle === displayTitle &&
                session.lastActivityState === lastActivityState)) &&
        terminal.agentSessionId === agentSessionId &&
        terminal.title === terminalTitle &&
        !attentionKind;
    if (isNoOp) return undefined;
    return {
        agentSessionId,
        ...(terminal.title !== terminalTitle && { terminalTitle }),
        sessionPatch: isPrimaryAgent
            ? {
                  displayTitle,
                  lastActivityState,
                  ...(attentionKind && { attentionKind }),
              }
            : undefined,
    };
}

export interface FallbackSelection {
    projectId: string | null;
    sessionId: string | null;
}

/**
 * Picks the newest visible Session using the same deterministic comparison policy as the Renderer.
 */
export function firstActiveSession(
    records: SessionRecord[],
    excludedSessionId?: string,
): SessionRecord | undefined {
    return records
        .filter((session) => session.archivedAt === undefined && session.id !== excludedSessionId)
        .toSorted(compareSessionSidebarOrder)
        .at(0);
}

/**
 * Picks the Project a fallback selection may land on. An auto-registered worktree Project (`ownerProjectId` set) and a
 * hidden Project are deliberately skipped: the PrimarySidebar never renders either, so selecting one would leave the
 * user with no highlighted Project row and no obvious way back.
 */
export function firstSelectableProject(
    records: readonly ProjectRecord[],
): ProjectRecord | undefined {
    return records.find((project) => isTopLevelProject(project) && project.hiddenAt === undefined);
}

/**
 * Picks the next Project/Session pair to select after the currently selected target is deleted. Both Project deletion
 * and Session deletion feed their already-scoped fallback candidate through this one rule instead of maintaining two
 * near-identical selection algorithms: a candidate Session (already ordered/scoped by the caller) wins outright;
 * otherwise fall back to `fallbackProjectId`.
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
 * Removes a closed Terminal's occurrence from the persisted Workbench tree. Composes the pure reducer in
 * `../shared/pane-layout.ts` instead of letting the persistence layer perform its own JSON surgery on layout state.
 */
export function withTerminalRemovedFromLayout(
    state: SessionState,
    terminalId: string,
): SessionState {
    return { ...state, paneLayout: removePaneTerminal(state.paneLayout, terminalId) };
}
