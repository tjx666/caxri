import type {
    AgentChatGoal,
    AgentChatGoalReply,
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';
import {
    AGENT_CHAT_GOAL_COMMAND,
    agentChatGoalElapsedSeconds,
    MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH,
    parseAgentChatGoalArguments,
    parseAgentChatGoalReply,
} from '@caxri/protocol';

import { clip } from '../chat-items';
import type { AgentChatSessionHost } from '../chat-provider';
import { applyClaudeFeedback } from '../providers/claude/system-notices';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * The warning Claude Code prints when it drops the goal after an unrecoverable error, such as a full context window
 * (verified with Claude Code 2.1.304).
 */
const ERROR_CLEARED_PREFIX = 'Goal cleared after an unrecoverable error';

/**
 * What a notice says about the goal: `null` when it dropped the goal (a clear, `No goal set`, or the error warning),
 * the `/goal` reply when it set or reported one, and `undefined` when it says nothing. Shared by the live Chat and the
 * history replay so both read the same replies.
 */
export function claudeGoalNotice(notice: Notice): AgentChatGoalReply | null | undefined {
    if (notice.kind === 'warning' && notice.message?.startsWith(ERROR_CLEARED_PREFIX)) return null;
    const reply = parseAgentChatGoalReply(notice);
    if (!reply) return undefined;
    return reply.action === 'cleared' || reply.action === 'none' ? null : reply;
}

/**
 * Whether a command is `/goal clear` sent while a goal is set and a turn runs. Claude Code's SDK mode holds a slash
 * command until the running query ends (only its interactive `/goal` runs beside a turn), and the goal's query keeps
 * going until the condition is met, so a clear that waited for the turn would never land.
 */
export function isClaudeGoalClearDuringTurn(
    snapshot: AgentChatSnapshot,
    name: string,
    arguments_: string | undefined,
): boolean {
    return (
        Boolean(snapshot.activeTurnId && snapshot.goal) &&
        name === AGENT_CHAT_GOAL_COMMAND &&
        parseAgentChatGoalArguments(arguments_)?.action === 'clear'
    );
}

/**
 * A Claude Code session's `/goal`, kept in the snapshot's `goal` so the composer's goal row shows it while Claude works
 * toward it. Claude Code streams no goal state to the SDK (its `active_goal` frames stay internal outside remote
 * sessions), so this reads what it does stream: the `/goal` replies say a goal was set, is active, or was cleared, and
 * the turn ends say when it was met. `/goal <condition>` is one query that keeps going while the Stop hook finds the
 * condition unmet, so a turn that completes with no background work left to wake it passed that check and the goal is
 * gone; an interrupted or failed turn leaves the goal for the next one, as Claude Code does.
 */
export class ClaudeGoals {
    /**
     * A turn that only printed the goal (`/goal` with no condition): it never ran the goal's check, so its end says
     * nothing about whether the goal was met.
     */
    private statusTurnId: string | undefined;

    constructor(
        private readonly host: Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read'>,
    ) {}

    private set(goal: AgentChatGoal | null): void {
        this.host.apply([{ op: 'state', state: { goal } }]);
    }

    /**
     * Shows a frame's feedback in Chat and reads the goal from it. Returns whether the frame carried any.
     */
    applyFeedback(message: Record<string, unknown>, scope?: 'agent' | 'session'): boolean {
        const notices = applyClaudeFeedback(this.host, message, scope);
        this.onNotices(notices);
        return notices.length > 0;
    }

    /**
     * Notices a frame added: a `/goal` reply, or Claude Code clearing the goal after an error.
     */
    onNotices(notices: readonly Notice[], now = Date.now()): void {
        for (const notice of notices) {
            const reply = claudeGoalNotice(notice);
            if (reply === undefined) continue;
            if (reply === null) {
                this.set(null);
                continue;
            }
            if (reply.action === 'active') this.statusTurnId = this.host.read().activeTurnId;
            const current = this.host.read().goal;
            const objective = clip(reply.objective, MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH);
            // A status check of the same goal keeps the time it has been worked on.
            if (reply.action === 'active' && current?.objective === objective) continue;
            this.set({
                objective,
                status: 'active',
                tokensUsed: 0,
                timeUsedSeconds: 0,
                updatedAt: now,
                pausable: false,
            });
        }
    }

    /**
     * A turn ended. One that completed with nothing left to wake Claude Code passed the goal's check; any other that
     * worked on the goal keeps it with the turn's time added, so the row's time does not restart from the last report.
     */
    onTurnEnded(
        turn: { id: string; status: AgentChatTurn['status']; startedAt: number | undefined },
        isWaitingOnBackground: boolean,
        now = Date.now(),
    ): void {
        const isStatusTurn = this.statusTurnId === turn.id;
        this.statusTurnId = undefined;
        const goal = this.host.read().goal;
        // A turn that only printed the goal did not work on it, so its time is not the goal's.
        if (!goal || isStatusTurn) return;
        if (!isWaitingOnBackground && turn.status === 'completed') {
            this.set(null);
            return;
        }
        this.set({
            ...goal,
            timeUsedSeconds: agentChatGoalElapsedSeconds(goal, now, turn.startedAt),
            updatedAt: now,
        });
    }
}
