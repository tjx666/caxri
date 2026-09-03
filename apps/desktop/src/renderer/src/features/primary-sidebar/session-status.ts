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
