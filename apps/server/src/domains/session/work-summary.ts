import type {
    ProjectRecord,
    SessionRecord,
    SessionWorkAttention,
    SessionWorkSummary,
    TerminalRecord,
} from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    isSessionAgentRunning,
    isSessionListedOnMobileHome,
    isTopLevelProject,
    SESSION_WORK_SUMMARY_ATTENTION_MAX,
    sessionActivityGroup,
} from '@caxri/protocol';

const TITLE_MAX_CHARACTERS = 200;

const clip = (value: string): string => [...value].slice(0, TITLE_MAX_CHARACTERS).join('');

function attentionKind(
    session: Pick<SessionRecord, 'lastAttentionKind'>,
): SessionWorkAttention['kind'] {
    if (session.lastAttentionKind === 'waiting') return 'waiting';
    if (session.lastAttentionKind === 'failed') return 'failed';
    return 'result';
}

/**
 * Counts the whole app's work the way the Activity view groups it (`sessionActivityGroup`), for the menu bar and Server
 * Core's keep-awake decision.
 *
 * - Working counts every active Session whose Agent runs, worktree Projects included: the Mac must stay awake for a
 *   Delegated Session's work as much as for a top-level one.
 * - Needs attention lists only what a list without nesting can show, by the phone home list's rule
 *   (`isSessionListedOnMobileHome`): a second opinion or delegated work belongs to the Session that asked for it,
 *   unless it waits on the user's answer. Sessions of a Project the Primary Side Bar hides are left out, as in the
 *   Activity view.
 */
export function summarizeSessionWork(input: {
    projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'ownerProjectId' | 'title'>>;
    sessions: readonly SessionRecord[];
    terminals: readonly TerminalRecord[];
}): SessionWorkSummary {
    const terminals = new Map(input.terminals.map((terminal) => [terminal.id, terminal]));
    const shellTerminals = new Map<string, TerminalRecord>();
    for (const terminal of input.terminals)
        if (terminal.kind === 'shell' && !shellTerminals.has(terminal.sessionId))
            shellTerminals.set(terminal.sessionId, terminal);
    const listedProjects = new Map(
        input.projects.filter(isTopLevelProject).map((project) => [project.id, project]),
    );
    const archivedIds = new Set(
        input.sessions.filter((session) => session.archivedAt !== undefined).map(({ id }) => id),
    );
    const active = input.sessions.filter((session) => session.archivedAt === undefined);
    const listedIds = new Set(
        active.filter((session) => listedProjects.has(session.projectId)).map(({ id }) => id),
    );
    let working = 0;
    let usageWaiting = 0;
    const attention: SessionRecord[] = [];
    for (const session of active) {
        const terminal = session.primaryAgentTerminalId
            ? terminals.get(session.primaryAgentTerminalId)
            : shellTerminals.get(session.id);
        const isUsageWaiting = terminal?.usageLimitWaitAt !== undefined;
        const group = sessionActivityGroup({
            hasPendingAttention: session.hasPendingAttention,
            isDetached: terminal?.lastProcessState === 'detached',
            isRunning: isSessionAgentRunning(session, terminal),
            isUsageWaiting,
        });
        if (isUsageWaiting) usageWaiting += 1;
        if (group === 'working') working += 1;
        if (
            group === 'attention' &&
            listedIds.has(session.id) &&
            isSessionListedOnMobileHome(
                {
                    ...session,
                    createdBySessionArchived:
                        session.createdBySessionId !== undefined &&
                        archivedIds.has(session.createdBySessionId),
                },
                listedIds,
            )
        )
            attention.push(session);
    }
    attention.sort((left, right) => compareSessionActivityGroupRows('attention', left, right));
    return {
        working,
        usageWaiting,
        attentionCount: attention.length,
        attention: attention.slice(0, SESSION_WORK_SUMMARY_ATTENTION_MAX).map((session) => ({
            sessionId: session.id,
            title: clip(session.title),
            projectTitle: clip(listedProjects.get(session.projectId)?.title ?? ''),
            kind: attentionKind(session),
        })),
    };
}
