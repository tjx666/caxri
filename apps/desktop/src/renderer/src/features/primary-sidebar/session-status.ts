import type { AgentOperation, SessionRecord } from '@caxri/protocol';

import { sessionActivityPresentation } from './session-activity';

export type SessionStatus =
    | { ariaLabel: string; emphasis: 'persistent' | 'unread'; kind: 'attention' }
    | { ariaLabel: string; kind: 'running' }
    | { kind: 'default' };

type SessionStatusSource = Pick<
    SessionRecord,
    'hasUnread' | 'lastActivityState' | 'lastAttentionKind'
>;

/**
 * Projects the detailed Agent lifecycle into the single status slot shared by Session lists. Attention outranks current
 * work because it represents an event the user has not acknowledged; a seen-but-still-waiting Agent remains visible
 * without animation.
 */
export function sessionStatus(
    session: SessionStatusSource,
    agentOperation?: AgentOperation,
): SessionStatus {
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

    if (session.lastActivityState === 'waiting') {
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
