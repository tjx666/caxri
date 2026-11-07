import type {
    AgentOperation,
    ProcessState,
    SessionAttentionVariant,
    SessionRecord,
} from '@caxri/protocol';
import { isSessionAgentRunning, sessionAttentionVariant } from '@caxri/protocol';

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
    | (VisibleSessionStatus & {
          kind: 'attention';
          /**
           * True once the user has seen the item but it still waits on them: Pending Attention that was read but not
           * marked Done, or a permission request or escalated question only the user can decide (`approvalPending`).
           * The glyph keeps its steady pulse but skips the arrival ripple, which belongs to news the user has not
           * seen.
           */
          isPending?: boolean;
          variant: SessionAttentionVariant;
      })
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
    'hasUnread' | 'hasPendingAttention' | 'agentActivityState' | 'lastAttentionKind'
>;

/**
 * Projects the detailed Agent lifecycle into the single status slot shared by Session lists, by the same rule
 * `sessionActivityGroup` files Activity rows: whatever group a row sits in, its glyph says the same thing in the
 * Project tree, the Activity view, and the MRU switcher.
 *
 * A Chat waiting for a plan limit to reset (issue caxri#2220) outranks everything: it asks nothing of the user and
 * continues by itself, so the clock replaces the failure or unread cue the limit left behind. The cue returns when the
 * wait ends.
 *
 * The amber attention slot means Pending Attention: a turn ended (finished, waiting on a question, or failed) and the
 * user has not marked it Done. Reading the Session does not clear it; Mark as Done or a new turn does. Unread attention
 * is the same item before the user has opened it, and only it plays the arrival ripple. It is never keyed off
 * `agentActivityState` alone: that state is not Chat-specific, and a Terminal (PTY) Session with a stale `waiting`
 * would keep an amber cue nothing could clear. The one extra amber source is `approvalPending`, passed only for a
 * nested Session whose delegation feed entry carries a permission request or an escalated question that waits on the
 * user (`isDelegationUserPending`); it clears when the request leaves the feed. A Terminal child never has one.
 *
 * A live turn outranks attention: a Session whose Agent woke itself while its last result was still unread sits under
 * Working, so its glyph spins there too. An approval the Agent is blocked on outranks the live turn.
 *
 * `delegationFailed` is the one signal a Session record cannot carry: the delegation that runs in a nested Session
 * ended in `failed` (see `useDelegationFeed`). It only ever changes how a nested row reads, so the caller passes it for
 * those rows alone. Live signals outrank it: a usage-limit wait, an approval the Agent is blocked on, and a running
 * turn (a follow-up after the failure). Below those, `failed` replaces an attention result and the settled default (a
 * detached Agent keeps its glyph), so a task that failed still shows it until a later task replaces the failure.
 */
export function sessionStatus(
    session: SessionStatusSource,
    terminal: SessionStatusTerminal,
    t: Translate,
    {
        approvalPending = false,
        delegationFailed = false,
    }: { approvalPending?: boolean; delegationFailed?: boolean } = {},
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

    if (approvalPending) {
        if (session.hasUnread && session.lastAttentionKind === 'waiting')
            return attentionStatus(session, t);
        const waiting = sessionActivityPresentation('waiting', undefined, t);
        return {
            ariaDescription: waiting.description,
            ariaLabel: waiting.label,
            isPending: true,
            kind: 'attention',
            variant: 'waiting',
        };
    }

    /**
     * A detached Agent was handed to another client on purpose, so whatever activity the last probe recorded is no
     * longer Caxri's to animate. Attention still wins: it was raised before the hand-over. A recorded delegation
     * failure does not replace the detached glyph either.
     */
    const hasAttention = session.hasUnread || session.hasPendingAttention;
    if (terminal.lastProcessState === 'detached') {
        if (hasAttention) return attentionStatus(session, t);
        return {
            ariaDescription: t('primarySidebar.status.detached.description'),
            ariaLabel: t('primarySidebar.status.detached.label'),
            kind: 'detached',
        };
    }

    if (isSessionAgentRunning(session, terminal)) {
        const currentActivity = sessionActivityPresentation(
            session.agentActivityState,
            agentOperation,
            t,
        );
        return {
            ariaDescription: currentActivity.description,
            ariaLabel: currentActivity.label,
            kind: 'running',
            variant: agentOperation === 'background' ? 'background' : 'active',
        };
    }

    const failedStatus: SessionStatus = {
        ariaDescription: t('primarySidebar.status.failed.description'),
        ariaLabel: t('primarySidebar.status.failed.label'),
        kind: 'failed',
    };
    if (hasAttention) {
        // A result about a task that already ended is replaced by the failure; a question the Agent asked is not.
        if (delegationFailed && session.lastAttentionKind !== 'waiting') return failedStatus;
        return attentionStatus(session, t);
    }

    return delegationFailed ? failedStatus : { kind: 'default' };
}

/**
 * The attention slot for a Session with unread or Pending Attention. `Unread, finished` rather than `Needs attention:
 * Finished` before it is opened; once read it says `Needs attention, finished` until Mark as Done.
 */
function attentionStatus(session: SessionStatusSource, t: Translate): SessionStatus {
    const attentionActivity = sessionActivityPresentation(
        session.lastAttentionKind ?? 'unknown',
        undefined,
        t,
    );
    const kind = attentionActivity.label.toLowerCase();
    const ariaLabel = session.hasUnread
        ? session.lastAttentionKind === undefined
            ? t('primarySidebar.status.unread')
            : t('primarySidebar.status.unreadWithKind', { kind })
        : session.lastAttentionKind === undefined
          ? t('primarySidebar.status.pending')
          : t('primarySidebar.status.pendingWithKind', { kind });
    return {
        ariaDescription: attentionActivity.description,
        ariaLabel,
        ...(!session.hasUnread && { isPending: true }),
        kind: 'attention',
        variant: sessionAttentionVariant(session.lastAttentionKind),
    };
}

export interface SessionStatusSummary {
    /**
     * Sessions showing attention. Running outranks attention in `sessionStatus`, so a Session is counted once.
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
