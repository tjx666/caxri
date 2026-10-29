import type { AgentOperation, ProcessState, SessionRecord } from '@caxri/protocol';

import { translate } from '../../i18n';
import { agentChatMessageTime } from '../agent-chat/transcript/agent-chat-time';
import { sessionActivityPresentation } from './session-activity';

/**
 * A visible status carries a short accessible name and a separate full sentence. The name joins the row's own
 * accessible name, so it stays a word or two (`Unread, finished`, `Working`); the sentence is the glyph's accessible
 * description, read on demand instead of on every arrow key through the list.
 */
interface VisibleSessionStatus {
    ariaDescription: string;
    ariaLabel: string;
}

/**
 * The shape an unread attention glyph takes, so "the Agent is blocked on you" and "there is a result to read" differ
 * without relying on color (issue caxri#1632). A failed turn or an unknown cause has nothing to answer, so it keeps the
 * result's dot.
 */
type SessionAttentionVariant = 'result' | 'waiting';

/**
 * `background` is a running Session whose turn ended while work that wakes it again (a subagent, workflow, or monitor)
 * still runs, so it reads as running but quieter than a live turn.
 */
type SessionRunningVariant = 'active' | 'background';

export type SessionStatus =
    | (VisibleSessionStatus & { kind: 'attention'; variant: SessionAttentionVariant })
    | (VisibleSessionStatus & { kind: 'detached' })
    | (VisibleSessionStatus & { kind: 'running'; variant: SessionRunningVariant })
    | (VisibleSessionStatus & { kind: 'usageWait' })
    | { kind: 'default' };

export interface SessionStatusTerminal {
    agentOperation?: AgentOperation;
    lastProcessState?: ProcessState;
    /**
     * When the Chat continues on its own after a plan limit resets; present only while it waits.
     */
    usageLimitWaitAt?: number;
}

type SessionStatusSource = Pick<
    SessionRecord,
    'hasUnread' | 'agentActivityState' | 'lastAttentionKind'
>;

/**
 * Projects the detailed Agent lifecycle into the single status slot shared by Session lists.
 *
 * A Chat waiting for a plan limit to reset (issue caxri#2220) outranks everything: it asks nothing of the user and
 * continues by itself, so the clock replaces the failure or unread cue the limit left behind. The cue returns when the
 * wait ends.
 *
 * The amber attention slot means exactly one thing: an event the user has not opened yet. It is therefore always the
 * animated unread state and always clears once the Session is read; there is deliberately no quieter "still waiting"
 * variant. A second, static amber state keyed off `agentActivityState` alone used to survive acknowledgement, which
 * left read Sessions marked with a cue no amount of reading could clear and made the animated one impossible to trust.
 */
export function sessionStatus(
    session: SessionStatusSource,
    terminal: SessionStatusTerminal = {},
): SessionStatus {
    const { agentOperation } = terminal;

    if (terminal.usageLimitWaitAt !== undefined) {
        return {
            ariaDescription: translate('primarySidebar.status.usageWait.description', {
                time: agentChatMessageTime(terminal.usageLimitWaitAt),
            }),
            ariaLabel: translate('primarySidebar.status.usageWait.label'),
            kind: 'usageWait',
        };
    }

    const currentActivity = sessionActivityPresentation(session.agentActivityState, agentOperation);

    if (session.hasUnread) {
        const attentionActivity = sessionActivityPresentation(
            session.lastAttentionKind ?? 'unknown',
        );
        const currentStatus =
            agentOperation === 'compacting' || session.agentActivityState === 'running'
                ? translate('primarySidebar.status.currentStatus', {
                      status: currentActivity.label,
                  })
                : '';
        return {
            ariaDescription: `${attentionActivity.description}${currentStatus}`,
            // `Unread, finished` rather than `Needs attention: Finished`: a finished turn needs nothing, it is unread.
            ariaLabel:
                session.lastAttentionKind === undefined
                    ? translate('primarySidebar.status.unread')
                    : translate('primarySidebar.status.unreadWithKind', {
                          kind: attentionActivity.label.toLowerCase(),
                      }),
            kind: 'attention',
            variant: session.lastAttentionKind === 'waiting' ? 'waiting' : 'result',
        };
    }

    /**
     * A detached Agent was handed to another client on purpose, so whatever activity the last probe recorded is no
     * longer Caxri's to animate. Unread attention still wins above: it was raised before the hand-over.
     */
    if (terminal.lastProcessState === 'detached') {
        return {
            ariaDescription: translate('primarySidebar.status.detached.description'),
            ariaLabel: translate('primarySidebar.status.detached.label'),
            kind: 'detached',
        };
    }

    if (agentOperation === 'compacting' || session.agentActivityState === 'running') {
        return {
            ariaDescription: currentActivity.description,
            ariaLabel: currentActivity.label,
            kind: 'running',
            variant: agentOperation === 'background' ? 'background' : 'active',
        };
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
