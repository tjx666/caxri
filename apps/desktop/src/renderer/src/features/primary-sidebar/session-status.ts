import type { AgentOperation, ProcessState, SessionRecord } from '@caxri/protocol';

import { sessionActivityPresentation } from './session-activity';

export type SessionStatus =
    | { ariaLabel: string; kind: 'attention' }
    | { ariaLabel: string; kind: 'detached' }
    | { ariaLabel: string; kind: 'running' }
    | { kind: 'default' };

export interface SessionStatusTerminal {
    agentOperation?: AgentOperation;
    lastProcessState?: ProcessState;
}

type SessionStatusSource = Pick<
    SessionRecord,
    'hasUnread' | 'lastActivityState' | 'lastAttentionKind'
>;

/**
 * Projects the detailed Agent lifecycle into the single status slot shared by Session lists.
 *
 * The amber attention slot means exactly one thing: an event the user has not opened yet. It is therefore always the
 * animated unread state and always clears once the Session is read — there is deliberately no quieter "still waiting"
 * variant. A second, static amber state keyed off `lastActivityState` alone used to survive acknowledgement, which left
 * read Sessions marked with a cue no amount of reading could clear and made the animated one impossible to trust.
 */
export function sessionStatus(
    session: SessionStatusSource,
    terminal: SessionStatusTerminal = {},
): SessionStatus {
    const { agentOperation } = terminal;
    const currentActivity = sessionActivityPresentation(session.lastActivityState, agentOperation);

    if (session.hasUnread) {
        const attentionActivity = sessionActivityPresentation(
            session.lastAttentionKind ?? 'unknown',
        );
        const currentStatus =
            agentOperation === 'compacting' || session.lastActivityState === 'running'
                ? ` Current status: ${currentActivity.ariaLabel}`
                : '';
        return {
            ariaLabel: `Needs attention: ${attentionActivity.label}. ${attentionActivity.description}${currentStatus}`,
            kind: 'attention',
        };
    }

    /**
     * A detached Agent was handed to another client on purpose, so whatever activity the last probe recorded is no
     * longer Caxri's to animate. Unread attention still wins above: it was raised before the hand-over.
     */
    if (terminal.lastProcessState === 'detached') {
        return {
            ariaLabel: 'Detached. The Agent was stopped so another client can resume it.',
            kind: 'detached',
        };
    }

    if (agentOperation === 'compacting' || session.lastActivityState === 'running') {
        return { ariaLabel: currentActivity.ariaLabel, kind: 'running' };
    }

    return { kind: 'default' };
}

export interface SessionStatusSummary {
    /**
     * Sessions showing unread attention. Attention outranks running in `sessionStatus`, so a Session is counted once.
     */
    attention: number;
    running: number;
}

/**
 * Folds a group of Sessions into the counts a collapsed Project heading shows, using the same projection as each row so
 * the heading can never report a state its expanded rows would not.
 */
export function summarizeSessionStatuses<Session extends SessionStatusSource>(
    sessions: readonly Session[],
    terminalFor: (session: Session) => SessionStatusTerminal | undefined,
): SessionStatusSummary {
    const summary: SessionStatusSummary = { attention: 0, running: 0 };
    for (const session of sessions) {
        const { kind } = sessionStatus(session, terminalFor(session));
        if (kind === 'attention') summary.attention += 1;
        else if (kind === 'running') summary.running += 1;
    }
    return summary;
}
