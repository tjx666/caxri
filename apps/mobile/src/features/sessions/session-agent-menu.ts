import type { BotHandoverRejection, MobileSessionMenuState } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import type { MobileSessionItem, MobileTerminal } from './session-model';

/**
 * Why Restart Agent cannot run, as Desktop's `restartAgentBlockedReason` decides: restarting resumes the Agent's
 * conversation, so it needs one, and a detached Agent was handed to another client on purpose, so only Resume takes it
 * back. Whether a conversation exists comes from the menu state, since the phone never learns its id.
 */
export type RestartAgentBlocker = 'detached' | 'noConversation';

export const RESTART_AGENT_BLOCKER_REASONS = {
    detached: 'sessions.actions.restartDetached',
    noConversation: 'sessions.actions.restartNoConversation',
} as const satisfies Record<RestartAgentBlocker, TranslationKey>;

/**
 * The Session menu's Agent group, Desktop's Session row menu entries a phone can act on. Each field is `undefined` when
 * its entry is hidden.
 */
export interface SessionAgentMenu {
    /**
     * Restart Agent, shown for a Session with an Agent and disabled with `blocker`.
     */
    restart: { blocker: RestartAgentBlocker | undefined } | undefined;
    /**
     * Detach Agent or Resume Agent, whichever the primary Agent's state calls for. Detach needs a running Agent.
     */
    detach: { action: 'detach'; canDetach: boolean } | { action: 'resume' } | undefined;
    /**
     * Hand Over to or Take Back from Caxri Bot, hidden until the menu state says which.
     */
    bot: 'handOver' | 'takeBack' | undefined;
    /**
     * Whether the Session has closed conversations Reopen Conversation can bring back.
     */
    canReopen: boolean;
    /**
     * The Session that created this one, when the phone lists it, for Go to Creating Session.
     */
    creatorSessionId: string | undefined;
}

const isRunning = (terminal: Pick<MobileTerminal, 'lastProcessState'>): boolean =>
    terminal.lastProcessState === 'running' || terminal.lastProcessState === 'starting';

/**
 * Decides the Agent group from the dashboard row and, once read, the menu state. The phone sees only the primary Agent,
 * so Detach and Resume follow it, where Desktop also counts the Session's other Agents; the Server's `session.detach`
 * and `session.resume` still act on every Agent of the Session. `listedSessionIds` are the Sessions the phone can open:
 * Go to Creating Session never restores an archived one, as on Desktop.
 */
export const sessionAgentMenu = (
    session: Pick<MobileSessionItem, 'createdBySessionId' | 'primaryTerminal'>,
    menuState: MobileSessionMenuState | undefined,
    listedSessionIds: ReadonlySet<string>,
): SessionAgentMenu => {
    const terminal = session.primaryTerminal?.provider ? session.primaryTerminal : undefined;
    const isDetached = terminal?.lastProcessState === 'detached';
    const creatorSessionId = session.createdBySessionId;
    return {
        restart: terminal && {
            blocker: isDetached
                ? 'detached'
                : menuState && !menuState.hasConversation
                  ? 'noConversation'
                  : undefined,
        },
        detach:
            terminal &&
            (isDetached
                ? { action: 'resume' }
                : { action: 'detach', canDetach: isRunning(terminal) }),
        bot: menuState && (menuState.isBotManaged ? 'takeBack' : 'handOver'),
        canReopen: (menuState?.conversations.length ?? 0) > 0,
        creatorSessionId:
            creatorSessionId !== undefined && listedSessionIds.has(creatorSessionId)
                ? creatorSessionId
                : undefined,
    };
};

/**
 * Desktop's words for why Caxri Bot refused a hand-over, completing "Nothing was handed over: …".
 */
export const BOT_HANDOVER_REJECTION_REASONS = {
    already_managed: 'sessions.handover.alreadyManaged',
    bot_session: 'sessions.handover.botSession',
    bot_unavailable: 'sessions.handover.botUnavailable',
    conversation_bound: 'sessions.handover.conversationBound',
    conversation_missing: 'sessions.handover.conversationMissing',
    duplicate: 'sessions.handover.duplicate',
    ownership_capacity: 'sessions.handover.ownershipCapacity',
    project_unavailable: 'sessions.handover.projectUnavailable',
    session_archived: 'sessions.handover.sessionArchived',
    session_missing: 'sessions.handover.sessionMissing',
    task_capacity: 'sessions.handover.taskCapacity',
} as const satisfies Record<BotHandoverRejection, TranslationKey>;
