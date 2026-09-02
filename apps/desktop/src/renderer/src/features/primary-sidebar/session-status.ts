import type { AgentOperation, ProcessState, SessionRecord } from '@caxri/protocol';

import { sessionActivityPresentation } from './session-activity';

export type SessionStatus =
    | { ariaLabel: string; emphasis: 'persistent' | 'unread'; kind: 'attention' }
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
 * Projects the detailed Agent lifecycle into the single status slot shared by Session lists. Attention outranks current
 * work because it represents an event the user has not acknowledged; a seen-but-still-waiting background Agent remains
 * visible without animation.
 */
export function sessionStatus(
    session: SessionStatusSource,
    terminal: SessionStatusTerminal = {},
    isCurrentSession = false,
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
            emphasis: 'unread',
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

    /**
     * The current Session already exposes its waiting reason in the visible Terminal. Keeping the same yellow dot after
     * its unread generation is acknowledged makes the row look perpetually unread, while background waiting Sessions
     * still need a durable status cue.
     */
    if (!isCurrentSession && session.lastActivityState === 'waiting') {
        return {
            ariaLabel: `Needs attention. ${currentActivity.ariaLabel}`,
            emphasis: 'persistent',
            kind: 'attention',
        };
    }

    if (agentOperation === 'compacting' || session.lastActivityState === 'running') {
        return { ariaLabel: currentActivity.ariaLabel, kind: 'running' };
    }

    return { kind: 'default' };
}
