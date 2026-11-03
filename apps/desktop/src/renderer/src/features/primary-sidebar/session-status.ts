import type {
    AgentOperation,
    ProcessState,
    SessionAttentionVariant,
    SessionRecord,
} from '@caxri/protocol';
import { sessionAttentionVariant } from '@caxri/protocol';

import type { Translate } from '../../i18n';
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
 * `background` is a running Session whose turn ended while work that wakes it again (a subagent, workflow, or monitor)
 * still runs, so it reads as running but quieter than a live turn.
 */
type SessionRunningVariant = 'active' | 'background';

export type SessionStatus =
    | (VisibleSessionStatus & { kind: 'attention'; variant: SessionAttentionVariant })
    | (VisibleSessionStatus & { kind: 'detached' })
    | (VisibleSessionStatus & { kind: 'failed' })
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
 *
 * `delegationFailed` is the one signal a Session record cannot carry: the delegation that runs in a nested Session
 * ended in `failed` (see `useDelegationFeed`). It only ever changes how a nested row reads, so the caller passes it for
 * those rows alone. Live signals outrank it, because they say the Session is doing something now or asks for you: a
 * usage-limit wait, an approval the Agent is blocked on, and a turn that is running (a follow-up after the failure).
 * Below those, `failed` outranks an unread result and the settled default (a detached Agent keeps its glyph), so a task
 * that failed and was then read still shows it until a later task replaces the failure.
 */
export function sessionStatus(
    session: SessionStatusSource,
    terminal: SessionStatusTerminal,
    t: Translate,
    { delegationFailed = false }: { delegationFailed?: boolean } = {},
): SessionStatus {
    const { agentOperation } = terminal;
    if (terminal.usageLimitWaitAt !== undefined) {
        return {
            ariaDescription: t('primarySidebar.status.usageWait.description', {
                time: agentChatMessageTime(terminal.usageLimitWaitAt, t.locale),
            }),
            ariaLabel: t('primarySidebar.status.usageWait.label'),
            kind: 'usageWait',
        };
    }

    const isLive = agentOperation === 'compacting' || session.agentActivityState === 'running';
    const failedStatus = (): SessionStatus => ({
        ariaDescription: t('primarySidebar.status.failed.description'),
        ariaLabel: t('primarySidebar.status.failed.label'),
        kind: 'failed',
    });

    const currentActivity = sessionActivityPresentation(
        session.agentActivityState,
        agentOperation,
        t,
    );

    if (session.hasUnread) {
        // An unread result is news about a task that already ended, which the failure replaces; an unread approval
        // request or a running turn is not, and stays.
        if (delegationFailed && !isLive && session.lastAttentionKind !== 'waiting')
            return failedStatus();
        const attentionActivity = sessionActivityPresentation(
            session.lastAttentionKind ?? 'unknown',
            undefined,
            t,
        );
        const currentStatus =
            agentOperation === 'compacting' || session.agentActivityState === 'running'
                ? t('primarySidebar.status.currentStatus', {
                      status: currentActivity.label,
                  })
                : '';
        return {
            ariaDescription: `${attentionActivity.description}${currentStatus}`,
            // `Unread, finished` rather than `Needs attention: Finished`: a finished turn needs nothing, it is unread.
            ariaLabel:
                session.lastAttentionKind === undefined
                    ? t('primarySidebar.status.unread')
                    : t('primarySidebar.status.unreadWithKind', {
                          kind: attentionActivity.label.toLowerCase(),
                      }),
            kind: 'attention',
            variant: sessionAttentionVariant(session.lastAttentionKind),
        };
    }

    /**
     * A detached Agent was handed to another client on purpose, so whatever activity the last probe recorded is no
     * longer Caxri's to animate. Unread attention still wins above: it was raised before the hand-over. A live signal
     * keeps its glyph, so a recorded delegation failure does not replace the detached one.
     */
    if (terminal.lastProcessState === 'detached') {
        return {
            ariaDescription: t('primarySidebar.status.detached.description'),
            ariaLabel: t('primarySidebar.status.detached.label'),
            kind: 'detached',
        };
    }

    if (isLive) {
        return {
            ariaDescription: currentActivity.description,
            ariaLabel: currentActivity.label,
            kind: 'running',
            variant: agentOperation === 'background' ? 'background' : 'active',
        };
    }

    return delegationFailed ? failedStatus() : { kind: 'default' };
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
    t: Translate,
): SessionStatusSummary {
    const summary: SessionStatusSummary = { attention: 0, running: 0 };
    for (const session of sessions) {
        const { kind } = sessionStatus(session, terminalFor(session) ?? {}, t);
        if (kind === 'attention') summary.attention += 1;
        else if (kind === 'running') summary.running += 1;
    }
    return summary;
}
